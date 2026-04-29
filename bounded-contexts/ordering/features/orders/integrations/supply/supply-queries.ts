import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type { AccountId } from "@chase-sets/primitives/typed-ids";
import type { MarketplaceDemand, MarketplaceSupplyCandidate } from "../../domain/policies";

type VersionSelectedOptionEntry = Readonly<{
  dimensionId: string;
  optionId: string;
}>;

type OrderingSupplyCandidateRow = Readonly<{
  listing_id: string;
  seller_account_id: string;
  inventory_item_id: string;
  catalog_catalog_item_id: string;
  product_id: string;
  item_title: string | null;
  item_subtitle: string | null;
  selected_options: unknown;
  product_summary: string | null;
  storage_location_name: string | null;
  ship_from_code: string | null;
  price_amount: string;
  available_quantity: number;
  updated_at: string;
}>;

function normalizeOptionalText(value: string | null | undefined) {
  return value?.trim() ? value.trim() : null;
}

function normalizeVersionSelection(value: readonly VersionSelectedOptionEntry[]) {
  return value
    .map((entry) => ({
      dimensionId: entry.dimensionId.trim(),
      optionId: entry.optionId.trim(),
    }))
    .filter((entry) => entry.dimensionId && entry.optionId);
}

export async function listOrderingSupplyCandidates(
  db: PgQueryable,
  demand: MarketplaceDemand & Readonly<{ sellerAccountId?: string }>,
): Promise<readonly MarketplaceSupplyCandidate[]> {
  const normalizedSelection = normalizeVersionSelection(demand.selectedOptions);
  const values: unknown[] = [demand.productId.trim()];
  const sellerClause = demand.sellerAccountId
    ? "AND listing.seller_account_id = $2"
    : "";

  if (demand.sellerAccountId) {
    values.push(demand.sellerAccountId);
  }

  const result = await db.query<OrderingSupplyCandidateRow>(
    `SELECT
       listing.listing_id,
       listing.seller_account_id,
       listing.inventory_item_id,
       listing.catalog_catalog_item_id,
       listing.product_id,
       listing.item_title,
       listing.item_subtitle,
       listing.selected_options,
       listing.product_summary,
       listing.storage_location_name,
       listing.ship_from_code,
       listing.price_amount::text AS price_amount,
       LEAST(
         listing.quantity_cap,
         GREATEST(
           item.total_quantity - COALESCE(active_holds.held_quantity, 0),
           0
         )
       ) AS available_quantity,
       listing.updated_at
     FROM ordering_market_listing_inputs AS listing
     INNER JOIN ordering_inventory_item_inputs AS item
       ON item.item_id = listing.inventory_item_id
     LEFT JOIN (
       SELECT item_id, SUM(quantity)::integer AS held_quantity
       FROM ordering_inventory_hold_inputs
       WHERE status = 'active'
       GROUP BY item_id
     ) AS active_holds
       ON active_holds.item_id = item.item_id
     WHERE listing.status = 'active'
       AND listing.product_id = $1
       ${sellerClause}
     ORDER BY
       listing.price_amount ASC,
       listing.updated_at ASC,
       listing.listing_id ASC`,
    values,
  );

  return result.rows
    .map((row) => ({
      listingId: row.listing_id,
      sellerAccountId: row.seller_account_id as AccountId,
      inventoryItemId: row.inventory_item_id,
      catalogItemId: row.catalog_catalog_item_id,
      productId: row.product_id,
      itemTitle: row.item_title ?? demand.itemTitle,
      itemSubtitle: normalizeOptionalText(row.item_subtitle ?? demand.itemSubtitle),
      selectedOptions: Array.isArray(row.selected_options)
        ? normalizeVersionSelection(row.selected_options as VersionSelectedOptionEntry[])
        : normalizedSelection,
      productSummary: normalizeOptionalText(row.product_summary ?? demand.productSummary),
      storageLocationName: row.storage_location_name,
      shipFromCode: row.ship_from_code,
      priceAmount: row.price_amount,
      availableQuantity: row.available_quantity,
      updatedAt: row.updated_at,
    }))
    .filter((row) => row.availableQuantity > 0);
}

export async function getOrderingSupplyCandidateByListingId(
  db: PgQueryable,
  listingId: string,
): Promise<MarketplaceSupplyCandidate | null> {
  const result = await db.query<OrderingSupplyCandidateRow>(
    `SELECT
       listing.listing_id,
       listing.seller_account_id,
       listing.inventory_item_id,
       listing.catalog_catalog_item_id,
       listing.product_id,
       listing.item_title,
       listing.item_subtitle,
       listing.selected_options,
       listing.product_summary,
       listing.storage_location_name,
       listing.ship_from_code,
       listing.price_amount::text AS price_amount,
       LEAST(
         listing.quantity_cap,
         GREATEST(
           item.total_quantity - COALESCE(active_holds.held_quantity, 0),
           0
         )
       ) AS available_quantity,
       listing.updated_at
     FROM ordering_market_listing_inputs AS listing
     INNER JOIN ordering_inventory_item_inputs AS item
       ON item.item_id = listing.inventory_item_id
     LEFT JOIN (
       SELECT item_id, SUM(quantity)::integer AS held_quantity
       FROM ordering_inventory_hold_inputs
       WHERE status = 'active'
       GROUP BY item_id
     ) AS active_holds
       ON active_holds.item_id = item.item_id
     WHERE listing.status = 'active'
       AND listing.listing_id = $1`,
    [listingId],
  );

  const row = result.rows[0];
  if (!row || row.available_quantity <= 0) {
    return null;
  }

  return {
    listingId: row.listing_id,
    sellerAccountId: row.seller_account_id as AccountId,
    inventoryItemId: row.inventory_item_id,
    catalogItemId: row.catalog_catalog_item_id,
    productId: row.product_id,
    itemTitle: row.item_title ?? "Item",
    itemSubtitle: normalizeOptionalText(row.item_subtitle),
    selectedOptions: Array.isArray(row.selected_options)
      ? normalizeVersionSelection(row.selected_options as VersionSelectedOptionEntry[])
      : [],
    productSummary: normalizeOptionalText(row.product_summary),
    storageLocationName: row.storage_location_name,
    shipFromCode: row.ship_from_code,
    priceAmount: row.price_amount,
    availableQuantity: row.available_quantity,
    updatedAt: row.updated_at,
  };
}
