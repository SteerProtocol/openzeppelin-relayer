import { ACTION_ABI, CODE_COPY, type Rpc, type Policy } from "../gas";
export const from = "0x1000000000000000000000000000000000000001";
export const proxy = "0x2000000000000000000000000000000000000002";
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
  orchestrator: proxy,
  proxyCodeHash: keccak256("0x6001"),
  implementationCodeHash: keccak256("0x6002"),
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
    if (method === "eth_estimateGas") return "0x7a120";
    if (method === "eth_call") return completed;
    throw new Error("Unexpected RPC " + method);
  };
  return { rpc, calls };
}
