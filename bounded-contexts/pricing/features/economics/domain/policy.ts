import { definePolicy, type PolicyDefinition } from "@chase-sets/platform-policy/define-policy";
import type { ResolvedPolicy } from "@chase-sets/platform-policy/resolver";
import type { JsonValue } from "@chase-sets/primitives/json";
import {
  isCanonicalMoneyAmount,
  normalizeMoneyAmount,
  normalizeSignedMoneyAmount,
  type MoneyAmount,
  type SignedMoneyAmount,
} from "@chase-sets/primitives/money";
import { requireRfc3339Instant } from "./contracts";
import { canonicalSha256 } from "./revision";

export const ECONOMICS_LAUNCH_POLICY_EFFECTIVE_AT = "2026-09-06T20:28:41Z";

export type EconomicsPolicyValue = Readonly<{
  sellerHandlingRelativeBps: number;
  sellerHandlingFixedPerUnitAmount: MoneyAmount;
  sellerHandlingCapPerUnitAmount: MoneyAmount | null;
  costBasisDiscountPerUnitAmount: SignedMoneyAmount;
  defaultCostBasisShareOfMarketBps: number;
  minimumCostBasisCoverageBps: number;
  defaultObservedHoldDays: number;
  defaultTurnaroundDays: number;
  defaultDailyReturnHurdle: number;
  observationWindowDays: number;
  minimumHoldSamples: number;
  minimumTurnaroundSamples: number;
  observationStatistic: "median";
  maximumObservationDurationDays: number;
}>;

export const ECONOMICS_LAUNCH_POLICY_VALUE: EconomicsPolicyValue = {
  sellerHandlingRelativeBps: 0,
  sellerHandlingFixedPerUnitAmount: "0.30" as MoneyAmount,
  sellerHandlingCapPerUnitAmount: null,
  costBasisDiscountPerUnitAmount: "0.30" as SignedMoneyAmount,
  defaultCostBasisShareOfMarketBps: 7_200,
  minimumCostBasisCoverageBps: 5_000,
  defaultObservedHoldDays: 30,
  defaultTurnaroundDays: 28,
  defaultDailyReturnHurdle: 0.005,
  observationWindowDays: 180,
  minimumHoldSamples: 5,
  minimumTurnaroundSamples: 5,
  observationStatistic: "median",
  maximumObservationDurationDays: 180,
};

const POLICY_KEYS = Object.keys(ECONOMICS_LAUNCH_POLICY_VALUE).sort();
const MAX_DAYS = 3_650;
const MAX_SAMPLES = 100_000;

export function decodeEconomicsPolicyValue(raw: JsonValue): EconomicsPolicyValue {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("Economics policy value must be an object.");
  }
  const record = raw as Record<string, unknown>;
  assertExactKeys(record, POLICY_KEYS, "Economics policy value");

  const maximumObservationDurationDays = positiveInteger(
    record.maximumObservationDurationDays,
    "maximumObservationDurationDays",
    MAX_DAYS,
  );
  const observationWindowDays = positiveInteger(record.observationWindowDays, "observationWindowDays", MAX_DAYS);
  if (maximumObservationDurationDays > observationWindowDays) {
    throw new Error("maximumObservationDurationDays cannot exceed observationWindowDays.");
  }

  return {
    sellerHandlingRelativeBps: basisPoints(record.sellerHandlingRelativeBps, "sellerHandlingRelativeBps"),
    sellerHandlingFixedPerUnitAmount: canonicalMoney(
      record.sellerHandlingFixedPerUnitAmount,
      "sellerHandlingFixedPerUnitAmount",
    ),
    sellerHandlingCapPerUnitAmount:
      record.sellerHandlingCapPerUnitAmount === null
        ? null
        : canonicalMoney(record.sellerHandlingCapPerUnitAmount, "sellerHandlingCapPerUnitAmount"),
    costBasisDiscountPerUnitAmount: canonicalSignedMoney(
      record.costBasisDiscountPerUnitAmount,
      "costBasisDiscountPerUnitAmount",
    ),
    defaultCostBasisShareOfMarketBps: basisPoints(
      record.defaultCostBasisShareOfMarketBps,
      "defaultCostBasisShareOfMarketBps",
    ),
    minimumCostBasisCoverageBps: basisPoints(record.minimumCostBasisCoverageBps, "minimumCostBasisCoverageBps"),
    defaultObservedHoldDays: positiveInteger(record.defaultObservedHoldDays, "defaultObservedHoldDays", MAX_DAYS),
    defaultTurnaroundDays: positiveInteger(record.defaultTurnaroundDays, "defaultTurnaroundDays", MAX_DAYS),
    defaultDailyReturnHurdle: finiteNumber(record.defaultDailyReturnHurdle, "defaultDailyReturnHurdle"),
    observationWindowDays,
    minimumHoldSamples: positiveInteger(record.minimumHoldSamples, "minimumHoldSamples", MAX_SAMPLES),
    minimumTurnaroundSamples: positiveInteger(record.minimumTurnaroundSamples, "minimumTurnaroundSamples", MAX_SAMPLES),
    observationStatistic: exactMedian(record.observationStatistic),
    maximumObservationDurationDays,
  };
}

export const economicsPolicy: PolicyDefinition<EconomicsPolicyValue> = definePolicy({
  policyKey: "pricing.economics",
  contextName: "pricing",
  schemaSummary:
    "{ seller handling money/bps, cost defaults/coverage, observed hold/turnaround median policy, numeric hurdle }",
  defaultValue: ECONOMICS_LAUNCH_POLICY_VALUE,
  decodeValue: decodeEconomicsPolicyValue,
});

export type ResolvedEconomicsPolicy = Readonly<{
  value: EconomicsPolicyValue;
  policyRevision: string;
  observedAt: string;
  source: "policy" | "fallback";
  documentId: string | null;
  effectiveFrom: string | null;
  effectiveUntil: string | null;
}>;

export function toResolvedEconomicsPolicy(resolved: ResolvedPolicy<EconomicsPolicyValue>): ResolvedEconomicsPolicy {
  if (resolved.policyKey !== economicsPolicy.policyKey) {
    throw new Error(`Expected ${economicsPolicy.policyKey}, received ${resolved.policyKey}.`);
  }
  if (resolved.source !== "policy" && resolved.source !== "fallback") {
    throw new Error("Economics policy source must be policy or fallback.");
  }
  const value = decodeEconomicsPolicyValue(resolved.value as JsonValue);
  const effectiveFrom = resolved.source === "fallback" ? null : resolved.effectiveFrom;
  if (resolved.source === "policy" && effectiveFrom === null) {
    throw new Error("An active Economics policy document must have effectiveFrom.");
  }
  if (
    resolved.source === "fallback" &&
    (resolved.documentId !== null || resolved.effectiveFrom !== null || resolved.effectiveUntil !== null)
  ) {
    throw new Error("The compiled Economics policy fallback cannot carry document validity metadata.");
  }
  if (resolved.source === "policy") {
    const activeEffectiveFrom = effectiveFrom;
    if (
      typeof resolved.documentId !== "string" ||
      resolved.documentId.length === 0 ||
      resolved.documentId.trim() !== resolved.documentId
    ) {
      throw new Error("An active Economics policy document must have an identity.");
    }
    if (activeEffectiveFrom === null) {
      throw new Error("An active Economics policy document must have effectiveFrom.");
    }
    requireRfc3339Instant(activeEffectiveFrom, "effectiveFrom");
    if (resolved.effectiveUntil !== null) {
      requireRfc3339Instant(resolved.effectiveUntil, "effectiveUntil");
      if (Date.parse(resolved.effectiveUntil) <= Date.parse(activeEffectiveFrom)) {
        throw new Error("Economics policy effectiveUntil must be after effectiveFrom.");
      }
    }
  }
  return parseResolvedEconomicsPolicy({
    value,
    policyRevision: canonicalSha256({
      policyKey: economicsPolicy.policyKey,
      source: resolved.source,
      documentId: resolved.documentId,
      effectiveFrom,
      effectiveUntil: resolved.effectiveUntil,
      decodedValue: value,
    }),
    observedAt: effectiveFrom ?? ECONOMICS_LAUNCH_POLICY_EFFECTIVE_AT,
    source: resolved.source,
    documentId: resolved.documentId,
    effectiveFrom,
    effectiveUntil: resolved.effectiveUntil,
  });
}

/** Revalidates provider-returned policy material before any dynamic value is
 * formatted or used. Presence alone is not authority: every field, document
 * posture, revision, and observed instant must reconcile. */
export function parseResolvedEconomicsPolicy(raw: unknown): ResolvedEconomicsPolicy {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("Resolved Economics policy must be an object.");
  }
  const record = raw as Record<string, unknown>;
  assertExactKeys(
    record,
    ["documentId", "effectiveFrom", "effectiveUntil", "observedAt", "policyRevision", "source", "value"],
    "Resolved Economics policy",
  );
  const value = decodeEconomicsPolicyValue(record.value as JsonValue);
  if (record.source !== "policy" && record.source !== "fallback") {
    throw new Error("Resolved Economics policy source must be policy or fallback.");
  }
  const source = record.source;
  const documentId = record.documentId;
  const effectiveFrom = record.effectiveFrom;
  const effectiveUntil = record.effectiveUntil;
  if (source === "fallback") {
    if (documentId !== null || effectiveFrom !== null || effectiveUntil !== null) {
      throw new Error("Resolved Economics fallback cannot carry document validity metadata.");
    }
  } else {
    if (typeof documentId !== "string" || documentId.length === 0 || documentId.trim() !== documentId) {
      throw new Error("Resolved Economics policy document identity is invalid.");
    }
    requireRfc3339Instant(effectiveFrom, "effectiveFrom");
    if (effectiveUntil !== null) {
      requireRfc3339Instant(effectiveUntil, "effectiveUntil");
      if (Date.parse(effectiveUntil as string) <= Date.parse(effectiveFrom as string)) {
        throw new Error("Resolved Economics policy effectiveUntil must be after effectiveFrom.");
      }
    }
  }
  const observedAt = requireRfc3339Instant(record.observedAt, "observedAt");
  const expectedObservedAt = source === "fallback" ? ECONOMICS_LAUNCH_POLICY_EFFECTIVE_AT : (effectiveFrom as string);
  if (observedAt !== expectedObservedAt) throw new Error("Resolved Economics policy observedAt is not authoritative.");
  const expectedRevision = canonicalSha256({
    policyKey: economicsPolicy.policyKey,
    source,
    documentId,
    effectiveFrom,
    effectiveUntil,
    decodedValue: value,
  });
  if (record.policyRevision !== expectedRevision) {
    throw new Error("Resolved Economics policy revision does not match its material value.");
  }
  return {
    value,
    policyRevision: expectedRevision,
    observedAt,
    source,
    documentId: documentId as string | null,
    effectiveFrom: effectiveFrom as string | null,
    effectiveUntil: effectiveUntil as string | null,
  };
}

export function assertEconomicsPolicyEffectiveAt(policy: ResolvedEconomicsPolicy, effectiveAt: string): void {
  const evaluationAt = requireRfc3339Instant(effectiveAt, "effectiveAt");
  if (Date.parse(policy.observedAt) > Date.parse(evaluationAt)) {
    throw new Error("Resolved Economics policy cannot postdate its evaluation.");
  }
  if (policy.source === "fallback") return;
  if (policy.effectiveFrom === null || Date.parse(policy.effectiveFrom) > Date.parse(evaluationAt)) {
    throw new Error("Resolved Economics policy is not yet effective at the evaluation instant.");
  }
  if (policy.effectiveUntil !== null && Date.parse(evaluationAt) >= Date.parse(policy.effectiveUntil)) {
    throw new Error("Resolved Economics policy is no longer effective at the evaluation instant.");
  }
}

function assertExactKeys(record: Record<string, unknown>, expected: readonly string[], name: string): void {
  const actual = Object.keys(record).sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${name} must contain exactly: ${expected.join(", ")}.`);
  }
}

function basisPoints(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 10_000) {
    throw new Error(`${name} must be an integer from 0 through 10000.`);
  }
  return value;
}

function positiveInteger(value: unknown, name: string, maximum: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > maximum) {
    throw new Error(`${name} must be a positive integer at most ${maximum}.`);
  }
  return value;
}

function finiteNumber(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${name} must be finite.`);
  return value;
}

function canonicalMoney(value: unknown, name: string): MoneyAmount {
  if (typeof value !== "string" || !isCanonicalMoneyAmount(value)) {
    throw new Error(`${name} must be canonical non-negative fixed-decimal money.`);
  }
  return normalizeMoneyAmount(value);
}

function canonicalSignedMoney(value: unknown, name: string): SignedMoneyAmount {
  if (typeof value !== "string") throw new Error(`${name} must be canonical signed fixed-decimal money.`);
  let normalized: SignedMoneyAmount;
  try {
    normalized = normalizeSignedMoneyAmount(value);
  } catch {
    throw new Error(`${name} must be canonical signed fixed-decimal money.`);
  }
  if (normalized !== value) throw new Error(`${name} must be canonical signed fixed-decimal money.`);
  return normalized;
}

function exactMedian(value: unknown): "median" {
  if (value !== "median") throw new Error("observationStatistic must be median.");
  return value;
}
