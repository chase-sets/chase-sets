import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type { VersionSelectedOptionEntry } from "../../../support/runtime-support/common";

export type CheckoutSellListLineRow = Readonly<{
  seller_account_id: string;
  line_id: string;
  line_type: "selected-offer" | "product";
  offer_id: string | null;
  buyer_account_id: string | null;
  buyer_display_name: string | null;
  offer_price_amount: string | null;
  catalog_catalog_item_id: string;
  product_id: string;
  item_title: string;
  item_subtitle: string | null;
  selected_options: readonly VersionSelectedOptionEntry[];
  product_summary: string | null;
  quantity: number;
  fallback_mode: "none" | "create-listing";
  minimum_listing_price_amount: string | null;
  created_at: string;
  updated_at: string;
}>;

export type CheckoutSellListReceiptRow = Readonly<{
  seller_account_id: string;
  execution_id: string | null;
  checked_out_at: string;
  execution_summary: Readonly<{
    acceptedOfferCount?: number;
    createdListingCount?: number;
    skippedLineCount?: number;
    skippedReasons?: readonly string[];
    lineOutcomes?: readonly Readonly<{
      lineId: string;
      itemTitle: string;
      status: "completed" | "partial" | "skipped";
      action: "accepted-offer" | "accepted-smart-match" | "created-listing" | "mixed" | "kept-in-sell-list";
      quantity: number;
      remainingQuantity: number;
      detail: string;
    }>[];
  }>;
}>;

export type CheckoutSellListExecutionRow = Readonly<{
  seller_account_id: string;
  execution_id: string;
  status: "pending" | "finalized";
  execution_plan: unknown;
  execution_progress: unknown;
  execution_summary: CheckoutSellListReceiptRow["execution_summary"] | null;
  created_at: string;
  updated_at: string;
  finalized_at: string | null;
}>;

type SellListPageRow = Omit<CheckoutSellListLineRow, "selected_options" | "line_type" | "fallback_mode"> & {
  selected_options: unknown;
  line_type: string;
  fallback_mode: string;
};

type SellListReceiptPageRow = Omit<CheckoutSellListReceiptRow, "execution_summary"> & { execution_summary: unknown };
type SellListExecutionPageRow = Omit<CheckoutSellListExecutionRow, "status" | "execution_summary"> & {
  status: string;
  execution_summary: unknown;
};

function mapSellListLine(row: SellListPageRow): CheckoutSellListLineRow {
  return {
    ...row,
    line_type: row.line_type === "selected-offer" ? "selected-offer" : "product",
    fallback_mode: row.fallback_mode === "create-listing" ? "create-listing" : "none",
    selected_options: Array.isArray(row.selected_options) ? (row.selected_options as VersionSelectedOptionEntry[]) : [],
  };
}

export async function listSellListLines(db: PgQueryable, sellerAccountId: string): Promise<CheckoutSellListLineRow[]> {
  const result = await db.query<SellListPageRow>(
    `SELECT
       seller_account_id,
       line_id,
       line_type,
       offer_id,
       buyer_account_id,
       buyer_display_name,
       offer_price_amount,
       catalog_catalog_item_id,
       product_id,
       item_title,
       item_subtitle,
       selected_options,
       product_summary,
       quantity,
       fallback_mode,
       minimum_listing_price_amount,
       created_at,
       updated_at
     FROM checkout_sell_list_line_pages
     WHERE seller_account_id = $1
     ORDER BY updated_at DESC, line_id ASC`,
    [sellerAccountId],
  );

  return result.rows.map(mapSellListLine);
}

export async function getLatestSellListReceipt(
  db: PgQueryable,
  sellerAccountId: string,
): Promise<CheckoutSellListReceiptRow | null> {
  const result = await db.query<SellListReceiptPageRow>(
    `SELECT
       seller_account_id,
       execution_id,
       checked_out_at,
       execution_summary
     FROM checkout_sell_list_execution_receipt_pages
     WHERE seller_account_id = $1
     ORDER BY checked_out_at DESC, execution_id DESC
     LIMIT 1`,
    [sellerAccountId],
  );

  const row = result.rows[0];
  if (row) {
    return mapSellListReceipt(row);
  }

  const legacyResult = await db.query<Omit<SellListReceiptPageRow, "execution_id">>(
    `SELECT
       seller_account_id,
       checked_out_at,
       execution_summary
     FROM checkout_sell_list_receipt_pages
     WHERE seller_account_id = $1
     LIMIT 1`,
    [sellerAccountId],
  );

  const legacyRow = legacyResult.rows[0];
  return legacyRow ? mapSellListReceipt({ ...legacyRow, execution_id: null }) : null;
}

function mapSellListReceipt(row: SellListReceiptPageRow): CheckoutSellListReceiptRow {
  return {
    ...row,
    execution_summary:
      typeof row.execution_summary === "object" && row.execution_summary !== null
        ? (row.execution_summary as CheckoutSellListReceiptRow["execution_summary"])
        : {},
  };
}

function mapSellListExecution(row: SellListExecutionPageRow): CheckoutSellListExecutionRow {
  return {
    ...row,
    status: row.status === "finalized" ? "finalized" : "pending",
    execution_summary:
      typeof row.execution_summary === "object" && row.execution_summary !== null
        ? (row.execution_summary as CheckoutSellListReceiptRow["execution_summary"])
        : null,
  };
}

export async function getSellListReceiptByExecutionId(
  db: PgQueryable,
  sellerAccountId: string,
  executionId: string,
): Promise<CheckoutSellListReceiptRow | null> {
  const result = await db.query<SellListReceiptPageRow>(
    `SELECT
       seller_account_id,
       execution_id,
       checked_out_at,
       execution_summary
     FROM checkout_sell_list_execution_receipt_pages
     WHERE seller_account_id = $1
       AND execution_id = $2
     LIMIT 1`,
    [sellerAccountId, executionId],
  );

  const row = result.rows[0];
  return row ? mapSellListReceipt(row) : null;
}

export async function getSellListExecution(
  db: PgQueryable,
  sellerAccountId: string,
  executionId: string,
): Promise<CheckoutSellListExecutionRow | null> {
  const result = await db.query<SellListExecutionPageRow>(
    `SELECT
       seller_account_id,
       execution_id,
       status,
       execution_plan,
       execution_progress,
       execution_summary,
       created_at,
       updated_at,
       finalized_at
     FROM checkout_sell_list_execution_pages
     WHERE seller_account_id = $1
       AND execution_id = $2
     LIMIT 1`,
    [sellerAccountId, executionId],
  );

  const row = result.rows[0];
  return row ? mapSellListExecution(row) : null;
}

export async function getLatestPendingSellListExecution(
  db: PgQueryable,
  sellerAccountId: string,
): Promise<CheckoutSellListExecutionRow | null> {
  const result = await db.query<SellListExecutionPageRow>(
    `SELECT
       seller_account_id,
       execution_id,
       status,
       execution_plan,
       execution_progress,
       execution_summary,
       created_at,
       updated_at,
       finalized_at
     FROM checkout_sell_list_execution_pages
     WHERE seller_account_id = $1
       AND status = 'pending'
     ORDER BY updated_at DESC, created_at DESC, execution_id DESC
     LIMIT 1`,
    [sellerAccountId],
  );

  const row = result.rows[0];
  return row ? mapSellListExecution(row) : null;
}
