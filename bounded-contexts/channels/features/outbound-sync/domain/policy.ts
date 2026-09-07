import { definePolicy, type PolicyDefinition } from "@chase-sets/platform-policy/define-policy";
import type { JsonValue } from "@chase-sets/primitives/json";

export type OutboundOperationBudget = Readonly<{
  maxRequestsPerWindow: number;
  windowMs: number;
  maxInFlightPerConnection: number;
  maxAttempts: number;
  baseBackoffMs: number;
  maxBackoffMs: number;
}>;

export type OutboundOperationBudgetOverride = Partial<OutboundOperationBudget> & Readonly<{ disabled?: boolean }>;

export type OutboundOperationBudgetPolicyValue = Readonly<{
  incidentMultiplier: number;
  providers: Readonly<Record<string, OutboundOperationBudgetOverride>>;
}>;

export const OUTBOUND_OPERATION_BUDGET_FALLBACK: OutboundOperationBudget = Object.freeze({
  maxRequestsPerWindow: 60,
  windowMs: 60_000,
  maxInFlightPerConnection: 4,
  maxAttempts: 5,
  baseBackoffMs: 1_000,
  maxBackoffMs: 300_000,
});

export const OUTBOUND_OPERATION_BUDGET_POLICY_FALLBACK: OutboundOperationBudgetPolicyValue = Object.freeze({
  incidentMultiplier: 1,
  providers: Object.freeze({}),
});

export const outboundOperationBudgetPolicy: PolicyDefinition<OutboundOperationBudgetPolicyValue> = definePolicy({
  policyKey: "channels.outbound-operation-budget",
  contextName: "channels",
  schemaSummary:
    "{ incidentMultiplier: number 0.1-10, providers: { [providerKey:environment]: { maxRequestsPerWindow?, windowMs?, maxInFlightPerConnection?, maxAttempts?, baseBackoffMs?, maxBackoffMs?, disabled? } } }",
  defaultValue: OUTBOUND_OPERATION_BUDGET_POLICY_FALLBACK,
  decodeValue: decodeOutboundOperationBudgetPolicy,
});

export function decodeOutboundOperationBudgetPolicy(raw: JsonValue): OutboundOperationBudgetPolicyValue {
  const record = closedRecord(raw, ["incidentMultiplier", "providers"], "outbound operation budget policy");
  const incidentMultiplier = finiteNumber(record.incidentMultiplier, 0.1, 10, "incidentMultiplier");
  const providersRecord = closedRecord(record.providers, Object.keys(asRecord(record.providers)), "providers");
  const providers: Record<string, OutboundOperationBudgetOverride> = {};
  for (const [identity, candidate] of Object.entries(providersRecord)) {
    if (!/^[a-z][a-z0-9-]{0,99}:(sandbox|production)$/.test(identity)) invalid(`providers.${identity} key is invalid.`);
    const override = closedRecord(
      candidate,
      [
        "maxRequestsPerWindow",
        "windowMs",
        "maxInFlightPerConnection",
        "maxAttempts",
        "baseBackoffMs",
        "maxBackoffMs",
        "disabled",
      ],
      `providers.${identity}`,
    );
    const decoded: Record<string, number | boolean> = {};
    if (override.maxRequestsPerWindow !== undefined)
      decoded.maxRequestsPerWindow = integer(override.maxRequestsPerWindow, 1, 1_000_000, `${identity}.maxRequestsPerWindow`);
    if (override.windowMs !== undefined)
      decoded.windowMs = integer(override.windowMs, 1_000, 86_400_000, `${identity}.windowMs`);
    if (override.maxInFlightPerConnection !== undefined)
      decoded.maxInFlightPerConnection = integer(
        override.maxInFlightPerConnection,
        1,
        1_000,
        `${identity}.maxInFlightPerConnection`,
      );
    if (override.maxAttempts !== undefined)
      decoded.maxAttempts = integer(override.maxAttempts, 1, 50, `${identity}.maxAttempts`);
    if (override.baseBackoffMs !== undefined)
      decoded.baseBackoffMs = integer(override.baseBackoffMs, 1, 86_400_000, `${identity}.baseBackoffMs`);
    if (override.maxBackoffMs !== undefined)
      decoded.maxBackoffMs = integer(override.maxBackoffMs, 1, 86_400_000, `${identity}.maxBackoffMs`);
    if (override.disabled !== undefined) {
      if (typeof override.disabled !== "boolean") invalid(`${identity}.disabled must be boolean.`);
      decoded.disabled = override.disabled;
    }
    if (
      typeof decoded.baseBackoffMs === "number" &&
      typeof decoded.maxBackoffMs === "number" &&
      decoded.maxBackoffMs < decoded.baseBackoffMs
    ) {
      invalid(`${identity}.maxBackoffMs must be at least baseBackoffMs.`);
    }
    providers[identity] = Object.freeze(decoded) as OutboundOperationBudgetOverride;
  }
  return Object.freeze({ incidentMultiplier, providers: Object.freeze(providers) });
}

export function resolveOutboundOperationBudget(
  value: OutboundOperationBudgetPolicyValue,
  providerIdentity: Readonly<{ providerKey: string; environment: "sandbox" | "production" }>,
  compiledProviders: Readonly<Record<string, OutboundOperationBudget>> = {},
): Readonly<{ disabled: boolean; budget: OutboundOperationBudget; incidentMultiplier: number }> {
  const key = `${providerIdentity.providerKey}:${providerIdentity.environment}`;
  const compiled = compiledProviders[key] ?? OUTBOUND_OPERATION_BUDGET_FALLBACK;
  const override = value.providers[key];
  const budget = {
    maxRequestsPerWindow: override?.maxRequestsPerWindow ?? compiled.maxRequestsPerWindow,
    windowMs: override?.windowMs ?? compiled.windowMs,
    maxInFlightPerConnection: override?.maxInFlightPerConnection ?? compiled.maxInFlightPerConnection,
    maxAttempts: override?.maxAttempts ?? compiled.maxAttempts,
    baseBackoffMs: override?.baseBackoffMs ?? compiled.baseBackoffMs,
    maxBackoffMs: override?.maxBackoffMs ?? compiled.maxBackoffMs,
  };
  return Object.freeze({ disabled: override?.disabled ?? false, budget: Object.freeze(budget), incidentMultiplier: value.incidentMultiplier });
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) invalid("value must be an object.");
  return value as Record<string, unknown>;
}

function closedRecord(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  const record = asRecord(value);
  const allowed = new Set(keys);
  for (const key of Object.keys(record)) if (!allowed.has(key)) invalid(`${label}.${key} is unknown.`);
  return record;
}

function integer(value: unknown, minimum: number, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    invalid(`${label} must be an integer from ${minimum} to ${maximum}.`);
  }
  return Number(value);
}

function finiteNumber(value: unknown, minimum: number, maximum: number, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) {
    invalid(`${label} must be a number from ${minimum} to ${maximum}.`);
  }
  return value;
}

function invalid(message: string): never {
  throw new Error(`Invalid channels outbound operation budget policy: ${message}`);
}
