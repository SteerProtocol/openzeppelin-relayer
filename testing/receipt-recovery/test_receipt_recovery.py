"""Exercise the deployed recovery CAS scripts against disposable local Redis.

python3 testing/receipt-recovery/test_receipt_recovery.py
No AWS access or third-party Python packages are used.
"""
import importlib.util
import json
import re
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('queue_tests', ROOT / 'testing/submission-control/test_submission_control.py')
queue_tests = importlib.util.module_from_spec(spec)
spec.loader.exec_module(queue_tests)
Harness = queue_tests.SubmissionControlTests


def script(path, method):
    source = (ROOT / path).read_text().split('async fn ' + method + '(', 1)[1]
    match = re.search(r'Script::new\(\s*r#"(.*?)"#\s*,?\s*\)', source, re.S)
    if not match:
        raise AssertionError('Production Lua script not found in ' + method)
    return match.group(1)


class ReceiptRecoveryTests(unittest.TestCase):
    setUpClass = Harness.__dict__['setUpClass']
    tearDownClass = Harness.__dict__['tearDownClass']
    command = Harness.__dict__['command']
    setUp = Harness.__dict__['setUp']

    def keeper(self, paused=False, token=None):
        value = {'id': 'matic-node-1', 'address': '0xabc', 'paused': paused,
                 'nonce_recovery_hold': token, 'custom_rpc_urls': [], 'policies': {'allowed_addresses': []}}
        self.keeper_key = self.ns + ':relayer:matic-node-1'
        self.owners = self.keeper_key + ':nonce_recovery'
        self.counter = self.ns + ':transaction_counter:matic-node-1:0xabc'
        self.command('SET', self.keeper_key, json.dumps(value))
        self.command('SET', self.counter, 42)
        return value

    def hold(self, token='tx-1'):
        code = script('src/repositories/relayer/mod.rs', 'hold_for_nonce_recovery')
        tx_key = self.keeper_key + ':tx:' + token
        if not self.command('EXISTS', tx_key):
            self.command('SET', tx_key, json.dumps({'id':token,'status':'sent','status_reason':None}))
        return self.command('EVAL', code, 3, self.keeper_key, self.owners, tx_key, token)

    def resume(self, token='tx-1', counter=42):
        code = script('src/repositories/relayer/mod.rs', 'resume_nonce_recovery')
        return self.command('EVAL', code, 2, self.keeper_key, self.owners, token, counter, self.ns)

    def test_manual_pause_never_acquires_automatic_resume_permission(self):
        self.keeper(paused=True)
        self.hold()
        held = json.loads(self.command('GET', self.keeper_key))
        self.assertTrue(held['paused'])
        self.assertIsNone(held['nonce_recovery_hold'])
        self.command('DEL', self.owners)
        self.assertIsNone(self.resume())

    def test_new_automatic_hold_is_durable_before_failure_write(self):
        self.keeper()
        self.hold()
        held = json.loads(self.command('GET', self.keeper_key))
        self.assertTrue(held['paused'])
        self.assertEqual(held['nonce_recovery_hold'], 'tx-1')
        self.assertEqual(self.command('ZRANGE', self.owners, 0, -1), ['tx-1'])
        self.assertIsNone(self.resume())

    def test_late_worker_cannot_rehold_reconciled_transaction(self):
        self.keeper()
        self.command('SET', self.keeper_key+':tx:tx-1', json.dumps({'id':'tx-1','status':'failed','status_reason':'Reverted on chain; nonce reconciled'}))
        self.hold()
        self.assertFalse(json.loads(self.command('GET', self.keeper_key))['paused'])
        self.assertEqual(self.command('ZCARD', self.owners), 0)

    def test_manual_patch_true_revokes_inflight_recovery_permission(self):
        self.keeper(paused=True, token='tx-1')
        code = script('src/repositories/relayer/relayer_redis.rs', 'partial_update')
        self.command('EVAL', code, 1, self.keeper_key, 'true')
        self.assertIsNone(self.resume())
        current = json.loads(self.command('GET', self.keeper_key))
        self.assertTrue(current['paused'])
        self.assertIsNone(current['nonce_recovery_hold'])
        self.assertEqual(current['custom_rpc_urls'], [])
        self.assertEqual(current['policies']['allowed_addresses'], [])

    def test_resume_requires_empty_recovery_index_and_unchanged_counter(self):
        self.keeper(paused=True, token='tx-1')
        self.command('ZADD', self.owners, 0, 'tx-other')
        self.assertIsNone(self.resume())
        self.command('DEL', self.owners)
        self.command('SET', self.counter, 43)
        self.assertIsNone(self.resume())
        self.command('SET', self.counter, 42)
        self.assertEqual(self.resume(), 1)
        current = json.loads(self.command('GET', self.keeper_key))
        self.assertFalse(current['paused'])
        self.assertIsNone(current['nonce_recovery_hold'])
        self.assertEqual(self.command('GET', self.counter), '42')

    def reconcile(self, stale=False, invalid_type=False, status='failed'):
        prefix = self.ns + ':relayer:'
        tx_key = prefix + 'matic-node-1:tx:tx-1'
        lookup = self.ns + ':tx_to_relayer:tx-1'
        statuses = prefix + 'matic-node-1:'
        keys = [lookup, statuses+'status_sorted:Failed', statuses+'status:Failed', statuses+'status_sorted:Confirmed']
        for status in ['Pending', 'Sent', 'Submitted', 'Mined']:
            keys.extend([statuses+'status_sorted:'+status, statuses+'status:'+status])
        owner_key = statuses+'nonce_recovery'
        tx = {'id':'tx-1','relayer_id':'matic-node-1','status':status,
              'status_reason':'Automatic submission failed: expired; nonce requires reconciliation',
              'network_data':{'data':{'nonce':41,'raw':[1,2,3],'hash':'0xknown'}},'hashes':['0xknown']}
        updated = dict(tx, status='confirmed', status_reason='Confirmed after receipt reconciliation')
        raw = json.dumps(tx)
        self.command('SET', lookup, 'matic-node-1')
        self.command('SET', tx_key, raw, 'EX', 600)
        self.command('ZADD', keys[1], 1, 'tx-1')
        self.command('ZADD', owner_key, 0, 'tx-1')
        if stale:
            self.command('SET', tx_key, json.dumps(dict(tx, status_reason='changed')))
        if invalid_type:
            self.command('SET', keys[3], 'wrong-type')
        before = self.command('GET', tx_key)
        code = script('src/repositories/transaction/transaction_redis.rs', 'reconcile_mined_auto_failure')
        args = ['matic-node-1',prefix,':tx:tx-1',raw,json.dumps(updated),'tx-1',100,owner_key]
        return code, keys, args, tx_key, before, updated, owner_key

    def test_receipt_cas_preserves_signed_intent_and_repairs_indexes(self):
        code, keys, args, tx_key, before, updated, owner = self.reconcile()
        self.assertEqual(self.command('EVAL', code, len(keys), *keys, *args), 1)
        self.assertEqual(json.loads(self.command('GET', tx_key)), updated)
        self.assertEqual(self.command('ZSCORE', keys[1], 'tx-1'), None)
        self.assertEqual(self.command('ZSCORE', keys[3], 'tx-1'), '100')
        self.assertEqual(self.command('ZCARD', owner), 0)
        self.assertGreater(self.command('TTL', tx_key), 0)

    def test_stale_receipt_snapshot_cannot_mutate_or_release_ownership(self):
        code, keys, args, tx_key, before, updated, owner = self.reconcile(stale=True)
        self.assertIsNone(self.command('EVAL', code, len(keys), *keys, *args))
        self.assertEqual(self.command('GET', tx_key), before)
        self.assertEqual(self.command('ZCARD', owner), 1)

    def test_receipt_cas_closes_indexed_pre_failure_crash_and_completion_races(self):
        for status in ['sent', 'submitted', 'confirmed']:
            code, keys, args, tx_key, before, updated, owner = self.reconcile(status=status)
            self.assertEqual(self.command('EVAL', code, len(keys), *keys, *args), 1)
            self.assertEqual(json.loads(self.command('GET', tx_key)), updated)
            self.assertEqual(self.command('ZCARD', owner), 0)

    def test_receipt_cas_cannot_change_an_unowned_transaction(self):
        code, keys, args, tx_key, before, updated, owner = self.reconcile()
        self.command('DEL', owner)
        self.assertIsNone(self.command('EVAL', code, len(keys), *keys, *args))
        self.assertEqual(self.command('GET', tx_key), before)

    def test_invalid_index_type_cannot_partially_write_reconciled_record(self):
        code, keys, args, tx_key, before, updated, owner = self.reconcile(invalid_type=True)
        with self.assertRaises(RuntimeError):
            self.command('EVAL', code, len(keys), *keys, *args)
        self.assertEqual(self.command('GET', tx_key), before)
        self.assertEqual(self.command('ZCARD', owner), 1)


del Harness

if __name__ == '__main__':
    unittest.main(verbosity=2)
