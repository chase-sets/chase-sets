import { definePolicy, type PolicyDefinition } from "@chase-sets/platform-policy/define-policy";
import type { JsonValue } from "@chase-sets/primitives/json";
import { compareMoney, normalizeMoneyAmount, SettlementDomainError } from "../../../support/runtime-support/common";

/**
 * The settlement clearance policy: how long a seller's sale credit stays
 * pending before it matures into available balance, and the high-value
 * threshold that upgrades an order onto the extended clearance window. This
 * is settlement's own runtime-configurable cash-flow dial on the shared
 * platform-policy machinery -- settlement both owns the schema/admin routes
 * (see `../api/clearance-policy-route.ts`) and is the only consumer (the
 * maturity query in `../read-model/queries.ts` and the display estimate in
 * `./funds-hold-policy.ts`), so no cross-context host port is needed.
 *
 * The qualifying conditions that pick base vs. extended clearance (trusted
 * seller, manual review, zero reviews, linked-risk clusters, trust-signal
 * eligibility) stay in the SQL predicate as domain logic -- only the NUMBERS
 * (the two day counts and the dollar threshold) move onto this policy.
 */

export type SettlementClearancePolicyValue = Readonly<{
  /** Days a sale credit stays pending before maturing, absent an extended-clearance qualifier. */
  baseClearanceDays: number;
  /** Days a sale credit stays pending when an extended-clearance qualifier applies (must be >= baseClearanceDays). */
  extendedClearanceDays: number;
  /** Order amount at or above which a sale independently qualifies for the extended clearance window. */
  highValueThresholdAmount: string;
}>;

/** The launch values (2-day base, 7-day extended, $250 high-value threshold) -- the migration's byte-identical seed and compiled fallback. */
export const SETTLEMENT_CLEARANCE_LAUNCH_POLICY_VALUE: SettlementClearancePolicyValue = {
  baseClearanceDays: 2,
  extendedClearanceDays: 7,
  highValueThresholdAmount: "250.00",
};

const MIN_CLEARANCE_DAYS = 0;
const MAX_CLEARANCE_DAYS = 30;

function normalizeClearanceDays(value: unknown, fieldName: string): number {
  const numeric = Number(value);
  if (!Number.isInteger(numeric) || numeric < MIN_CLEARANCE_DAYS || numeric > MAX_CLEARANCE_DAYS) {
    throw new SettlementDomainError(
      `${fieldName} must be a whole number of days between ${MIN_CLEARANCE_DAYS} and ${MAX_CLEARANCE_DAYS}.`,
    );
  }
  return numeric;
}

export function decodeSettlementClearancePolicyValue(raw: JsonValue): SettlementClearancePolicyValue {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new SettlementDomainError("Settlement clearance policy value must be an object.");
  }
  const record = raw as Record<string, unknown>;

  const baseClearanceDays = normalizeClearanceDays(record.baseClearanceDays, "Base clearance days");
  const extendedClearanceDays = normalizeClearanceDays(record.extendedClearanceDays, "Extended clearance days");
  if (extendedClearanceDays < baseClearanceDays) {
    throw new SettlementDomainError("Extended clearance days must be at least the base clearance days.");
  }

  const highValueThresholdAmount = normalizeMoneyAmount(String(record.highValueThresholdAmount ?? ""), {
    fieldName: "High-value threshold amount",
    allowZero: true,
  });
  if (compareMoney(highValueThresholdAmount, "0.00") < 0) {
    throw new SettlementDomainError("High-value threshold amount must be zero or greater.");
  }

  return { baseClearanceDays, extendedClearanceDays, highValueThresholdAmount };
}

export const settlementClearancePolicy: PolicyDefinition<SettlementClearancePolicyValue> = definePolicy({
  policyKey: "settlement.clearance-window",
  contextName: "settlement",
  schemaSummary:
    "{ baseClearanceDays: integer 0-30, extendedClearanceDays: integer 0-30 (>= base), highValueThresholdAmount: decimal string >= 0 }",
  defaultValue: SETTLEMENT_CLEARANCE_LAUNCH_POLICY_VALUE,
  decodeValue: decodeSettlementClearancePolicyValue,
});
