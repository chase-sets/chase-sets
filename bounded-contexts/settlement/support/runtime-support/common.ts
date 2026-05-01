import type { AccountId, LedgerEntryId, OrderId, PaymentId, PayoutId } from "@chase-sets/primitives/typed-ids";

export type CurrencyCode = "usd";

export type LedgerEntryDirection = "credit" | "debit";

export type LedgerEntryFundsStatus = "pending" | "available";

export type LedgerEntryKind =
  | "sale"
  | "fee"
  | "rebate"
  | "refund"
  | "platform-purchase"
  | "payout"
  | "payout-reversal"
  | "adjustment";

export type PayoutStatus = "scheduled" | "in-transit" | "completed" | "failed";
export type PayoutReadinessStatus =
  | "not-started"
  | "pending"
  | "ready"
  | "restricted";
export type ProviderSetupStatus = "not-started" | "pending" | "complete";
export type ProviderCapabilityStatus = "inactive" | "pending" | "active";
export type ProviderPayoutDestinationStatus = "missing" | "pending" | "ready";

export type WalletSummary = Readonly<{
  accountId: AccountId;
  currencyCode: CurrencyCode;
  pendingBalanceAmount: string;
  availableBalanceAmount: string;
  totalCreditedAmount: string;
  totalDebitedAmount: string;
  openedAt: string | null;
  updatedAt: string | null;
}>;

export type WalletLedgerEntrySummary = Readonly<{
  ledgerEntryId: LedgerEntryId;
  accountId: AccountId;
  kind: LedgerEntryKind;
  direction: LedgerEntryDirection;
  amount: string;
  currencyCode: CurrencyCode;
  fundsStatus: LedgerEntryFundsStatus;
  orderId: OrderId | null;
  paymentId: PaymentId | null;
  payoutId: PayoutId | null;
  description: string | null;
  postedAt: string;
  availableAt: string | null;
}>;

export type PayoutSummary = Readonly<{
  payoutId: PayoutId;
  accountId: AccountId;
  amount: string;
  currencyCode: CurrencyCode;
  destinationReference: string | null;
  note: string | null;
  status: PayoutStatus;
  providerTransferReference: string | null;
  providerPayoutReference: string | null;
  providerStatus: string | null;
  providerFailureCode: string | null;
  providerFailureMessage: string | null;
  scheduledAt: string;
  sentAt: string | null;
  completedAt: string | null;
  failedAt: string | null;
  failureReason: string | null;
}>;

export type PayoutReadinessSummary = Readonly<{
  accountId: AccountId;
  status: PayoutReadinessStatus;
  missingRequirements: readonly string[];
  providerReference: string | null;
  onboardingStatus: ProviderSetupStatus;
  transferCapabilityStatus: ProviderCapabilityStatus;
  payoutCapabilityStatus: ProviderCapabilityStatus;
  payoutDestinationStatus: ProviderPayoutDestinationStatus;
  updatedAt: string;
}>;

export class SettlementDomainError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "SettlementDomainError";
  }
}

export function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new SettlementDomainError(message);
  }
}

export function assertNever(value: never): never {
  throw new SettlementDomainError(`Unhandled variant: ${JSON.stringify(value)}`);
}

export function normalizeRequiredText(value: string, message: string): string {
  const normalized = value.trim();
  assert(normalized.length > 0, message);
  return normalized;
}

export function normalizeOptionalText(value?: string | null): string | null {
  const normalized = value?.trim() ?? "";
  return normalized.length > 0 ? normalized : null;
}

export function ensureIsoTimestamp(value: string, message: string): string {
  assert(!Number.isNaN(Date.parse(value)), message);
  return value;
}

export function normalizeMoneyAmount(
  value: string,
  options: Readonly<{ allowZero?: boolean; fieldName?: string }> = {},
) {
  const normalized = value.trim();
  const fieldName = options.fieldName ?? "Amount";

  assert(
    /^\d+(\.\d{1,2})?$/.test(normalized),
    `${fieldName} must be a valid decimal.`,
  );

  const numeric = Number.parseFloat(normalized);
  assert(
    options.allowZero ? numeric >= 0 : numeric > 0,
    `${fieldName} must be ${options.allowZero ? "zero or greater" : "greater than zero"}.`,
  );

  return numeric.toFixed(2);
}

export function normalizeSignedMoneyAmount(
  value: string,
  fieldName = "Amount",
) {
  const normalized = value.trim();
  assert(
    /^-?\d+(\.\d{1,2})?$/.test(normalized),
    `${fieldName} must be a valid signed decimal.`,
  );
  return Number.parseFloat(normalized).toFixed(2);
}

function parseSignedMoneyAmount(value: string, fieldName = "Amount") {
  return Number.parseFloat(normalizeSignedMoneyAmount(value, fieldName));
}

export function addMoney(left: string, right: string) {
  return (parseSignedMoneyAmount(left) + parseSignedMoneyAmount(right)).toFixed(2);
}

export function subtractMoney(left: string, right: string) {
  return (parseSignedMoneyAmount(left) - parseSignedMoneyAmount(right)).toFixed(2);
}

export function compareMoney(left: string, right: string): -1 | 0 | 1 {
  const difference = parseSignedMoneyAmount(left) - parseSignedMoneyAmount(right);
  if (difference < 0) {
    return -1;
  }
  if (difference > 0) {
    return 1;
  }
  return 0;
}

export function normalizeCurrencyCode(value: string): CurrencyCode {
  const normalized = value.trim().toLowerCase();
  assert(normalized === "usd", "Only USD settlement is supported.");
  return normalized;
}

export function normalizeLedgerEntryDirection(value: string): LedgerEntryDirection {
  switch (value.trim()) {
    case "credit":
      return "credit";
    case "debit":
      return "debit";
    default:
      throw new SettlementDomainError("Ledger entry direction is not supported.");
  }
}

export function normalizeLedgerEntryFundsStatus(value: string): LedgerEntryFundsStatus {
  switch (value.trim()) {
    case "pending":
      return "pending";
    case "available":
      return "available";
    default:
      throw new SettlementDomainError("Ledger entry funds status is not supported.");
  }
}

export function normalizeLedgerEntryKind(value: string): LedgerEntryKind {
  switch (value.trim()) {
    case "sale":
      return "sale";
    case "fee":
      return "fee";
    case "rebate":
      return "rebate";
    case "refund":
      return "refund";
    case "platform-purchase":
      return "platform-purchase";
    case "payout":
      return "payout";
    case "payout-reversal":
      return "payout-reversal";
    case "adjustment":
      return "adjustment";
    default:
      throw new SettlementDomainError("Ledger entry kind is not supported.");
  }
}

export function normalizePayoutStatus(value: string): PayoutStatus {
  switch (value.trim()) {
    case "scheduled":
      return "scheduled";
    case "in-transit":
      return "in-transit";
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    default:
      throw new SettlementDomainError("Payout status is not supported.");
  }
}

export function normalizePayoutReadinessStatus(value: string): PayoutReadinessStatus {
  switch (value.trim()) {
    case "not-started":
      return "not-started";
    case "pending":
      return "pending";
    case "ready":
      return "ready";
    case "restricted":
      return "restricted";
    default:
      throw new SettlementDomainError("Payout readiness status is not supported.");
  }
}

export function normalizeProviderSetupStatus(value: string): ProviderSetupStatus {
  switch (value.trim()) {
    case "not-started":
      return "not-started";
    case "pending":
      return "pending";
    case "complete":
      return "complete";
    default:
      throw new SettlementDomainError("Provider setup status is not supported.");
  }
}

export function normalizeProviderCapabilityStatus(
  value: string,
): ProviderCapabilityStatus {
  switch (value.trim()) {
    case "inactive":
      return "inactive";
    case "pending":
      return "pending";
    case "active":
      return "active";
    default:
      throw new SettlementDomainError("Provider capability status is not supported.");
  }
}

export function normalizeProviderPayoutDestinationStatus(
  value: string,
): ProviderPayoutDestinationStatus {
  switch (value.trim()) {
    case "missing":
      return "missing";
    case "pending":
      return "pending";
    case "ready":
      return "ready";
    default:
      throw new SettlementDomainError(
        "Provider payout destination status is not supported.",
      );
  }
}

export function createEmptyWalletSummary(accountId: AccountId): WalletSummary {
  return {
    accountId,
    currencyCode: "usd",
    pendingBalanceAmount: "0.00",
    availableBalanceAmount: "0.00",
    totalCreditedAmount: "0.00",
    totalDebitedAmount: "0.00",
    openedAt: null,
    updatedAt: null,
  };
}
