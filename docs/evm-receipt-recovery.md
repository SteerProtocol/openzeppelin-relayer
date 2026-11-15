# Receipt-based recovery of EVM nonce holds

An expired request is not an expired signed Ethereum transaction. It can still
mine after the request's freshness deadline, including as a revert. A mined revert
consumes its nonce. Polygon nodes 1 and 3 stopped on November 10/11, 2026 because
older workers held the signer but never observed those late receipts.

## Automatic and manual pause ownership

An automatic nonce hold persists `paused=true` and an internal
`nonce_recovery_hold` transaction token. The hold registers its transaction in a
per-relayer Redis recovery index before stopping admissions. Transaction
terminalization and index insertion also share an atomic write. This closes the
window between pausing a signer and marking a transaction failed.

An explicit pause PATCH, including another `paused=true`, revokes automatic
resume permission. Full EVM configuration writes and runtime reinitialization
preserve the current pause ownership. Configuration `paused` initializes a new
relayer; use the pause endpoint to change an existing EVM relayer. Other network
types retain their existing configuration behavior. Legacy pauses without a
provenance token remain manual and require operator reconciliation.

## Recovery checks and limits

A targeted `nonce_receipt_recovery` health job runs for automatically held EVM
signers. It persists the next heartbeat before any RPC work. Existing provenance
seeds a heartbeat 60 seconds after startup, after any previous worker cooldown
can expire. Failed initial queue production remains
retryable; an enqueue failure releases its own gate. Ordinary paused transaction
workers do no receipt RPCs and only coalesce heartbeat production.

Each pass processes at most eight indexed nonce owners. A shared Redis gate
limits execution to once per 55 seconds per signer; the next durable heartbeat is
scheduled after 60 seconds. A 40-second timeout bounds the pass. Duplicate job
deliveries do not each poll transactions. Errors retain the hold and next job.

For each eligible known hash, recovery proves:

- The provider reports the configured chain ID.
- The transaction hash, signer, nonce, chain ID, destination, calldata and value
  match the stored signed intent.
- The transaction and receipt identify the same block as the canonical block at
  that height.
- The block has the network's configured confirmation depth. Revert receipts
  receive the same confirmation requirement as successful receipts.

The receipt compare-and-set requires the owner to remain indexed and its entire
stored snapshot to remain unchanged. It changes outcome metadata and status
indexes together, clears that recovery owner, preserves signed bytes, hashes and
nonce reservations, and starts a fresh configured record-retention window. It
also handles the race where a normal status worker finalized the indexed owner
before the automatic-failure write, or a crash left it in Sent/Submitted. Generic
terminal-record mutation guards remain unchanged.

A signer resumes only when its owner index is empty, latest and pending chain
nonces agree, and the stored next nonce equals that chain nonce. The final Redis
compare-and-set checks the pause token, empty recovery index and unchanged stored
counter together. A concurrent failure or manual pause defeats the resume.

The worker never signs, cancels, replaces, resets a nonce, increases a fee ceiling,
or replays expired calldata. It currently proves the stored current signed hash.
A missing receipt, historical replacement winning instead, canceled/expired
owner, mismatched intent, unknown nonce consumer, missing owner, inconsistent
index or nonce reservation requires operator reconciliation. It does not assume
that a higher chain nonce alone proves which transaction executed.

The plugin's freshness deadline remains unchanged. An expired Sent transaction
with a known hash checks for a receipt before entering an expiry hold, avoiding
unnecessary pauses when the transaction already mined. Pending/unsigned work and
unexpired Sent work retain their previous DB-only status checks.

## Monitoring

Structured native logs emit `nonce_receipt_reconciled` with relayer ID,
transaction ID, hash, nonce, final status and reason, followed by
`nonce_receipt_recovery_resumed` when an automatic hold clears. A pause PATCH
converts the signer to operator control and stops subsequent recovery RPCs. This
change does not alter vault quorum or workflow success reporting.

## Verification

```sh
cargo test --release --test evm_receipt_recovery --test evm_submission_recovery --test polygon_gas_estimation --locked --features redis-tls-native
python3 testing/receipt-recovery/test_receipt_recovery.py
```

The Rust integration fixture panics on signing and broadcasting. It exercises
late success/revert receipts, manual pauses, missing/foreign/reorged/unconfirmed
receipts, duplicate bounds, queue-production failure recovery and RPC failure.
The disposable Redis tests run the production Lua scripts and cover manual
pause races, ownership registration, nonce/index guards, stale receipts,
retention preservation and wrong-type failures before writes. Full library unit
test execution remains a separate check; do not substitute type-checking for a
claim that the full suite ran.
