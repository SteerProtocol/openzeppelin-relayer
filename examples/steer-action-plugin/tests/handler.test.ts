import assert from "node:assert/strict";
import { test } from "node:test";
import type { PluginContext } from "@openzeppelin/relayer-sdk";
import { handler, relayerRpc, withinDeadline } from "../index";
import { data, mockRpc, policy } from "./helpers";

function context(
  mode = "estimate",
  mutate?: (method: string, params: unknown[]) => unknown,
) {
  const { rpc, calls } = mockRpc(mutate);
  const sent: unknown[] = [];
  const relayer = {
    getRelayer: async () => ({
      id: "keeper",
      network_type: "evm",
      address: "0x1000000000000000000000000000000000000001",
      paused: false,
    }),
    rpc: async (p: { method: string; params: unknown[] }) => ({
      jsonrpc: "2.0",
      result: await rpc(p.method, p.params),
    }),
    sendTransaction: async (p: unknown) => {
      sent.push(p);
      return { id: "tx-123" };
    },
  };
  const ctx = {
    method: "POST",
    config: policy,
    params: { data, mode },
    api: {
      useRelayer: (id: string) => {
        assert.equal(id, "keeper");
        return relayer;
      },
    },
  } as unknown as PluginContext;
  return { ctx, sent, calls, relayer };
}
test("estimate mode never queues a transaction", async () => {
  const { ctx, sent } = context();
  const result = await handler(ctx);
  assert.equal(result.mode, "estimate");
  assert.equal(sent.length, 0);
});
test("submit queues original payload once with checked gas and initial fee", async () => {
  const { ctx, sent, calls } = context("submit");
  const result = await handler(ctx);
  assert.equal(result.transactionId, "tx-123");
  const request = sent[0] as Record<string, unknown>;
  assert.ok(Date.parse(request.valid_until as string) > Date.now());
  const { valid_until, ...fields } = request;
  assert.deepEqual(fields, {
    to: policy.orchestrator,
    data,
    value: 0,
    gas_limit: 550000,
    gas_price: 25000000,
  });
  assert.equal(sent.length, 1);
  assert.equal(
    calls.filter((c) => c.method === "eth_call").at(-1)!.params.length,
    2,
  );
});
test("invalid method, config, input, identity and failed preflight never enqueue", async () => {
  for (const patch of [
    { method: "GET" },
    { config: {} },
    { params: { data, mode: "submit", relayerId: "attacker" } },
  ]) {
    const { ctx, sent } = context("submit");
    Object.assign(ctx, patch);
    await assert.rejects(handler(ctx));
    assert.equal(sent.length, 0);
  }
  const { ctx, sent } = context("submit", (m) =>
    m === "eth_call" ? "0x" + "0".repeat(64) : undefined,
  );
  await assert.rejects(handler(ctx));
  assert.equal(sent.length, 0);
  const inactive = context("submit");
  inactive.relayer.getRelayer = async () => ({
    id: "wrong",
    network_type: "evm",
    address: "0x1000000000000000000000000000000000000001",
    paused: false,
  });
  await assert.rejects(handler(inactive.ctx));
  assert.equal(inactive.sent.length, 0);
});
test("ambiguous enqueue failure is not retried", async () => {
  const c = context("submit");
  let attempts = 0;
  c.relayer.sendTransaction = async () => {
    attempts++;
    throw new Error("timeout");
  };
  await assert.rejects(handler(c.ctx), /timeout/);
  assert.equal(attempts, 1);
});
test("RPC adapter unwraps raw result and redacts provider errors", async () => {
  const rpc = relayerRpc({
    rpc: async () => ({
      jsonrpc: "2.0",
      error: {
        code: -32000,
        message: "private-url",
        description: "private-url",
      },
    }),
  });
  await assert.rejects(
    rpc("eth_call", []),
    (e) => e instanceof Error && !e.message.includes("private-url"),
  );
});

test("validation deadline rejects hung reads and prevents later continuation", async () => {
  let continued = false;
  await assert.rejects(
    (async () => {
      await withinDeadline(
        () => new Promise((resolve) => setTimeout(resolve, 40)),
        Date.now() + 5,
      );
      continued = true;
    })(),
    /deadline/,
  );
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(continued, false);
  await assert.rejects(
    withinDeadline(async () => 1, Date.now() - 1),
    /deadline/,
  );
});
