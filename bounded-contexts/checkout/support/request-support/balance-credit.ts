import { normalizeRequestedBalanceCreditAmount as normalizePaymentBalanceCreditAmount } from "@chase-sets/payments/server";

export function normalizeRequestedBalanceCreditAmount(value: unknown): string | null {
  return normalizePaymentBalanceCreditAmount(value);
}
