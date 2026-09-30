import type { PluginContext, Relayer } from "@openzeppelin/relayer-sdk";
import {
  estimateAction,
  parseAction,
  parsePolicy,
  readSnapshot,
  requireFresh,
  verifyBeforeSubmission,
  type Rpc,
} from "./gas";

export async function withinDeadline<T>(
  operation: () => Promise<T>,
  deadline: number,
): Promise<T> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error("Action validation deadline exceeded");
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Action validation deadline exceeded")),
          remaining,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function relayerRpc(
  relayer: Pick<Relayer, "rpc">,
  deadline = Date.now() + 30000,
): Rpc {
  let id = 0;
  return async (method, params) => {
    const response = await withinDeadline(
      () => relayer.rpc({ jsonrpc: "2.0", id: ++id, method, params }),
      deadline,
    );
    if (
      response.error ||
      !Object.prototype.hasOwnProperty.call(response, "result")
    ) {
      // Avoid propagating provider URLs, credentials or full calldata in errors.
      throw new Error(
        `Relayer RPC failed for ${method} (code ${response.error?.code ?? "unknown"})`,
      );
    }
    return response.result;
  };
}

/** Explicit endpoint, not a relayer lifecycle hook. POST only, fail closed. */
export async function handler(context: PluginContext) {
  if (context.method !== "POST") throw new Error("Only POST is accepted");
  const policy = parsePolicy(context.config);
  const action = parseAction(context.params);
  const relayer = context.api.useRelayer(policy.relayerId);
  // Finish validation before the configured 120-second runner timeout. A timed
  // out read cannot later continue into an enqueue operation.
  const deadline = Date.now() + 30000;
  const info = await withinDeadline(() => relayer.getRelayer(), deadline);
  if (
    info.id !== policy.relayerId ||
    info.network_type !== "evm" ||
    !info.address ||
    info.paused ||
    info.system_disabled
  )
    throw new Error("Configured EVM relayer is unavailable");
  const rpc = relayerRpc(relayer, deadline);
  requireFresh(await readSnapshot(rpc), policy);
  const report = await estimateAction(rpc, policy, action, info.address);
  requireFresh(report.snapshot, policy);
  if (action.mode === "estimate") return { mode: "estimate", report };
  const submissionSnapshot = await verifyBeforeSubmission(rpc, policy, report);
  // A single enqueue attempt. An ambiguous timeout must be reconciled by the
  // processor, never retried automatically here. No wait() inside the plugin.
  if (Date.now() >= deadline)
    throw new Error("Action validation deadline exceeded");
  const submitted = await relayer.sendTransaction({
    to: report.transaction.to,
    data: report.transaction.data,
    value: 0,
    gas_limit: report.gasLimit,
    gas_price: Number(report.gasPrice),
    valid_until: new Date(
      Date.now() + policy.maxSnapshotAgeSeconds * 1000,
    ).toISOString(),
  });
  return {
    mode: "submit",
    transactionId: submitted.id,
    report,
    submissionSnapshot,
  };
}
