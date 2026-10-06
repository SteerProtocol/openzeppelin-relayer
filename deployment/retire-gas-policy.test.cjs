const { test } = require('node:test');
const assert = require('node:assert/strict');
const { stripRetiredPolicy, retirePolicies } = require('./retire-gas-policy.cjs');
test('removes only the retired policy while preserving serialized large integers', () => {
 for (const policies of ['{"min_balance":"123","gas_limit_buffer_percent":50,"nonce":9007199254740993}', '{"gas_limit_buffer_percent":10,"min_balance":"0"}', '{"gas_limit_buffer_percent":50}']) {
  const stored = '{"id":"arbitrum-node-1","policies":' + policies + ',"nonce":9007199254740993}';
  const cleaned = stripRetiredPolicy(stored);
  assert.ok(!cleaned.includes('gas_limit_buffer_percent'));
  assert.ok(cleaned.includes('9007199254740993'));
  assert.equal(stripRetiredPolicy(cleaned), cleaned);
 }
});
test('aborts on concurrent writes instead of overwriting new state', async () => {
 const redis = { get: async () => '{"policies":{"gas_limit_buffer_percent":50}}', eval: async () => 0 };
 await assert.rejects(retirePolicies(redis, ['arbitrum-node-1']), /Concurrent/);
});
