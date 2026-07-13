import { moneyStatusLabel } from "@chase-sets/http/money-status";

export const checkoutUnavailableReasonLabels = {
  "no-payable-order-balance": moneyStatusLabel("no-payable-order-balance"),
  "order-not-found": moneyStatusLabel("order-not-found"),
  "order-not-ready": moneyStatusLabel("order-not-ready"),
  "wallet-terms-not-accepted": moneyStatusLabel("wallet-terms-not-accepted"),
} as const;

export type CheckoutUnavailableReasonCode = keyof typeof checkoutUnavailableReasonLabels;

export function checkoutUnavailableReasonLabel(code: CheckoutUnavailableReasonCode | string) {
  return moneyStatusLabel(code);
}
