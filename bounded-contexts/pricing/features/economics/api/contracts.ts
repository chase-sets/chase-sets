import {
  parseResolveEconomicsInput,
  parseResolveEconomicsRequest,
  economicsFactNames,
  requireClosedRecord,
  requireCurrency,
  requireRfc3339Instant,
  type EconomicsFactName,
  EconomicsContractError,
  type ResolveEconomicsRequest,
} from "../domain/contracts";
import type {
  ClearAllEconomicsFactOverrides,
  ClearEconomicsFactOverride,
  EconomicsOverrideKey,
  SetEconomicsFactOverride,
} from "../domain/overrides";

/**
 * Closes the public request before authenticated identity is injected. Provider,
 * environment, account, and nested Channel coordinates are therefore rejected
 * as unknown input instead of being ignored or trusted.
 */
export function parseAuthenticatedResolveEconomicsRequest(
  raw: unknown,
  authenticatedAccountId: string,
): ResolveEconomicsRequest {
  const input = parseResolveEconomicsInput(raw);
  return parseResolveEconomicsRequest({ accountId: authenticatedAccountId, ...input });
}

export function parseAuthenticatedSetEconomicsOverrideRequest(
  raw: unknown,
  authenticatedAccountId: string,
): Readonly<{ key: EconomicsOverrideKey; command: SetEconomicsFactOverride }> {
  const input = requireClosedRecord(
    raw,
    ["connectionId", "currency", "expectedVersion", "factName", "setAt", "value"] as const,
    "Set Economics override request",
  );
  const key = parseOverrideKey(input, authenticatedAccountId);
  return {
    key,
    command: {
      type: "SetEconomicsFactOverride",
      expectedVersion: nonNegativeVersion(input.expectedVersion),
      factName: factName(input.factName),
      value: input.value,
      setAt: requireRfc3339Instant(input.setAt, "setAt"),
    },
  };
}

export function parseAuthenticatedClearEconomicsOverrideRequest(
  raw: unknown,
  authenticatedAccountId: string,
): Readonly<{ key: EconomicsOverrideKey; command: ClearEconomicsFactOverride }> {
  const input = requireClosedRecord(
    raw,
    ["clearedAt", "connectionId", "currency", "expectedVersion", "factName"] as const,
    "Clear Economics override request",
  );
  return {
    key: parseOverrideKey(input, authenticatedAccountId),
    command: {
      type: "ClearEconomicsFactOverride",
      expectedVersion: nonNegativeVersion(input.expectedVersion),
      factName: factName(input.factName),
      clearedAt: requireRfc3339Instant(input.clearedAt, "clearedAt"),
    },
  };
}

export function parseAuthenticatedClearAllEconomicsOverridesRequest(
  raw: unknown,
  authenticatedAccountId: string,
): Readonly<{ key: EconomicsOverrideKey; command: ClearAllEconomicsFactOverrides }> {
  const input = requireClosedRecord(
    raw,
    ["clearedAt", "connectionId", "currency", "expectedVersion"] as const,
    "Clear all Economics overrides request",
  );
  return {
    key: parseOverrideKey(input, authenticatedAccountId),
    command: {
      type: "ClearAllEconomicsFactOverrides",
      expectedVersion: nonNegativeVersion(input.expectedVersion),
      clearedAt: requireRfc3339Instant(input.clearedAt, "clearedAt"),
    },
  };
}

function parseOverrideKey(
  input: Readonly<{ connectionId: unknown; currency: unknown }>,
  accountId: string,
): EconomicsOverrideKey {
  if (
    typeof input.connectionId !== "string" ||
    input.connectionId.length === 0 ||
    input.connectionId.trim() !== input.connectionId
  ) {
    throw new EconomicsContractError("connectionId must be non-empty and already trimmed.");
  }
  return { accountId, connectionId: input.connectionId, currency: requireCurrency(input.currency, "currency") };
}

function factName(value: unknown): EconomicsFactName {
  if (typeof value !== "string" || !(economicsFactNames as readonly string[]).includes(value)) {
    throw new EconomicsContractError("factName must be a supported Economics fact.");
  }
  return value as EconomicsFactName;
}

function nonNegativeVersion(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new EconomicsContractError("expectedVersion must be a non-negative safe integer.");
  }
  return value;
}
