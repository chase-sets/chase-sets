export type CommercialAccountType = "personal" | "business" | "enterprise";
export type CommercialTermsStatus = "active" | "inactive";

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
  assert(/^\d+(\.\d{1,2})?$/.test(normalized), `${options.fieldName} must be a valid decimal.`);
  const numericValue = Number.parseFloat(normalized);
  assert(
    options.allowZero ? numericValue >= 0 : numericValue > 0,
    options.allowZero
      ? `${options.fieldName} must be zero or greater.`
      : `${options.fieldName} must be greater than zero.`,
  );
  return numericValue.toFixed(2);
}

export function normalizePercentageBps(value: number, fieldName: string) {
  assert(Number.isInteger(value), `${fieldName} must be a whole number of basis points.`);
  assert(value >= 0, `${fieldName} must be zero or greater.`);
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

export function numberToMoneyAmount(value: number) {
  return value.toFixed(2);
}

export function moneyToNumber(value: string) {
  return Number.parseFloat(
    normalizeMoneyAmount(value, {
      fieldName: "Money amount",
      allowZero: true,
    }),
  );
}

export function applyFeeFormula(baseAmount: string, formula: FeeFormula) {
  const base = moneyToNumber(baseAmount);
  const fixedAmount = moneyToNumber(formula.fixedAmount);
  return numberToMoneyAmount(base * (formula.percentageBps / 10_000) + fixedAmount);
}

export function subtractMoneyAmounts(left: string, right: string, rightTwo: string) {
  return numberToMoneyAmount(moneyToNumber(left) - moneyToNumber(right) - moneyToNumber(rightTwo));
}
