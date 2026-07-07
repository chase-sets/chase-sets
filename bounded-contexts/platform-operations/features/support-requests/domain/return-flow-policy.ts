export const returnFlowPolicy = {
  highValueReviewThresholdAmount: "250.00",
  sellerConditionAttestationHours: 72,
} as const;

export function isHighValueReturnAmount(orderTotalAmount: string | null) {
  return Number(orderTotalAmount ?? "0") >= Number(returnFlowPolicy.highValueReviewThresholdAmount);
}
