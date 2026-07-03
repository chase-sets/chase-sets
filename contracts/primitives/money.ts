import type { Branded } from "./brand";

export type MoneyAmount = Branded<string, "MoneyAmount">;
export type SignedMoneyAmount = Branded<string, "SignedMoneyAmount">;
export type MoneyRoundingMode = "ceil" | "floor" | "nearest";

export const MONEY_AMOUNT_MAX_CENTS = 999_999_999_999n;
export const MONEY_AMOUNT_MAX = "9999999999.99";

const MONEY_DECIMAL_PATTERN = /^\d+(?:\.\d{1,2})?$/;
const SIGNED_MONEY_DECIMAL_PATTERN = /^-?\d+(?:\.\d{1,2})?$/;

type ParseMoneyOptions = Readonly<{
  allowNegative?: boolean;
  maxCents?: bigint;
}>;

function parseMoneyCents(value: string, options: ParseMoneyOptions = {}): bigint | null {
  const text = value.trim();
  const pattern = options.allowNegative ? SIGNED_MONEY_DECIMAL_PATTERN : MONEY_DECIMAL_PATTERN;
  if (!pattern.test(text)) {
    return null;
  }

  const negative = text.startsWith("-");
  const unsigned = negative ? text.slice(1) : text;
  const [wholePart = "0", fractionalPart = ""] = unsigned.split(".");
  const wholeCents = BigInt(wholePart) * 100n;
  const fractionalCents = BigInt(fractionalPart.padEnd(2, "0"));
  const cents = wholeCents + fractionalCents;
  if (cents > (options.maxCents ?? MONEY_AMOUNT_MAX_CENTS)) {
    return null;
  }

  if (negative && cents > 0n) {
    return -cents;
  }
  return cents;
}

function toIntegerBigInt(value: number | bigint, fieldName: string): bigint {
  if (typeof value === "bigint") {
    return value;
  }
  if (!Number.isSafeInteger(value)) {
    throw new Error(`${fieldName} must be a safe integer.`);
  }
  return BigInt(value);
}

export function tryMoneyToCents(value: string): bigint | null {
  return parseMoneyCents(value);
}

export function trySignedMoneyToCents(value: string): bigint | null {
  return parseMoneyCents(value, { allowNegative: true });
}

export function moneyToCents(value: string): bigint {
  const cents = tryMoneyToCents(value);
  if (cents === null) {
    throw new Error(`Money amount must be a non-negative decimal at or below ${MONEY_AMOUNT_MAX}.`);
  }
  return cents;
}

export function signedMoneyToCents(value: string): bigint {
  const cents = trySignedMoneyToCents(value);
  if (cents === null) {
    throw new Error(`Money amount must be a signed decimal at or below ${MONEY_AMOUNT_MAX}.`);
  }
  return cents;
}

export function centsToMoneyAmount(cents: number | bigint): MoneyAmount {
  const value = toIntegerBigInt(cents, "Money cents");
  if (value < 0n || value > MONEY_AMOUNT_MAX_CENTS) {
    throw new Error(`Money cents must be between 0 and ${MONEY_AMOUNT_MAX_CENTS}.`);
  }
  return formatCents(value) as MoneyAmount;
}

export function centsToSignedMoneyAmount(cents: number | bigint): SignedMoneyAmount {
  const value = toIntegerBigInt(cents, "Money cents");
  if (value < -MONEY_AMOUNT_MAX_CENTS || value > MONEY_AMOUNT_MAX_CENTS) {
    throw new Error(`Money cents must be between -${MONEY_AMOUNT_MAX_CENTS} and ${MONEY_AMOUNT_MAX_CENTS}.`);
  }
  return formatCents(value) as SignedMoneyAmount;
}

export function normalizeMoneyAmount(value: string): MoneyAmount {
  return centsToMoneyAmount(moneyToCents(value));
}

export function normalizeSignedMoneyAmount(value: string): SignedMoneyAmount {
  return centsToSignedMoneyAmount(signedMoneyToCents(value));
}

export function isCanonicalMoneyAmount(value: string): value is MoneyAmount {
  return /^\d+\.\d{2}$/.test(value) && tryMoneyToCents(value) !== null && formatCents(moneyToCents(value)) === value;
}

export function addMoneyAmounts(left: string, right: string): MoneyAmount {
  return centsToMoneyAmount(moneyToCents(left) + moneyToCents(right));
}

export function addSignedMoneyAmounts(left: string, right: string): SignedMoneyAmount {
  return centsToSignedMoneyAmount(signedMoneyToCents(left) + signedMoneyToCents(right));
}

export function subtractMoneyAmounts(left: string, right: string): SignedMoneyAmount {
  return centsToSignedMoneyAmount(signedMoneyToCents(left) - signedMoneyToCents(right));
}

export function subtractNonNegativeMoneyAmounts(left: string, right: string): MoneyAmount {
  const cents = moneyToCents(left) - moneyToCents(right);
  if (cents < 0n) {
    throw new Error("Money subtraction cannot produce a negative amount.");
  }
  return centsToMoneyAmount(cents);
}

export function compareMoneyAmounts(left: string, right: string): -1 | 0 | 1 {
  const difference = signedMoneyToCents(left) - signedMoneyToCents(right);
  return difference < 0n ? -1 : difference > 0n ? 1 : 0;
}

export function sumMoneyAmounts(amounts: readonly string[]): MoneyAmount {
  return centsToMoneyAmount(amounts.reduce((sum, amount) => sum + moneyToCents(amount), 0n));
}

export function sumSignedMoneyAmounts(amounts: readonly string[]): SignedMoneyAmount {
  return centsToSignedMoneyAmount(amounts.reduce((sum, amount) => sum + signedMoneyToCents(amount), 0n));
}

export function applyBasisPointsToMoneyAmount(
  amount: string,
  basisPoints: number,
  roundingMode: MoneyRoundingMode,
): MoneyAmount {
  assertBasisPoints(basisPoints, "Basis points");
  return centsToMoneyAmount(roundRational(moneyToCents(amount) * BigInt(basisPoints), 10_000n, roundingMode));
}

export function grossUpMoneyAmountByBasisPoints(
  params: Readonly<{
    basisAmount: string;
    percentageBps: number;
    fixedAmount?: string;
    roundingMode: MoneyRoundingMode;
  }>,
): MoneyAmount {
  assertBasisPoints(params.percentageBps, "Basis points");
  if (params.percentageBps >= 10_000) {
    throw new Error("Basis points must be below 10000 when grossing up a money amount.");
  }

  const fixedCents = params.fixedAmount === undefined ? 0n : moneyToCents(params.fixedAmount);
  const numerator = moneyToCents(params.basisAmount) * BigInt(params.percentageBps) + fixedCents * 10_000n;
  return centsToMoneyAmount(roundRational(numerator, 10_000n - BigInt(params.percentageBps), params.roundingMode));
}

export function applyMoneyRatio(
  amount: string,
  numerator: number | bigint,
  denominator: number | bigint,
  roundingMode: MoneyRoundingMode,
): MoneyAmount {
  const numeratorValue = toIntegerBigInt(numerator, "Money ratio numerator");
  const denominatorValue = toIntegerBigInt(denominator, "Money ratio denominator");
  if (numeratorValue < 0n) {
    throw new Error("Money ratio numerator must be zero or greater.");
  }
  if (denominatorValue <= 0n) {
    throw new Error("Money ratio denominator must be greater than zero.");
  }
  return centsToMoneyAmount(roundRational(moneyToCents(amount) * numeratorValue, denominatorValue, roundingMode));
}

export function allocateMoneyByLargestRemainder(
  totalAmount: string,
  weights: readonly (string | number | bigint)[],
): MoneyAmount[] {
  const totalCents = moneyToCents(totalAmount);
  if (weights.length === 0) {
    return [];
  }

  const weightValues = weights.map((weight) => {
    const value = typeof weight === "string" ? moneyToCents(weight) : toIntegerBigInt(weight, "Allocation weight");
    if (value < 0n) {
      throw new Error("Allocation weights must be zero or greater.");
    }
    return value;
  });
  const totalWeight = weightValues.reduce((sum, weight) => sum + weight, 0n);
  if (totalWeight === 0n || totalCents === 0n) {
    return weightValues.map(() => centsToMoneyAmount(0n));
  }

  const allocations = weightValues.map((weight, index) => {
    const numerator = totalCents * weight;
    return {
      index,
      cents: numerator / totalWeight,
      remainder: numerator % totalWeight,
    };
  });

  let remainingCents = totalCents - allocations.reduce((sum, allocation) => sum + allocation.cents, 0n);
  const remainderOrder = [...allocations].sort(
    (left, right) =>
      Number(right.remainder > left.remainder) - Number(right.remainder < left.remainder) || left.index - right.index,
  );

  for (const allocation of remainderOrder) {
    if (remainingCents <= 0n) {
      break;
    }
    allocation.cents += 1n;
    remainingCents -= 1n;
  }

  const byIndex = [...remainderOrder].sort((left, right) => left.index - right.index);
  return byIndex.map((allocation) => centsToMoneyAmount(allocation.cents));
}

export function roundRational(
  numerator: number | bigint,
  denominator: number | bigint,
  roundingMode: MoneyRoundingMode,
): bigint {
  const numeratorValue = toIntegerBigInt(numerator, "Rounding numerator");
  const denominatorValue = toIntegerBigInt(denominator, "Rounding denominator");
  if (numeratorValue < 0n) {
    throw new Error("Rounding numerator must be zero or greater.");
  }
  if (denominatorValue <= 0n) {
    throw new Error("Rounding denominator must be greater than zero.");
  }

  const quotient = numeratorValue / denominatorValue;
  const remainder = numeratorValue % denominatorValue;
  if (remainder === 0n || roundingMode === "floor") {
    return quotient;
  }
  if (roundingMode === "ceil") {
    return quotient + 1n;
  }
  return remainder * 2n >= denominatorValue ? quotient + 1n : quotient;
}

function assertBasisPoints(value: number, fieldName: string): void {
  if (!Number.isInteger(value) || value < 0 || value > 10_000) {
    throw new Error(`${fieldName} must be an integer between 0 and 10000.`);
  }
}

function formatCents(cents: bigint): string {
  const sign = cents < 0n ? "-" : "";
  const absolute = cents < 0n ? -cents : cents;
  return `${sign}${absolute / 100n}.${(absolute % 100n).toString().padStart(2, "0")}`;
}
