import { definePolicy, type PolicyDefinition } from "@chase-sets/platform-policy/define-policy";
import type { JsonValue } from "@chase-sets/primitives/json";
import { SettlementDomainError } from "../../../../support/runtime-support/common";

export type MarketplaceLabelPostagePolicyValue = Readonly<{
  policyVersion: string;
  cutoverRecordedAt: string;
}>;

/**
 * Todd's recorded funding ruling is the immutable launch boundary. Keeping the
 * instant in the Settlement-owned policy value makes replay independent of a
 * worker's clock while excluding facts that predate the ruling.
 */
export const MARKETPLACE_LABEL_POSTAGE_LAUNCH_POLICY_VALUE: MarketplaceLabelPostagePolicyValue = {
  policyVersion: "marketplace-label-postage-v1",
  cutoverRecordedAt: "2026-09-10T15:46:52.000Z",
};

export function decodeMarketplaceLabelPostagePolicyValue(raw: JsonValue): MarketplaceLabelPostagePolicyValue {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new SettlementDomainError("Marketplace label postage policy value must be an object.");
  }

  const record = raw as Record<string, unknown>;
  const policyVersion = typeof record.policyVersion === "string" ? record.policyVersion.trim() : "";
  const cutoverRecordedAt = typeof record.cutoverRecordedAt === "string" ? record.cutoverRecordedAt.trim() : "";
  if (policyVersion.length === 0) {
    throw new SettlementDomainError("Marketplace label postage policy version is required.");
  }
  if (cutoverRecordedAt.length === 0 || Number.isNaN(Date.parse(cutoverRecordedAt))) {
    throw new SettlementDomainError("Marketplace label postage cutover must be an ISO timestamp.");
  }

  return { policyVersion, cutoverRecordedAt };
}

export const marketplaceLabelPostagePolicy: PolicyDefinition<MarketplaceLabelPostagePolicyValue> = definePolicy({
  policyKey: "settlement.marketplace-label-postage",
  contextName: "settlement",
  schemaSummary: "{ policyVersion: non-empty string, cutoverRecordedAt: ISO timestamp }",
  defaultValue: MARKETPLACE_LABEL_POSTAGE_LAUNCH_POLICY_VALUE,
  decodeValue: decodeMarketplaceLabelPostagePolicyValue,
});
