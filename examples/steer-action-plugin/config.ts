import type { Policy, Deployments } from "./types";
import { record, decimal, integer, hash, address } from "./validation";
export function parsePolicy(value: unknown): Policy {
  const p = record(value, "deployment configuration");
  if (typeof p.relayerId !== "string" || !p.relayerId.trim())
    throw new Error("Invalid relayerId");
  const maxGasPrice = decimal(p.maxGasPrice, "maxGasPrice");
  if (BigInt(maxGasPrice) > BigInt(Number.MAX_SAFE_INTEGER))
    throw new Error("maxGasPrice exceeds SDK numeric precision");
  const profile = record(p.profile, "compatibility profile");
  if (typeof profile.id !== "string" || !/^[a-zA-Z0-9_-]+$/.test(profile.id))
    throw new Error("Invalid profile id");
  if (
    profile.backend !== "guarded-rpc" &&
    profile.backend !== "native-call-search"
  )
    throw new Error("Invalid estimation backend");
  for (const flag of ["estimateEnabled", "submitEnabled"])
    if (p[flag] !== undefined && typeof p[flag] !== "boolean")
      throw new Error(`Invalid ${flag}`);
  if (p.submitEnabled && !p.estimateEnabled)
    throw new Error("Submission requires enabled estimation");
  const deployments: Partial<Deployments> = {};
  if (profile.deployments !== undefined) {
    for (const [name, value] of Object.entries(
      record(profile.deployments, "deployment overrides"),
    )) {
      if (
        ![
          "Orchestrator",
          "GasVault",
          "VaultRegistry",
          "StrategyRegistry",
        ].includes(name)
      )
        throw new Error("Unknown deployment override");
      deployments[name as keyof Deployments] = address(value, name);
    }
  }
  return {
    relayerId: p.relayerId,
    chainId: decimal(p.chainId, "chainId"),
    profile: {
      id: profile.id,
      backend: profile.backend,
      proxyCodeHash: hash(profile.proxyCodeHash, "proxyCodeHash"),
      implementationCodeHash: hash(
        profile.implementationCodeHash,
        "implementationCodeHash",
      ),
      ...(Object.keys(deployments).length ? { deployments } : {}),
    },
    estimateEnabled: p.estimateEnabled === true,
    submitEnabled: p.submitEnabled === true,
    deadlineMs: integer(p.deadlineMs ?? 30000, "deadlineMs", 1000, 90000),
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

/** Resolve only operator-approved relayers. Validate the whole map before any RPC. */
export function resolvePolicy(config: unknown, relayerId: unknown): Policy {
  if (typeof relayerId !== "string" || !/^[a-zA-Z0-9_-]+$/.test(relayerId))
    throw new Error("Invalid relayerId selector");
  const root = record(config, "plugin configuration");
  if (Object.keys(root).some((key) => key !== "chains"))
    throw new Error("Unknown plugin configuration field");
  const chains = record(root.chains, "chain policies");
  const seen = new Set<string>();
  let selected: Policy | undefined;
  for (const [chainId, value] of Object.entries(chains)) {
    decimal(chainId, "chainId");
    const entry = record(value, "chain policy");
    if ("relayerId" in entry || "chainId" in entry)
      throw new Error("Chain policy cannot override routing");
    if (!Array.isArray(entry.relayerIds) || entry.relayerIds.length === 0)
      throw new Error("Chain policy requires approved relayerIds");
    const { relayerIds, ...settings } = entry;
    for (const id of relayerIds) {
      if (
        typeof id !== "string" ||
        !/^[a-zA-Z0-9_-]+$/.test(id) ||
        seen.has(id)
      )
        throw new Error("Invalid or duplicate configured relayerId");
      seen.add(id);
      const policy = parsePolicy({ ...settings, chainId, relayerId: id });
      if (id === relayerId) selected = policy;
    }
  }
  if (!selected) throw new Error("Relayer is not approved for this plugin");
  return selected;
}
export function parseRequest(value: unknown) {
  const request = record(value, "plugin request");
  if (
    Object.keys(request).some(
      (key) => !["relayerId", "mode", "data"].includes(key),
    )
  )
    throw new Error("Only relayerId, mode and data are accepted");
  return {
    relayerId: request.relayerId,
    action: { mode: request.mode, data: request.data },
  };
}
