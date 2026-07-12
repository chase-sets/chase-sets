import type { PgQueryable } from "@chase-sets/event-core-postgres";

export type BulkRepriceRowOutcome = "applied" | "unchanged" | "failed";

export type BulkRepriceRow = Readonly<{
  job_id: string;
  row_number: number;
  seller_sku: string | null;
  listing_id: string | null;
  requested_price_amount: string | null;
  resolved_listing_id: string | null;
  previous_price_amount: string | null;
  outcome: BulkRepriceRowOutcome;
  error_message: string | null;
  updated_at: string;
}>;

export type BulkRepriceRowUpsert = Readonly<{
  rowNumber: number;
  sellerSku: string | null;
  listingId: string | null;
  requestedPriceAmount: string | null;
  resolvedListingId: string | null;
  previousPriceAmount: string | null;
  outcome: BulkRepriceRowOutcome;
  errorMessage: string | null;
}>;

/** Bulk-upserts one processing wave's row outcomes in a single round trip. */
export async function upsertBulkRepriceRows(
  db: PgQueryable,
  params: Readonly<{ jobId: string; rows: readonly BulkRepriceRowUpsert[] }>,
): Promise<void> {
  if (params.rows.length === 0) {
    return;
  }

  const values: unknown[] = [];
  const placeholders = params.rows.map((row, index) => {
    const base = index * 9;
    values.push(
      params.jobId,
      row.rowNumber,
      row.sellerSku,
      row.listingId,
      row.requestedPriceAmount,
      row.resolvedListingId,
      row.previousPriceAmount,
      row.outcome,
      row.errorMessage,
    );
    return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}, $${base + 8}, $${base + 9}, now())`;
  });

  await db.query(
    `INSERT INTO pricing_bulk_reprice_rows
       (job_id, row_number, seller_sku, listing_id, requested_price_amount, resolved_listing_id, previous_price_amount, outcome, error_message, updated_at)
     VALUES ${placeholders.join(", ")}
     ON CONFLICT (job_id, row_number) DO UPDATE SET
       seller_sku = EXCLUDED.seller_sku,
       listing_id = EXCLUDED.listing_id,
       requested_price_amount = EXCLUDED.requested_price_amount,
       resolved_listing_id = EXCLUDED.resolved_listing_id,
       previous_price_amount = EXCLUDED.previous_price_amount,
       outcome = EXCLUDED.outcome,
       error_message = EXCLUDED.error_message,
       updated_at = now()`,
    values,
  );
}

export async function listBulkRepriceRows(
  db: PgQueryable,
  params: Readonly<{ jobId: string; limit?: number; offset?: number }>,
): Promise<readonly BulkRepriceRow[]> {
  const result = await db.query<BulkRepriceRow>(
    `SELECT job_id, row_number, seller_sku, listing_id,
            requested_price_amount::text AS requested_price_amount,
            resolved_listing_id,
            previous_price_amount::text AS previous_price_amount,
            outcome, error_message, updated_at
     FROM pricing_bulk_reprice_rows
     WHERE job_id = $1
     ORDER BY row_number ASC
     LIMIT $2 OFFSET $3`,
    [params.jobId, params.limit ?? 1_000_000, params.offset ?? 0],
  );
  return result.rows;
}

export type BulkRepriceRowOutcomeSummary = Readonly<{
  applied: number;
  unchanged: number;
  failed: number;
  total: number;
}>;

export async function summarizeBulkRepriceRowOutcomes(
  db: PgQueryable,
  params: Readonly<{ jobId: string }>,
): Promise<BulkRepriceRowOutcomeSummary> {
  const result = await db.query<{ outcome: BulkRepriceRowOutcome; count: string }>(
    `SELECT outcome, COUNT(*)::text AS count
     FROM pricing_bulk_reprice_rows
     WHERE job_id = $1
     GROUP BY outcome`,
    [params.jobId],
  );
  const byOutcome = new Map(result.rows.map((row) => [row.outcome, Number(row.count)]));
  const applied = byOutcome.get("applied") ?? 0;
  const unchanged = byOutcome.get("unchanged") ?? 0;
  const failed = byOutcome.get("failed") ?? 0;
  return { applied, unchanged, failed, total: applied + unchanged + failed };
}

/** Counts an account's queued/running bulk-reprice jobs -- backs the "one active job per account" cap. */
export async function countActiveBulkRepriceJobsForAccount(
  db: PgQueryable,
  params: Readonly<{ accountId: string }>,
): Promise<number> {
  const result = await db.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count
     FROM pricing_bulk_reprice_jobs
     WHERE status IN ('queued', 'running')
       AND (event_context->'audit'->>'forAccountId') = $1`,
    [params.accountId],
  );
  return Number(result.rows[0]?.count ?? "0");
}
