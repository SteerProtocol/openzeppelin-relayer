import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ACTION_ABI,
  CODE_COPY,
  estimateAction,
  parseAction,
  parsePolicy,
  requireCompleted,
  requireFresh,
  verifyBeforeSubmission,
  type Rpc,
  type Policy,
} from "../gas";

import { from, proxy, impl, target, data, policy, mockRpc } from "./helpers";
const completed = "0x" + "0".repeat(63) + "1";
const pending = "0x" + "0".repeat(64);
test("only canonical action calldata and explicit modes; no caller overrides", () => {
  assert.deepEqual(parseAction({ data, mode: "estimate" }), {
    data,
    mode: "estimate",
  });
  for (const value of [
    { data },
    { data, mode: "submit", from },
    { data, mode: "submit", gas_limit: 1 },
    { data: data + "00", mode: "submit" },
    { data: "0x12345678", mode: "estimate" },
    { data: "0x" + "ff".repeat(65537), mode: "estimate" },
  ])
    assert.throws(() => parseAction(value));
  assert.throws(() =>
    parseAction({
      data: ACTION_ABI.encodeFunctionData("executeAction", [
        CODE_COPY,
        1,
        [],
        [],
        "0x" + "00".repeat(32),
      ]),
      mode: "estimate",
    }),
  );
});
test("zero action target is rejected before discovery", () => {
  assert.throws(
    () =>
      parseAction({
        data: ACTION_ABI.encodeFunctionData("executeAction", [
          "0x" + "00".repeat(20),
          1,
          [],
          [],
          "0x" + "00".repeat(32),
        ]),
        mode: "estimate",
      }),
    /Reserved/,
  );
});
test("configuration rejects missing hashes, unbounded/unsafe caps and reserved identities", () => {
  for (const changed of [
    { maxGas: -1 },
    { maxGas: 1e12 },
    { maxGasPrice: "9007199254740992" },
    { profile: { ...policy.profile, implementationCodeHash: "" } },
    {
      profile: { ...policy.profile, deployments: { Orchestrator: CODE_COPY } },
    },
    { chainId: "0x1" },
    { marginBps: 10001 },
  ])
    assert.throws(() => parsePolicy({ ...policy, ...changed }));
});
test("bounded guard estimate then direct check; no state/storage overrides", async () => {
  const { rpc, calls } = mockRpc();
  const report = await estimateAction(
    rpc,
    policy,
    { data, mode: "estimate" },
    from,
  );
  assert.equal(report.gasLimit, 550000);
  const estimate = calls.filter((c) => c.method === "eth_estimateGas").at(-1)!;
  assert.equal((estimate.params[0] as { from: string }).from, from);
  assert.equal(estimate.params[1], report.snapshot.number);
  assert.deepEqual(
    Object.keys(estimate.params[2] as object).sort(),
    [proxy, CODE_COPY].sort(),
  );
  for (const override of Object.values(
    estimate.params[2] as Record<string, object>,
  ))
    assert.deepEqual(Object.keys(override), ["code"]);
  const lastCall = calls.filter((c) => c.method === "eth_call").at(-1)!;
  assert.equal(lastCall.params.length, 2);
  assert.equal((lastCall.params[0] as { gas: string }).gas, "0x86470");
  assert.equal(
    (lastCall.params[0] as { gasPrice: string }).gasPrice,
    report.transaction.gasPrice,
  );
});
test("PENDING and malformed returns fail closed", () => {
  for (const result of [
    pending,
    "0x",
    completed + "00",
    "0x" + "0".repeat(63) + "2",
    undefined,
  ])
    assert.throws(() => requireCompleted(result));
});
test("ordinary direct PENDING prevents accepting a guarded estimate", async () => {
  const { rpc } = mockRpc((method, params) =>
    method === "eth_call" &&
    params.length === 2 &&
    (params[0] as { data: string }).data === data
      ? pending
      : undefined,
  );
  await assert.rejects(
    estimateAction(rpc, policy, { data, mode: "estimate" }, from),
    /COMPLETED/,
  );
});
test("RPC outages/unsupported overrides do not fall back or retry", async () => {
  const { rpc, calls } = mockRpc((method, params) => {
    if (method === "eth_call" && params.length === 3)
      throw new Error("Unsupported overrides");
  });
  await assert.rejects(
    estimateAction(rpc, policy, { data, mode: "estimate" }, from),
    /Unsupported/,
  );
  assert.equal(calls.filter((c) => c.method === "eth_estimateGas").length, 0);
});
test("wrong chain, code hash, fee, occupied copy and gas cap stop estimation", async () => {
  for (const change of [
    (m: string) => (m === "eth_chainId" ? "0x1" : undefined),
    (m: string, p: unknown[]) =>
      m === "eth_getCode" && p[0] === proxy ? "0x6003" : undefined,
    (m: string, p: unknown[]) =>
      m === "eth_getCode" && p[0] === impl ? "0x6003" : undefined,
    (m: string) => (m === "eth_gasPrice" ? "0xfffffff" : undefined),
    (m: string, p: unknown[]) =>
      m === "eth_getCode" && p[0] === CODE_COPY ? "0x6003" : undefined,
    (m: string) => (m === "eth_estimateGas" ? "0xf4240" : undefined),
  ])
    await assert.rejects(
      estimateAction(
        mockRpc(change).rpc,
        policy,
        { data, mode: "estimate" },
        from,
      ),
    );
});
test("reorg during validation stops acceptance", async () => {
  let count = 0;
  const { rpc } = mockRpc((m) => {
    if (m === "eth_getBlockByNumber" && ++count === 2)
      return {
        number: "0x10",
        hash: "0x" + "22".repeat(32),
        gasLimit: "0xffffff",
        timestamp: "0x1",
      };
  });
  await assert.rejects(
    estimateAction(rpc, policy, { data, mode: "estimate" }, from),
    /changed/,
  );
});
test("fresh unmodified pre-submission call checks new snapshot and deployment", async () => {
  const { rpc, calls } = mockRpc();
  const report = await estimateAction(
    rpc,
    policy,
    { data, mode: "estimate" },
    from,
  );
  await verifyBeforeSubmission(rpc, policy, report);
  assert.equal(
    calls.filter((c) => c.method === "eth_call").at(-1)!.params.length,
    2,
  );
  const changed = mockRpc((m, p) =>
    m === "eth_call" && (p[0] as { data: string }).data === data
      ? pending
      : undefined,
  );
  await assert.rejects(
    verifyBeforeSubmission(changed.rpc, policy, report),
    /COMPLETED/,
  );
});
test("stale snapshots are rejected", () => {
  assert.throws(
    () =>
      requireFresh(
        {
          number: "0x1",
          hash: "0x" + "11".repeat(32),
          gasLimit: "0xffffff",
          timestamp: "0x1",
        },
        policy,
      ),
    /stale/,
  );
});

test("oversized provider estimate never causes an over-cap simulation", async () => {
  const { rpc, calls } = mockRpc((method, params) =>
    method === "eth_estimateGas" &&
    (params[2] as Record<string, { code: string }>)[proxy].code !==
      "0x60006000fd"
      ? "0xffffffff"
      : undefined,
  );
  await assert.rejects(
    estimateAction(rpc, policy, { data, mode: "estimate" }, from),
    /cap/,
  );
  for (const call of calls.filter(
    (call) => call.method === "eth_call" && "gas" in (call.params[0] as object),
  )) {
    assert.ok(
      BigInt((call.params[0] as { gas: string }).gas) <= BigInt(policy.maxGas),
    );
  }
});

test("oracle quote below the snapshot base fee uses the base fee without a gas buffer", async () => {
  const base = mockRpc();
  const calls: { method: string; params: unknown[] }[] = [];
  const rpc: Rpc = async (method, params) => {
    calls.push({ method, params });
    const value = await base.rpc(method, params);
    if (method === "eth_getBlockByNumber")
      return { ...(value as object), baseFeePerGas: "0x1338e60" }; // 20,156,000 wei
    if (method === "eth_gasPrice") return "0x1312d00"; // 20,000,000 wei
    return value;
  };
  const report = await estimateAction(
    rpc,
    policy,
    { data, mode: "estimate" },
    from,
  );
  assert.equal(report.gasPrice, String(BigInt("0x1338e60")));
  assert.equal(report.gasLimit, 550000);
  for (const call of calls.filter((c) => c.method === "eth_call")) {
    const tx = call.params[0] as { gasPrice?: string };
    if (tx.gasPrice) assert.ok(BigInt(tx.gasPrice) >= BigInt("0x1338e60"));
  }
});

test("a rising base fee rejects stale submission pricing before simulation or enqueue", async () => {
  const report = await estimateAction(
    mockRpc().rpc,
    policy,
    { data, mode: "estimate" },
    from,
  );
  const base = mockRpc();
  let pricedCalls = 0;
  const rpc: Rpc = async (method, params) => {
    if (method === "eth_call" && (params[0] as { gasPrice?: string }).gasPrice)
      pricedCalls++;
    const value = await base.rpc(method, params);
    if (method === "eth_getBlockByNumber")
      return { ...(value as object), baseFeePerGas: "0x1c9c380" }; // 30,000,000 > selected 25,000,000
    return value;
  };
  await assert.rejects(
    verifyBeforeSubmission(rpc, policy, report),
    /FEE_BELOW_BASE_FEE/,
  );
  assert.equal(pricedCalls, 0);
});

test("over-cap guarded gas errors retain the required estimate and limit", async () => {
  const { rpc } = mockRpc((method, params) => {
    const overrides = params[2] as Record<string, { code: string }> | undefined;
    if (
      method === "eth_estimateGas" &&
      overrides?.[proxy]?.code !== "0x60006000fd"
    )
      return "0x" + (968602).toString(16);
    return undefined;
  });
  await assert.rejects(
    estimateAction(rpc, policy, { data, mode: "estimate" }, from),
    /GAS_LIMIT_CAP_EXCEEDED.*968602.*1065463.*1000000/,
  );
});

test("fresh strategy allowance changes invalidate an estimated report", async () => {
  const report = await estimateAction(
    mockRpc().rpc,
    policy,
    { data, mode: "estimate" },
    from,
  );
  const changed = {
    ...report,
    metadata: { ...report.metadata, innerGasAllowance: "499999" },
  };
  await assert.rejects(
    verifyBeforeSubmission(mockRpc().rpc, policy, changed),
    /STRATEGY_GAS_POLICY_CHANGED/,
  );
  await assert.rejects(
    verifyBeforeSubmission(
      mockRpc().rpc,
      { ...policy, maxGas: 540000 },
      report,
    ),
    /cap/,
  );
});

test("near-cap telemetry preserves the estimated limit instead of allocating the maximum", async () => {
  const logs: string[] = [];
  const original = console.info;
  console.info = (message) => logs.push(message);
  try {
    const report = await estimateAction(
      mockRpc().rpc,
      { ...policy, maxGas: 600000 },
      { data, mode: "estimate" },
      from,
    );
    assert.equal(report.gasLimit, 550000);
    assert.equal(report.gasPolicy!.capUtilizationBps, 9167);
    assert.equal(JSON.parse(logs[0]).event, "steer_gas_near_cap");
    assert.equal(JSON.parse(logs[0]).hardMaxGas, 600000);
  } finally {
    console.info = original;
  }
});

test("telemetry action hashes use canonical full-call or time-independent prefixes", async () => {
  const { actionHashFor } = await import("../gas");
  const { AbiCoder, keccak256 } = await import("ethers");
  assert.equal(
    actionHashFor(data),
    keccak256(
      AbiCoder.defaultAbiCoder().encode(
        ["address", "uint256", "bytes[]"],
        [target, 1, ["0x1234"]],
      ),
    ),
  );
  const prefixed = ACTION_ABI.encodeFunctionData("executeAction", [
    target,
    1,
    ["0x1234"],
    [1],
    "0x" + "00".repeat(32),
  ]);
  assert.equal(
    actionHashFor(prefixed),
    keccak256(
      AbiCoder.defaultAbiCoder().encode(
        ["address", "uint256", "bytes[]", "string"],
        [target, 1, ["0x12"], "$$"],
      ),
    ),
  );
});
