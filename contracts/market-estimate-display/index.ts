import { moneyToCents } from "@chase-sets/primitives/money";

export type MarketEstimateConfidence = "low" | "medium" | "high";
export type MarketEstimateDisclosure = "internal" | "account" | "public";
export type MarketEstimateAudience = "account" | "public";

export type MarketEstimateBand = Readonly<{
  lowAmount: string;
  highAmount: string;
}>;

/**
 * Pricing-owned estimate fields needed by displaying consumers. Pricing keeps
 * ownership of estimation and publication; this contract only centralizes the
 * eligibility semantics that Inventory and Collections must render alike.
 */
export type MarketEstimateForDisplay = Readonly<{
  amount: string;
  currencyCode: string;
  band: MarketEstimateBand | null;
  confidence: MarketEstimateConfidence;
  estimatedAt: string;
  freshUntil: string;
  disclosure: MarketEstimateDisclosure;
}>;

export type MarketEstimateDisplayStatus = "current" | "missing" | "stale";
export type MarketEstimateUnavailableReason = "not-found" | "not-disclosed" | "currency-mismatch" | "stale";

export type MarketEstimateDisplayDecision = Readonly<{
  status: MarketEstimateDisplayStatus;
  reason: MarketEstimateUnavailableReason | null;
  estimate: MarketEstimateForDisplay | null;
}>;

export function classifyMarketEstimateForDisplay(
  estimate: MarketEstimateForDisplay | null,
  input: Readonly<{ audience: MarketEstimateAudience; currencyCode: string; asOf: string }>,
): MarketEstimateDisplayDecision {
  if (!estimate) {
    return { status: "missing", reason: "not-found", estimate: null };
  }

  if (!isDisclosedTo(estimate.disclosure, input.audience)) {
    return { status: "missing", reason: "not-disclosed", estimate: null };
  }

  if (normalizeCurrencyCode(estimate.currencyCode) !== normalizeCurrencyCode(input.currencyCode)) {
    return { status: "missing", reason: "currency-mismatch", estimate: null };
  }

  const asOf = timestamp(input.asOf, "Valuation as-of time");
  const freshUntil = timestamp(estimate.freshUntil, "Estimate fresh-until time");
  if (freshUntil < asOf) {
    return { status: "stale", reason: "stale", estimate };
  }

  return { status: "current", reason: null, estimate };
}

export function multiplyMarketValueAmount(amount: string, quantity: number): string {
  if (!Number.isSafeInteger(quantity) || quantity < 0) {
    throw new Error("Market-value quantity must be a non-negative safe integer.");
  }
  return formatCents(moneyToCents(amount) * BigInt(quantity));
}

export function sumMarketValueAmounts(amounts: readonly string[]): string {
  return formatCents(amounts.reduce((sum, amount) => sum + marketValueToCents(amount), 0n));
}

function isDisclosedTo(disclosure: MarketEstimateDisclosure, audience: MarketEstimateAudience): boolean {
  return disclosure === "public" || (audience === "account" && disclosure === "account");
}

function normalizeCurrencyCode(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!/^[a-z]{3}$/.test(normalized)) {
    throw new Error("Market estimate currency code must be a three-letter code.");
  }
  return normalized;
}

function timestamp(value: string, fieldName: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${fieldName} must be an ISO timestamp.`);
  }
  return parsed;
}

function formatCents(cents: bigint): string {
  if (cents < 0n) {
    throw new Error("Market-value amount cannot be negative.");
  }
  return `${cents / 100n}.${(cents % 100n).toString().padStart(2, "0")}`;
}

function marketValueToCents(value: string): bigint {
  const normalized = value.trim();
  if (!/^\d+(?:\.\d{1,2})?$/.test(normalized)) {
    throw new Error("Market-value amount must be a non-negative decimal.");
  }
  const [whole = "0", fractional = ""] = normalized.split(".");
  return BigInt(whole) * 100n + BigInt(fractional.padEnd(2, "0"));
}
