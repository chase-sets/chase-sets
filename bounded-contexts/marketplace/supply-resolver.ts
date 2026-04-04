import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type { AccountId } from "@chase-sets/primitives/typed-ids";
import type { CatalogVersionKey } from "@chase-sets/sellable-units";
import type { MarketplaceServices } from "./services";

type VersionSelectionEntry = Readonly<{
  dimensionId: string;
  choiceId: string;
}>;

type SupplyDemand = Readonly<{
  catalogItemId: string;
  catalogVersionKey: string;
  itemTitle: string;
  itemSubtitle: string | null;
  versionSelection: readonly VersionSelectionEntry[];
  versionSummary: string | null;
  sellerAccountId?: string;
}>;

type SupplyCandidateRow = Readonly<{
  listing_id: string;
  seller_account_id: string;
  inventory_record_id: string;
  catalog_item_id: string;
  catalog_version_key: string;
  item_title: string | null;
  item_subtitle: string | null;
  version_selection: unknown;
  version_summary: string | null;
  storage_location_name: string | null;
  ship_from_code: string | null;
  price_amount: string;
  available_quantity: number;
  updated_at: string;
}>;

function normalizeMoneyAmount(
  value: string,
  options: Readonly<{ fieldName: string }>,
) {
  const normalized = value.trim();
  if (!/^\d+(\.\d{1,2})?$/.test(normalized)) {
    throw new Error(`${options.fieldName} must be a valid decimal amount.`);
  }

  return normalized;
}

function normalizeOptionalText(value: string | null | undefined) {
  return value?.trim() ? value.trim() : null;
}

function normalizeVersionSelection(value: readonly VersionSelectionEntry[]) {
  return value
    .map((entry) => ({
      dimensionId: entry.dimensionId.trim(),
      choiceId: entry.choiceId.trim(),
    }))
    .filter((entry) => entry.dimensionId && entry.choiceId);
}

async function resolveMarketplaceSupplyCandidates(
  db: PgQueryable,
  demand: SupplyDemand,
) {
  const normalizedSelection = normalizeVersionSelection(demand.versionSelection);
  const values: unknown[] = [demand.catalogVersionKey.trim()];
  const sellerClause = demand.sellerAccountId
    ? "AND listing.account_id = $2"
    : "";

  if (demand.sellerAccountId) {
    values.push(demand.sellerAccountId);
  }

  const result = await db.query<SupplyCandidateRow>(
    `SELECT
       listing.listing_id,
       listing.account_id AS seller_account_id,
       listing.inventory_record_id,
       listing.catalog_item_id,
       listing.catalog_version_key,
       COALESCE(listing.item_title, catalog_item.title) AS item_title,
       COALESCE(listing.item_subtitle, catalog_item.subtitle) AS item_subtitle,
       listing.version_selection,
       listing.version_summary,
       listing.storage_location_name,
       listing.ship_from_code,
       listing.price_amount::text AS price_amount,
       LEAST(
         listing.quantity_cap,
         GREATEST(
           record.total_quantity - COALESCE(active_holds.held_quantity, 0),
           0
         )
       ) AS available_quantity,
       listing.updated_at
     FROM marketplace_listing_pages AS listing
     INNER JOIN inventory_records AS record
       ON record.record_id = listing.inventory_record_id
     LEFT JOIN inventory_catalog_items AS catalog_item
       ON catalog_item.item_id = listing.catalog_item_id
     LEFT JOIN (
       SELECT record_id, SUM(quantity)::integer AS held_quantity
       FROM inventory_holds
       WHERE status = 'active'
       GROUP BY record_id
     ) AS active_holds
       ON active_holds.record_id = record.record_id
     WHERE listing.status = 'active'
       AND listing.catalog_version_key = $1
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
      inventoryRecordId: row.inventory_record_id,
      catalogItemId: row.catalog_item_id,
      catalogVersionKey: row.catalog_version_key as CatalogVersionKey,
      itemTitle: row.item_title ?? demand.itemTitle,
      itemSubtitle: normalizeOptionalText(row.item_subtitle ?? demand.itemSubtitle),
      versionSelection: Array.isArray(row.version_selection)
        ? normalizeVersionSelection(row.version_selection as VersionSelectionEntry[])
        : normalizedSelection,
      versionSummary: normalizeOptionalText(row.version_summary ?? demand.versionSummary),
      storageLocationName: row.storage_location_name,
      shipFromCode: row.ship_from_code,
      priceAmount: normalizeMoneyAmount(row.price_amount, {
        fieldName: "Listing price",
      }),
      availableQuantity: row.available_quantity,
      updatedAt: row.updated_at,
    }))
    .filter((row) => row.availableQuantity > 0);
}

export function createMarketplaceSupplyResolver(
  services: Pick<MarketplaceServices, "db">,
) {
  return {
    resolveCandidates: (demand: SupplyDemand) =>
      resolveMarketplaceSupplyCandidates(services.db, demand),
  };
}
