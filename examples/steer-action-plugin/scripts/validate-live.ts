// Read-only historical validation: no wallet, private key or send methods.
import { parseArgs } from "node:util";
import { keccak256, toQuantity } from "ethers";
import {
  ACTION_ABI,
  estimateAction,
  readSnapshot,
  type Rpc,
  type Policy,
} from "../gas";
import { deploymentsFor } from "../metadata";
import { ExecutionReverted, isExecutionFailure } from "../errors";
import guard from "../guard-runtime.json";
const READS = new Set([
  "eth_chainId",
  "eth_getTransactionByHash",
  "eth_getTransactionReceipt",
  "eth_getBlockByNumber",
  "eth_getCode",
  "eth_getStorageAt",
  "eth_getBalance",
  "eth_getTransactionCount",
  "eth_estimateGas",
  "eth_call",
]);
const SLOT =
  "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
async function main() {
  const { values } = parseArgs({
    options: {
      "tx-hash": { type: "string" },
      "max-gas": { type: "string" },
      block: { type: "string" },
      backend: { type: "string", default: "guarded-rpc" },
    },
  });
  if (
    !process.env.RPC_URL ||
    !values["tx-hash"] ||
    !/^0x[0-9a-fA-F]{64}$/.test(values["tx-hash"]) ||
    !values["max-gas"]
  )
    throw new Error("RPC_URL, --tx-hash and --max-gas are required");
  let id = 0;
  const rpc: Rpc = async (method, params) => {
    if (!READS.has(method)) throw new Error("Disallowed RPC method");
    const response = await fetch(process.env.RPC_URL!, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
      signal: AbortSignal.timeout(20000),
    });
    if (!response.ok) throw new Error(`RPC HTTP ${response.status}`);
    const body = (await response.json()) as {
      error?: { code: number; message: string };
      result?: unknown;
    };
    if (body.error && isExecutionFailure(body.error))
      throw new ExecutionReverted();
    if (body.error || !Object.prototype.hasOwnProperty.call(body, "result"))
      throw new Error(
        `RPC ${method} failed (code ${body.error?.code ?? "unknown"})`,
      );
    return body.result;
  };
  const tx = (await rpc("eth_getTransactionByHash", [
    values["tx-hash"],
  ])) as Record<string, string>;
  const receipt = (await rpc("eth_getTransactionReceipt", [
    values["tx-hash"],
  ])) as Record<string, string>;
  if (
    !tx?.blockNumber ||
    !receipt ||
    tx.blockHash !== receipt.blockHash ||
    tx.blockNumber !== receipt.blockNumber
  )
    throw new Error("Matching mined transaction and receipt required");
  if (BigInt(tx.value) !== 0n || (tx.type && BigInt(tx.type) !== 0n))
    throw new Error("Historical validator requires a zero-value legacy action");
  const blockTag = toQuantity(
    values.block === undefined
      ? BigInt(tx.blockNumber) - 1n
      : BigInt(values.block),
  );
  const snapshot = await readSnapshot(rpc, blockTag);
  const proxyCode = (await rpc("eth_getCode", [tx.to, blockTag])) as string;
  const slot = (await rpc("eth_getStorageAt", [
    tx.to,
    SLOT,
    blockTag,
  ])) as string;
  const implementation = "0x" + slot.slice(-40);
  const implCode = (await rpc("eth_getCode", [
    implementation,
    blockTag,
  ])) as string;
  const policy: Policy = {
    relayerId: "read-only-validation",
    chainId: BigInt((await rpc("eth_chainId", [])) as string).toString(),
    profile: {
      id: "historical-diagnostic",
      backend: values.backend as Policy["profile"]["backend"],
      proxyCodeHash: keccak256(proxyCode),
      implementationCodeHash: keccak256(implCode),
    },
    estimateEnabled: true,
    submitEnabled: false,
    deadlineMs: 30000,
    maxGas: Number(values["max-gas"]),
    maxGasPrice: BigInt(tx.gasPrice).toString(),
    marginBps: 1000,
    maxSnapshotAgeSeconds: 60,
  };
  if (deploymentsFor(policy).Orchestrator.toLowerCase() !== tx.to.toLowerCase())
    throw new Error("Transaction destination differs from SDK Orchestrator");
  const transaction = {
    from: tx.from,
    to: tx.to,
    data: tx.input,
    value: "0x0",
    gasPrice: tx.gasPrice,
  };
  async function outcome(gas: string) {
    try {
      const result = await rpc("eth_call", [{ ...transaction, gas }, blockTag]);
      const state = ACTION_ABI.decodeFunctionResult(
        "executeAction",
        result as string,
      )[0];
      return state === 1n
        ? "COMPLETED"
        : state === 0n
          ? "PENDING"
          : "INVALID_STATE";
    } catch {
      return "RPC_ERROR_OR_REVERT";
    }
  }
  const ordinary = (await rpc("eth_estimateGas", [
    { ...transaction, gas: toQuantity(policy.maxGas) },
    blockTag,
  ])) as string;
  const report = await estimateAction(
    rpc,
    policy,
    { data: tx.input, mode: "estimate" },
    tx.from,
    { blockTag, gasPrice: BigInt(tx.gasPrice).toString() },
  );
  console.log(
    JSON.stringify(
      {
        transactionHash: values["tx-hash"],
        transactionIndex: tx.transactionIndex,
        receiptStatus: receipt.status,
        chainId: policy.chainId,
        snapshot,
        proxyCodeHash: policy.profile.proxyCodeHash,
        implementation,
        implementationCodeHash: policy.profile.implementationCodeHash,
        guardRuntimeHash: keccak256(guard.runtime),
        originalGas: Number(BigInt(tx.gas)),
        originalOutcome: await outcome(tx.gas),
        ordinaryEstimate: Number(BigInt(ordinary)),
        ordinaryEstimateOutcome: await outcome(ordinary),
        backend: report.backend,
        metadata: report.metadata,
        guardedEstimate: report.guardedEstimate,
        guardedEstimateDirectOutcome: await outcome(
          toQuantity(report.guardedEstimate),
        ),
        selectedGas: report.gasLimit,
        selectedOutcome: "COMPLETED",
        marginBps: policy.marginBps,
        caveat:
          "Pinned historical simulation, not exact transaction-index replay, future success, or production integration.",
      },
      null,
      2,
    ),
  );
}
main().catch(() => {
  console.error(
    "Read-only validation failed. Check inputs, archive state and state-override RPC support. No transaction was submitted.",
  );
  process.exitCode = 1;
});
