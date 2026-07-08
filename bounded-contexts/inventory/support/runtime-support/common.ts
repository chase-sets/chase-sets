import type { TypedUlid } from "@chase-sets/primitives/typed-ids";

export type InventoryStorageLocationId = TypedUlid<"loc">;
export type InventoryHoldId = TypedUlid<"hld">;

export type InventoryHoldStatus = "active" | "released" | "consumed" | "expired";

export class InventoryDomainError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "InventoryDomainError";
  }
}

export function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new InventoryDomainError(message);
  }
}

export function assertNever(value: never): never {
  throw new InventoryDomainError(`Unhandled variant: ${JSON.stringify(value)}`);
}

export function normalizeLabel(value: string): string {
  return value.trim();
}

export function normalizeOptionalText(value?: string | null): string | null {
  const normalized = value?.trim() ?? "";
  return normalized.length > 0 ? normalized : null;
}

export function ensureInteger(value: number, message: string) {
  assert(Number.isInteger(value), message);
  return value;
}

export function ensurePositiveInteger(value: number, message: string) {
  ensureInteger(value, message);
  assert(value > 0, message);
  return value;
}

export function ensureNonNegativeInteger(value: number, message: string) {
  ensureInteger(value, message);
  assert(value >= 0, message);
  return value;
}
