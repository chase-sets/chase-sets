function isAuthorizedOrder(values: unknown, orderId: string): boolean {
  return Array.isArray(values) && values.length === 1 && values[0] === orderId;
}

export function assertSubmittingOrderIds(formValues: string[], orderId: string): void {
  if (!isAuthorizedOrder(formValues, orderId)) {
    throw new Error(
      "Stripe embed UAT payment creation refused: the submitting form does not match the authorized order.",
    );
  }
}

export function assertPaymentOrderIds(orderIds: unknown, orderId: string): void {
  if (!isAuthorizedOrder(orderIds, orderId)) {
    throw new Error(
      "Stripe embed UAT card entry and confirmation refused: the payment does not match the authorized order.",
    );
  }
}
