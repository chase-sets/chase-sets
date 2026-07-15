import type { PgQueryable } from "@chase-sets/event-core-postgres";

export type InventoryRecoveredItemRow = Readonly<{
  recovered_item_id: string;
  return_shipment_id: string;
  remedy_id: string;
  custody_location_id: string;
  custody_identifier: string;
  evidence_references: readonly string[];
  status: string;
  catalog_item_id: string | null;
  product_id: string | null;
  selected_options: readonly Readonly<{ dimensionId: string; optionId: string }>[];
  condition_grade: string | null;
  authenticity_review_required: boolean;
  authenticity_outcome: string | null;
  disposition_authority: unknown;
  disposition: string | null;
  target_account_id: string | null;
  storage_location_id: string | null;
  sellable_at: string | null;
  merged_into_recovered_item_id: string | null;
  received_at: string;
  updated_at: string;
}>;

export async function listRecoveredItems(
  db: PgQueryable,
  params: Readonly<{ status?: string | null; limit?: number; offset?: number }> = {},
) {
  const limit = Math.max(1, Math.min(params.limit ?? 50, 250));
  const offset = Math.max(0, params.offset ?? 0);
  const status = params.status?.trim() || null;
  const result = await db.query<InventoryRecoveredItemRow & { total_count: number }>(
    `SELECT *, COUNT(*) OVER()::integer AS total_count
     FROM inventory_recovered_items
     WHERE ($1::text IS NULL OR status = $1)
     ORDER BY received_at ASC, recovered_item_id ASC
     LIMIT $2 OFFSET $3`,
    [status, limit, offset],
  );
  return {
    items: result.rows.map(({ total_count: _totalCount, ...row }) => row),
    total: Number(result.rows[0]?.total_count ?? 0),
  };
}

export async function getRecoveredItem(db: PgQueryable, recoveredItemId: string) {
  const item = await db.query<InventoryRecoveredItemRow>(
    `SELECT * FROM inventory_recovered_items WHERE recovered_item_id = $1`,
    [recoveredItemId],
  );
  if (!item.rows[0]) {
    return null;
  }
  const [audit, values] = await Promise.all([
    db.query(`SELECT * FROM inventory_recovered_item_audit WHERE recovered_item_id = $1 ORDER BY stream_version`, [
      recoveredItemId,
    ]),
    db.query(
      `SELECT * FROM inventory_recovered_item_values WHERE recovered_item_id = $1 ORDER BY recorded_at, recovery_id`,
      [recoveredItemId],
    ),
  ]);
  return { ...item.rows[0], audit: audit.rows, values: values.rows };
}

export async function getRecoveredItemMetrics(db: PgQueryable) {
  const result = await db.query<{
    total_count: number;
    unidentified_count: number;
    quarantined_count: number;
    sellable_count: number;
    terminal_count: number;
    recovered_count: number;
    recovery_rate: number;
    average_age_hours: number;
    gross_value: string;
    disposition_cost: string;
    net_recovered_value: string;
  }>(
    `SELECT
       COUNT(*)::integer AS total_count,
       COUNT(*) FILTER (WHERE status = 'awaiting-identification')::integer AS unidentified_count,
       COUNT(*) FILTER (WHERE status IN ('awaiting-identification', 'quarantined', 'inspection-complete', 'authenticity-review', 'ready-for-disposition'))::integer AS quarantined_count,
       COUNT(*) FILTER (WHERE status = 'sellable')::integer AS sellable_count,
       COUNT(*) FILTER (WHERE status IN ('transferred', 'disposed'))::integer AS terminal_count,
       (SELECT COUNT(DISTINCT recovered_item_id) FROM inventory_recovered_item_values WHERE gross_amount > 0)::integer AS recovered_count,
       COALESCE(
         (SELECT COUNT(DISTINCT recovered_item_id)::float8 FROM inventory_recovered_item_values WHERE gross_amount > 0)
         / NULLIF(COUNT(*) FILTER (WHERE status IN ('sellable', 'transferred', 'disposed')), 0),
         0
       )::float8 AS recovery_rate,
       COALESCE(AVG(EXTRACT(EPOCH FROM (now() - received_at)) / 3600), 0)::float8 AS average_age_hours,
       COALESCE((SELECT SUM(gross_amount) FROM inventory_recovered_item_values), 0)::text AS gross_value,
       COALESCE((SELECT SUM(cost_amount) FROM inventory_recovered_item_values), 0)::text AS disposition_cost,
       COALESCE((SELECT SUM(gross_amount - cost_amount) FROM inventory_recovered_item_values), 0)::text AS net_recovered_value
     FROM inventory_recovered_items`,
  );
  return result.rows[0]!;
}
