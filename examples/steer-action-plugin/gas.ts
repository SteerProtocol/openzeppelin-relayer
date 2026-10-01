import { getAddress, keccak256, toQuantity } from "ethers";
import guard from "./guard-runtime.json";

export type Rpc = (method: string, params: unknown[]) => Promise<unknown>;
export { ACTION_ABI } from "./metadata";
import {
  ACTION_ABI,
  deploymentsFor,
  readActionMetadata,
  SDK_VERSION,
  type Deployments,
  type ActionMetadata,
} from "./metadata";
import { ActionError, ExecutionReverted, withinDeadline } from "./errors";
export const CODE_COPY = "0x00000000000000000000000000000000Ac710001";
const IMPLEMENTATION_SLOT =
  "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";

export interface CompatibilityProfile {
  id: string;
  backend: "guarded-rpc" | "native-call-search";
  proxyCodeHash: string;
  implementationCodeHash: string;
  // Reviewed alternate deployments only; callers cannot provide these.
  deployments?: Partial<Deployments>;
}
export interface Policy {
  relayerId: string;
  chainId: string;
  profile: CompatibilityProfile;
  estimateEnabled: boolean;
  submitEnabled: boolean;
  deadlineMs: number;
  maxGas: number;
  maxGasPrice: string;
  marginBps: number;
  maxSnapshotAgeSeconds: number;
}
export interface Action {
  data: string;
  mode: "estimate" | "submit";
}
export interface Snapshot {
  number: string;
  hash: string;
  gasLimit: string;
  timestamp: string;
}
export interface Transaction {
  from: string;
  to: string;
  data: string;
  value: string;
  gasPrice: string;
}
export interface GasReport {
  chainId: string;
  profileId: string;
  backend: CompatibilityProfile["backend"];
  sdkVersion: string;
  metadata: ActionMetadata;
  relayerFeeCap?: string;
  snapshot: Snapshot;
  implementation: string;
  guardedEstimate: number;
  gasLimit: number;
  gasPrice: string;
  transaction: Transaction;
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`Invalid ${name}`);
  return value as Record<string, unknown>;
}
function integer(
  value: unknown,
  name: string,
  min: number,
  max: number,
): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < min ||
    (value as number) > max
  )
    throw new Error(`Invalid ${name}`);
  return value as number;
}
function decimal(value: unknown, name: string): string {
  if (typeof value !== "string" || !/^[1-9][0-9]*$/.test(value))
    throw new Error(`Invalid ${name}: positive decimal string required`);
  return value;
}
function hash(value: unknown, name: string): string {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(value))
    throw new Error(`Invalid ${name}`);
  return value.toLowerCase();
}
function address(value: unknown, name: string): string {
  if (typeof value !== "string") throw new Error(`Invalid ${name}`);
  const result = getAddress(value);
  if (BigInt(result) === 0n || result === CODE_COPY)
    throw new Error(`Reserved ${name}`);
  return result;
}
export function parsePolicy(value: unknown): Policy {
  const p = record(value, "deployment configuration");
  if (typeof p.relayerId !== "string" || !p.relayerId.trim())
    throw new Error("Invalid relayerId");
  const maxGasPrice = decimal(p.maxGasPrice, "maxGasPrice");
  if (BigInt(maxGasPrice) > BigInt(Number.MAX_SAFE_INTEGER))
    throw new Error("maxGasPrice exceeds SDK numeric precision");
  const profile = record(p.profile, "compatibility profile");
  if (typeof profile.id !== "string" || !/^[a-zA-Z0-9_-]+$/.test(profile.id))
    throw new Error("Invalid profile id");
  if (
    profile.backend !== "guarded-rpc" &&
    profile.backend !== "native-call-search"
  )
    throw new Error("Invalid estimation backend");
  for (const flag of ["estimateEnabled", "submitEnabled"])
    if (p[flag] !== undefined && typeof p[flag] !== "boolean")
      throw new Error(`Invalid ${flag}`);
  if (p.submitEnabled && !p.estimateEnabled)
    throw new Error("Submission requires enabled estimation");
  const deployments: Partial<Deployments> = {};
  if (profile.deployments !== undefined) {
    for (const [name, value] of Object.entries(
      record(profile.deployments, "deployment overrides"),
    )) {
      if (
        ![
          "Orchestrator",
          "GasVault",
          "VaultRegistry",
          "StrategyRegistry",
        ].includes(name)
      )
        throw new Error("Unknown deployment override");
      deployments[name as keyof Deployments] = address(value, name);
    }
  }
  return {
    relayerId: p.relayerId,
    chainId: decimal(p.chainId, "chainId"),
    profile: {
      id: profile.id,
      backend: profile.backend,
      proxyCodeHash: hash(profile.proxyCodeHash, "proxyCodeHash"),
      implementationCodeHash: hash(
        profile.implementationCodeHash,
        "implementationCodeHash",
      ),
      ...(Object.keys(deployments).length ? { deployments } : {}),
    },
    estimateEnabled: p.estimateEnabled === true,
    submitEnabled: p.submitEnabled === true,
    deadlineMs: integer(p.deadlineMs ?? 30000, "deadlineMs", 1000, 90000),
    maxGas: integer(p.maxGas, "maxGas", 21000, 100_000_000),
    maxGasPrice,
    marginBps: integer(p.marginBps ?? 1000, "marginBps", 0, 10000),
    maxSnapshotAgeSeconds: integer(
      p.maxSnapshotAgeSeconds ?? 60,
      "maxSnapshotAgeSeconds",
      1,
      300,
    ),
  };
}
export function parseAction(value: unknown): Action {
  const p = record(value, "action");
  if (Object.keys(p).some((k) => k !== "data" && k !== "mode"))
    throw new Error(
      "Only data and mode are accepted; relayer, destination, fees and overrides come from deployment configuration",
    );
  if (p.mode !== "estimate" && p.mode !== "submit")
    throw new Error("mode must be estimate or submit");
  if (
    typeof p.data !== "string" ||
    !/^0x(?:[0-9a-fA-F]{2})+$/.test(p.data) ||
    p.data.length > 131074
  )
    throw new Error("Invalid or oversized calldata (maximum 64 KiB)");
  const decoded = ACTION_ABI.parseTransaction({ data: p.data });
  if (!decoded || decoded.name !== "executeAction")
    throw new Error("Only executeAction is accepted");
  address(decoded.args.targetAddress, "action target");
  // Reject trailing bytes and noncanonical encodings, keeping the checked payload exact.
  if (
    ACTION_ABI.encodeFunctionData(
      "executeAction",
      Array.from(decoded.args),
    ).toLowerCase() !== p.data.toLowerCase()
  )
    throw new Error("Noncanonical executeAction calldata");
  return { data: p.data, mode: p.mode };
}
function quantity(value: unknown, name: string): bigint {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]+$/.test(value))
    throw new Error(`Invalid RPC ${name}`);
  return BigInt(value);
}
export async function readSnapshot(
  rpc: Rpc,
  blockTag = "latest",
): Promise<Snapshot> {
  const b = record(
    await rpc("eth_getBlockByNumber", [blockTag, false]),
    "block",
  );
  return {
    number: toQuantity(quantity(b.number, "block number")),
    hash: hash(b.hash, "block hash"),
    gasLimit: toQuantity(quantity(b.gasLimit, "block gas limit")),
    timestamp: toQuantity(quantity(b.timestamp, "block timestamp")),
  };
}
export function requireFresh(snapshot: Snapshot, policy: Policy): void {
  const age =
    Math.floor(Date.now() / 1000) - Number(BigInt(snapshot.timestamp));
  if (age < -30 || age > policy.maxSnapshotAgeSeconds)
    throw new ActionError(
      "STALE_SNAPSHOT",
      "RPC snapshot is stale or has a future timestamp",
    );
}
async function code(rpc: Rpc, at: string, tag: string): Promise<string> {
  const result = await rpc("eth_getCode", [at, tag]);
  if (typeof result !== "string" || !/^0x(?:[0-9a-fA-F]{2})+$/.test(result))
    throw new Error(`Missing runtime code at ${at}`);
  return result;
}
export async function checkDeployment(
  rpc: Rpc,
  policy: Policy,
  snapshot: Snapshot,
): Promise<{ proxyCode: string; implementation: string }> {
  if (
    quantity(await rpc("eth_chainId", []), "chain ID") !==
    BigInt(policy.chainId)
  )
    throw new ActionError("CHAIN_MISMATCH", "RPC chain ID mismatch");
  const proxyCode = await code(
    rpc,
    deploymentsFor(policy).Orchestrator,
    snapshot.number,
  );
  if (keccak256(proxyCode) !== policy.profile.proxyCodeHash)
    throw new ActionError(
      "DEPLOYMENT_CHANGED",
      "Proxy runtime code hash mismatch",
    );
  const slot = await rpc("eth_getStorageAt", [
    deploymentsFor(policy).Orchestrator,
    IMPLEMENTATION_SLOT,
    snapshot.number,
  ]);
  if (typeof slot !== "string" || !/^0x0{24}[0-9a-fA-F]{40}$/.test(slot))
    throw new Error("Invalid EIP-1967 implementation slot");
  const implementation = address("0x" + slot.slice(-40), "implementation");
  if (implementation === deploymentsFor(policy).Orchestrator)
    throw new Error("Implementation cannot equal proxy");
  if (
    keccak256(await code(rpc, implementation, snapshot.number)) !==
    policy.profile.implementationCodeHash
  )
    throw new ActionError(
      "DEPLOYMENT_CHANGED",
      "Implementation runtime code hash mismatch",
    );
  return { proxyCode, implementation };
}
export function requireCompleted(result: unknown): void {
  if (
    typeof result !== "string" ||
    !/^0x[0-9a-fA-F]{64}$/.test(result) ||
    BigInt(result) !== 1n
  )
    throw new ActionError(
      "ACTION_NOT_COMPLETED",
      "Original transaction did not return COMPLETED",
    );
}
async function checkCanonical(rpc: Rpc, snapshot: Snapshot): Promise<void> {
  if ((await readSnapshot(rpc, snapshot.number)).hash !== snapshot.hash)
    throw new ActionError(
      "SNAPSHOT_CHANGED",
      "Snapshot block changed during validation",
    );
}
export async function estimateAction(
  rpc: Rpc,
  policy: Policy,
  action: Action,
  sender: string,
  options: {
    blockTag?: string;
    gasPrice?: string;
    relayerFeeCap?: string;
  } = {},
): Promise<GasReport> {
  // Revalidate even when called directly by the read-only validation script.
  policy = parsePolicy(policy);
  action = parseAction(action);
  const upstream = rpc;
  const deadline = Date.now() + policy.deadlineMs;
  rpc = (method, params) =>
    withinDeadline(() => upstream(method, params), deadline);
  if (
    !policy.estimateEnabled ||
    (action.mode === "submit" && !policy.submitEnabled)
  )
    throw new ActionError(
      "CHAIN_DISABLED",
      "Requested action mode is disabled for this profile",
    );
  const from = address(sender, "keeper");
  if (from === deploymentsFor(policy).Orchestrator)
    throw new Error("Keeper cannot equal Orchestrator");
  const snapshot = await readSnapshot(rpc, options.blockTag);
  if (options.blockTag === undefined) requireFresh(snapshot, policy);
  const { proxyCode, implementation } = await checkDeployment(
    rpc,
    policy,
    snapshot,
  );
  if (from === implementation)
    throw new Error("Keeper cannot equal implementation");
  const copyCode = await rpc("eth_getCode", [CODE_COPY, snapshot.number]);
  if (
    copyCode !== "0x" ||
    quantity(
      await rpc("eth_getTransactionCount", [CODE_COPY, snapshot.number]),
      "copy nonce",
    ) !== 0n ||
    quantity(
      await rpc("eth_getBalance", [CODE_COPY, snapshot.number]),
      "copy balance",
    ) !== 0n
  )
    throw new Error("Simulation code-copy address is occupied");
  const gasPrice =
    options.gasPrice === undefined
      ? quantity(await rpc("eth_gasPrice", []), "gas price")
      : BigInt(decimal(options.gasPrice, "gasPrice"));
  if (gasPrice <= 0n || gasPrice > BigInt(policy.maxGasPrice))
    throw new Error("Gas price exceeds configured cap or is zero");
  const ceiling =
    BigInt(policy.maxGas) < BigInt(snapshot.gasLimit)
      ? BigInt(policy.maxGas)
      : BigInt(snapshot.gasLimit);
  const transaction: Transaction = {
    from,
    to: deploymentsFor(policy).Orchestrator,
    data: action.data,
    value: "0x0",
    gasPrice: toQuantity(gasPrice),
  };
  const metadata = await readActionMetadata(
    rpc,
    policy,
    snapshot,
    transaction,
    options.relayerFeeCap,
  );
  const overrides = {
    [deploymentsFor(policy).Orchestrator]: { code: guard.runtime },
    [CODE_COPY]: { code: proxyCode },
  };
  const bounded = { ...transaction, gas: toQuantity(ceiling) };
  // A successful action alone cannot prove an endpoint honored code overrides.
  // Force an empty return, then require estimation to respect a forced revert.
  const empty = await rpc("eth_call", [
    bounded,
    snapshot.number,
    { [transaction.to]: { code: "0x60006000f3" } },
  ]);
  if (empty !== "0x")
    throw new ActionError(
      "UNSUPPORTED_OVERRIDES",
      "RPC ignored eth_call code override",
    );
  if (policy.profile.backend === "guarded-rpc") {
    try {
      await rpc("eth_estimateGas", [
        bounded,
        snapshot.number,
        { [transaction.to]: { code: "0x60006000fd" } },
      ]);
    } catch (error) {
      if (!(error instanceof ExecutionReverted)) throw error;
      // Only a proven execution revert demonstrates this capability.
      return finish(await guardedEstimate());
    }
    throw new ActionError(
      "UNSUPPORTED_OVERRIDES",
      "RPC ignored eth_estimateGas code override",
    );
  }
  return finish(await searchEstimate());

  async function guardedEstimate(): Promise<bigint> {
    requireCompleted(
      await rpc("eth_call", [bounded, snapshot.number, overrides]),
    );
    return quantity(
      await rpc("eth_estimateGas", [bounded, snapshot.number, overrides]),
      "gas estimate",
    );
  }
  async function searchEstimate(): Promise<bigint> {
    requireCompleted(
      await rpc("eth_call", [bounded, snapshot.number, overrides]),
    );
    let low = 20999n;
    let high = ceiling;
    for (let probe = 0; high - low > 1000n && probe < 20; probe++) {
      const gas = (low + high) / 2n;
      try {
        requireCompleted(
          await rpc("eth_call", [
            { ...transaction, gas: toQuantity(gas) },
            snapshot.number,
            overrides,
          ]),
        );
        high = gas;
      } catch (error) {
        if (!(error instanceof ExecutionReverted)) throw error;
        low = gas;
      }
    }
    if (high - low > 1000n)
      throw new ActionError(
        "SEARCH_LIMIT",
        "Native gas search exceeded probe budget",
      );
    return high;
  }
  async function finish(estimate: bigint): Promise<GasReport> {
    const gas = (estimate * BigInt(10000 + policy.marginBps) + 9999n) / 10000n;
    if (estimate < 21000n || gas > ceiling)
      throw new Error(
        "Guarded estimate plus margin exceeds configured/block gas cap",
      );
    requireCompleted(
      await rpc("eth_call", [
        { ...transaction, gas: toQuantity(estimate) },
        snapshot.number,
        overrides,
      ]),
    );
    requireCompleted(
      await rpc("eth_call", [
        { ...transaction, gas: toQuantity(gas) },
        snapshot.number,
      ]),
    );
    await checkCanonical(rpc, snapshot);
    return {
      chainId: policy.chainId,
      profileId: policy.profile.id,
      backend: policy.profile.backend,
      sdkVersion: SDK_VERSION,
      metadata,
      relayerFeeCap: options.relayerFeeCap,
      snapshot,
      implementation,
      guardedEstimate: Number(estimate),
      gasLimit: Number(gas),
      gasPrice: gasPrice.toString(),
      transaction,
    };
  }
}
export async function verifyBeforeSubmission(
  rpc: Rpc,
  policy: Policy,
  report: GasReport,
): Promise<Snapshot> {
  policy = parsePolicy(policy);
  if (!policy.submitEnabled)
    throw new ActionError("CHAIN_DISABLED", "Submission is disabled");
  requireFresh(report.snapshot, policy);
  await checkCanonical(rpc, report.snapshot);
  const snapshot = await readSnapshot(rpc);
  requireFresh(snapshot, policy);
  await checkDeployment(rpc, policy, snapshot);
  await readActionMetadata(
    rpc,
    policy,
    snapshot,
    report.transaction,
    report.relayerFeeCap,
  );
  if (BigInt(report.gasLimit) > BigInt(snapshot.gasLimit))
    throw new ActionError(
      "POLICY_VIOLATION",
      "Gas limit exceeds current block cap",
    );
  requireCompleted(
    await rpc("eth_call", [
      { ...report.transaction, gas: toQuantity(report.gasLimit) },
      snapshot.number,
    ]),
  );
  await checkCanonical(rpc, snapshot);
  requireFresh(snapshot, policy);
  return snapshot;
}
