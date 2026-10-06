# Steer action gas plugin

An opt-in plugin for registered Steer vault actions through `Orchestrator.executeAction`.
It estimates only an action that returns exactly `COMPLETED`, then submits the original
transaction through the relayer. It does not change deployed contracts or build swap calldata.

## Discovery and policy

`@steerprotocol/sdk@3.8.0` supplies deployment addresses and GasVault, VaultRegistry and
StrategyRegistry ABIs. The SDK does not export the Orchestrator ABI. `orchestrator-abi.json`
is copied from `@steerprotocol/contracts@3.1.7`, `deployments/arbitrum.json`,
`contracts.Orchestrator.abi`. It describes the reviewed v1 profile. New implementations
must have separately reviewed code hashes and compatible interfaces; discovering an
address does not approve its implementation.

At the pinned block, the plugin validates Orchestrator/GasVault/registry relationships,
registered vault identity, strategy ID, fee ceiling, inner gas allowance and funding.
The persisted action ceiling also includes `GasVault balance / strategy.maxGasPerAction`.
Before enqueueing, the plugin takes the lower ceiling from the estimation and submission
snapshots. `fee_ceiling_wei` is an optional decimal-string API extension in this fork,
not an upstream SDK 1.10 field. Deploy this relayer server change before the plugin;
the plugin requires the enqueue response to acknowledge the stored ceiling. An absent
acknowledgement requires reconciliation because the transaction might already exist.
Upgrade every API and transaction worker before enabling guarded submissions. Older
workers can ignore the field; drain or reconcile capped pending actions before downgrading
the server.
The effective fee ceiling is the minimum of operator, strategy and relayer caps when the
relayer exposes one. The fee-dependent GasVault getter is also checked from the keeper.
A vault state is reported, rather than used as an invented blanket eligibility rule.
The original action remains the execution eligibility check.

Configuration separates:

- `profile`: reviewed ID, backend, proxy/implementation hashes. Addresses default to the
  SDK. Optional `profile.deployments` overrides are for reviewed alternate deployments
  and isolated fixtures, never request parameters.
- Operator policy: approved `relayerIds`, chain-map key `chainId`, required `maxGas` outer ceiling and
  `maxGasPrice` fee ceiling in wei, margin, freshness and deadline.
- `estimateEnabled` and `submitEnabled`: both default false. Submission requires both true.

Inner `maxGasPerAction` is read live. It is not substituted for outer gas: the Orchestrator,
self-call and reimbursement consume additional gas. Keep the outer ceiling explicit.
Scratch address, EIP-1967 slot and `COMPLETED=1` are reviewed protocol constants.

## Estimation flow

1. Obtain the signer from the configured relayer, check availability and chain ID, and pin
   a block number/hash. Verify approved Orchestrator proxy and implementation code hashes.
2. Resolve the deployment graph and vault strategy metadata at that block. Fail closed on
   missing registration, graph mismatch, unacceptable fees or insufficient funding.
3. Verify the simulation scratch address has no code, nonce or balance. Prove `eth_call`
   honors a code override using a forced empty return.
4. Install `ActionSimulationGuard` only in simulation. It delegates to the copied proxy
   runtime, preserving address/storage, keeper, origin, implementation and self-call routing.
   Exact `COMPLETED` is required. Never install the guard in a live proxy or deploy it as
   an execution wrapper.
5. Establish completion at the bounded outer ceiling and use the selected backend:
   - `guarded-rpc`: first prove `eth_estimateGas` honors overrides using forced revert,
     then estimate the guarded path.
   - `native-call-search`: use only guarded `eth_call` probes. Search between 21,000 gas
     and the ceiling, with at most 20 probes and 1,000-gas tolerance. Only positively
     identified execution reverts/OOG count as failed probes. Transport/unknown errors
     abort. Every probe uses the same pinned RPC state; no TEVM or persistent fork exists.
6. Apply the bounded margin, verify the guarded estimate and require the original call
   with no overrides to return `COMPLETED`. Recheck block canonicality.
7. Submit mode requires a fresh original snapshot, rechecks its canonicality, then repeats
   deployment, live limits, funding and original completion at a fresh block. Enqueue once
   with checked initial legacy fee, bounded gas and short validity. Never retry an ambiguous
   enqueue or fall back to an unguarded endpoint.

The request remains `{data, mode: "estimate" | "submit"}`. Caller-provided signer,
destination, fees, profiles and overrides are rejected. Only canonical `executeAction`
calldata, up to 64 KiB, is accepted. Inner calls remain opaque and are executed as supplied.

The report adds profile ID, backend, SDK version, resolved addresses, strategy ID/state,
inner allowance, fee ceiling and gas funding. Metadata/fee quantities use decimal strings;
existing outer gas fields remain bounded safe numbers for API compatibility. Typed action
errors carry stable codes in their messages; provider URLs and raw errors are redacted.
Orchestrator-caught target errors cannot be decoded after their revert bytes are discarded.

## Register and call

Requires Node 22.14+, recent state at explicit block numbers, `eth_call` code overrides,
and normal chain/block/code/storage/account/fee reads. `guarded-rpc` additionally requires
overrides on `eth_estimateGas`. Archive state is needed only for historical replay.

Install this directory in the relayer image, install its runtime dependencies with
`npm ci --omit=dev --ignore-scripts`, and register the shared plugin with one policy per chain.
The fragment deliberately requires verified code hashes and an operator fee cap.
Register one `steer-action` plugin. Its `config.chains` map is keyed by numeric chain ID. Each entry contains one chain policy and a `relayerIds` allowlist for its keepers. A relayer may appear in only one chain entry. Requests select an approved relayer; the actual RPC chain ID must match its configured chain. Each chain retains independent estimate/submit switches.
Existing per-keeper registrations must migrate to `config.chains` and the shared endpoint; the old request envelope is rejected.
No new chain is automatically enabled by its presence in the SDK.

Keep runner timeout at 120 seconds or more; the shared read deadline defaults to 30 seconds
and must be shorter than the runner and gateway budgets. For a 30-second HTTP gateway,
configure `deadlineMs` at most 20,000 and verify end-to-end timing. Timed-out reads cannot
later continue into enqueue. Submission itself can have an ambiguous transport outcome.

```http
POST /api/v1/plugins/steer-action/call
Content-Type: application/json
Authorization: Bearer <existing relayer credential>

{"params":{"relayerId":"arbitrum-node-1","mode":"estimate","data":"0x<encoded executeAction>"}}
```

Use authenticated POST and the standard response envelope (`raw_response: false`). Submit
returns `transactionId`, `relayerId`, report and submission snapshot. Poll that relayer's
transaction API and verify receipt status plus matching `ActionExecuted` before success.
The plugin does not wait for mining or replace keeper voting/authorization.

## Processor and IAM integration

The processor's companion change retains `RELAYER_CHAINS=['arbitrum']` and introduces an
independent, initially empty `GUARDED_TEND_CHAINS`. Selected `executeAction` requests use
this plugin; votes and funding retain the normal transaction endpoint. Plugin errors and
ambiguous responses do not cause a generic submit fallback. The processor verifies action
hash and event emitter/keeper before completion callbacks.

Before enabling guarded routing, the IAM gateway must admit only the configured plugin IDs
on `POST /api/v1/plugins/<id>/call`, forward the request to the existing bearer-authenticated
relayer upstream, and grant matching `execute-api:Invoke` resources. Do not expose plugin
listing, administration, GET invocation or arbitrary plugin IDs. The deployed proxy source
has not been located or changed; gateway access is an explicit rollout gate.

Enable estimate-only Arbitrum shadow traffic first. Verify all keeper identities and
representative vault families, then opt into guarded submission. Bittensor uses
`native-call-search` when validated, but remains disabled by default. Local native-search
success is not production Bittensor validation. Validate each additional chain separately.
Rollback stops new guarded requests; reconcile already accepted transactions before retry.

## Validation

```sh
pnpm --dir ../../plugins install --frozen-lockfile --ignore-scripts
npm ci --ignore-scripts
npm run validate
```

This checks reproducible Solidity runtime, types, formatting, metadata and policy violations,
provider override capabilities, bounded search/error handling, reorgs/freshness, actual Anvil
execution and the repository's pooled compiler/socket runtime. Only the isolated Anvil test
sends a local transaction. Fixtures model execution boundaries, not all production vaults.

Historical diagnostic, with a read-only RPC allowlist and no wallet/submission API:

```sh
RPC_URL=<archive RPC> npm run validate:live -- \
  --tx-hash 0xb50977e00631abc7abb39157cf52b8d8f0b634868458931c311c9bfdfd876289 \
  --max-gas 1000000 --backend guarded-rpc
```

Use `--backend native-call-search` to exercise native search. The script discovers diagnostic
hashes from the historical deployment, not production approval. It requires the transaction's
Orchestrator to match the SDK, uses parent-block state and original legacy fee, and verifies
canonicality. Prior results in `validation-results.json` predate this metadata expansion;
they are not new replay evidence. Failed historical actions can terminate with a non-completed
result; increasing gas does not repair an invalid swap. Archive availability is a separate gate.

## Limits and enablement gates

- Simulation does not guarantee future mining success. State, queue delay and fee replacement
  can change. This is an explicit endpoint, not a replacement/signing lifecycle hook.
- The relayer persists the action ceiling and checks final fees before initial signing,
  automatic resubmission and manual replacement. Replacement requests cannot remove or
  raise it. A minimum bump above the ceiling leaves the original pending for monitoring
  and existing expiry/cancellation. NOOP cancellation clears this action ceiling.
- This ceiling is a snapshot, not a reservation of GasVault funds. Later funding, strategy,
  votes or vault-state changes can still prevent mining success. There is no lifecycle
  re-simulation hook. Validate native transaction type and replacement behavior for each
  chain before enabling. No EIP-1559 plugin fee mode is added in this change.
- Guard overhead and access warming can shift estimates. Verify original-call completion and
  validate margins across representative actions. Gas search need not find a mathematical
  minimum for gas-dependent contracts; only a verified bounded candidate is accepted.
- Failure at the ceiling stops submission. No swap recomputation or fork scheduler fix is included.
- No durable idempotency/reconciliation worker is added. An accepted submission with a lost
  response must be reconciled before another attempt. Retain transaction IDs and action records.
- The SDK is a pinned dependency with a broad transitive dependency tree. Review dependency
  audit findings when updating it; do not run automatic breaking dependency fixes in this PR.

## Organization and caller authorization

`config.ts` resolves the trusted chain policy and approved keeper. `types.ts` holds shared execution types. `validation.ts` holds input validators. `index.ts` orchestrates one request; `metadata.ts` and `gas.ts` remain the single metadata and simulation implementations. No mutable simulation state is shared across invocations.

A shared endpoint changes IAM route granularity: permission to call it reaches every configured keeper unless the authenticated gateway enforces a caller-to-relayer allowlist. The plugin context does not provide an authenticated IAM principal. The chain map is an operator allowlist, not caller authorization. Before rollout, either verify that callers are authorized for every configured keeper, or enforce the authenticated principal's permitted `params.relayerId` at the trusted proxy. Never derive that principal from request body fields. Route-level IAM alone cannot preserve previous per-keeper isolation on a shared route.

### Simulation fee floor

`eth_gasPrice` can quote a newer block whose fee is lower than the pinned simulation
block's base fee. Default pricing uses the greater of the oracle quote and the
snapshot base fee, still subject to operator, strategy, relayer and GasVault caps.
This changes the price per gas, not the gas limit, and adds no gas buffer. A pinned
explicit price below that floor is rejected. A base-fee increase between estimation
and the fresh submission snapshot returns `FEE_BELOW_BASE_FEE` before enqueue; it
never changes the accepted transaction's pricing silently or retries submission.

`GAS_LIMIT_CAP_EXCEEDED` includes the guarded estimate, required limit with the
configured plugin margin and enforced ceiling. Do not remove caps or margins just
to turn validation green; evaluate the action and operator policy first.
