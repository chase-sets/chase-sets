export type EffectiveSaleInput = Readonly<{
  quantity: number;
  unitPrice: number;
  orderShipping: number;
}>;

/** Pinned source behavior: allocate qualifying order shipping without rounding. */
export function effectiveSaleAmountExact(input: EffectiveSaleInput, freeShippingThreshold: number): number {
  const units = input.quantity > 0 ? input.quantity : 1;
  const shippingPerUnit = input.unitPrice >= freeShippingThreshold ? input.orderShipping / units : 0;
  return input.unitPrice + shippingPerUnit;
}

/** Chase money boundary: half-up exactly once, after shipping allocation. */
export function effectiveSaleAmount(input: EffectiveSaleInput, freeShippingThreshold: number): string {
  const exact = effectiveSaleAmountExact(input, freeShippingThreshold);
  return (Math.round((exact + Number.EPSILON) * 100) / 100).toFixed(2);
}
