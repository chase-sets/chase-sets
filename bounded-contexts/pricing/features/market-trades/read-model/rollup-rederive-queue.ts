import type { PgQueryable } from "@chase-sets/event-core-postgres";

export type QueuedTradeRollupRederive = Readonly<{
  catalogItemId: string;
  productId: string;
  day: string;
  queuedAt: string;
}>;

/**
 * Loads the oldest retroactive tape changes first. The queue is deliberately
 * small and bounded per closer pass; ordinary recent days continue to use the
 * trailing-window scan in market-rollups.
 */
export async function listQueuedTradeRollupRederives(
  db: PgQueryable,
  limit: number,
): Promise<readonly QueuedTradeRollupRederive[]> {
  const result = await db.query<{
    catalog_catalog_item_id: string;
    product_id: string;
    day: string;
    queued_at: string;
  }>(
    `SELECT catalog_catalog_item_id, product_id, day::text, queued_at::text
     FROM pricing_market_trade_rollup_rederive_queue
     ORDER BY queued_at, catalog_catalog_item_id, product_id, day
     LIMIT $1`,
    [limit],
  );

  return result.rows.map((row) => ({
    catalogItemId: row.catalog_catalog_item_id,
    productId: row.product_id,
    day: row.day,
    queuedAt: row.queued_at,
  }));
}

/**
 * Acknowledges only the exact queue version that was recomputed. A concurrent
 * exclusion/re-inclusion refreshes queued_at, so this conditional delete
 * cannot erase work that arrived while the closer was running.
 */
export async function acknowledgeTradeRollupRederive(db: PgQueryable, tuple: QueuedTradeRollupRederive): Promise<void> {
  await db.query(
    `DELETE FROM pricing_market_trade_rollup_rederive_queue
     WHERE catalog_catalog_item_id = $1
       AND product_id = $2
       AND day = $3
       AND queued_at = $4`,
    [tuple.catalogItemId, tuple.productId, tuple.day, tuple.queuedAt],
  );
}
