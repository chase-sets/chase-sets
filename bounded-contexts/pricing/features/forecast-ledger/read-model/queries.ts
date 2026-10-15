import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type { RealizedOutcomes } from "../domain/cohort";
import type { ConditionSaleBucket } from "../domain/condition-rate";
import type { ForecastGrade } from "../domain/grading";
import type { ForecastGradeScope, GradedForecast, GradedLedgerEntry } from "../domain/grade-ledger";
import type { ForecastLedgerEntry } from "../domain/ledger";

/** A year of weeks before the pricing instant, plus the week that straddles the window's start. */
const CONDITION_SALES_DAYS = 364 + 7;
const PROVIDER = "tcgplayer";

/**
 * A product's weekly provider sales from weeks begun by `asOf`, as observed
 * now. A later observation replaces a week's count, so these are read when a
 * price is evaluated and its forecasts are fixed, never afterwards.
 */
export async function loadConditionSales(
  db: PgQueryable,
  input: Readonly<{ catalogItemId: string; productId: string; asOf: string }>,
): Promise<readonly ConditionSaleBucket[]> {
  const sales = await db.query<{ week_start: string; transaction_count: number }>(
    `SELECT week_start::text, sum(transaction_count)::integer AS transaction_count
     FROM pricing_external_weekly_sale_buckets
     WHERE provider_key = $1 AND catalog_item_id = $2 AND catalog_product_key = $3
       AND week_start > ($4::timestamptz - make_interval(days => $5::integer))::date AND week_start <= $4::timestamptz
     GROUP BY week_start ORDER BY week_start`,
    [PROVIDER, input.catalogItemId, input.productId, input.asOf, CONDITION_SALES_DAYS],
  );
  return sales.rows.map((row) => ({ weekStart: row.week_start, transactionCount: row.transaction_count }));
}

export async function insertForecastLedgerEntries(
  db: PgQueryable,
  entries: readonly ForecastLedgerEntry[],
  globalPosition: string,
): Promise<void> {
  if (entries.length === 0) return;
  const column = <Value>(read: (entry: ForecastLedgerEntry) => Value) => entries.map(read);
  await db.query(
    `INSERT INTO pricing_forecast_ledger_entries (
       entry_id, global_position, evaluation_id, seller_account_id, catalog_catalog_item_id, product_id,
       listing_id, role, goal_id, goal_version, curve_version, price_amount, quantity, priced_at, forecasts
     )
     SELECT entry.entry_id, $2::bigint, entry.evaluation_id, entry.seller_account_id, entry.catalog_item_id,
       entry.product_id, entry.listing_id, entry.role, entry.goal_id, entry.goal_version, entry.curve_version,
       entry.price_amount, entry.quantity, entry.priced_at, entry.forecasts
     FROM unnest(
       $1::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::text[], $8::text[], $9::text[],
       $10::integer[], $11::bigint[], $12::numeric[], $13::integer[], $14::timestamptz[], $15::jsonb[]
     ) AS entry(
       entry_id, evaluation_id, seller_account_id, catalog_item_id, product_id, listing_id, role, goal_id,
       goal_version, curve_version, price_amount, quantity, priced_at, forecasts
     )
     ON CONFLICT (entry_id) DO NOTHING`,
    [
      column((entry) => entry.entryId),
      globalPosition,
      column((entry) => entry.evaluationId),
      column((entry) => entry.sellerAccountId),
      column((entry) => entry.catalogItemId),
      column((entry) => entry.productId),
      column((entry) => entry.listingId),
      column((entry) => entry.role),
      column((entry) => entry.goalId),
      column((entry) => entry.goalVersion),
      column((entry) => entry.curveVersion),
      column((entry) => entry.priceAmount),
      column((entry) => entry.quantity),
      column((entry) => entry.pricedAt),
      column((entry) => JSON.stringify(entry.forecasts)),
    ],
  );
}

type ScopeWindow = ForecastGradeScope & Readonly<{ since: string; closedAt: string }>;

/** Goal versions and roles with an entry priced in the window. */
export async function listForecastGradeScopes(
  db: PgQueryable,
  input: Readonly<{ since: string; closedAt: string }>,
): Promise<readonly ForecastGradeScope[]> {
  const result = await db.query<{ goal_id: string; goal_version: number; role: ForecastGradeScope["role"] }>(
    `SELECT DISTINCT goal_id, goal_version, role FROM pricing_forecast_ledger_entries
     WHERE priced_at >= $1 AND priced_at < $2 ORDER BY goal_id, goal_version, role`,
    [input.since, input.closedAt],
  );
  return result.rows.map((row) => ({ goalId: row.goal_id, goalVersion: row.goal_version, role: row.role }));
}

const scopeListingsSql = `SELECT DISTINCT entry.listing_id FROM pricing_forecast_ledger_entries AS entry
  WHERE entry.goal_id = $1 AND entry.goal_version = $2 AND entry.role = $3
    AND entry.priced_at >= $4 AND entry.priced_at < $5`;

const realizedSalesSql = `SELECT listing.listing_id, trade.sold_at AS sold_at, trade.updated_at AS recorded_at,
    'trade:' || trade.order_id || ':' || trade.line_id AS sale_id
  FROM scope_listings JOIN pricing_market_listing_inputs AS listing USING (listing_id)
  JOIN pricing_market_trades AS trade
    ON trade.seller_account_id = listing.seller_account_id AND trade.inventory_item_id = listing.inventory_item_id
  WHERE trade.excluded = false AND trade.sold_at >= $4 AND trade.sold_at < $5
  UNION ALL
  SELECT listing.listing_id, observation.sale_at, observation.updated_at, 'own-sale:' || observation.sale_event_id
  FROM scope_listings JOIN pricing_market_listing_inputs AS listing USING (listing_id)
  JOIN pricing_own_sale_observations AS observation
    ON observation.seller_account_id = listing.seller_account_id
   AND observation.inventory_item_id = listing.inventory_item_id
  WHERE observation.applied_quantity > 0 AND observation.sale_at >= $4 AND observation.sale_at < $5`;

/**
 * Identifies what one scope's cohort reads: its ledger entries, its listings'
 * realized sales, and which of them are in stock. Equal versions grade equal.
 */
export async function getForecastGradingInputVersion(db: PgQueryable, scope: ScopeWindow): Promise<string> {
  const result = await db.query<{ input_version: string }>(
    `WITH scope_listings AS (${scopeListingsSql}),
     entries AS (
       SELECT count(*) AS entry_count, COALESCE(max(global_position), 0) AS entry_position
       FROM pricing_forecast_ledger_entries
       WHERE goal_id = $1 AND goal_version = $2 AND role = $3 AND priced_at >= $4 AND priced_at < $5
     ),
     sales AS (
       SELECT count(*) AS sale_count, max(recorded_at) AS sale_recorded_at,
         md5(COALESCE(string_agg(sale_id, ',' ORDER BY sale_id), '')) AS sale_ids
       FROM (${realizedSalesSql}) AS sale
     ),
     stock AS (
       SELECT md5(COALESCE(string_agg(listing.listing_id, ',' ORDER BY listing.listing_id), '')) AS in_stock
       FROM scope_listings JOIN pricing_market_listing_inputs AS listing USING (listing_id)
       WHERE listing.status <> 'withdrawn' AND listing.quantity_cap > 0
     )
     SELECT concat_ws('|', entries.entry_count, entries.entry_position, sales.sale_count,
       sales.sale_recorded_at, sales.sale_ids, stock.in_stock) AS input_version
     FROM entries, sales, stock`,
    [scope.goalId, scope.goalVersion, scope.role, scope.since, scope.closedAt],
  );
  return result.rows[0]!.input_version;
}

export async function listForecastLedgerScopeEntries(
  db: PgQueryable,
  scope: ScopeWindow,
): Promise<readonly GradedLedgerEntry[]> {
  const result = await db.query<{
    listing_id: string;
    priced_at: Date;
    quantity: number | null;
    forecasts: GradedLedgerEntry["forecasts"];
  }>(
    `SELECT listing_id, priced_at, quantity, forecasts FROM pricing_forecast_ledger_entries
     WHERE goal_id = $1 AND goal_version = $2 AND role = $3 AND priced_at >= $4 AND priced_at < $5
     ORDER BY listing_id, priced_at, entry_id`,
    [scope.goalId, scope.goalVersion, scope.role, scope.since, scope.closedAt],
  );
  return result.rows.map((row) => ({
    listingId: row.listing_id,
    pricedAt: new Date(row.priced_at).getTime(),
    quantity: row.quantity,
    forecasts: row.forecasts,
  }));
}

/**
 * Realized sales of the scope's listings, from the trades tape and the
 * Own-Sale Observation model only, matched through each listing's inventory
 * item; a trade the tape excludes was refunded, cancelled, or not a genuine
 * sale. A listing is in stock while it is not withdrawn and has quantity.
 */
export async function loadRealizedOutcomes(db: PgQueryable, scope: ScopeWindow): Promise<RealizedOutcomes> {
  const [sales, stock] = await Promise.all([
    db.query<{ listing_id: string; sold_at: Date }>(
      `WITH scope_listings AS (${scopeListingsSql})
       SELECT listing_id, sold_at FROM (${realizedSalesSql}) AS sale ORDER BY listing_id, sold_at`,
      [scope.goalId, scope.goalVersion, scope.role, scope.since, scope.closedAt],
    ),
    db.query<{ listing_id: string }>(
      `WITH scope_listings AS (${scopeListingsSql})
       SELECT listing.listing_id FROM scope_listings
       JOIN pricing_market_listing_inputs AS listing USING (listing_id)
       WHERE listing.status <> 'withdrawn' AND listing.quantity_cap > 0`,
      [scope.goalId, scope.goalVersion, scope.role, scope.since, scope.closedAt],
    ),
  ]);
  const saleTimesByListing = new Map<string, number[]>();
  for (const row of sales.rows) {
    saleTimesByListing.set(row.listing_id, [
      ...(saleTimesByListing.get(row.listing_id) ?? []),
      new Date(row.sold_at).getTime(),
    ]);
  }
  return { saleTimesByListing, inStockListingIds: new Set(stock.rows.map((row) => row.listing_id)) };
}

export type ForecastGradingInput = Readonly<{ rulesVersion: string; inputVersion: string; checkedAt: string }>;

export async function getForecastGradingInput(
  db: PgQueryable,
  scope: ForecastGradeScope & Readonly<{ closedOn: string }>,
): Promise<ForecastGradingInput | null> {
  const result = await db.query<{ rules_version: string; input_version: string; checked_at: Date }>(
    `SELECT rules_version, input_version, checked_at FROM pricing_forecast_grading_inputs
     WHERE goal_id = $1 AND goal_version = $2 AND role = $3 AND closed_on = $4::date`,
    [scope.goalId, scope.goalVersion, scope.role, scope.closedOn],
  );
  const row = result.rows[0];
  return row
    ? {
        rulesVersion: row.rules_version,
        inputVersion: row.input_version,
        checkedAt: new Date(row.checked_at).toISOString(),
      }
    : null;
}

/** Records that the scope's inputs were found unchanged. */
export async function touchForecastGradingInput(
  db: PgQueryable,
  scope: ForecastGradeScope & Readonly<{ closedOn: string; checkedAt: string }>,
): Promise<void> {
  await db.query(
    `UPDATE pricing_forecast_grading_inputs SET checked_at = $5
     WHERE goal_id = $1 AND goal_version = $2 AND role = $3 AND closed_on = $4::date`,
    [scope.goalId, scope.goalVersion, scope.role, scope.closedOn, scope.checkedAt],
  );
}

/** Replaces one scope's grades for the closed day, and records the rules they followed and the inputs they read. */
export async function replaceForecastGrades(
  db: PgQueryable,
  scope: ForecastGradeScope &
    Readonly<{ closedOn: string; rulesVersion: string; inputVersion: string; gradedAt: string }>,
  grades: readonly GradedForecast[],
): Promise<void> {
  const key = [scope.goalId, scope.goalVersion, scope.role, scope.closedOn];
  await db.query(
    `DELETE FROM pricing_forecast_grades
     WHERE goal_id = $1 AND goal_version = $2 AND role = $3 AND closed_on = $4::date`,
    key,
  );
  for (const graded of grades) {
    await db.query(
      `INSERT INTO pricing_forecast_grades (
         goal_id, goal_version, role, forecast_kind, model, horizon_days, closed_on, rules_version, input_version,
         grade, graded_at
       ) VALUES ($1, $2, $3, $5, $6, $7, $4::date, $8, $9, $10::jsonb, $11)`,
      [
        ...key,
        graded.forecastKind,
        graded.model,
        graded.horizonDays,
        scope.rulesVersion,
        scope.inputVersion,
        JSON.stringify(graded.grade),
        scope.gradedAt,
      ],
    );
  }
  await db.query(
    `INSERT INTO pricing_forecast_grading_inputs
       (goal_id, goal_version, role, closed_on, rules_version, input_version, graded_at, checked_at)
     VALUES ($1, $2, $3, $4::date, $5, $6, $7, $7)
     ON CONFLICT (goal_id, goal_version, role, closed_on)
     DO UPDATE SET rules_version = EXCLUDED.rules_version, input_version = EXCLUDED.input_version,
       graded_at = EXCLUDED.graded_at, checked_at = EXCLUDED.checked_at`,
    [...key, scope.rulesVersion, scope.inputVersion, scope.gradedAt],
  );
}

export type StoredForecastGrade = Readonly<{
  closedOn: string;
  forecastKind: string;
  model: string;
  horizonDays: number;
  grade: ForecastGrade;
}>;

/** One scope's grades of a Forecast Kind at a horizon under one set of grading rules, newest closed day first. */
export async function listForecastGrades(
  db: PgQueryable,
  input: ForecastGradeScope & Readonly<{ forecastKind: string; horizonDays: number; rulesVersion: string }>,
): Promise<readonly StoredForecastGrade[]> {
  const result = await db.query<{ closed_on: string; model: string; grade: ForecastGrade }>(
    `SELECT closed_on::text, model, grade FROM pricing_forecast_grades
     WHERE goal_id = $1 AND goal_version = $2 AND role = $3 AND forecast_kind = $4 AND horizon_days = $5
       AND rules_version = $6
     ORDER BY closed_on DESC, model`,
    [input.goalId, input.goalVersion, input.role, input.forecastKind, input.horizonDays, input.rulesVersion],
  );
  return result.rows.map((row) => ({
    closedOn: row.closed_on,
    forecastKind: input.forecastKind,
    model: row.model,
    horizonDays: input.horizonDays,
    grade: row.grade,
  }));
}
