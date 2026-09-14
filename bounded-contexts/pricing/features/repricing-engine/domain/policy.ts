import { definePolicy, type PolicyDefinition } from "@chase-sets/platform-policy/define-policy";
import type { JsonValue } from "@chase-sets/primitives/json";

export type RepricingEnginePolicyValue = Readonly<{
  productRoundCooldownMinutes: number;
  pauseResumeStableHours: number;
  repauseCooldownHours: number;
  lastSoldFreshForDays: number;
  hardAskOutlierPriceRatio: number;
  spiralBreakerRounds: number;
  spiralBreakerFreezeMinutes: number;
}>;

export const REPRICING_ENGINE_LAUNCH_POLICY_VALUE: RepricingEnginePolicyValue = {
  productRoundCooldownMinutes: 30,
  pauseResumeStableHours: 12,
  repauseCooldownHours: 1,
  lastSoldFreshForDays: 30,
  hardAskOutlierPriceRatio: 10,
  spiralBreakerRounds: 3,
  spiralBreakerFreezeMinutes: 120,
};

function boundedNumber(
  record: Record<string, unknown>,
  key: keyof RepricingEnginePolicyValue,
  min: number,
  max: number,
) {
  const value = Number(record[key]);
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${key} must be between ${min} and ${max}.`);
  }
  return value;
}

export function decodeRepricingEnginePolicyValue(raw: JsonValue): RepricingEnginePolicyValue {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("Repricing-engine policy value must be an object.");
  }
  const record: Record<string, unknown> = {
    spiralBreakerRounds: REPRICING_ENGINE_LAUNCH_POLICY_VALUE.spiralBreakerRounds,
    spiralBreakerFreezeMinutes: REPRICING_ENGINE_LAUNCH_POLICY_VALUE.spiralBreakerFreezeMinutes,
    ...raw,
  };
  const spiralBreakerRounds = boundedNumber(record, "spiralBreakerRounds", 2, 10);
  if (!Number.isInteger(spiralBreakerRounds)) {
    throw new Error("spiralBreakerRounds must be an integer.");
  }
  return {
    productRoundCooldownMinutes: boundedNumber(record, "productRoundCooldownMinutes", 15, 60),
    pauseResumeStableHours: boundedNumber(record, "pauseResumeStableHours", 1, 72),
    repauseCooldownHours: boundedNumber(record, "repauseCooldownHours", 0, 24),
    lastSoldFreshForDays: boundedNumber(record, "lastSoldFreshForDays", 1, 365),
    hardAskOutlierPriceRatio: boundedNumber(record, "hardAskOutlierPriceRatio", 2, 1000),
    spiralBreakerRounds,
    spiralBreakerFreezeMinutes: boundedNumber(record, "spiralBreakerFreezeMinutes", 60, 1440),
  };
}

export const repricingEnginePolicy: PolicyDefinition<RepricingEnginePolicyValue> = definePolicy({
  policyKey: "pricing.repricing-engine",
  contextName: "pricing",
  schemaSummary:
    "{ productRoundCooldownMinutes: 15-60, pauseResumeStableHours: 1-72, repauseCooldownHours: 0-24, " +
    "lastSoldFreshForDays: 1-365, hardAskOutlierPriceRatio: 2-1000, " +
    "spiralBreakerRounds: integer 2-10, spiralBreakerFreezeMinutes: 60-1440 }",
  defaultValue: REPRICING_ENGINE_LAUNCH_POLICY_VALUE,
  decodeValue: decodeRepricingEnginePolicyValue,
});
