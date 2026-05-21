import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type { ProductAlertMarketSide } from "../domain/domain";

export type ProductAlertPageRow = Readonly<{
  alert_id: string;
  account_id: string;
  market_side: ProductAlertMarketSide;
  catalog_catalog_item_id: string;
  product_id: string;
  selected_options: readonly { dimensionId: string; optionId: string }[];
  product_summary: string | null;
  threshold_amount: string | null;
  status: "active" | "paused" | "deleted";
  created_at: string;
  updated_at: string;
}>;

type ProductAlertDbRow = Omit<ProductAlertPageRow, "selected_options"> &
  Readonly<{
    selected_options: unknown;
  }>;

export async function listProductAlerts(
  db: PgQueryable,
  input: Readonly<{ accountId: string; includeDeleted?: boolean }>,
): Promise<readonly ProductAlertPageRow[]> {
  const result = await db.query<ProductAlertDbRow>(
    `SELECT
       alert_id,
       account_id,
       market_side,
       catalog_catalog_item_id,
       product_id,
       selected_options,
       product_summary,
       threshold_amount,
       status,
       created_at,
       updated_at
     FROM discovery_product_alert_pages
     WHERE account_id = $1
       AND ($2::boolean OR status != 'deleted')
     ORDER BY updated_at DESC, alert_id DESC`,
    [input.accountId, Boolean(input.includeDeleted)],
  );

  return result.rows.map(rowToProductAlert);
}

export async function getProductAlert(
  db: PgQueryable,
  input: Readonly<{ accountId: string; alertId: string }>,
): Promise<ProductAlertPageRow | null> {
  const result = await db.query<ProductAlertDbRow>(
    `SELECT
       alert_id,
       account_id,
       market_side,
       catalog_catalog_item_id,
       product_id,
       selected_options,
       product_summary,
       threshold_amount,
       status,
       created_at,
       updated_at
     FROM discovery_product_alert_pages
     WHERE account_id = $1
       AND alert_id = $2`,
    [input.accountId, input.alertId],
  );

  return result.rows[0] ? rowToProductAlert(result.rows[0]) : null;
}

function rowToProductAlert(row: ProductAlertDbRow): ProductAlertPageRow {
  return {
    ...row,
    threshold_amount: row.threshold_amount === null ? null : String(row.threshold_amount),
    created_at: new Date(row.created_at).toISOString(),
    updated_at: new Date(row.updated_at).toISOString(),
    selected_options: Array.isArray(row.selected_options)
      ? row.selected_options.filter((entry): entry is { dimensionId: string; optionId: string } =>
          Boolean(entry && typeof entry === "object" && "dimensionId" in entry && "optionId" in entry),
        )
      : [],
  };
}
