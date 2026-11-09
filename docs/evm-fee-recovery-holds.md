# EVM fee recovery and nonce reconciliation holds

When a signed transaction cannot be replaced within its spending limits, the
relayer must stop accepting higher nonces instead of repeatedly polling a queue
that cannot make progress. This change addresses the Arbitrum incidents observed
on 2, 5 and 8 November 2026.

## Behavior

Replacement pricing uses the maximum of the current speed quote, the required
replacement bump and the freshly observed base fee for legacy transactions. The
relayer cap and the transaction's `fee_ceiling_wei` still apply. Finalized legacy
and EIP-1559 candidate fees are checked again after any custom price handler.

If those limits cannot accommodate a valid replacement, automatic recovery ends:

- Set the relayer's persisted `paused` flag before marking an allocated nonce as
  requiring reconciliation. A failed hold write propagates an error; it must not
  silently make that nonce terminal.
- Keep the original transaction intent, nonce, signed bytes, hashes and reservation.
  Do not reset the counter, delete records or broadcast a cancellation/NOOP.
- Store an `Automatic submission failed:` reason and emit
  `relayer paused: allocated nonce requires operator reconciliation` with relayer
  and transaction IDs.
- Apply the same hold to expired allocated transactions and to earlier failed
  automatic submissions found by the gap detector. Such a record still owns its
  nonce and is not a gap that an automatic filler can overwrite.
- Paused EVM status checks preserve their records and return without chain RPCs.
  Queue deliveries remain available under the normal status schedule; this is not
  a queue deletion or archive. Paused preparation, submission and replacement
  workers reject work before allocating, signing or broadcasting.

The relayer model is loaded anew for each job delivery, so the persistent hold is
visible to subsequent workers and survives restart. Work already in progress when
a pause is written can still finish; this is not an atomic fence against an
already executing external broadcast. Mined transactions may still settle on-chain
while local monitoring is paused. Their receipts must be reconciled before resume.

## A cap can make a retry impossible

For the 8 November example, the original price was 20,032,000 wei. A 10% minimum
replacement requires 22,035,200 wei. A permitted candidate capped at 20,799,759 wei
cannot satisfy that rule, even when it exceeds the current base fee. The safe
result is an explicit hold, not bypassing the ceiling or repeatedly retrying.

This change does not guarantee that every budget can fund a replacement. An
operator must address an insufficient strategy/operator/relayer ceiling or funding
limit through the normal reviewed configuration process.

## Deploy and resume

1. Build and test this branch, publish an immutable image digest, then deploy it.
   Pushing this PR alone does not change the running worker. In the old deployment,
   pausing admissions does not suppress existing status-worker RPC polling.
2. Keep affected relayers paused. Reconcile their original and replacement hashes,
   latest/pending chain nonces, stored reservations and action-completion state.
   Already executed or expired strategy actions must not be blindly replayed.
3. Choose the authorized disposition of each unconsumed nonce. This patch does
   not grant permission to send cancellations, spend above a fee ceiling or reset
   a signed nonce.
4. Resolve the fee budget or funding limitation, restore only fresh eligible
   work, and explicitly unpause the signer. Verify receipts, nonce progress and
   RPC usage per confirmed transaction before expanding traffic.

Pauses never automatically clear on the next healthy RPC response. Other relayers
are independent. There are no new configuration fields, secrets or API routes.

## Verification

Integration regressions exercise paused status checks with a provider that panics
on any RPC, paused workers without counter/signature/broadcast calls, capped recovery
preserving signed nonce ownership, pre-existing failed owners, and a failed hold
write preventing terminalization. They use the in-memory repository implementations.
Pricing regressions cover the incident values,
base fees above lagging speed quotes, action and relayer caps, both fee formats,
and normal valid replacements.

```sh
cargo test --release --test evm_submission_recovery --test polygon_gas_estimation --locked --features redis-tls-native
cargo check --release --lib --tests --locked --features redis-tls-native
```

The targeted suites passed 23 tests. Six new regressions failed against the
unmodified branch before the fix. All library/test targets type-check; the full
library unit-test binary could not be built within the local Docker VM's memory
limit, so this is not a claim that the entire unit suite ran.
