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
    minimumCostBasisCoverageBps: basisPoints(
      record.minimumCostBasisCoverageBps,
      "minimumCostBasisCoverageBps",
    ),
    defaultObservedHoldDays: positiveInteger(record.defaultObservedHoldDays, "defaultObservedHoldDays", MAX_DAYS),
    defaultTurnaroundDays: positiveInteger(record.defaultTurnaroundDays, "defaultTurnaroundDays", MAX_DAYS),
    defaultDailyReturnHurdle: finiteNumber(record.defaultDailyReturnHurdle, "defaultDailyReturnHurdle"),
    observationWindowDays,
    minimumHoldSamples: positiveInteger(record.minimumHoldSamples, "minimumHoldSamples", MAX_SAMPLES),
    minimumTurnaroundSamples: positiveInteger(
      record.minimumTurnaroundSamples,
      "minimumTurnaroundSamples",
      MAX_SAMPLES,
    ),
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
  const value = decodeEconomicsPolicyValue(resolved.value as JsonValue);
  const effectiveFrom = resolved.source === "fallback" ? null : resolved.effectiveFrom;
  if (resolved.source === "policy" && effectiveFrom === null) {
    throw new Error("An active Economics policy document must have effectiveFrom.");
  }
  return {
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
  };
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
