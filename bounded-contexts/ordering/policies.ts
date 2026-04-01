import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type { AccountId } from "@chase-sets/primitives/typed-ids";
import {
  assert,
  buildDemandSignature,
  normalizeMoneyAmount,
  normalizeOptionalText,
  normalizeVersionSelection,
  numberToMoneyAmount,
  type ShippingOption,
  type VersionSelectionEntry,
} from "./common";

export type MarketplaceDemand = Readonly<{
  catalogItemId: string;
  itemTitle: string;
  itemSubtitle: string | null;
  versionSelection: readonly VersionSelectionEntry[];
  versionSummary: string | null;
  quantity: number;
}>;

export type MarketplaceSupplyCandidate = Readonly<{
  listingId: string;
  sellerAccountId: AccountId;
  inventoryRecordId: string;
  catalogItemId: string;
  itemTitle: string;
  itemSubtitle: string | null;
  versionSelection: readonly VersionSelectionEntry[];
  versionSummary: string | null;
  condition: string;
  storageLocationName: string | null;
  shipFromCode: string | null;
  priceAmount: string;
  availableQuantity: number;
  updatedAt: string;
}>;

export interface MarketplaceSupplyResolver {
  resolveCandidates(
    demand: MarketplaceDemand & Readonly<{ sellerAccountId?: string }>,
  ): Promise<readonly MarketplaceSupplyCandidate[]>;
}

export type ShippingQuoteResult = Readonly<{
  shippingOption: ShippingOption;
  baseAmount: string;
  discountAmount: string;
  chargeAmount: string;
}>;

export interface ShippingQuotePolicy {
  quote(params: Readonly<{
    sellerAccountId: string;
    shippingOption: ShippingOption;
    itemSubtotalAmount: string;
    quantity: number;
    listingCount: number;
  }>): ShippingQuoteResult;
}

type SupplyCandidateRow = Readonly<{
  listing_id: string;
  seller_account_id: string;
  inventory_record_id: string;
  catalog_item_id: string;
  item_title: string | null;
  item_subtitle: string | null;
  version_selection: unknown;
  version_summary: string | null;
  condition: string;
  storage_location_name: string | null;
  ship_from_code: string | null;
  price_amount: string;
  available_quantity: number;
  updated_at: string;
}>;

export function createDatabaseMarketplaceSupplyResolver(
  db: PgQueryable,
): MarketplaceSupplyResolver {
  return {
    async resolveCandidates(demand) {
      const normalizedSelection = normalizeVersionSelection(demand.versionSelection);
      const values: unknown[] = [
        demand.catalogItemId.trim(),
        JSON.stringify(normalizedSelection),
      ];
      const sellerClause = demand.sellerAccountId
        ? `AND listing.account_id = $3`
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
           COALESCE(listing.item_title, catalog_item.title) AS item_title,
           COALESCE(listing.item_subtitle, catalog_item.subtitle) AS item_subtitle,
           listing.version_selection,
           listing.version_summary,
           listing.condition,
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
           AND listing.catalog_item_id = $1
           AND listing.version_selection @> $2::jsonb
           AND $2::jsonb @> listing.version_selection
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
          itemTitle: row.item_title ?? demand.itemTitle,
          itemSubtitle: normalizeOptionalText(row.item_subtitle ?? demand.itemSubtitle),
          versionSelection: Array.isArray(row.version_selection)
            ? normalizeVersionSelection(row.version_selection as VersionSelectionEntry[])
            : normalizedSelection,
          versionSummary: normalizeOptionalText(row.version_summary ?? demand.versionSummary),
          condition: row.condition,
          storageLocationName: row.storage_location_name,
          shipFromCode: row.ship_from_code,
          priceAmount: normalizeMoneyAmount(row.price_amount, { fieldName: "Listing price" }),
          availableQuantity: row.available_quantity,
          updatedAt: row.updated_at,
        }))
        .filter((row) => row.availableQuantity > 0);
    },
  };
}

export const defaultShippingQuotePolicy: ShippingQuotePolicy = {
  quote({ shippingOption, itemSubtotalAmount, quantity, listingCount }) {
    const subtotal = Number.parseFloat(
      normalizeMoneyAmount(itemSubtotalAmount, {
        allowZero: true,
        fieldName: "Item subtotal",
      }),
    );
    const perOrderBase =
      shippingOption === "priority"
        ? 19.99
        : shippingOption === "expedited"
          ? 9.99
          : 4.99;
    const volumeSurcharge = Math.max(0, quantity - 1) * 0.35;
    const consolidationSurcharge = Math.max(0, listingCount - 1) * 0.5;
    const baseAmount = perOrderBase + volumeSurcharge + consolidationSurcharge;

    const discountAmount =
      shippingOption === "standard"
        ? subtotal >= 50
          ? baseAmount
          : subtotal >= 25
            ? Math.min(baseAmount, 2.5)
            : 0
        : shippingOption === "expedited"
          ? subtotal >= 100
            ? Math.min(baseAmount, 5)
            : 0
          : 0;

    return {
      shippingOption,
      baseAmount: numberToMoneyAmount(baseAmount),
      discountAmount: numberToMoneyAmount(discountAmount),
      chargeAmount: numberToMoneyAmount(Math.max(0, baseAmount - discountAmount)),
    };
  },
};

export type InventoryReservation = Readonly<{
  holdId: string;
  inventoryRecordId: string;
  sellerAccountId: string;
  quantity: number;
}>;

export interface InventoryReservationGateway {
  createReservation(params: Readonly<{
    sellerAccountId: AccountId;
    inventoryRecordId: string;
    quantity: number;
    reason: string;
    notes?: string | null;
    context: unknown;
  }>): Promise<InventoryReservation>;
  releaseReservation(params: Readonly<{
    sellerAccountId: string;
    holdId: string;
    context: unknown;
  }>): Promise<void>;
}

export function tieBreakPlanKey(orderIds: readonly string[]) {
  return [...orderIds].sort().join("|");
}

export function demandKeyForLine(
  line: Pick<MarketplaceDemand, "catalogItemId" | "versionSelection">,
) {
  return buildDemandSignature(line.catalogItemId, line.versionSelection);
}

export function assertSupplyAvailable(
  candidates: readonly MarketplaceSupplyCandidate[],
  quantity: number,
  message: string,
) {
  const totalAvailable = candidates.reduce(
    (sum, candidate) => sum + candidate.availableQuantity,
    0,
  );
  assert(totalAvailable >= quantity, message);
}
