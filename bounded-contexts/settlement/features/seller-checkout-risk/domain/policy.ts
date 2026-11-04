/**
 * V1 deliberately exposes permission to continue, not a risk assessment.
 * These inputs remain private Settlement facts and no predicate is active yet.
 */
export function evaluateSellerCheckoutRisk() {
  return {
    status: "clear",
    reasonCode: null,
  } as const;
}
