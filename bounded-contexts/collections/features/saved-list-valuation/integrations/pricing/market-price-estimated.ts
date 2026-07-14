import { compareMoneyAmounts, normalizeMoneyAmount } from "@chase-sets/primitives/money";
import type { MarketEstimateConfidence, MarketEstimateDisclosure } from "@chase-sets/market-estimate-display";
import type { SavedListMarketEstimate } from "../../domain/contracts";

export type MarketPriceEstimatedEventData = Readonly<{
  schemaVersion: 1;
  catalogItemId: string;
  productId: string;
  estimateVersion: string;
  window: Readonly<{ startedAt: string; endedAt: string }>;
  amount: string;
  currencyCode: string;
  band: Readonly<{ lowAmount: string; highAmount: string }> | null;
  confidence: MarketEstimateConfidence;
  estimatedAt: string;
  freshUntil: string;
  disclosure: MarketEstimateDisclosure;
}>;

/**
 * Anti-corruption boundary for Pricing's published estimate fact. The
 * publisher owns the wire vocabulary; Collections immediately normalizes it
 * into the smaller display contract needed by Saved List valuation.
 */
export function decodeMarketPriceEstimated(data: unknown): SavedListMarketEstimate {
  const record = object(data, "MarketPriceEstimated data");
  if (record.schemaVersion !== 1) {
    throw new Error("MarketPriceEstimated schema version must be 1.");
  }
  const window = object(record.window, "MarketPriceEstimated window");
  const band = record.band === null ? null : object(record.band, "MarketPriceEstimated band");
  const amount = normalizeMoneyAmount(text(record.amount, "amount"));
  const lowAmount = band ? normalizeMoneyAmount(text(band.lowAmount, "band.lowAmount")) : null;
  const highAmount = band ? normalizeMoneyAmount(text(band.highAmount, "band.highAmount")) : null;
  if (
    lowAmount &&
    highAmount &&
    (compareMoneyAmounts(lowAmount, amount) > 0 || compareMoneyAmounts(amount, highAmount) > 0)
  ) {
    throw new Error("MarketPriceEstimated band must contain its estimate amount.");
  }
  const windowStartedAt = isoTimestamp(window.startedAt, "window.startedAt");
  const windowEndedAt = isoTimestamp(window.endedAt, "window.endedAt");
  const estimatedAt = isoTimestamp(record.estimatedAt, "estimatedAt");
  const freshUntil = isoTimestamp(record.freshUntil, "freshUntil");
  if (Date.parse(windowEndedAt) < Date.parse(windowStartedAt)) {
    throw new Error("MarketPriceEstimated window must end after it starts.");
  }
  if (Date.parse(freshUntil) < Date.parse(estimatedAt)) {
    throw new Error("MarketPriceEstimated freshUntil must not precede estimatedAt.");
  }

  return {
    catalogItemId: text(record.catalogItemId, "catalogItemId"),
    productId: text(record.productId, "productId"),
    estimateVersion: text(record.estimateVersion, "estimateVersion"),
    windowStartedAt,
    windowEndedAt,
    amount,
    currencyCode: currencyCode(record.currencyCode),
    band: lowAmount && highAmount ? { lowAmount, highAmount } : null,
    confidence: oneOf(record.confidence, ["low", "medium", "high"] as const, "confidence"),
    estimatedAt,
    freshUntil,
    disclosure: oneOf(record.disclosure, ["internal", "account", "public"] as const, "disclosure"),
  };
}

function object(value: unknown, fieldName: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${fieldName} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, fieldName: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`MarketPriceEstimated ${fieldName} is required.`);
  }
  return value.trim();
}

function isoTimestamp(value: unknown, fieldName: string): string {
  const normalized = text(value, fieldName);
  if (!Number.isFinite(Date.parse(normalized))) {
    throw new Error(`MarketPriceEstimated ${fieldName} must be an ISO timestamp.`);
  }
  return normalized;
}

function currencyCode(value: unknown): string {
  const normalized = text(value, "currencyCode").toLowerCase();
  if (!/^[a-z]{3}$/.test(normalized)) {
    throw new Error("MarketPriceEstimated currencyCode must be a three-letter code.");
  }
  return normalized;
}

function oneOf<const TValues extends readonly string[]>(
  value: unknown,
  values: TValues,
  fieldName: string,
): TValues[number] {
  if (typeof value !== "string" || !values.includes(value)) {
    throw new Error(`MarketPriceEstimated ${fieldName} is invalid.`);
  }
  return value as TValues[number];
}
