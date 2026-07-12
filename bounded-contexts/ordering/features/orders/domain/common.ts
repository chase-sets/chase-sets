import type { TypedUlid } from "@chase-sets/primitives/typed-ids";
import type { OrderingOrderSourceType } from "@chase-sets/checkout-order-source";
import { centsToMoneyAmount, moneyToCents, roundRational, tryMoneyToCents } from "@chase-sets/primitives/money";

export type CartLineId = TypedUlid<"cli">;
export type OrderLineId = TypedUlid<"oli">;

export type ShippingOption = "standard" | "expedited" | "priority";
export type OrderStatus = "pending-reservation" | "pending-payment" | "ready-for-fulfillment" | "cancelled";
export type OrderSourceType = OrderingOrderSourceType;

export type VersionSelectedOptionEntry = Readonly<{
  dimensionId: string;
  optionId: string;
}>;

export class OrderingDomainError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "OrderingDomainError";
  }
}

export function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new OrderingDomainError(message);
  }
}

export function assertNever(value: never): never {
  throw new OrderingDomainError(`Unhandled variant: ${JSON.stringify(value)}`);
}

export function ensurePositiveInteger(value: number, message: string) {
  assert(Number.isInteger(value) && value > 0, message);
  return value;
}

export function ensureNonNegativeInteger(value: number, message: string) {
  assert(Number.isInteger(value) && value >= 0, message);
  return value;
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

export function normalizeMoneyAmount(
  value: string,
  options: Readonly<{ allowZero?: boolean; fieldName?: string }> = {},
) {
  const normalized = value.trim();
  const fieldName = options.fieldName ?? "Amount";

  const cents = tryMoneyToCents(normalized);
  assert(cents !== null, `${fieldName} must be a valid decimal.`);

  assert(
    options.allowZero ? cents >= 0n : cents > 0n,
    `${fieldName} must be ${options.allowZero ? "zero or greater" : "greater than zero"}.`,
  );

  return centsToMoneyAmount(cents);
}

export function moneyToNumber(value: string) {
  return Number(moneyToCents(normalizeMoneyAmount(value, { allowZero: true }))) / 100;
}

export function numberToMoneyAmount(value: number) {
  assert(Number.isFinite(value) && value >= 0, "Monetary values cannot be negative.");
  return centsToMoneyAmount(numberToCents(value, "nearest"));
}

export function numberToMoneyAmountRoundDown(value: number) {
  assert(Number.isFinite(value) && value >= 0, "Monetary values cannot be negative.");
  return centsToMoneyAmount(numberToCents(value, "floor"));
}

function numberToCents(value: number, roundingMode: "ceil" | "floor" | "nearest") {
  const [wholePart = "0", fractionalPart = ""] = value.toFixed(6).split(".");
  const scaledDollars = BigInt(wholePart) * 1_000_000n + BigInt(fractionalPart.padEnd(6, "0"));
  return roundRational(scaledDollars, 10_000n, roundingMode);
}

export function normalizeVersionSelection(value: readonly VersionSelectedOptionEntry[]): VersionSelectedOptionEntry[] {
  const normalized = value
    .map((entry) => ({
      dimensionId: normalizeRequiredText(entry.dimensionId, "Selected options must include a dimension."),
      optionId: normalizeRequiredText(entry.optionId, "Selected options must include an option."),
    }))
    .sort(
      (left, right) => left.dimensionId.localeCompare(right.dimensionId) || left.optionId.localeCompare(right.optionId),
    );

  const seen = new Set<string>();
  for (const entry of normalized) {
    assert(!seen.has(entry.dimensionId), "Selected options cannot include duplicate dimensions.");
    seen.add(entry.dimensionId);
  }

  return normalized;
}

export function buildDemandSignature(productId: string) {
  return normalizeRequiredText(String(productId), "Product id is required.");
}

export function normalizeShippingOption(value: string): ShippingOption {
  switch (value.trim()) {
    case "standard":
      return "standard";
    case "expedited":
      return "expedited";
    case "priority":
      return "priority";
    default:
      throw new OrderingDomainError("Shipping option is not supported.");
  }
}
