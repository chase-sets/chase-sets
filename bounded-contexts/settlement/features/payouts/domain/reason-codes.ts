import { moneyStatusLabel } from "@chase-sets/http/money-status";

export const payoutUnavailableReasonLabels = {
  "payout-setup-incomplete": moneyStatusLabel("payout-setup-incomplete"),
  "payout-setup-refresh-required": moneyStatusLabel("payout-setup-refresh-required"),
  "provider-requirements-open": moneyStatusLabel("provider-requirements-open"),
  "no-available-wallet-balance": moneyStatusLabel("no-available-wallet-balance"),
  "recent-payout-failure": moneyStatusLabel("recent-payout-failure"),
  "payout-reconciliation-required": moneyStatusLabel("payout-reconciliation-required"),
  "platform-balance-insufficient": moneyStatusLabel("platform-balance-insufficient"),
  "amount-below-minimum": moneyStatusLabel("amount-below-minimum"),
  "amount-above-maximum": moneyStatusLabel("amount-above-maximum"),
  "amount-exceeds-available-balance": moneyStatusLabel("amount-exceeds-available-balance"),
  "payout-release-hold-active": moneyStatusLabel("payout-release-hold-active"),
} as const;

export type PayoutUnavailableReasonCode = keyof typeof payoutUnavailableReasonLabels;

export function payoutUnavailableReasonLabel(code: PayoutUnavailableReasonCode | string) {
  return moneyStatusLabel(code);
}
