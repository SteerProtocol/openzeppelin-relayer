"""Exercise production queue scripts against an isolated, disposable Redis.

Run with python3 testing/submission-control/test_submission_control.py.
No AWS credentials, production endpoints, or Python packages are used.
"""
import concurrent.futures
import json
from pathlib import Path
import socket
import subprocess
import unittest
import uuid

ROOT = Path(__file__).resolve().parents[2]


class SubmissionControlTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.container = subprocess.check_output([
            "docker", "run", "--rm", "-d", "--pull=never",
            "-p", "127.0.0.1::6379", "redis:7.4-alpine",
            "redis-server", "--save", "", "--appendonly", "no",
        ], text=True).strip()
        try:
            mapping = subprocess.check_output([
                "docker", "port", cls.container, "6379/tcp"
            ], text=True).strip()
            cls.port = int(mapping.rsplit(":", 1)[1])
            subprocess.run(["docker", "exec", cls.container, "redis-cli", "PING"],
                           check=True, capture_output=True)
        except BaseException:
            subprocess.run(["docker", "stop", cls.container], capture_output=True)
            raise

    @classmethod
    def tearDownClass(cls):
        subprocess.run(["docker", "stop", cls.container], check=True, capture_output=True)

    def setUp(self):
        self.ns = "test:" + uuid.uuid4().hex
        self.keys = [self.ns + suffix for suffix in
                     [":data", ":active", ":signal", ":scheduled", ":control", ":done", ":dead"]]

    @classmethod
    def command(cls, *args):
        with socket.create_connection(("127.0.0.1", cls.port), timeout=5) as sock:
            parts = [str(x).encode() for x in args]
            sock.sendall(b"*%d\r\n" % len(parts) + b"".join(
                b"$%d\r\n" % len(x) + x + b"\r\n" for x in parts))
            stream = sock.makefile("rb")

            def read():
                line = stream.readline()
                kind, value = line[:1], line[1:-2]
                if kind == b"-":
                    raise RuntimeError(value.decode())
                if kind == b"+":
                    return value.decode()
                if kind == b":":
                    return int(value)
                if kind == b"$":
                    size = int(value)
                    if size == -1:
                        return None
                    data = stream.read(size)
                    stream.read(2)
                    return data.decode()
                if kind == b"*":
                    return [read() for _ in range(int(value))]
                raise RuntimeError("Unexpected Redis response")
            return read()

    def enqueue(self, task="task-1", scheduled=""):
        script = (ROOT / "src/queues/redis/scripts/enqueue_submission.lua").read_text()
        return self.command("EVAL", script, len(self.keys), *self.keys,
                            task, json.dumps({"args": {"message_id": task}}), scheduled)

    def test_repeated_status_checks_enqueue_only_one_job(self):
        self.enqueue("first")
        self.enqueue("second")
        self.assertEqual(self.command("LRANGE", self.keys[1], 0, -1), ["first"])
        self.assertIsNone(self.command("HGET", self.keys[0], "second"))

    def finish(self, owner, outcome="retryable", reason=""):
        script = (ROOT / "src/queues/redis/scripts/finish_submission.lua").read_text()
        return self.command("EVAL", script, 1, self.keys[4], owner, outcome, reason)

    def test_concurrent_producers_share_one_reservation(self):
        with concurrent.futures.ThreadPoolExecutor(max_workers=12) as executor:
            results = list(executor.map(self.enqueue, [str(x) for x in range(24)]))
        self.assertEqual(sum(r[0] == 1 for r in results), 1)
        self.assertEqual(self.command("LLEN", self.keys[1]), 1)

    def test_queued_and_crashed_worker_reservations_do_not_expire(self):
        self.enqueue("first")
        self.assertEqual(self.command("TTL", self.keys[4]), -1)
        self.command("LPOP", self.keys[1])
        self.command("SADD", self.ns + ":inflight:worker", "first")
        self.assertEqual(self.enqueue("second")[0], 0)
        # Apalis's orphan recovery moves the original ID back to the queue.
        self.command("SREM", self.ns + ":inflight:worker", "first")
        self.command("RPUSH", self.keys[1], "first")
        self.assertEqual(self.enqueue("third")[0], 0)
        self.assertEqual(self.command("LRANGE", self.keys[1], 0, -1), ["first"])

    def test_scheduled_jobs_reserve_before_their_delivery_time(self):
        self.enqueue("first", scheduled="9999999999")
        self.assertEqual(self.enqueue("second")[0], 0)
        self.assertEqual(self.command("ZCARD", self.keys[3]), 1)
        self.assertEqual(self.command("LLEN", self.keys[1]), 0)

    def test_completion_applies_exponential_backoff_across_fresh_jobs(self):
        now = int(self.command("TIME")[0])
        for attempt in range(1, 5):
            owner = "attempt-" + str(attempt)
            self.command("HSET", self.keys[4], "next_allowed", 0)
            self.assertEqual(self.enqueue(owner)[0], 1)
            self.assertEqual(self.finish(owner), 1)
            self.assertEqual(self.command("HGET", self.keys[4], "failures"), str(attempt))
            until = int(self.command("HGET", self.keys[4], "next_allowed"))
            self.assertGreaterEqual(until - now, 30 * 2 ** (attempt - 1))
            self.assertEqual(self.enqueue("early")[2], "cooldown")

    def test_eight_unsuccessful_cycles_block_automatic_recovery(self):
        for attempt in range(1, 9):
            owner = str(attempt)
            self.command("HSET", self.keys[4], "next_allowed", 0)
            self.enqueue(owner)
            self.finish(owner)
        self.assertEqual(self.enqueue("ninth"), [-1, "", "retry_budget_exhausted"])
        self.assertEqual(self.command("TTL", self.keys[4]), -1)

    def test_permanent_error_requires_operator_recovery(self):
        self.enqueue("first")
        self.assertEqual(self.finish("first", "permanent", "intrinsic_gas_too_low"), 2)
        self.assertEqual(self.enqueue("second"), [-1, "", "intrinsic_gas_too_low"])

    def test_failed_transaction_releases_owner_and_does_not_hold_other_jobs(self):
        self.enqueue("bad-gas")
        self.assertEqual(self.command("LPOP", self.keys[1]), "bad-gas")
        self.assertEqual(self.finish("bad-gas", "permanent", "intrinsic_gas_too_low"), 2)
        self.assertIsNone(self.command("HGET", self.keys[4], "owner"))
        self.assertEqual(self.enqueue("bad-gas-again")[0], -1)
        # Same queue, independent transaction: failure never blocks its enqueue.
        self.keys[4] = self.ns + ":control:other-transaction"
        self.assertEqual(self.enqueue("healthy")[0], 1)
        self.assertEqual(self.command("LRANGE", self.keys[1], 0, -1), ["healthy"])

    def test_late_completion_cannot_release_a_new_owner(self):
        self.enqueue("first")
        self.finish("first", "progress")
        self.command("HSET", self.keys[4], "next_allowed", 0)
        self.enqueue("second")
        self.assertEqual(self.finish("first"), 0)
        self.assertEqual(self.command("HGET", self.keys[4], "owner"), "second")

    def test_lost_completion_recovers_only_after_durable_ack(self):
        self.enqueue("first")
        self.assertEqual(self.enqueue("before-ack")[0], 0)
        self.command("ZADD", self.keys[6], 1, "first")
        self.assertEqual(self.enqueue("after-ack")[0], 1)
        self.assertEqual(self.command("HGET", self.keys[4], "failures"), "1")

    def test_success_resets_failure_budget(self):
        self.enqueue("first")
        self.finish("first")
        self.command("HSET", self.keys[4], "next_allowed", 0)
        self.enqueue("second")
        self.finish("second", "progress")
        self.assertEqual(self.command("HGET", self.keys[4], "failures"), "0")

    def test_invalid_queue_type_does_not_claim_or_write_a_job(self):
        self.command("SET", self.keys[1], "wrong-type")
        with self.assertRaises(RuntimeError):
            self.enqueue("first")
        self.assertEqual(self.command("EXISTS", self.keys[4]), 0)
        self.assertEqual(self.command("HLEN", self.keys[0]), 0)


if __name__ == "__main__":
    unittest.main(verbosity=2)
