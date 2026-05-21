import type { TypedUlid } from "@chase-sets/primitives/typed-ids";
import type { AccountId, OrderId, PaymentId } from "@chase-sets/primitives/typed-ids";

export type RefundId = TypedUlid<"rfd">;

export type PaymentStatus = "pending-confirmation" | "captured" | "failed" | "cancelled";

export type RefundStatus = "requested" | "issued" | "failed";

export type CurrencyCode = "usd";

export type PaymentProcessorName = "stripe";

export class PaymentsDomainError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "PaymentsDomainError";
  }
}

export function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new PaymentsDomainError(message);
  }
}

export function assertNever(value: never): never {
  throw new PaymentsDomainError(`Unhandled variant: ${JSON.stringify(value)}`);
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

  assert(/^\d+(\.\d{1,2})?$/.test(normalized), `${fieldName} must be a valid decimal.`);

  const numeric = Number.parseFloat(normalized);
  assert(
    options.allowZero ? numeric >= 0 : numeric > 0,
    `${fieldName} must be ${options.allowZero ? "zero or greater" : "greater than zero"}.`,
  );

  return numeric.toFixed(2);
}

export function moneyToMinorUnits(value: string): number {
  const normalized = normalizeMoneyAmount(value, {
    allowZero: true,
    fieldName: "Amount",
  });

  return Math.round(Number.parseFloat(normalized) * 100);
}

function parseMoneyAmount(value: string, options: Readonly<{ allowZero?: boolean; fieldName?: string }> = {}) {
  return Number.parseFloat(normalizeMoneyAmount(value, options));
}

export function addMoney(left: string, right: string) {
  return (parseMoneyAmount(left, { allowZero: true }) + parseMoneyAmount(right, { allowZero: true })).toFixed(2);
}

export function subtractMoney(left: string, right: string) {
  return (parseMoneyAmount(left, { allowZero: true }) - parseMoneyAmount(right, { allowZero: true })).toFixed(2);
}

export function compareMoney(left: string, right: string): -1 | 0 | 1 {
  const difference = parseMoneyAmount(left, { allowZero: true }) - parseMoneyAmount(right, { allowZero: true });
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
  assert(normalized === "usd", "Only USD payments are supported.");
  return normalized;
}

export function normalizePaymentStatus(value: string): PaymentStatus {
  switch (value.trim()) {
    case "pending-confirmation":
      return "pending-confirmation";
    case "captured":
      return "captured";
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
    default:
      throw new PaymentsDomainError("Payment status is not supported.");
  }
}

export function normalizeRefundStatus(value: string): RefundStatus {
  switch (value.trim()) {
    case "requested":
      return "requested";
    case "issued":
      return "issued";
    case "failed":
      return "failed";
    default:
      throw new PaymentsDomainError("Refund status is not supported.");
  }
}

export function normalizeProcessorName(value: string): PaymentProcessorName {
  const normalized = value.trim().toLowerCase();
  assert(normalized === "stripe", "Only Stripe payments are supported.");
  return normalized;
}

export function normalizeOrderIds(orderIds: readonly string[]): OrderId[] {
  assert(orderIds.length > 0, "Payments must include at least one order.");

  const normalized = [
    ...new Set(orderIds.map((orderId) => normalizeRequiredText(orderId, "Payments must reference valid orders."))),
  ];

  assert(normalized.length > 0, "Payments must include at least one order.");

  return normalized as OrderId[];
}

export type BuyerOrderSnapshot = Readonly<{
  orderId: OrderId;
  buyerAccountId: AccountId;
  totalAmount: string;
  status: string;
}>;

export type PaymentSummary = Readonly<{
  paymentId: PaymentId;
  buyerAccountId: AccountId;
  orderIds: readonly OrderId[];
  amount: string;
  currencyCode: CurrencyCode;
  processorName: PaymentProcessorName;
  processorPaymentReference: string;
  processorClientSecret: string | null;
  processorRedirectUrl: string | null;
  processorStatus: string;
  status: PaymentStatus;
  failureCode: string | null;
  failureMessage: string | null;
  createdAt: string;
  updatedAt: string;
  capturedAt: string | null;
  failedAt: string | null;
  cancelledAt: string | null;
}>;
