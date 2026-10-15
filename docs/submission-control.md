# Automatic EVM submission control

## Arbitrum recovery gas

Canonical Arbitrum One, Nova and Sepolia chain IDs retain Arbitrum behavior when
SDK-derived network records omit optional tags. Explicit `arbitrum-based` tags
continue to classify other Arbitrum-based networks. NOOP gas estimation clears
any inherited gas ceiling. Persisted NOOP resubmissions on the canonical chains
refresh the estimate and apply the existing gas buffer before repricing and
signing. Estimation failure aborts that attempt; it does not broadcast the old
underfunded gas limit. The nonce, destination and zero value are preserved.

## Behavior

The Redis backend atomically reserves one automatic EVM submission task per
`(relayer_id, transaction_id)`. Submit, Resubmit and Resend share that reservation.
Explicit Cancel commands and API cancellation-resubmit requests bypass automatic
suppression. API cancellation is server-marked and still uses the existing
repricing/signing path; it does not clear the automatic recovery budget.
Other queue backends and
non-EVM networks retain their existing behavior.

The reservation and Apalis job are written by one Lua script. A scheduled job
reserves immediately. A queued/running reservation has no TTL: a long queue wait
or crashed worker cannot allow a second producer to enqueue competing work.
Apalis recovers the original orphaned task. The owning task ID is carried in job
metadata; completion uses compare-and-set so an old task cannot release a newer
reservation.

The submission handler distinguishes a successful RPC operation from actual
progress. Returning `Ok` while leaving the record Pending/Sent, or returning an
unchanged Submitted record, counts as an unsuccessful recovery cycle. This
includes the nonce-too-high recovery branches. Such attempts return a job
failure instead of acknowledging success; they do not hold the worker awaiting
the cooldown. The status monitor can schedule a later bounded recovery cycle.
Unsuccessful cycles back off 30, 60, 120, 240, 480, then at most 900 seconds.
Eight consecutive unsuccessful cycles end the submission job with an explicit
abort/failure. `intrinsic gas too low` fails immediately. The owning reservation
is released in either case, so the worker can process other jobs. Further
automatic enqueue attempts for that transaction return an error, rather than
pretending that scheduling succeeded. A successful transition out of
Pending/Sent or an updated broadcast hash/timestamp resets the failure budget,
with a minimum 30-second cooldown.

Failed submission controls preserve the transaction, signed bytes, nonce, and existing
chain status; they do not mark a transaction Failed or recycle its nonce. They require
operator reconciliation. Their key is:

```
<submission queue data hash>:submission-control:<relayer id>:<transaction id>
```

The hash records `owner`, `failures`, `next_allowed`, and `blocked` as applicable.
An abort error and WARN event identify a failed submission, and
`submission_control_decisions_total{relayer_id,decision,reason}` counts enqueue,
suppression and block decisions. Nonblocked idle controls expire after 30 days;
pending and blocked controls do not expire automatically.

If completion cannot reach Redis, subsequent producers inspect Apalis's
done/dead acknowledgement. They recover the reservation conservatively, counting
the unknown outcome as a failed cycle. Until that durable acknowledgement exists,
the reservation stays held. There is no two-step reservation/enqueue crash gap.

## Observability

`redis_pool_acquire_seconds{operation,outcome}` measures repository pool checkout,
including connection recycling. The existing `transaction_processing_seconds`
histogram additionally measures:

- `api_relayer_lookup`
- `api_relayer_construction`
- `api_transaction_persistence`
- `api_status_queue_insert`
- `api_prepare_queue_insert`

`submission job picked up` is emitted before repository/relayer construction, so
the log timestamp identifies pickup without including repository wait time.

## Validation and rollout

Run `python3 testing/submission-control/test_submission_control.py`. It starts a
disposable local Redis 7.4 container on a dynamically assigned loopback port and
executes the production scripts. It does not use AWS credentials or live RPC.

Also compile-check the Rust changes with the repository's pinned toolchain.
The guard serializes the same `Request<Job<TransactionSend>, RedisContext>` format
as pinned Apalis Redis 0.7.4 and uses its configured queue keys.

Rust regressions cover guard eligibility/cancellation, unchanged Submitted
recovery budgets, fresh NOOP estimation and canonical-chain classification.
The local 8 GiB Docker environment could not build the full unit-test binary
because compilation exhausted memory. Run these on a sufficiently sized runner
before production rollout:

```
cargo test --lib --release --locked --features redis-tls-native submission_control
cargo test --lib --release --locked --features redis-tls-native recovery_budget
cargo test --lib --release --locked --features redis-tls-native test_make_noop
cargo test --lib --release --locked --features redis-tls-native test_arbitrum
```

Existing jobs lack ownership metadata and remain compatible, but they are not
retroactively deduplicated. The backlog must be reconciled and selectively
compacted with producers/workers stopped before production cutover. Do not clear
the queue or its data hash wholesale. Preserve explicit cancellations, unresolved
transactions, inflight recovery information and nonce ownership.

An operator must not clear a blocked control until its transaction and nonce have
been reconciled. Rolling back the binary does not remove guard metadata; the old
binary ignores it and can resume the original unbounded scheduling behavior.
Keep producers/workers stopped during rollback decisions and preserve the queue
backup and transaction records.

Submission job failure is distinct from a confirmed on-chain revert. An already
accepted asynchronous POST cannot be retroactively changed into an HTTP failure.
This patch reports the error at enqueue/worker boundaries; it does not invent an
on-chain Failed receipt or free a nonce still unconsumed on chain.
