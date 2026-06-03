import type { ProjectionHandlerSet } from "@chase-sets/event-core/projector";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type { JsonObject, JsonValue } from "@chase-sets/primitives/json";

const TCGPLAYER_PROVIDER_KEY = "tcgplayer";
const DEFAULT_STALE_AFTER_MS = 24 * 60 * 60 * 1000;

export type TcgplayerPriceSignalStatus = "current" | "stale" | "missing-price";

export type TcgplayerAutomationPricePointInput = Readonly<{
  skuId: number;
  marketPrice?: number | null;
  lowestPrice?: number | null;
  highestPrice?: number | null;
  priceCount?: number | null;
  calculatedAt?: string | null;
}>;

export type TcgplayerPriceSignalInput = Readonly<{
  skuId: number;
  observedAt: string;
  staleAfterMs?: number;
  pricePoint?: TcgplayerAutomationPricePointInput | null;
  latestSales?: JsonValue;
  listings?: JsonValue;
  priceHistory?: JsonValue;
  recommendation?: JsonObject;
}>;

export type TcgplayerPriceSignalRecordResult =
  | Readonly<{
      status: "unresolved";
      reason: "sku-reference-not-mapped";
      externalKey: string;
    }>
  | Readonly<{
      status: "recorded";
      signal: TcgplayerPriceSignalRecord;
    }>;

export type TcgplayerPriceSignalRecord = Readonly<{
  signalId: string;
  externalKey: string;
  catalogItemId: string;
  catalogProductKey: string;
  status: TcgplayerPriceSignalStatus;
  marketPriceAmount: string | null;
  lowestPriceAmount: string | null;
  highestPriceAmount: string | null;
  priceCount: number | null;
  calculatedAt: string | null;
  observedAt: string;
  staleAfter: string;
}>;

type PriceSignalRuntimeDeps = Readonly<{
  db: PgQueryable;
}>;

type ExternalProductReferenceRow = Readonly<{
  catalog_item_id: string;
  catalog_product_key: string;
}>;

export type PriceSignalRuntime = Readonly<{
  recordTcgplayerPriceSignal: (input: TcgplayerPriceSignalInput) => Promise<TcgplayerPriceSignalRecordResult>;
  projectors: readonly ProjectionHandlerSet[];
}>;

export function createPriceSignalRuntime(deps: PriceSignalRuntimeDeps): PriceSignalRuntime {
  return {
    recordTcgplayerPriceSignal: (input) => recordTcgplayerPriceSignal(deps.db, input),
    projectors: [],
  };
}

async function recordTcgplayerPriceSignal(
  db: PgQueryable,
  input: TcgplayerPriceSignalInput,
): Promise<TcgplayerPriceSignalRecordResult> {
  const skuId = positiveInteger(input.skuId, "TCGplayer SKU id is required.");
  const externalKey = `sku:${skuId}`;
  const observedAt = requiredIsoDate(input.observedAt, "Observed time is required.");
  const staleAfterMs = positiveInteger(input.staleAfterMs ?? DEFAULT_STALE_AFTER_MS, "Stale window must be positive.");
  const staleAfter = new Date(new Date(observedAt).getTime() + staleAfterMs).toISOString();

  const reference = await findExternalProductReference(db, externalKey);
  if (!reference) {
    return {
      status: "unresolved",
      reason: "sku-reference-not-mapped",
      externalKey,
    };
  }

  const pricePoint = input.pricePoint ?? null;
  const marketPriceAmount = money(pricePoint?.marketPrice ?? null);
  const calculatedAt = optionalIsoDate(pricePoint?.calculatedAt ?? null);
  const status = priceSignalStatus({ marketPriceAmount, calculatedAt, observedAt, staleAfterMs });
  const signal: TcgplayerPriceSignalRecord = {
    signalId: tcgplayerPriceSignalId(externalKey, observedAt),
    externalKey,
    catalogItemId: reference.catalog_item_id,
    catalogProductKey: reference.catalog_product_key,
    status,
    marketPriceAmount,
    lowestPriceAmount: money(pricePoint?.lowestPrice ?? null),
    highestPriceAmount: money(pricePoint?.highestPrice ?? null),
    priceCount: positiveIntegerOrNull(pricePoint?.priceCount ?? null),
    calculatedAt,
    observedAt,
    staleAfter,
  };

  await db.query(
    `INSERT INTO pricing_tcgplayer_price_signals (
       signal_id,
       external_key,
       catalog_item_id,
       catalog_product_key,
       status,
       market_price_amount,
       lowest_price_amount,
       highest_price_amount,
       price_count,
       calculated_at,
       observed_at,
       stale_after,
       source_payload,
       recommendation_payload,
       updated_at
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb, $14::jsonb, $11
     )
     ON CONFLICT (signal_id) DO UPDATE SET
       external_key = EXCLUDED.external_key,
       catalog_item_id = EXCLUDED.catalog_item_id,
       catalog_product_key = EXCLUDED.catalog_product_key,
       status = EXCLUDED.status,
       market_price_amount = EXCLUDED.market_price_amount,
       lowest_price_amount = EXCLUDED.lowest_price_amount,
       highest_price_amount = EXCLUDED.highest_price_amount,
       price_count = EXCLUDED.price_count,
       calculated_at = EXCLUDED.calculated_at,
       observed_at = EXCLUDED.observed_at,
       stale_after = EXCLUDED.stale_after,
       source_payload = EXCLUDED.source_payload,
       recommendation_payload = EXCLUDED.recommendation_payload,
       updated_at = EXCLUDED.updated_at`,
    [
      signal.signalId,
      signal.externalKey,
      signal.catalogItemId,
      signal.catalogProductKey,
      signal.status,
      signal.marketPriceAmount,
      signal.lowestPriceAmount,
      signal.highestPriceAmount,
      signal.priceCount,
      signal.calculatedAt,
      signal.observedAt,
      signal.staleAfter,
      JSON.stringify(sourcePayload(input)),
      JSON.stringify(input.recommendation ?? {}),
    ],
  );

  return { status: "recorded", signal };
}

async function findExternalProductReference(
  db: PgQueryable,
  externalKey: string,
): Promise<ExternalProductReferenceRow | null> {
  const result = await db.query<ExternalProductReferenceRow>(
    `SELECT catalog_item_id, catalog_product_key
     FROM pricing_external_product_reference_inputs
     WHERE provider_key = $1
       AND external_key = $2`,
    [TCGPLAYER_PROVIDER_KEY, externalKey],
  );
  return result.rows[0] ?? null;
}

function sourcePayload(input: TcgplayerPriceSignalInput): JsonObject {
  return {
    providerKey: TCGPLAYER_PROVIDER_KEY,
    skuId: input.skuId,
    pricePoint: (input.pricePoint ?? null) as JsonValue,
    latestSales: input.latestSales ?? null,
    listings: input.listings ?? null,
    priceHistory: input.priceHistory ?? null,
  };
}

function priceSignalStatus(
  input: Readonly<{
    marketPriceAmount: string | null;
    calculatedAt: string | null;
    observedAt: string;
    staleAfterMs: number;
  }>,
): TcgplayerPriceSignalStatus {
  if (!input.marketPriceAmount) {
    return "missing-price";
  }
  if (!input.calculatedAt) {
    return "stale";
  }
  const ageMs = new Date(input.observedAt).getTime() - new Date(input.calculatedAt).getTime();
  return ageMs > input.staleAfterMs ? "stale" : "current";
}

function tcgplayerPriceSignalId(externalKey: string, observedAt: string): string {
  return `tcgplayer_price_${externalKey.replace(/[^A-Za-z0-9]+/g, "_")}_${observedAt.replace(/[^A-Za-z0-9]+/g, "_")}`;
}

function money(value: number | null): string | null {
  if (value === null || !Number.isFinite(value) || value <= 0) {
    return null;
  }
  return value.toFixed(2);
}

function requiredIsoDate(value: string, message: string): string {
  const normalized = value.trim();
  if (!normalized || Number.isNaN(new Date(normalized).getTime())) {
    throw new Error(message);
  }
  return new Date(normalized).toISOString();
}

function optionalIsoDate(value: string | null): string | null {
  if (!value?.trim()) {
    return null;
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function positiveInteger(value: number, message: string): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(message);
  }
  return value;
}

function positiveIntegerOrNull(value: number | null): number | null {
  if (value === null || !Number.isInteger(value) || value < 0) {
    return null;
  }
  return value;
}
