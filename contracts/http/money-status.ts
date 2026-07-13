export const moneyStatusLabels = {
  "no-payable-order-balance": "There is no payable order balance.",
  "order-not-found": "One or more orders were not found.",
  "order-not-ready": "One or more orders are not ready for payment.",
  "payout-setup-incomplete": "Finish payout setup in Chase Sets before requesting funds.",
  "payout-setup-refresh-required": "Refresh payout setup status in Chase Sets before requesting funds.",
  "payout-destination-cooling-period":
    "Confirm it is you before requesting a payout, or wait until the payout destination cooling period ends.",
  "provider-requirements-open": "Complete the requested payout setup details before requesting funds.",
  "no-available-wallet-balance": "Available balance is zero.",
  "negative-balance-active": "Recover the negative wallet balance before requesting a payout.",
  "recent-payout-failure": "Review the recent payout failure before requesting more funds.",
  "payout-reconciliation-required": "A previous payout request needs reconciliation.",
  "platform-balance-insufficient": "Funds are temporarily unavailable for payout.",
  "amount-below-minimum": "Enter an amount above the minimum payout.",
  "amount-above-maximum": "Enter an amount below the maximum payout.",
  "amount-exceeds-available-balance": "Enter an amount within the available wallet balance.",
  "support-hold-active": "Resolve open support requests before requesting these funds.",
  "payout-release-hold-active": "Recent sales are held until delivery and risk checks clear.",
  "wallet-terms-not-accepted": "Accept the current Terms of Service to use wallet balance as payment.",
} as const;

export type MoneyStatusCode = keyof typeof moneyStatusLabels;

export type MoneyStatusDetail = Readonly<{
  code: string;
  message: string;
}>;

export function moneyStatusLabel(code: MoneyStatusCode | string) {
  return moneyStatusLabels[code as MoneyStatusCode] ?? code.replaceAll("-", " ");
}

export function moneyStatusDetails(codes: readonly (MoneyStatusCode | string)[]): readonly MoneyStatusDetail[] {
  return codes.map((code) => ({
    code,
    message: moneyStatusLabel(code),
  }));
}
