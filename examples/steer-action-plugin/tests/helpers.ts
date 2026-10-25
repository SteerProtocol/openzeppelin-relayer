import { CORE_ABIS } from "../metadata";
import { ExecutionReverted } from "../errors";
import { ACTION_ABI, CODE_COPY, type Rpc, type Policy } from "../gas";
export const from = "0x1000000000000000000000000000000000000001";
export const proxy = "0x2000000000000000000000000000000000000002";
export const gasVault = "0x5000000000000000000000000000000000000005";
export const vaultRegistry = "0x6000000000000000000000000000000000000006";
export const strategyRegistry = "0x7000000000000000000000000000000000000007";
export const impl = "0x3000000000000000000000000000000000000003";
export const target = "0x4000000000000000000000000000000000000004";
const { keccak256 } = require("ethers") as typeof import("ethers");
export const data = ACTION_ABI.encodeFunctionData("executeAction", [
  target,
  1,
  ["0x1234"],
  [],
  "0x" + "00".repeat(32),
]);
export const policy: Policy = {
  relayerId: "keeper",
  chainId: "42161",
  profile: {
    id: "fixture-v1",
    backend: "guarded-rpc",
    proxyCodeHash: keccak256("0x6001"),
    implementationCodeHash: keccak256("0x6002"),
    deployments: {
      Orchestrator: proxy,
      GasVault: gasVault,
      VaultRegistry: vaultRegistry,
      StrategyRegistry: strategyRegistry,
    },
  },
  estimateEnabled: true,
  submitEnabled: true,
  deadlineMs: 30000,
  maxGas: 1000000,
  maxGasPrice: "30000000",
  marginBps: 1000,
  maxSnapshotAgeSeconds: 60,
};
const completed = "0x" + "0".repeat(63) + "1";
const pending = "0x" + "0".repeat(64);
export function mockRpc(
  change?: (method: string, params: unknown[]) => unknown,
): { rpc: Rpc; calls: { method: string; params: unknown[] }[] } {
  const calls: { method: string; params: unknown[] }[] = [];
  const rpc: Rpc = async (method, params) => {
    calls.push({ method, params });
    const changed = change?.(method, params);
    if (changed !== undefined) return changed;
    if (method === "eth_chainId") return "0xa4b1";
    if (method === "eth_getBlockByNumber")
      return {
        number: "0x10",
        hash: "0x" + "11".repeat(32),
        gasLimit: "0x1c9c380",
        timestamp: "0x" + Math.floor(Date.now() / 1000).toString(16),
      };
    if (method === "eth_getCode")
      return params[0] === CODE_COPY
        ? "0x"
        : params[0] === proxy
          ? "0x6001"
          : "0x6002";
    if (method === "eth_getStorageAt")
      return "0x" + impl.slice(2).padStart(64, "0");
    if (method === "eth_getBalance" || method === "eth_getTransactionCount")
      return "0x0";
    if (method === "eth_gasPrice") return "0x17d7840";
    if (method === "eth_call" || method === "eth_estimateGas") {
      const tx = params[0] as { to: string; data: string };
      const overrides = params[2] as
        | Record<string, { code: string }>
        | undefined;
      if (overrides?.[proxy]?.code === "0x60006000f3") return "0x";
      if (overrides?.[proxy]?.code === "0x60006000fd")
        throw new ExecutionReverted();
      if (method === "eth_estimateGas") return "0x7a120";
      if (
        tx.to === proxy &&
        tx.data.startsWith(ACTION_ABI.getFunction("executeAction")!.selector)
      )
        return completed;
      const name =
        tx.to === proxy
          ? "Orchestrator"
          : tx.to === gasVault
            ? "GasVault"
            : tx.to === vaultRegistry
              ? "VaultRegistry"
              : "StrategyRegistry";
      const abi = CORE_ABIS[name];
      const decoded = abi.parseTransaction({ data: tx.data })!;
      const values: Record<string, unknown[]> = {
        gasVault: [gasVault],
        orchestrator: [proxy],
        vaultRegistry: [vaultRegistry],
        strategyRegistry: [strategyRegistry],
        getVaultDetails: [[3, 1, 1, "ipfs", target, "fixture"]],
        getRegisteredStrategy: [[1, "fixture", from, "ipfs", 30000000, 500000]],
        ethBalances: [1000000000000000000n],
        gasAvailableForTransaction: [500000],
      };
      return abi.encodeFunctionResult(decoded.name, values[decoded.name]);
    }
    throw new Error("Unexpected RPC " + method);
  };
  return { rpc, calls };
}
