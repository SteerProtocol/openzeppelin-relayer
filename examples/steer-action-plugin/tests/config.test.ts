import assert from "node:assert/strict";
import { test } from "node:test";
import { parseRequest, resolvePolicy } from "../config";
import { policy, data } from "./helpers";
const { chainId, relayerId, ...settings } = policy;
const config = {
  chains: {
    "42161": {
      ...settings,
      relayerIds: ["arbitrum-node-1", "arbitrum-node-2", "arbitrum-node-3"],
    },
    "8453": { ...settings, submitEnabled: false, relayerIds: ["base-node-1"] },
  },
};
test("one registration resolves multiple chains and all three keeper identities", () => {
  for (const id of config.chains["42161"].relayerIds) {
    const resolved = resolvePolicy(config, id);
    assert.equal(resolved.relayerId, id);
    assert.equal(resolved.chainId, "42161");
    assert.equal(resolved.submitEnabled, true);
  }
  assert.equal(resolvePolicy(config, "base-node-1").chainId, "8453");
  assert.equal(resolvePolicy(config, "base-node-1").submitEnabled, false);
});
test("unknown selectors, duplicate mappings and routing overrides are rejected", () => {
  for (const id of [undefined, "attacker", "../admin", ""])
    assert.throws(() => resolvePolicy(config, id));
  assert.throws(
    () =>
      resolvePolicy(
        {
          chains: {
            ...config.chains,
            "1": { ...settings, relayerIds: ["base-node-1"] },
          },
        },
        "arbitrum-node-1",
      ),
    /duplicate/,
  );
  assert.throws(
    () =>
      resolvePolicy(
        {
          chains: {
            "42161": { ...settings, relayerIds: ["keeper"], chainId: "1" },
          },
        },
        "keeper",
      ),
    /routing/,
  );
  assert.throws(() => resolvePolicy(policy, "keeper"));
});
test("request accepts only selector, canonical action and mode", () => {
  assert.deepEqual(
    parseRequest({ data, mode: "estimate", relayerId: "keeper" }),
    { relayerId: "keeper", action: { data, mode: "estimate" } },
  );
  for (const field of ["chainId", "profile", "maxGas", "from", "to"]) {
    assert.throws(() =>
      parseRequest({
        data,
        mode: "submit",
        relayerId: "keeper",
        [field]: "override",
      }),
    );
  }
});
