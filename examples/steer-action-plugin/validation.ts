import { getAddress } from "ethers";
export const CODE_COPY = "0x00000000000000000000000000000000Ac710001";
export function record(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`Invalid ${name}`);
  return value as Record<string, unknown>;
}
export function integer(
  value: unknown,
  name: string,
  min: number,
  max: number,
): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < min ||
    (value as number) > max
  )
    throw new Error(`Invalid ${name}`);
  return value as number;
}
export function decimal(value: unknown, name: string): string {
  if (typeof value !== "string" || !/^[1-9][0-9]*$/.test(value))
    throw new Error(`Invalid ${name}: positive decimal string required`);
  return value;
}
export function hash(value: unknown, name: string): string {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(value))
    throw new Error(`Invalid ${name}`);
  return value.toLowerCase();
}
export function address(value: unknown, name: string): string {
  if (typeof value !== "string") throw new Error(`Invalid ${name}`);
  const result = getAddress(value);
  if (BigInt(result) === 0n || result === CODE_COPY)
    throw new Error(`Reserved ${name}`);
  return result;
}
