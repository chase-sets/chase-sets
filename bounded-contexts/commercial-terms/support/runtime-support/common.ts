import {
  addMoneyAmounts,
  applyBasisPointsToMoneyAmount,
  centsToMoneyAmount,
  moneyToCents,
  normalizeMoneyAmount as normalizePrimitiveMoneyAmount,
  roundRational,
  subtractNonNegativeMoneyAmounts,
  tryMoneyToCents,
} from "@chase-sets/primitives/money";

export type CommercialAccountType = "personal" | "business" | "enterprise";
export type CommercialTermsStatus = "active" | "inactive";
export const DEFAULT_SHIPPING_ALLOWANCE_PERCENTAGE_BPS = 500;

export type FeeFormula = Readonly<{
  percentageBps: number;
  fixedAmount: string;
}>;

export class CommercialTermsDomainError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "CommercialTermsDomainError";
  }
}

export function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new CommercialTermsDomainError(message);
  }
}

export function assertNever(value: never): never {
  throw new CommercialTermsDomainError(`Unhandled variant: ${JSON.stringify(value)}`);
}

export function ensureIsoTimestamp(value: string, message: string) {
  assert(!Number.isNaN(Date.parse(value)), message);
  return value;
}

export function normalizeEffectiveWindow(
  effectiveFrom: string,
  effectiveUntil: string | null,
  labels: Readonly<{ from: string; until: string }>,
) {
  const normalizedFrom = ensureIsoTimestamp(effectiveFrom, `${labels.from} must be an ISO timestamp.`);
  const normalizedUntil =
    effectiveUntil === null ? null : ensureIsoTimestamp(effectiveUntil, `${labels.until} must be an ISO timestamp.`);

  assert(
    normalizedUntil === null || Date.parse(normalizedUntil) > Date.parse(normalizedFrom),
    `${labels.until} must be after ${labels.from}.`,
  );

  return { effectiveFrom: normalizedFrom, effectiveUntil: normalizedUntil };
}

export function normalizeLabel(value: string, fieldName: string) {
  const normalized = value.trim();
  assert(normalized.length > 0, `${fieldName} is required.`);
  return normalized;
}

export function normalizeMoneyAmount(
  value: string,
  options: Readonly<{ fieldName: string; allowZero?: boolean }> = {
    fieldName: "Amount",
  },
) {
  const normalized = value.trim();
  const cents = tryMoneyToCents(normalized);
  assert(cents !== null, `${options.fieldName} must be a valid decimal.`);
  assert(
    options.allowZero ? cents >= 0n : cents > 0n,
    options.allowZero
      ? `${options.fieldName} must be zero or greater.`
      : `${options.fieldName} must be greater than zero.`,
  );
  return centsToMoneyAmount(cents);
}

export function normalizePercentageBps(value: number, fieldName: string) {
  assert(Number.isInteger(value), `${fieldName} must be a whole number of basis points.`);
  assert(value >= 0, `${fieldName} must be zero or greater.`);
  assert(value <= 10_000, `${fieldName} cannot exceed 10000 basis points.`);
  return value;
}

export function normalizeCommercialAccountType(value: string): CommercialAccountType {
  assert(
    value === "personal" || value === "business" || value === "enterprise",
    "Account type must be personal, business, or enterprise.",
  );
  return value;
}

export function normalizeCommercialTermsStatus(value: string): CommercialTermsStatus {
  assert(value === "active" || value === "inactive", "Status must be active or inactive.");
  return value;
}

/**
 * Shared account-id validation for the commercial-terms-owned targeting
 * dimensions (agreement policy documents key on account id; see
 * `terms-policy.ts`). Lives here, not in a feature slice, so support-layer
 * modules (which features depend on, never the reverse) can validate account
 * ids without importing from a feature.
 */
export function normalizeCommercialAccountId(value: unknown): string {
  const accountId = typeof value === "string" ? value.trim() : "";
  assert(accountId.startsWith("acc_"), "Account ID must start with acc_.");
  return accountId;
}

export function numberToMoneyAmount(value: number) {
  assert(Number.isFinite(value), "Money amount must be finite.");
  return centsToMoneyAmount(numberToCents(value, "nearest"));
}

export function numberToMoneyAmountRoundUp(value: number) {
  if (value <= 0) {
    return "0.00";
  }

  assert(Number.isFinite(value), "Money amount must be finite.");
  return centsToMoneyAmount(numberToCents(value, "ceil"));
}

export function moneyToNumber(value: string) {
  return Number(moneyToCents(normalizeMoneyAmount(value, { fieldName: "Money amount", allowZero: true }))) / 100;
}

export function applyFeeFormula(baseAmount: string, formula: FeeFormula) {
  return addMoneyAmounts(
    applyBasisPointsToMoneyAmount(baseAmount, formula.percentageBps, "ceil"),
    normalizePrimitiveMoneyAmount(formula.fixedAmount),
  );
}

export function calculateSellerNetUnitAmount(basisAmount: string, feeAmount: string) {
  try {
    return subtractNonNegativeMoneyAmounts(basisAmount, feeAmount);
  } catch {
    throw new CommercialTermsDomainError("Marketplace sales fee cannot exceed the basis amount.");
  }
}

function numberToCents(value: number, roundingMode: "ceil" | "floor" | "nearest") {
  assert(value >= 0, "Money amount cannot be negative.");
  const [wholePart = "0", fractionalPart = ""] = value.toFixed(6).split(".");
  const scaledDollars = BigInt(wholePart) * 1_000_000n + BigInt(fractionalPart.padEnd(6, "0"));
  return roundRational(scaledDollars, 10_000n, roundingMode);
}
