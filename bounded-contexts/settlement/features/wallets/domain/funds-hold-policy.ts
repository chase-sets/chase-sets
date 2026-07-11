import { settlementClearancePolicy, type SettlementClearancePolicyValue } from "./clearance-policy";

/**
 * The compiled base-clearance display default, single-sourced from the
 * settlement clearance policy's compiled fallback rather than a separately
 * hardcoded day count. This is a display-only estimate for the wallet UI's
 * "days until available" copy; the authoritative maturity decision
 * (including the extended-clearance qualifiers) lives in the
 * `listPendingCreditEntriesMaturedBy` SQL predicate, which reads the resolved
 * policy directly (see `../api/runtime.ts`).
 */
export const sellerFundsHoldPolicy = {
  holdDays: settlementClearancePolicy.defaultValue.baseClearanceDays,
} as const;

export function sellerFundsAvailableAt(
  postedAt: string,
  policy: Pick<SettlementClearancePolicyValue, "baseClearanceDays"> = settlementClearancePolicy.defaultValue,
) {
  const posted = new Date(postedAt);
  if (Number.isNaN(posted.getTime())) {
    return null;
  }

  const availableAt = new Date(posted);
  availableAt.setUTCDate(availableAt.getUTCDate() + policy.baseClearanceDays);
  return availableAt.toISOString();
}

export function isSellerFundsHoldMatured(
  postedAt: string,
  now: string = new Date().toISOString(),
  policy: Pick<SettlementClearancePolicyValue, "baseClearanceDays"> = settlementClearancePolicy.defaultValue,
) {
  const availableAt = sellerFundsAvailableAt(postedAt, policy);
  return availableAt ? Date.parse(availableAt) <= Date.parse(now) : false;
}
