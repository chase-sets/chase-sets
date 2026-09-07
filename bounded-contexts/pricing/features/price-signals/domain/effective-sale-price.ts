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
  const units = BigInt(input.quantity > 0 ? input.quantity : 1);
  const unitPriceCents = canonicalCents(input.unitPrice, "unitPrice");
  const thresholdCents = canonicalCents(freeShippingThreshold, "freeShippingThreshold");
  const shippingCents = canonicalCents(input.orderShipping, "orderShipping");
  const exactCentNumerator = unitPriceCents * units + (unitPriceCents >= thresholdCents ? shippingCents : 0n);
  const roundedCents = (exactCentNumerator * 2n + units) / (units * 2n);
  return formatCents(roundedCents);
}

function canonicalCents(value: number, name: string): bigint {
  const scaled = value * 100;
  const rounded = Math.round(scaled);
  if (!Number.isFinite(value) || value < 0 || !Number.isSafeInteger(rounded) || Math.abs(scaled - rounded) > 1e-8) {
    throw new Error(`${name} must be canonical non-negative integer cents.`);
  }
  return BigInt(rounded);
}

function formatCents(cents: bigint): string {
  const whole = cents / 100n;
  const fraction = (cents % 100n).toString().padStart(2, "0");
  return `${whole}.${fraction}`;
}
