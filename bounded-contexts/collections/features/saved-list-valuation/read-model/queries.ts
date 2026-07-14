import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type { AccountId } from "@chase-sets/primitives/typed-ids";
import type { SavedListId, SavedListLineId, SavedListVisibility } from "../../saved-lists/domain";
import type { SavedListMarketEstimate, SavedListValuationInputLine } from "../domain/contracts";

export type SavedListValuationSource = Readonly<{
  listId: SavedListId;
  ownerAccountId: AccountId;
  visibility: SavedListVisibility;
  lifecycle: "active" | "archived";
  lines: readonly SavedListValuationInputLine[];
  estimates: readonly SavedListMarketEstimate[];
}>;

export async function getSavedListValuationSource(
  db: PgQueryable,
  listId: SavedListId,
): Promise<SavedListValuationSource | null> {
  const listResult = await db.query<{
    list_id: string;
    owner_account_id: string;
    visibility: SavedListVisibility;
    lifecycle: "active" | "archived";
  }>(
    `SELECT list_id, owner_account_id, visibility, lifecycle
     FROM collections_saved_list_valuation_lists
     WHERE list_id = $1`,
    [listId],
  );
  const list = listResult.rows[0];
  if (!list) {
    return null;
  }

  const lineResult = await db.query<ValuationLineRow>(
    `SELECT
       line.line_id,
       line.catalog_catalog_item_id,
       line.product_id,
       line.tracked_quantity,
       estimate.estimate_version,
       estimate.window_started_at::text,
       estimate.window_ended_at::text,
       estimate.amount::text,
       estimate.currency_code,
       estimate.band_low_amount::text,
       estimate.band_high_amount::text,
       estimate.confidence,
       estimate.estimated_at::text,
       estimate.fresh_until::text,
       estimate.disclosure
     FROM collections_saved_list_valuation_lines line
     LEFT JOIN collections_saved_list_market_estimates estimate
       ON estimate.catalog_catalog_item_id = line.catalog_catalog_item_id
      AND estimate.product_id = line.product_id
     WHERE line.list_id = $1 AND line.active
     ORDER BY line.line_id ASC`,
    [listId],
  );

  return {
    listId: list.list_id as SavedListId,
    ownerAccountId: list.owner_account_id as AccountId,
    visibility: list.visibility,
    lifecycle: list.lifecycle,
    lines: lineResult.rows.map((row) => ({
      lineId: row.line_id as SavedListLineId,
      catalogItemId: row.catalog_catalog_item_id,
      productId: row.product_id,
      trackedQuantity: row.tracked_quantity,
    })),
    estimates: lineResult.rows.flatMap((row) => (row.estimate_version ? [estimateFromRow(row)] : [])),
  };
}

type ValuationLineRow = Readonly<{
  line_id: string;
  catalog_catalog_item_id: string;
  product_id: string;
  tracked_quantity: number;
  estimate_version: string | null;
  window_started_at: string | null;
  window_ended_at: string | null;
  amount: string | null;
  currency_code: string | null;
  band_low_amount: string | null;
  band_high_amount: string | null;
  confidence: "low" | "medium" | "high" | null;
  estimated_at: string | null;
  fresh_until: string | null;
  disclosure: "internal" | "account" | "public" | null;
}>;

function estimateFromRow(row: ValuationLineRow): SavedListMarketEstimate {
  if (
    !row.estimate_version ||
    !row.window_started_at ||
    !row.window_ended_at ||
    !row.amount ||
    !row.currency_code ||
    !row.confidence ||
    !row.estimated_at ||
    !row.fresh_until ||
    !row.disclosure
  ) {
    throw new Error("Saved List market estimate projection row is incomplete.");
  }

  return {
    catalogItemId: row.catalog_catalog_item_id,
    productId: row.product_id,
    estimateVersion: row.estimate_version,
    windowStartedAt: row.window_started_at,
    windowEndedAt: row.window_ended_at,
    amount: row.amount,
    currencyCode: row.currency_code,
    band:
      row.band_low_amount !== null && row.band_high_amount !== null
        ? { lowAmount: row.band_low_amount, highAmount: row.band_high_amount }
        : null,
    confidence: row.confidence,
    estimatedAt: row.estimated_at,
    freshUntil: row.fresh_until,
    disclosure: row.disclosure,
  };
}
