# Steer action gas plugin

An opt-in plugin for `executeAction(address,uint256,bytes[],uint256[],bytes32)`.
It estimates gas only when the action completes, then submits the original
transaction through the normal relayer queue. No deployed contract changes,
keeper licenses, balances, votes, or storage overrides are required.

## Flow

1. The processor calls the plugin with `{ "data": "0x...", "mode": "estimate" }`
   or `{ "data": "0x...", "mode": "submit" }`.
2. The plugin obtains the keeper address from the configured relayer and pins a
   block. It checks chain ID, proxy runtime hash and implementation runtime hash.
3. For simulation only, it replaces proxy code with `ActionSimulationGuard` and
   places the original proxy runtime at an unused code-copy address. The guard
   delegates to that runtime, retaining proxy storage, `msg.sender`, `tx.origin`,
   implementation routing and internal self-calls. Only `executeAction` results
   are asserted: the exact 32-byte return must equal `COMPLETED` (1).
4. It establishes successful execution at the gas ceiling, estimates the guarded
   path, verifies that estimate, adds a configured margin and checks the original
   transaction with **no overrides**. Errors stop the request; no ordinary
   estimator fallback or unbounded gas growth is used.
5. Submit mode repeats the unmodified check against a fresh block and enqueues
   once, using explicit `gas_limit`, the checked initial legacy `gas_price`, and
   a short `valid_until`. It returns the relayer transaction ID without waiting
   for mining. The normal relayer signs, broadcasts and tracks the transaction.

The caller supplies only calldata and an explicit mode. Relayer identity,
Orchestrator, hashes and caps come from trusted deployment configuration.
Calldata must match the inspected ABI, use canonical encoding and fit 64 KiB.
The guard source and reproducible runtime are included. Never install this guard
as a live proxy implementation or deploy it as an execution wrapper.

## Register and call

Requires Node 22.14+ and an RPC supporting archive state and **code overrides on
both `eth_call` and `eth_estimateGas`**. Validate the actual provider first.

Install this directory as `/app/plugins/steer-action-plugin` in the relayer image
or mount it there. Install its runtime dependencies with
`npm ci --omit=dev --ignore-scripts` inside that directory. Merge the plugin entry
from `config.fragment.json` into the existing relayer configuration. The fragment
is deliberately invalid until its identity and code hashes are filled in.
Resolve hashes from the intended deployment, verify them independently and repeat
that review after an upgrade. The example caps and 10% margin are experimental
settings, not recommended values for every vault.

Keep the plugin timeout at 120 seconds or more. Validation has a shared 30-second
read deadline; timed-out reads cannot later continue into transaction submission.
Use authenticated POST only:

```http
POST /api/v1/plugins/steer-action-gas/call
Content-Type: application/json
Authorization: Bearer <existing relayer API credential>

{"params":{"mode":"submit","data":"0x<encoded executeAction>"}}
```

The HTTP API returns its usual response envelope. Its `data` contains
`transactionId`, the gas report, and the final submission snapshot. Estimate mode
returns the report without enqueueing. Configure the endpoint only for callers
already authorized to exercise that keeper. This plugin does not replace keeper
votes or processor authorization.

For the processor, change its Orchestrator action submission path in
`relayer-transaction-manager.ts` from the generic transaction endpoint to this
plugin endpoint. Keep the existing resolved node/relayer mapping; use a separate
plugin configuration per keeper. Add the endpoint to the API Gateway proxy and
IAM allowlist. Track the returned transaction ID through the existing relayer
transaction/receipt APIs, and require the matching Orchestrator `ActionExecuted`
event and action hash before recording action success. Other transaction kinds
retain their current endpoint. This PR does not modify or deploy the processor
or gateway infrastructure.

## Validation

From this directory, with Anvil installed:

```sh
npm ci --ignore-scripts
npm run validate
```

For the runtime integration test, install the repository's existing plugin
runtime dependencies first: `pnpm --dir ../../plugins install --frozen-lockfile
--ignore-scripts`. `npm run validate` checks reproducible Solidity bytecode,
TypeScript, formatting, failure/cap/reorg cases, actual Anvil execution, and the repository's
real compiler and pooled executor over its socket protocol. Only the isolated
Anvil test signs/sends a local transaction. Its fixture models the inspected
contract boundaries; it is not a copy of the production contracts.

Read-only historical validation against deployed bytecode:

```sh
RPC_URL=<archive RPC> npm run validate:live -- \
  --tx-hash 0xb50977e00631abc7abb39157cf52b8d8f0b634868458931c311c9bfdfd876289 \
  --max-gas 1000000
```

The script has a read-only RPC allowlist, no wallet and no submission API. It uses
block N-1 and original legacy gas price, verifies the block hash, and prints a
small report without RPC URLs or calldata. Hash discovery here is research only;
production requires trusted configured hashes. Historical results are saved in
`validation-results.json`.

## Limits

- A successful simulation is not a guarantee at mining time. Pending transactions,
  state changes, queue delay and replacement fees remain relevant. The plugin is
  an explicit entry point, not a signing or replacement lifecycle hook.
- Configure the relayer's own `gas_price_cap` consistently with vault limits.
  Replacements can change fees; this plugin does not revalidate replacements.
  Inner GasVault allowances and funding limits are unchanged.
- The guard adds delegate calls and changes code visibility/access warming. Its
  estimate is a candidate, checked against the original execution path. The
  margin needs validation across representative actions, not one transaction.
- `PENDING` can have causes besides insufficient gas. Persistent failure at the
  configured ceiling stops submission rather than increasing gas indefinitely.
- `_executeAction` discards target revert bytes. This guard does not recover
  erased errors; call tracing is still needed for detailed failure diagnosis.
- No durable action idempotency is implemented here. If enqueue times out, its
  outcome is unknown. Reconcile with the existing transaction/action records
  before retrying; the plugin never automatically resubmits.
- Historical N-1 simulations exclude earlier transactions in the mined block.
  Saved results prove this pinned snapshot, not an exact transaction-index replay,
  future execution, or production processor integration.

The existing `plugins` regression suite was also checked at base commit
`2255fb47ae925cd0e00c4de6bda6822ebb876a1f`: all 173 assertions pass, then a
pre-existing dangling `sendTransaction` socket timeout causes a nonzero exit on
Node 26.7.0. The identical failure was reproduced from an untouched main-branch
snapshot. The new plugin validation exits successfully; existing runtime source
is unchanged by this PR.
