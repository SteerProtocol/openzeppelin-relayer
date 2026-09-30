import { Interface, getAddress, keccak256, toQuantity } from "ethers";
import guard from "./guard-runtime.json";

export type Rpc = (method: string, params: unknown[]) => Promise<unknown>;
export const ACTION_ABI = new Interface([
  "function executeAction(address targetAddress,uint256 jobEpoch,bytes[] calldatas,uint256[] timeIndependentLengths,bytes32 jobHash) returns (uint8)",
]);
export const CODE_COPY = "0x00000000000000000000000000000000Ac710001";
const IMPLEMENTATION_SLOT =
  "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";

export interface Policy {
  relayerId: string;
  chainId: string;
  orchestrator: string;
  proxyCodeHash: string;
  implementationCodeHash: string;
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
  return {
    relayerId: p.relayerId,
    chainId: decimal(p.chainId, "chainId"),
    orchestrator: address(p.orchestrator, "orchestrator"),
    proxyCodeHash: hash(p.proxyCodeHash, "proxyCodeHash"),
    implementationCodeHash: hash(
      p.implementationCodeHash,
      "implementationCodeHash",
    ),
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
  if (getAddress(decoded.args.targetAddress) === CODE_COPY)
    throw new Error("Reserved action target");
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
    throw new Error("RPC snapshot is stale or has a future timestamp");
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
    throw new Error("RPC chain ID mismatch");
  const proxyCode = await code(rpc, policy.orchestrator, snapshot.number);
  if (keccak256(proxyCode) !== policy.proxyCodeHash)
    throw new Error("Proxy runtime code hash mismatch");
  const slot = await rpc("eth_getStorageAt", [
    policy.orchestrator,
    IMPLEMENTATION_SLOT,
    snapshot.number,
  ]);
  if (typeof slot !== "string" || !/^0x0{24}[0-9a-fA-F]{40}$/.test(slot))
    throw new Error("Invalid EIP-1967 implementation slot");
  const implementation = address("0x" + slot.slice(-40), "implementation");
  if (implementation === policy.orchestrator)
    throw new Error("Implementation cannot equal proxy");
  if (
    keccak256(await code(rpc, implementation, snapshot.number)) !==
    policy.implementationCodeHash
  )
    throw new Error("Implementation runtime code hash mismatch");
  return { proxyCode, implementation };
}
export function requireCompleted(result: unknown): void {
  if (
    typeof result !== "string" ||
    !/^0x[0-9a-fA-F]{64}$/.test(result) ||
    BigInt(result) !== 1n
  )
    throw new Error("Original transaction did not return COMPLETED");
}
async function checkCanonical(rpc: Rpc, snapshot: Snapshot): Promise<void> {
  if ((await readSnapshot(rpc, snapshot.number)).hash !== snapshot.hash)
    throw new Error("Snapshot block changed during validation");
}
export async function estimateAction(
  rpc: Rpc,
  policy: Policy,
  action: Action,
  sender: string,
  options: { blockTag?: string; gasPrice?: string } = {},
): Promise<GasReport> {
  // Revalidate even when called directly by the read-only validation script.
  policy = parsePolicy(policy);
  action = parseAction(action);
  const from = address(sender, "keeper");
  if (from === policy.orchestrator)
    throw new Error("Keeper cannot equal Orchestrator");
  const snapshot = await readSnapshot(rpc, options.blockTag);
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
    to: policy.orchestrator,
    data: action.data,
    value: "0x0",
    gasPrice: toQuantity(gasPrice),
  };
  const overrides = {
    [policy.orchestrator]: { code: guard.runtime },
    [CODE_COPY]: { code: proxyCode },
  };
  const bounded = { ...transaction, gas: toQuantity(ceiling) };
  // Establish a successful upper bound first. Unsupported overrides and permanent
  // action failures stop here; never silently fall back to the ordinary estimator.
  requireCompleted(
    await rpc("eth_call", [bounded, snapshot.number, overrides]),
  );
  const estimate = quantity(
    await rpc("eth_estimateGas", [bounded, snapshot.number, overrides]),
    "gas estimate",
  );
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
    snapshot,
    implementation,
    guardedEstimate: Number(estimate),
    gasLimit: Number(gas),
    gasPrice: gasPrice.toString(),
    transaction,
  };
}
export async function verifyBeforeSubmission(
  rpc: Rpc,
  policy: Policy,
  report: GasReport,
): Promise<Snapshot> {
  const snapshot = await readSnapshot(rpc);
  requireFresh(snapshot, policy);
  await checkDeployment(rpc, policy, snapshot);
  if (BigInt(report.gasLimit) > BigInt(snapshot.gasLimit))
    throw new Error("Gas limit exceeds current block cap");
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
