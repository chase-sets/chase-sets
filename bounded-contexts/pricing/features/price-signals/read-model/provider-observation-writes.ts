import { withPgTransaction, type PgQueryable, type PgTransactionalPool } from "@chase-sets/event-core-postgres";
import type { ProviderObservationCapture } from "../domain/provider-observation-mapper";

export type MarketCaptureCursor = Readonly<{ afterExternalKey: string; generation: number }>;
export type MarketCaptureWorkItem = Readonly<{
  productExternalKey: string;
  productId: number;
  catalogItemId: string;
  skus: readonly Readonly<{ skuId: number; catalogProductKey: string }>[];
  expectedCursor: MarketCaptureCursor;
  nextCursor: MarketCaptureCursor;
}>;

type ProductReferenceRow = Readonly<{
  external_key: string;
  catalog_item_id: string;
  sku_external_key: string;
  catalog_product_key: string;
}>;

type CursorRow = Readonly<{ after_external_key: string; generation: string | number }>;

export async function selectMarketCaptureSignalWork(
  db: PgQueryable,
  providerKey: string,
  productsPerPass: number,
): Promise<readonly MarketCaptureWorkItem[]> {
  const [references, cursorResult] = await Promise.all([
    db.query<ProductReferenceRow>(
      `SELECT p.external_key,
              p.catalog_item_id,
              s.external_key AS sku_external_key,
              s.catalog_product_key
       FROM pricing_external_catalog_item_reference_inputs p
       JOIN pricing_external_product_reference_inputs s
         ON s.provider_key = p.provider_key
        AND s.catalog_item_id = p.catalog_item_id
       WHERE p.provider_key = $1
         AND p.external_key LIKE 'product:%'
         AND s.external_key LIKE 'sku:%'
       ORDER BY p.external_key, s.external_key`,
      [providerKey],
    ),
    db.query<CursorRow>(
      `SELECT after_external_key, generation
       FROM pricing_external_market_capture_cursors
       WHERE provider_key = $1`,
      [providerKey],
    ),
  ]);
  const cursorRow = cursorResult.rows[0];
  const initial: MarketCaptureCursor = {
    afterExternalKey: cursorRow?.after_external_key ?? "",
    generation: Number(cursorRow?.generation ?? 0),
  };
  const grouped = new Map<
    string,
    { catalogItemId: string; skus: Array<{ skuId: number; catalogProductKey: string }> }
  >();
  for (const row of references.rows) {
    const productId = externalNumericId(row.external_key, "product:");
    const skuId = externalNumericId(row.sku_external_key, "sku:");
    if (productId === null || skuId === null) continue;
    const product = grouped.get(row.external_key) ?? { catalogItemId: row.catalog_item_id, skus: [] };
    product.skus.push({ skuId, catalogProductKey: row.catalog_product_key });
    grouped.set(row.external_key, product);
  }
  const keys = [...grouped.keys()].sort((a, b) => a.localeCompare(b));
  if (keys.length === 0) return [];
  const afterIndex = keys.findIndex((key) => key > initial.afterExternalKey);
  const start = afterIndex >= 0 ? afterIndex : 0;
  const ordered = [...keys.slice(start), ...keys.slice(0, start)].slice(0, Math.min(productsPerPass, keys.length));
  let expected = initial;
  return ordered.map((key) => {
    const groupedProduct = grouped.get(key)!;
    const keyIndex = keys.indexOf(key);
    const afterExternalKey = keyIndex === keys.length - 1 ? "" : key;
    const next = { afterExternalKey, generation: expected.generation + 1 };
    const item: MarketCaptureWorkItem = {
      productExternalKey: key,
      productId: externalNumericId(key, "product:")!,
      catalogItemId: groupedProduct.catalogItemId,
      skus: groupedProduct.skus,
      expectedCursor: expected,
      nextCursor: next,
    };
    expected = next;
    return item;
  });
}

export async function commitProviderObservationCapture(
  pool: PgTransactionalPool,
  providerKey: string,
  work: MarketCaptureWorkItem,
  capture: ProviderObservationCapture,
): Promise<"committed" | "replayed" | "stale-worker"> {
  return withPgTransaction(pool, async (db) => {
    const cursorResult = await db.query<CursorRow>(
      `SELECT after_external_key, generation
       FROM pricing_external_market_capture_cursors
       WHERE provider_key = $1
       FOR UPDATE`,
      [providerKey],
    );
    const current = cursorResult.rows[0];
    const afterExternalKey = current?.after_external_key ?? "";
    const generation = Number(current?.generation ?? 0);
    if (afterExternalKey !== work.expectedCursor.afterExternalKey || generation !== work.expectedCursor.generation) {
      return "stale-worker";
    }

    const headerDisposition = await insertCaptureHeader(db, capture);
    if (headerDisposition === "existing") return "replayed";
    for (const row of capture.sales) {
      await db.query(
        `INSERT INTO pricing_external_sale_observations (
           capture_id, sale_fingerprint, observed_occurrence_count, provider_condition, provider_variant,
           provider_language, listing_type, sold_at, quantity, unit_price, order_shipping
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         ON CONFLICT (capture_id, sale_fingerprint) DO NOTHING`,
        [
          row.captureId,
          row.saleFingerprint,
          row.observedOccurrenceCount,
          row.providerCondition,
          row.providerVariant,
          row.providerLanguage,
          row.listingType,
          row.soldAt,
          row.quantity,
          row.unitPrice,
          row.orderShipping,
        ],
      );
    }
    for (const row of capture.weekly) {
      await db.query(
        `INSERT INTO pricing_external_weekly_sale_buckets (
           provider_key, external_key, catalog_item_id, catalog_product_key, week_start, provider_condition,
           provider_variant, provider_language, transaction_count, quantity_sold, low_sale_amount, high_sale_amount,
           low_delivered_amount, high_delivered_amount, provider_market_amount, last_capture_id, last_observed_at, updated_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$17)
         ON CONFLICT (provider_key, external_key, week_start) DO UPDATE SET
           catalog_item_id = EXCLUDED.catalog_item_id,
           catalog_product_key = EXCLUDED.catalog_product_key,
           provider_condition = EXCLUDED.provider_condition,
           provider_variant = EXCLUDED.provider_variant,
           provider_language = EXCLUDED.provider_language,
           transaction_count = EXCLUDED.transaction_count,
           quantity_sold = EXCLUDED.quantity_sold,
           low_sale_amount = EXCLUDED.low_sale_amount,
           high_sale_amount = EXCLUDED.high_sale_amount,
           low_delivered_amount = EXCLUDED.low_delivered_amount,
           high_delivered_amount = EXCLUDED.high_delivered_amount,
           provider_market_amount = EXCLUDED.provider_market_amount,
           last_capture_id = EXCLUDED.last_capture_id,
           last_observed_at = EXCLUDED.last_observed_at,
           updated_at = EXCLUDED.updated_at
         WHERE EXCLUDED.last_observed_at > pricing_external_weekly_sale_buckets.last_observed_at`,
        [
          row.providerKey,
          row.externalKey,
          row.catalogItemId,
          row.catalogProductKey,
          row.weekStart,
          row.providerCondition,
          row.providerVariant,
          row.providerLanguage,
          row.transactionCount,
          row.quantitySold,
          row.lowSaleAmount,
          row.highSaleAmount,
          row.lowDeliveredAmount,
          row.highDeliveredAmount,
          row.providerMarketAmount,
          row.captureId,
          row.observedAt,
        ],
      );
    }
    for (const row of capture.snapshots) {
      await db.query(
        `INSERT INTO pricing_external_listing_snapshots (
           provider_key, catalog_item_id, provider_variant, provider_language, provider_condition, observed_on,
           distinct_seller_count, cheapest_delivered_amount, second_cheapest_delivered_amount,
           last_capture_id, last_observed_at, updated_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11)
         ON CONFLICT (provider_key, catalog_item_id, provider_variant, provider_language, provider_condition, observed_on)
         DO UPDATE SET
           distinct_seller_count = EXCLUDED.distinct_seller_count,
           cheapest_delivered_amount = EXCLUDED.cheapest_delivered_amount,
           second_cheapest_delivered_amount = EXCLUDED.second_cheapest_delivered_amount,
           last_capture_id = EXCLUDED.last_capture_id,
           last_observed_at = EXCLUDED.last_observed_at,
           updated_at = EXCLUDED.updated_at
         WHERE EXCLUDED.last_observed_at > pricing_external_listing_snapshots.last_observed_at`,
        [
          row.providerKey,
          row.catalogItemId,
          row.providerVariant,
          row.providerLanguage,
          row.providerCondition,
          row.observedOn,
          row.distinctSellerCount,
          row.cheapestDeliveredAmount,
          row.secondCheapestDeliveredAmount,
          row.captureId,
          row.observedAt,
        ],
      );
    }
    for (const row of capture.askDepth) {
      await db.query(
        `INSERT INTO pricing_external_listing_ask_depth (
           capture_id, anonymous_capture_seller_ordinal, provider_condition, delivered_amount, coverage
         ) VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (capture_id, anonymous_capture_seller_ordinal, provider_condition, delivered_amount) DO NOTHING`,
        [row.captureId, row.anonymousCaptureSellerOrdinal, row.providerCondition, row.deliveredAmount, row.coverage],
      );
    }
    await db.query(
      `INSERT INTO pricing_external_market_capture_cursors (provider_key, after_external_key, generation, updated_at)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (provider_key) DO UPDATE SET
         after_external_key = EXCLUDED.after_external_key,
         generation = EXCLUDED.generation,
         updated_at = EXCLUDED.updated_at`,
      [providerKey, work.nextCursor.afterExternalKey, work.nextCursor.generation, capture.header.captureCompletedAt],
    );
    return "committed";
  });
}

const CAPTURE_HEADER_COLUMNS = [
  "capture_id",
  "provider_key",
  "catalog_item_id",
  "external_key",
  "signal_pass_started_at",
  "signal_policy_revision_id",
  "products_per_pass",
  "capture_started_at",
  "capture_completed_at",
  "observation_policy_revision_id",
  "stat_hygiene_policy_revision_id",
  "captures_per_pass",
  "currency",
  "authenticated_request",
  "recorded_signal_count",
  "unresolved_signal_count",
  "outcome_kind",
  "reason_code",
  "rejected_row_count",
  "sales_status",
  "sales_requested_at",
  "sales_response_observed_at",
  "sales_coverage",
  "sales_pages_fetched",
  "sales_returned_count",
  "sales_first_reported_total",
  "sales_last_reported_total",
  "sales_last_next_page",
  "listings_status",
  "listings_requested_at",
  "listings_response_observed_at",
  "listings_coverage",
  "listings_pages_fetched",
  "listings_returned_count",
  "listings_reported_total",
  "own_seller_exclusion_applied",
  "history_status",
  "history_requested_at",
  "history_response_observed_at",
  "history_coverage",
  "history_result_count",
  "history_bucket_count",
  "request_posture",
  "sales_first_result_count",
  "sales_last_result_count",
  "sales_http_status_class",
  "listings_http_status_class",
  "history_http_status_class",
  "history_range",
] as const;

async function insertCaptureHeader(
  db: PgQueryable,
  capture: ProviderObservationCapture,
): Promise<"inserted" | "existing"> {
  const h = capture.header;
  const values: readonly unknown[] = [
    h.captureId,
    h.providerKey,
    h.catalogItemId,
    h.externalKey,
    h.signalPassStartedAt,
    h.signalPolicyRevisionId,
    h.productsPerPass,
    h.captureStartedAt,
    h.captureCompletedAt,
    h.observationPolicyRevisionId,
    h.statHygienePolicyRevisionId,
    h.capturesPerPass,
    h.currency,
    h.authenticatedRequest,
    h.recordedSignalCount,
    h.unresolvedSignalCount,
    h.outcomeKind,
    h.reasonCode,
    h.rejectedRowCount,
    h.sales?.status ?? null,
    h.sales?.requestedAt ?? null,
    h.sales?.responseObservedAt ?? null,
    h.sales?.coverage ?? null,
    h.sales?.pagesFetched ?? 0,
    h.sales?.returnedCount ?? 0,
    h.sales?.firstReportedTotal ?? null,
    h.sales?.lastReportedTotal ?? null,
    h.sales?.lastNextPage ?? null,
    h.listings?.status ?? null,
    h.listings?.requestedAt ?? null,
    h.listings?.responseObservedAt ?? null,
    h.listings?.coverage ?? null,
    h.listings?.pagesFetched ?? 0,
    h.listings?.returnedCount ?? 0,
    h.listings?.reportedTotal ?? null,
    h.listings?.ownSellerExclusionApplied ?? false,
    h.history?.status ?? null,
    h.history?.requestedAt ?? null,
    h.history?.responseObservedAt ?? null,
    h.history?.coverage ?? null,
    h.history?.resultCount ?? 0,
    h.history?.bucketCount ?? 0,
    h.requestPosture ? JSON.stringify(h.requestPosture) : null,
    h.sales?.firstResultCount ?? null,
    h.sales?.lastResultCount ?? null,
    h.sales?.httpStatusClass ?? null,
    h.listings?.httpStatusClass ?? null,
    h.history?.httpStatusClass ?? null,
    h.requestPosture?.historyRange ?? null,
  ];
  const placeholders = CAPTURE_HEADER_COLUMNS.map((column, index) =>
    column === "request_posture" ? `$${index + 1}::jsonb` : `$${index + 1}`,
  );
  const inserted = await db.query<{ capture_id: string }>(
    `INSERT INTO pricing_external_market_captures (${CAPTURE_HEADER_COLUMNS.join(", ")})
     VALUES (${placeholders.join(", ")})
     ON CONFLICT (capture_id) DO NOTHING
     RETURNING capture_id`,
    values,
  );
  if (inserted.rows.length > 0) return "inserted";

  const immutablePredicates = CAPTURE_HEADER_COLUMNS.slice(1).map((column, index) =>
    column === "request_posture"
      ? `${column} IS NOT DISTINCT FROM $${index + 2}::jsonb`
      : `${column} IS NOT DISTINCT FROM $${index + 2}`,
  );
  const existing = await db.query<{ capture_id: string }>(
    `SELECT capture_id
     FROM pricing_external_market_captures
     WHERE capture_id = $1
       AND ${immutablePredicates.join("\n       AND ")}`,
    values,
  );
  if (existing.rows.length === 0) throw new Error("capture-immutable-conflict");
  return "existing";
}

function externalNumericId(value: string, prefix: string): number | null {
  if (!value.startsWith(prefix) || !/^\d+$/.test(value.slice(prefix.length))) return null;
  const parsed = Number(value.slice(prefix.length));
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}
