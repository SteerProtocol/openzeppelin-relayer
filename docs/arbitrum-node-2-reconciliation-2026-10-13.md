# Arbitrum node-2 reconciliation — 2026-10-13

Prepared read-only through ECS Exec. No transaction was signed, sent, retried,
replaced or canceled. No Redis key, queue, nonce counter or ECS configuration was
modified during collection. The application continued processing concurrently,
so the inventory is a bounded-time observation rather than an atomic snapshot.

## Nonce obstruction

Observed at **14:39:28 UTC / 20:09:28 IST**:

| Field | Value |
|---|---|
| Relayer | `arbitrum-node-2`, chain 42161 |
| Keeper | `0xdf789ab9f28550416e4a4197f8aa5d6553f8d7a9` |
| Chain latest nonce | 117292 |
| Chain pending nonce | 117292 |
| Redis next-nonce counter | 117932 |
| Counter distance above chain | 640 |
| Record at next chain nonce | `fc168e15-16ec-4d43-8076-999340bb74f0` |
| Record created | 2026-10-07 19:40:34 UTC |
| Persisted status | Submitted |
| Reason | Transaction is expired. Replacing with NOOP. |
| Destination | Keeper itself |
| Value | 0 |
| Gas limit | 21000 |
| Stored hash history | 6 entries |
| Current stored hash | `0x21f4c33b8918205d463e6aa8d49f5f0cdad217cb9c9ba8b9342c993a6e312484` |
| Receipt / transaction-by-hash | Both absent from the configured RPC |

Records at 117293–117303 also existed, were self-transfers with gas 21000, and
showed roughly 2293–2303 nonce-too-high attempts. These are allocated nonces,
not a verified empty region. **Do not rewind the counter to the chain nonce.**

At 14:41:27 UTC a read-only `eth_estimateGas` for the keeper's zero-value,
empty-calldata self-transfer returned **22886** (`0x5966`). The same estimate
with gas explicitly constrained to 21000 failed with JSON-RPC code -32000.
The stored 21000 limit is insufficient under the observed network conditions.
The estimate is time-sensitive and is not an approved replacement gas limit.

The persisted network config additionally has `config.Evm.tags = null` for
chain ID 42161. The current `EvmNetwork::is_arbitrum()` checks only the
`arbitrum-based` tag. Thus an untagged Arbitrum config selects the ordinary
21000-gas NOOP path instead of the existing Arbitrum gas-estimation path.
The local patch restores canonical-chain classification without changing live
tags, clears inherited estimation ceilings and refreshes persisted NOOP gas
before repricing/signing. This patch must be deployed and verified before
attempting nonce recovery. It does not mutate the live network config.

## Submission backlog

The active-list IDs were collected at 14:39:28 UTC and their payload inventory
completed at **14:40:07 UTC / 20:10:07 IST**. All 49050 listed payloads were read.

| Quantity | Count |
|---|---:|
| Waiting jobs | 49050 |
| Distinct `(relayer, transaction)` pairs | 605 |
| Attempts beyond one per transaction | 48445 |
| Resubmit jobs | 48994 |
| Submit jobs | 56 |
| Node-2 jobs | 47551 |
| Node-3 jobs | 1197 |
| Node-1 jobs | 302 |

The oldest listed job was created at 09:55:36 UTC. The most repeated transaction
had 338 waiting jobs. These counts exclude inflight and scheduled queues, and
are evidence of duplication rather than a deletion manifest.

## Production recovery sequence for review

1. Fix and validate the retry guard. Resolve why Arbitrum NOOP generation or
   repricing retained 21000 gas; ensure the recovery path estimates the replacement
   without inheriting the old gas ceiling. Verify runtime Arbitrum network tags
   because the current code selects its special NOOP handling from those tags.
2. Freeze new submissions and stop relayer workers before taking the cleanup
   snapshot. Archive the active list, job payloads, scheduled/inflight state,
   affected transaction records and nonce indices. Keep signer material and
   credentials out of the exported diagnostic artifacts.
3. Recheck the lowest unresolved nonce, all known hashes, receipts and pending
   state through the configured RPC and an independent trusted provider. Obtain
   a fresh gas estimate, replacement fee requirements and keeper balance. Budget
   the recovery fees before releasing a batch of allocated nonces. The first candidate
   for recovery is **the existing record at nonce 117292**, a zero-value
   self-transfer. Do not create a fresh execution/vote to recover this nonce.
4. Produce an explicit cleanup manifest per transaction: final/obsolete jobs,
   redundant automatic jobs, retained automatic job and retained cancellation
   intent. Preserve unresolved records and allocated nonces. Do not delete an
   inflight job merely because a duplicate exists in the active list.
5. Deploy the reviewed fix, reconcile the blocking nonce through one authorized
   submission path, then resume one worker. Verify advancement beyond 117292,
   queue depth, new guard decisions, pool acquisition and API latency before
   restoring normal producer traffic.

These steps require a reviewed execution manifest before production mutation.
This report and the local patch do not authorize queue deletion or broadcasting.

## Subsequent authorized cleanup

On 2026-10-13, after the user authorized removing stale transaction work while
preserving operational state, the service was stopped and an encrypted
ElastiCache snapshot was created and verified available:
`steer-stale-cleanup-20261013-164457`.

The stopped-worker manifest contained 36711 waiting submission jobs, 4359
inflight submission entries and 2922 dead entries. All 26 queue keys in the
explicit work-queue manifest were removed, along with 18 confirmed transaction
records and their indexes. The 681 unresolved nonce-owning transaction records
were retained. All 2662 protected-key fingerprints matched immediately after
cleanup. Signer, network, retained transaction and retained nonce-index records
also matched after restart; normal startup health checks refreshed some other
nonce counters and relayer health state. No counter was cleared or rewound by
the cleanup.

The existing task definition 21 was restored and became healthy. Transaction
queues were empty on verification; routine health checks were newly scheduled.
The read-only node-2 relayer API returned HTTP 200 in 334 ms. These observations
do not establish transaction-submission latency or nonce recovery.

The retry/gas patch in this branch was not deployed as part of that cleanup.
The nonce obstruction still requires fresh chain reconciliation and separately
authorized recovery before a transaction test.
