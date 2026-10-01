import {
  abis,
  getContractAddressByChainIdAndContractName,
} from "@steerprotocol/sdk";
import { Interface, getAddress, type InterfaceAbi } from "ethers";
import orchestratorAbi from "./orchestrator-abi.json";
import { ActionError } from "./errors";
import type { Policy, Rpc, Snapshot, Transaction } from "./gas";

export const SDK_VERSION = "3.8.0";
export const ACTION_ABI = new Interface(orchestratorAbi);
export const CORE_ABIS = {
  Orchestrator: ACTION_ABI,
  GasVault: new Interface(abis.GasVault as unknown as InterfaceAbi),
  VaultRegistry: new Interface(abis.VaultRegistry as unknown as InterfaceAbi),
  StrategyRegistry: new Interface(
    abis.StrategyRegistry as unknown as InterfaceAbi,
  ),
};
export type ContractName = keyof typeof CORE_ABIS;
export type Deployments = Record<ContractName, string>;
export interface ActionMetadata {
  deployments: Deployments;
  target: string;
  strategyId: string;
  vaultState: number;
  innerGasAllowance: string;
  strategyGasPriceCap: string;
  effectiveGasPriceCap: string;
  gasBalance: string;
}
export function deploymentsFor(policy: Policy): Deployments {
  const chainId = Number(policy.chainId);
  if (!Number.isSafeInteger(chainId))
    throw new ActionError(
      "UNSUPPORTED_PROFILE",
      "Chain ID exceeds SDK precision",
    );
  return Object.fromEntries(
    Object.keys(CORE_ABIS).map((key) => {
      const name = key as ContractName;
      const value =
        policy.profile.deployments?.[name] ??
        getContractAddressByChainIdAndContractName(chainId, name);
      if (!value)
        throw new ActionError(
          "UNSUPPORTED_PROFILE",
          `SDK has no ${name} deployment for chain ${chainId}`,
        );
      const address = getAddress(value);
      if (BigInt(address) === 0n)
        throw new ActionError(
          "UNSUPPORTED_PROFILE",
          `Missing ${name} deployment`,
        );
      return [name, address];
    }),
  ) as Deployments;
}
export async function readCore(
  rpc: Rpc,
  name: ContractName,
  at: string,
  method: string,
  args: unknown[],
  snapshot: Snapshot,
  context: Partial<Transaction> = {},
) {
  const abi = CORE_ABIS[name];
  const result = await rpc("eth_call", [
    { ...context, to: at, data: abi.encodeFunctionData(method, args) },
    snapshot.number,
  ]);
  return abi.decodeFunctionResult(method, result as string);
}
export async function readActionMetadata(
  rpc: Rpc,
  policy: Policy,
  snapshot: Snapshot,
  transaction: Transaction,
  relayerFeeCap?: string,
): Promise<ActionMetadata> {
  const deployments = deploymentsFor(policy);
  const target = getAddress(
    ACTION_ABI.decodeFunctionData("executeAction", transaction.data)[0],
  );
  if (Object.values(deployments).includes(target))
    throw new ActionError(
      "UNREGISTERED_TARGET",
      "Core contracts cannot be vault action targets",
    );
  async function link(name: ContractName, method: string, expected: string) {
    const actual = getAddress(
      (await readCore(rpc, name, deployments[name], method, [], snapshot))[0],
    );
    if (actual !== expected)
      throw new ActionError(
        "DEPLOYMENT_CHANGED",
        `${name}.${method} differs from approved deployment graph`,
      );
  }
  await link("Orchestrator", "gasVault", deployments.GasVault);
  await link("GasVault", "orchestrator", deployments.Orchestrator);
  await link("GasVault", "vaultRegistry", deployments.VaultRegistry);
  await link("GasVault", "strategyRegistry", deployments.StrategyRegistry);
  await link("VaultRegistry", "orchestrator", deployments.Orchestrator);
  await link("VaultRegistry", "strategyRegistry", deployments.StrategyRegistry);
  const vault = (
    await readCore(
      rpc,
      "VaultRegistry",
      deployments.VaultRegistry,
      "getVaultDetails",
      [target],
      snapshot,
    )
  )[0];
  if (getAddress(vault.vaultAddress) !== target)
    throw new ActionError(
      "UNREGISTERED_TARGET",
      "Target is not a registered Steer vault",
    );
  const strategy = (
    await readCore(
      rpc,
      "StrategyRegistry",
      deployments.StrategyRegistry,
      "getRegisteredStrategy",
      [vault.tokenId],
      snapshot,
    )
  )[0];
  if (
    strategy.id !== vault.tokenId ||
    strategy.maxGasPerAction <= 0n ||
    strategy.maxGasCost <= 0n
  )
    throw new ActionError(
      "POLICY_VIOLATION",
      "Strategy has invalid gas parameters",
    );
  const caps = [BigInt(policy.maxGasPrice), strategy.maxGasCost as bigint];
  if (relayerFeeCap !== undefined) caps.push(BigInt(relayerFeeCap));
  const effectiveGasPriceCap = caps.reduce((a, b) => (a < b ? a : b));
  const fee = BigInt(transaction.gasPrice);
  if (fee <= 0n || fee > effectiveGasPriceCap)
    throw new ActionError(
      "POLICY_VIOLATION",
      "Gas price exceeds operator, strategy or relayer cap",
    );
  const balance = (
    await readCore(
      rpc,
      "GasVault",
      deployments.GasVault,
      "ethBalances",
      [target],
      snapshot,
    )
  )[0] as bigint;
  if (balance < fee * strategy.maxGasPerAction)
    throw new ActionError("POLICY_VIOLATION", "Insufficient GasVault funding");
  // The live getter is authoritative about fee-dependent execution eligibility.
  const allowance = (
    await readCore(
      rpc,
      "GasVault",
      deployments.GasVault,
      "gasAvailableForTransaction",
      [target],
      snapshot,
      { from: transaction.from, gasPrice: transaction.gasPrice },
    )
  )[0] as bigint;
  if (allowance !== strategy.maxGasPerAction)
    throw new ActionError(
      "DEPLOYMENT_CHANGED",
      "GasVault allowance differs from registered strategy",
    );
  return {
    deployments,
    target,
    strategyId: vault.tokenId.toString(),
    vaultState: Number(vault.state),
    innerGasAllowance: allowance.toString(),
    strategyGasPriceCap: strategy.maxGasCost.toString(),
    effectiveGasPriceCap: effectiveGasPriceCap.toString(),
    gasBalance: balance.toString(),
  };
}
