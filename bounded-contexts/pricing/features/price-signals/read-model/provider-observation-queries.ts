import type { PgQueryable } from "@chase-sets/event-core-postgres";

export type ProviderObservationCoverage =
  | "complete"
  | "ceiling-truncated"
  | "page-budget-truncated"
  | "request-cap-truncated"
  | "inconsistent"
  | "unknown";

type SaleEvidenceRow = Readonly<{
  sale_fingerprint: string;
  observed_occurrence_count: number;
  provider_condition: string;
  provider_variant: string;
  provider_language: string;
  listing_type: string;
  sold_at: string;
  quantity: number;
  unit_price: string;
  order_shipping: string;
  capture_id: string;
  capture_started_at: string;
  currency: string;
  observation_policy_revision_id: string;
  sales_coverage: string | null;
}>;

export async function listProviderSaleEvidence(
  db: PgQueryable,
  params: Readonly<{ providerKey: string; catalogItemId: string; soldSince: string; soldUntil?: string }>,
) {
  const result = await db.query<SaleEvidenceRow>(
    `SELECT s.sale_fingerprint, s.observed_occurrence_count, s.provider_condition, s.provider_variant,
            s.provider_language, s.listing_type, s.sold_at::text, s.quantity, s.unit_price::text,
            s.order_shipping::text, s.capture_id, c.capture_started_at::text, c.currency,
            c.observation_policy_revision_id, c.sales_coverage
     FROM pricing_external_sale_observations s
     JOIN pricing_external_market_captures c ON c.capture_id = s.capture_id
     WHERE c.provider_key = $1 AND c.catalog_item_id = $2
       AND s.sold_at >= $3 AND ($4::timestamptz IS NULL OR s.sold_at < $4)
     ORDER BY s.sold_at, s.sale_fingerprint, c.capture_started_at, s.capture_id`,
    [params.providerKey, params.catalogItemId, params.soldSince, params.soldUntil ?? null],
  );
  const groups = new Map<string, SaleEvidenceRow[]>();
  for (const row of result.rows) groups.set(row.sale_fingerprint, [...(groups.get(row.sale_fingerprint) ?? []), row]);
  return [...groups.values()].map((rows) => {
    const representative = rows[0]!;
    return {
      saleFingerprint: representative.sale_fingerprint,
      providerCondition: representative.provider_condition,
      providerVariant: representative.provider_variant,
      providerLanguage: representative.provider_language,
      listingType: representative.listing_type,
      soldAt: representative.sold_at,
      quantity: representative.quantity,
      unitPrice: representative.unit_price,
      orderShipping: representative.order_shipping,
      maxObservedTupleMultiplicity: Math.max(...rows.map((row) => row.observed_occurrence_count)),
      countSemantics: "provider-returned-max-per-capture" as const,
      captureIds: rows.map((row) => row.capture_id),
      captureStartedAt: rows.at(-1)!.capture_started_at,
      currency: representative.currency,
      policyRevisionId: representative.observation_policy_revision_id,
      coverage: consolidateSaleCoverage(rows.map((row) => row.sales_coverage)),
    };
  });
}

type WeeklyRow = Readonly<{
  external_key: string;
  week_start: string;
  catalog_product_key: string | null;
  provider_condition: string;
  provider_variant: string;
  provider_language: string;
  transaction_count: number;
  quantity_sold: number;
  low_sale_amount: string | null;
  high_sale_amount: string | null;
  low_delivered_amount: string | null;
  high_delivered_amount: string | null;
  provider_market_amount: string | null;
  last_capture_id: string;
  last_observed_at: string;
}>;

export async function listProviderWeeklySaleBuckets(
  db: PgQueryable,
  params: Readonly<{ providerKey: string; catalogItemId: string; weekStartSince: string; asOf: string }>,
) {
  const result = await db.query<WeeklyRow>(
    `SELECT external_key, week_start::text, catalog_product_key, provider_condition, provider_variant,
            provider_language, transaction_count, quantity_sold, low_sale_amount::text, high_sale_amount::text,
            low_delivered_amount::text, high_delivered_amount::text, provider_market_amount::text,
            last_capture_id, last_observed_at::text
     FROM pricing_external_weekly_sale_buckets
     WHERE provider_key = $1 AND catalog_item_id = $2 AND week_start >= $3 AND last_observed_at <= $4
     ORDER BY external_key, week_start`,
    [params.providerKey, params.catalogItemId, params.weekStartSince, params.asOf],
  );
  return result.rows.map((row) => ({
    externalKey: row.external_key,
    weekStart: row.week_start,
    catalogProductKey: row.catalog_product_key,
    providerCondition: row.provider_condition,
    providerVariant: row.provider_variant,
    providerLanguage: row.provider_language,
    transactionCount: row.transaction_count,
    quantitySold: row.quantity_sold,
    lowSaleAmount: row.low_sale_amount,
    highSaleAmount: row.high_sale_amount,
    lowDeliveredAmount: row.low_delivered_amount,
    highDeliveredAmount: row.high_delivered_amount,
    providerMarketAmount: row.provider_market_amount,
    captureId: row.last_capture_id,
    observedAt: row.last_observed_at,
  }));
}

type SnapshotRow = Readonly<{
  provider_variant: string;
  provider_language: string;
  provider_condition: string;
  observed_on: string;
  distinct_seller_count: number;
  cheapest_delivered_amount: string | null;
  second_cheapest_delivered_amount: string | null;
  last_capture_id: string;
  last_observed_at: string;
  listings_coverage: ProviderObservationCoverage;
}>;

export async function listProviderListingSnapshots(
  db: PgQueryable,
  params: Readonly<{ providerKey: string; catalogItemId: string; observedSince: string; observedUntil?: string }>,
) {
  const result = await db.query<SnapshotRow>(
    `SELECT s.provider_variant, s.provider_language, s.provider_condition, s.observed_on::text,
            s.distinct_seller_count, s.cheapest_delivered_amount::text, s.second_cheapest_delivered_amount::text,
            s.last_capture_id, s.last_observed_at::text, c.listings_coverage
     FROM pricing_external_listing_snapshots s
     JOIN pricing_external_market_captures c ON c.capture_id = s.last_capture_id
     WHERE s.provider_key = $1 AND s.catalog_item_id = $2
       AND s.observed_on >= $3 AND ($4::date IS NULL OR s.observed_on < $4)
     ORDER BY s.observed_on, s.provider_variant, s.provider_language, s.provider_condition`,
    [params.providerKey, params.catalogItemId, params.observedSince, params.observedUntil ?? null],
  );
  return result.rows.map((row) => ({
    observedOn: row.observed_on,
    providerVariant: row.provider_variant,
    providerLanguage: row.provider_language,
    providerCondition: row.provider_condition,
    distinctSellerCount: row.distinct_seller_count,
    cheapestDeliveredAmount: row.cheapest_delivered_amount,
    secondCheapestDeliveredAmount: row.second_cheapest_delivered_amount,
    captureId: row.last_capture_id,
    observedAt: row.last_observed_at,
    coverage: row.listings_coverage,
  }));
}

type AskRow = Readonly<{
  capture_id: string;
  anonymous_capture_seller_ordinal: number;
  provider_condition: string;
  delivered_amount: string;
  coverage: ProviderObservationCoverage;
}>;

export async function listProviderListingAskGroups(
  db: PgQueryable,
  params: Readonly<{ providerKey: string; catalogItemId: string; captureId: string }>,
) {
  const rows = await askRows(db, params);
  return rows.map((row) => ({
    captureId: row.capture_id,
    anonymousCaptureSellerOrdinal: row.anonymous_capture_seller_ordinal,
    providerCondition: row.provider_condition,
    deliveredAmount: row.delivered_amount,
    coverage: row.coverage,
  }));
}

export async function listProviderListingAskDepth(
  db: PgQueryable,
  params: Readonly<{ providerKey: string; catalogItemId: string; captureId: string }>,
) {
  const rows = await askRows(db, params);
  const conditionAmounts = new Map<string, number[]>();
  for (const row of rows) {
    conditionAmounts.set(row.provider_condition, [
      ...(conditionAmounts.get(row.provider_condition) ?? []),
      Number(row.delivered_amount),
    ]);
  }
  const histogram = (amounts: readonly number[]) =>
    [...new Set(amounts)]
      .sort((a, b) => a - b)
      .map((amount) => ({
        deliveredAmount: amount.toFixed(2),
        cumulativeSellerCount: amounts.filter((candidate) => candidate <= amount).length,
      }));
  return {
    captureId: params.captureId,
    coverage: rows[0]?.coverage ?? "unknown",
    conditions: [...conditionAmounts.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([providerCondition, amounts]) => ({ providerCondition, points: histogram(amounts) })),
    product: histogram(rows.map((row) => Number(row.delivered_amount))),
  };
}

export async function countProviderCompetingSellersAt(
  db: PgQueryable,
  params: Readonly<{
    providerKey: string;
    catalogItemId: string;
    captureId: string;
    deliveredAmount: string;
    providerCondition?: string;
  }>,
) {
  const rows = await askRows(db, params);
  const eligible = rows.filter(
    (row) =>
      (!params.providerCondition || row.provider_condition === params.providerCondition) &&
      Number(row.delivered_amount) <= Number(params.deliveredAmount),
  );
  return {
    count: new Set(eligible.map((row) => row.anonymous_capture_seller_ordinal)).size,
    coverage: rows[0]?.coverage ?? "unknown",
  };
}

async function askRows(
  db: PgQueryable,
  params: Readonly<{ providerKey: string; catalogItemId: string; captureId: string }>,
): Promise<readonly AskRow[]> {
  const result = await db.query<AskRow>(
    `SELECT d.capture_id, d.anonymous_capture_seller_ordinal, d.provider_condition,
            d.delivered_amount::text, d.coverage
     FROM pricing_external_listing_ask_depth d
     JOIN pricing_external_market_captures c ON c.capture_id = d.capture_id
     WHERE c.provider_key = $1 AND c.catalog_item_id = $2 AND d.capture_id = $3
     ORDER BY d.provider_condition, d.delivered_amount, d.anonymous_capture_seller_ordinal`,
    [params.providerKey, params.catalogItemId, params.captureId],
  );
  return result.rows;
}

type CaptureRow = Readonly<{
  capture_id: string;
  external_key: string;
  capture_started_at: string;
  capture_completed_at: string;
  signal_pass_started_at: string;
  signal_policy_revision_id: string;
  products_per_pass: number;
  observation_policy_revision_id: string | null;
  stat_hygiene_policy_revision_id: string | null;
  captures_per_pass: number | null;
  currency: string | null;
  outcome_kind: string;
  reason_code: string | null;
  sales_status: string | null;
  listings_status: string | null;
  history_status: string | null;
  sales_coverage: string | null;
  listings_coverage: string | null;
  history_coverage: string | null;
}>;

export async function latestProviderMarketCapture(
  db: PgQueryable,
  params: Readonly<{ providerKey: string; catalogItemId: string; asOf: string }>,
) {
  const result = await db.query<CaptureRow>(
    `SELECT capture_id, external_key, capture_started_at::text, capture_completed_at::text,
            signal_pass_started_at::text, signal_policy_revision_id, products_per_pass,
            observation_policy_revision_id, stat_hygiene_policy_revision_id, captures_per_pass,
            currency, outcome_kind, reason_code, sales_status, listings_status, history_status,
            sales_coverage, listings_coverage, history_coverage
     FROM pricing_external_market_captures
     WHERE provider_key = $1 AND catalog_item_id = $2 AND capture_started_at <= $3
     ORDER BY capture_started_at DESC, capture_id DESC
     LIMIT 1`,
    [params.providerKey, params.catalogItemId, params.asOf],
  );
  const row = result.rows[0];
  return row
    ? {
        captureId: row.capture_id,
        externalKey: row.external_key,
        captureStartedAt: row.capture_started_at,
        captureCompletedAt: row.capture_completed_at,
        signalPassStartedAt: row.signal_pass_started_at,
        signalPolicyRevisionId: row.signal_policy_revision_id,
        productsPerPass: row.products_per_pass,
        observationPolicyRevisionId: row.observation_policy_revision_id,
        statHygienePolicyRevisionId: row.stat_hygiene_policy_revision_id,
        capturesPerPass: row.captures_per_pass,
        currency: row.currency,
        outcomeKind: row.outcome_kind,
        reasonCode: row.reason_code,
        endpoints: {
          sales: { status: row.sales_status, coverage: row.sales_coverage },
          listings: { status: row.listings_status, coverage: row.listings_coverage },
          history: { status: row.history_status, coverage: row.history_coverage },
        },
      }
    : null;
}

function consolidateSaleCoverage(values: readonly (string | null)[]) {
  if (values.some((value) => value === "inconsistent")) return "unknown" as const;
  if (values.some((value) => value && value !== "complete")) return "truncated-capture" as const;
  if (values.length > 0 && values.every((value) => value === "complete")) return "complete-capture" as const;
  return "unknown" as const;
}
