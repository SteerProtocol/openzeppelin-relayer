# EVM submission recovery

Resolved fees are refreshed from RPC market prices on replacement, including
Arbitrum. Both legacy and EIP-1559 replacements retain the original nonce and
intent. Relayer caps and the stored action fee ceiling still apply; a cap below
an acceptable replacement fee does not authorize a higher fee.

A definite fee rejection permits one immediate same-nonce repricing attempt.
Timeouts, gateway errors and unknown broadcast outcomes do not enter that path.
A replacement-underpriced response is a rejection, not proof of submission.
Signed replacement bytes and both old/new hashes are persisted before broadcast.

Automatic submission recovery is bounded by the existing eight-cycle budget.
An intrinsic-gas-too-low rejection stops it immediately. Each finished delivery
ends; subsequent status-driven jobs observe the shared cooldown. Exhausted
status monitoring and expired/invalid automatic work also stop without rewriting
the action into a cancellation.

These off-chain failures are persisted with `status=failed` and a reason beginning
`Automatic submission failed: `, ending `nonce requires reconciliation`.
This status describes automation failure, not proof that a transaction reverted
or that its nonce is reusable. Signed bytes, hashes, calldata and nonce remain
available. A mined/final outcome already persisted wins over a late failure.
Stale worker patches cannot mutate a preserved failure.

Nonce health keeps these reserved nonces occupied and does not fill them with
NOOPs. Automatic cleanup retains these records even after `delete_at`. Counters
are not reset or decremented by failure handling. If the nonce remains unused,
later nonces cannot execute until it is reconciled; this is surfaced as failure
rather than silently canceling the original intent. Operators must inspect all
recorded hashes, receipts and chain nonce before choosing recovery. Never replay
expired actions or restore quarantined jobs blindly.

Run isolated regressions with:

```sh
cargo test --release --test evm_submission_recovery --locked --features redis-tls-native
python3 testing/submission-control/test_submission_control.py
```

These tests do not submit transactions to production networks.

The production image uses `redis-tls-native`, matching the existing runtime.
The local closed-TLS-peer regression exercises real Redis TLS setup and must
return a connection error rather than panic during provider selection.
