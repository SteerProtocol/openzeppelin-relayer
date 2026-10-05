import { parseRequest, resolvePolicy } from "./config";
import {
  ActionError,
  ExecutionReverted,
  isExecutionFailure,
  withinDeadline,
} from "./errors";
import type { PluginContext, Relayer } from "@openzeppelin/relayer-sdk";
import {
  estimateAction,
  parseAction,
  readSnapshot,
  requireFresh,
  verifyBeforeSubmission,
  type Rpc,
} from "./gas";

export { withinDeadline } from "./errors";

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
      if (response.error && isExecutionFailure(response.error))
        throw new ExecutionReverted();
      // Avoid propagating provider URLs, credentials or full calldata in errors.
      throw new ActionError(
        "RPC_UNAVAILABLE",
        `Relayer RPC failed for ${method} (code ${response.error?.code ?? "unknown"})`,
      );
    }
    return response.result;
  };
}

/** Explicit endpoint, not a relayer lifecycle hook. POST only, fail closed. */
export async function handler(context: PluginContext) {
  if (context.method !== "POST") throw new Error("Only POST is accepted");
  const request = parseRequest(context.params);
  const policy = resolvePolicy(context.config, request.relayerId);
  const action = parseAction(request.action);
  const relayer = context.api.useRelayer(policy.relayerId);
  // Finish validation before the configured 120-second runner timeout. A timed
  // out read cannot later continue into an enqueue operation.
  const deadline = Date.now() + policy.deadlineMs;
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
  const feeCap =
    info.policies && "gas_price_cap" in info.policies
      ? (info.policies.gas_price_cap ?? undefined)
      : undefined;
  if (feeCap !== undefined && (!Number.isSafeInteger(feeCap) || feeCap < 0))
    throw new Error("Relayer fee cap exceeds SDK numeric precision");
  const report = await estimateAction(rpc, policy, action, info.address, {
    relayerFeeCap: feeCap === undefined ? undefined : String(feeCap),
  });
  requireFresh(report.snapshot, policy);
  if (action.mode === "estimate") return { mode: "estimate", report };
  const { snapshot: submissionSnapshot, feeCeilingWei } =
    await verifyBeforeSubmission(rpc, policy, report);
  // A single enqueue attempt. An ambiguous timeout must be reconciled by the
  // processor, never retried automatically here. No wait() inside the plugin.
  if (Date.now() >= deadline)
    throw new Error("Action validation deadline exceeded");
  // SDK 1.10 predates this server extension; a typed variable preserves the
  // decimal string without changing the SDK's transport or numeric fee fields.
  const transactionRequest = {
    to: report.transaction.to,
    data: report.transaction.data,
    value: 0,
    gas_limit: report.gasLimit,
    gas_price: Number(report.gasPrice),
    fee_ceiling_wei: feeCeilingWei,
    valid_until: new Date(
      Date.now() + policy.maxSnapshotAgeSeconds * 1000,
    ).toISOString(),
  };
  const submitted = await relayer.sendTransaction(transactionRequest);
  if (
    (submitted as unknown as { fee_ceiling_wei?: string }).fee_ceiling_wei !==
    feeCeilingWei
  )
    throw new Error(
      "Relayer did not acknowledge stored fee ceiling; reconcile accepted transaction before retrying",
    );
  return {
    feeCeilingWei,
    mode: "submit",
    transactionId: submitted.id,
    relayerId: policy.relayerId,
    report,
    submissionSnapshot,
  };
}
