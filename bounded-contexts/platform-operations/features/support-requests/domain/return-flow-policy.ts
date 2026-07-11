export const returnFlowPolicy = {
  highValueReviewThresholdAmount: "250.00",
  sellerConditionAttestationHours: 72,
  /**
   * Once a `return-for-refund` resolution's returned item is delivered back,
   * the seller has this long to dispute its condition before the refund
   * auto-releases on silence.
   */
  returnRefundInspectionWindowHours: 120,
} as const;

export function isHighValueReturnAmount(orderTotalAmount: string | null) {
  return Number(orderTotalAmount ?? "0") >= Number(returnFlowPolicy.highValueReviewThresholdAmount);
}
