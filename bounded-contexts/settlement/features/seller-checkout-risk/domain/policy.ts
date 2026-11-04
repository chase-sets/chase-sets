import { sellerCheckoutRiskPolicyRevision, type SellerCheckoutRiskResult } from "./contract";

/**
 * V1 deliberately exposes permission to continue, not a risk assessment.
 * These inputs remain private Settlement facts and no predicate is active yet.
 */
export type SellerCheckoutRiskPolicyFacts = Readonly<Record<string, unknown>>;

export function evaluateSellerCheckoutRisk(_facts: SellerCheckoutRiskPolicyFacts): SellerCheckoutRiskResult {
  return {
    schemaVersion: "settlement.seller-checkout-risk.v1",
    status: "clear",
    reasonCode: null,
    policyRevision: sellerCheckoutRiskPolicyRevision,
    sourceRevision: 0,
    sourceTimestamp: null,
    rowState: "absent",
  };
}
