import assert from "node:assert/strict";
import { test } from "node:test";
import { estimateAction, parsePolicy, verifyBeforeSubmission } from "../gas";
import { deploymentsFor, CORE_ABIS } from "../metadata";
import { ExecutionReverted } from "../errors";
import {
  data,
  from,
  proxy,
  gasVault,
  vaultRegistry,
  strategyRegistry,
  policy,
  mockRpc,
} from "./helpers";
const native = {
  ...policy,
  profile: { ...policy.profile, backend: "native-call-search" as const },
};
function actionCall(method: string, params: unknown[]): boolean {
  return (
    method === "eth_call" &&
    (params[0] as { data: string }).data === data &&
    (params[2] as Record<string, { code: string }> | undefined)?.[proxy]
      ?.code !== "0x60006000f3"
  );
}
test("SDK resolves Arbitrum and Bittensor without address overrides; unknown chains fail closed", () => {
  for (const chainId of ["42161", "964"]) {
    const resolved = deploymentsFor({
      ...policy,
      chainId,
      profile: { ...policy.profile, deployments: undefined },
    });
    assert.ok(
      Object.values(resolved).every((value) =>
        /^0x[0-9a-fA-F]{40}$/.test(value),
      ),
    );
  }
  assert.throws(
    () =>
      deploymentsFor({
        ...policy,
        chainId: "999999999",
        profile: { ...policy.profile, deployments: undefined },
      }),
    /SDK has no/,
  );
});
test("new profiles are disabled unless explicitly enabled", async () => {
  const parsed = parsePolicy({
    ...policy,
    estimateEnabled: undefined,
    submitEnabled: undefined,
  });
  assert.equal(parsed.estimateEnabled, false);
  assert.equal(parsed.submitEnabled, false);
  await assert.rejects(
    estimateAction(mockRpc().rpc, parsed, { data, mode: "estimate" }, from),
    /disabled/,
  );
  await assert.rejects(
    estimateAction(
      mockRpc().rpc,
      { ...policy, submitEnabled: false },
      { data, mode: "submit" },
      from,
    ),
    /disabled/,
  );
});
test("report separates inner allowance from outer budget and records metadata provenance", async () => {
  const report = await estimateAction(
    mockRpc().rpc,
    policy,
    { data, mode: "estimate" },
    from,
  );
  assert.equal(report.metadata.innerGasAllowance, "500000");
  assert.equal(report.gasLimit, 550000);
  assert.equal(report.metadata.strategyId, "1");
  assert.equal(report.sdkVersion, "3.8.0");
  assert.equal(report.profileId, policy.profile.id);
});
test("graph mismatch, unregistered target, strategy fee and funding violations reject before estimation", async () => {
  for (const [at, abi, method, value, error] of [
    [gasVault, CORE_ABIS.GasVault, "orchestrator", [from], /graph/],
    [
      vaultRegistry,
      CORE_ABIS.VaultRegistry,
      "getVaultDetails",
      [[3, 1, 1, "ipfs", from, "fixture"]],
      /registered/,
    ],
    [
      strategyRegistry,
      CORE_ABIS.StrategyRegistry,
      "getRegisteredStrategy",
      [[1, "fixture", from, "ipfs", 1, 500000]],
      /cap/,
    ],
    [gasVault, CORE_ABIS.GasVault, "ethBalances", [1], /funding/],
  ] as const) {
    const { rpc, calls } = mockRpc((m, p) =>
      m === "eth_call" &&
      (p[0] as { to: string }).to === at &&
      (p[0] as { data: string }).data.startsWith(
        abi.getFunction(method)!.selector,
      )
        ? abi.encodeFunctionResult(method, value)
        : undefined,
    );
    await assert.rejects(
      estimateAction(rpc, policy, { data, mode: "estimate" }, from),
      error,
    );
    assert.equal(
      calls.filter((call) => call.method === "eth_estimateGas").length,
      0,
    );
  }
});
test("relayer cap participates in the effective fee cap", async () => {
  await assert.rejects(
    estimateAction(mockRpc().rpc, policy, { data, mode: "estimate" }, from, {
      relayerFeeCap: "1",
    }),
    /cap/,
  );
  const report = await estimateAction(
    mockRpc().rpc,
    policy,
    { data, mode: "estimate" },
    from,
    { relayerFeeCap: "26000000" },
  );
  assert.equal(report.metadata.effectiveGasPriceCap, "26000000");
});
test("paused vault metadata is not arbitrarily excluded when the original action completes", async () => {
  const { rpc } = mockRpc((m, p) =>
    m === "eth_call" &&
    (p[0] as { data: string }).data.startsWith(
      CORE_ABIS.VaultRegistry.getFunction("getVaultDetails")!.selector,
    )
      ? CORE_ABIS.VaultRegistry.encodeFunctionResult("getVaultDetails", [
          [
            2,
            1,
            1,
            "ipfs",
            policy.profile.deployments
              ? "0x4000000000000000000000000000000000000004"
              : from,
            "fixture",
          ],
        ])
      : undefined,
  );
  const report = await estimateAction(
    rpc,
    policy,
    { data, mode: "estimate" },
    from,
  );
  assert.equal(report.metadata.vaultState, 2);
});
test("native search uses only eth_call, bounds probes, and verifies the original transaction", async () => {
  const { rpc, calls } = mockRpc((m, p) => {
    if (actionCall(m, p) && BigInt((p[0] as { gas: string }).gas) < 500000n)
      throw new ExecutionReverted();
    if (m === "eth_estimateGas")
      throw new Error("Must not use native estimateGas");
  });
  const report = await estimateAction(
    rpc,
    native,
    { data, mode: "estimate" },
    from,
  );
  assert.ok(
    report.guardedEstimate >= 500000 && report.guardedEstimate <= 501000,
  );
  assert.ok(
    calls.filter((c) => c.method === "eth_call" && c.params.length === 3)
      .length <= 23,
  );
  assert.equal(calls.filter((c) => c.method === "eth_estimateGas").length, 0);
  assert.equal(
    calls.filter((c) => actionCall(c.method, c.params)).at(-1)!.params.length,
    2,
  );
});
test("native search aborts outages instead of treating them as insufficient gas", async () => {
  let probes = 0;
  const { rpc } = mockRpc((m, p) => {
    if (actionCall(m, p) && ++probes === 2)
      throw new Error("Upstream unavailable");
  });
  await assert.rejects(
    estimateAction(rpc, native, { data, mode: "estimate" }, from),
    /Upstream unavailable/,
  );
  assert.equal(probes, 2);
});
test("permanent action failure at ceiling is not retried with more gas", async () => {
  let probes = 0;
  const { rpc } = mockRpc((m, p) => {
    if (actionCall(m, p)) {
      probes++;
      throw new ExecutionReverted();
    }
  });
  await assert.rejects(
    estimateAction(rpc, native, { data, mode: "estimate" }, from),
    /execution reverted/,
  );
  assert.equal(probes, 1);
});
test("endpoints ignoring call or estimation overrides are rejected", async () => {
  for (const backend of ["guarded-rpc", "native-call-search"] as const) {
    const { rpc } = mockRpc((m, p) =>
      m === "eth_call" &&
      (p[2] as Record<string, { code: string }> | undefined)?.[proxy]?.code ===
        "0x60006000f3"
        ? "0x" + "0".repeat(63) + "1"
        : undefined,
    );
    await assert.rejects(
      estimateAction(
        rpc,
        { ...policy, profile: { ...policy.profile, backend } },
        { data, mode: "estimate" },
        from,
      ),
      /ignored eth_call/,
    );
  }
  const { rpc } = mockRpc((m) =>
    m === "eth_estimateGas" ? "0x7a120" : undefined,
  );
  await assert.rejects(
    estimateAction(rpc, policy, { data, mode: "estimate" }, from),
    /ignored eth_estimateGas/,
  );
});
test("fresh pre-submission reads catch changed strategy limits and reject stale estimates", async () => {
  const report = await estimateAction(
    mockRpc().rpc,
    policy,
    { data, mode: "estimate" },
    from,
  );
  const { rpc } = mockRpc((m, p) =>
    m === "eth_call" &&
    (p[0] as { data: string }).data.startsWith(
      CORE_ABIS.StrategyRegistry.getFunction("getRegisteredStrategy")!.selector,
    )
      ? CORE_ABIS.StrategyRegistry.encodeFunctionResult(
          "getRegisteredStrategy",
          [[1, "fixture", from, "ipfs", 1, 500000]],
        )
      : undefined,
  );
  await assert.rejects(verifyBeforeSubmission(rpc, policy, report), /cap/);
  await assert.rejects(
    verifyBeforeSubmission(mockRpc().rpc, policy, {
      ...report,
      snapshot: { ...report.snapshot, timestamp: "0x1" },
    }),
    /stale/,
  );
});

test("funding fee ceiling uses inner allowance and submission preserves the lower snapshot ceiling", async () => {
  const funding = (balance: bigint) =>
    mockRpc((m, p) =>
      m === "eth_call" &&
      (p[0] as { data: string }).data.startsWith(
        CORE_ABIS.GasVault.getFunction("ethBalances")!.selector,
      )
        ? CORE_ABIS.GasVault.encodeFunctionResult("ethBalances", [balance])
        : undefined,
    ).rpc;
  const report = await estimateAction(
    funding(13000000000000n),
    policy,
    { data, mode: "estimate" },
    from,
  );
  assert.equal(report.metadata.feeCeilingWei, "26000000");
  assert.equal(report.metadata.effectiveGasPriceCap, "30000000");
  assert.equal(
    (await verifyBeforeSubmission(funding(14000000000000n), policy, report))
      .feeCeilingWei,
    "26000000",
  );
  assert.equal(
    (await verifyBeforeSubmission(funding(12500000000000n), policy, report))
      .feeCeilingWei,
    "25000000",
  );
});

test("fee-dependent metadata reads use bounded gas rather than the provider default", async () => {
  const { rpc, calls } = mockRpc();
  await estimateAction(rpc, policy, { data, mode: "estimate" }, from);
  const selector = CORE_ABIS.GasVault.getFunction(
    "gasAvailableForTransaction",
  )!.selector;
  const call = calls.find(
    (c) =>
      c.method === "eth_call" &&
      (c.params[0] as { data?: string }).data?.startsWith(selector),
  );
  assert.ok(call);
  assert.equal(
    BigInt((call.params[0] as { gas: string }).gas),
    BigInt(policy.maxGas),
  );
});
