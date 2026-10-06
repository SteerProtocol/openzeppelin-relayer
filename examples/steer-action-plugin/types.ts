export type ContractName =
  | "Orchestrator"
  | "GasVault"
  | "VaultRegistry"
  | "StrategyRegistry";
export type Deployments = Record<ContractName, string>;
export interface ActionMetadata {
  deployments: Deployments;
  target: string;
  strategyId: string;
  vaultState: number;
  innerGasAllowance: string;
  strategyGasPriceCap: string;
  effectiveGasPriceCap: string;
  feeCeilingWei: string;
  gasBalance: string;
}
export type Rpc = (method: string, params: unknown[]) => Promise<unknown>;
export interface CompatibilityProfile {
  id: string;
  backend: "guarded-rpc" | "native-call-search";
  proxyCodeHash: string;
  implementationCodeHash: string;
  // Reviewed alternate deployments only; callers cannot provide these.
  deployments?: Partial<Deployments>;
}
export interface Policy {
  relayerId: string;
  chainId: string;
  profile: CompatibilityProfile;
  estimateEnabled: boolean;
  submitEnabled: boolean;
  deadlineMs: number;
  maxGas: number;
  maxGasPrice: string;
  marginBps: number;
  maxSnapshotAgeSeconds: number;
}
export interface Action {
  data: string;
  mode: "estimate" | "submit";
}
export interface Snapshot {
  baseFeePerGas?: string;
  number: string;
  hash: string;
  gasLimit: string;
  timestamp: string;
}
export interface Transaction {
  from: string;
  to: string;
  data: string;
  value: string;
  gasPrice: string;
}
export interface GasReport {
  chainId: string;
  profileId: string;
  backend: CompatibilityProfile["backend"];
  sdkVersion: string;
  metadata: ActionMetadata;
  relayerFeeCap?: string;
  snapshot: Snapshot;
  implementation: string;
  guardedEstimate: number;
  gasLimit: number;
  gasPrice: string;
  transaction: Transaction;
}
