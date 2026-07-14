import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type { MarketplaceOfferAcceptedPayload } from "@chase-sets/event-core";
import type { AddressSnapshot } from "@chase-sets/primitives/address-snapshot";
import type { ProductKey } from "@chase-sets/primitives/catalog-identity";
import type { AccountId, CatalogItemId } from "@chase-sets/primitives/typed-ids";
import type { ProductMeasureSnapshot } from "@chase-sets/product-measures";
import type { MarketplaceDemand, MarketplaceSupplyCandidate, MarketplaceSupplyFeeLock } from "../../domain/policies";

type VersionSelectedOptionEntry = Readonly<{
  dimensionId: string;
  optionId: string;
}>;

type OrderingSupplyCandidateRow = Readonly<{
  listing_id: string;
  seller_account_id: string;
  seller_display_name: string | null;
  inventory_item_id: string;
  catalog_catalog_item_id: string;
  product_id: string;
  item_title: string | null;
  item_subtitle: string | null;
  selected_options: unknown;
  product_summary: string | null;
  product_measure_snapshot: unknown;
  graded_card: unknown;
  storage_location_name: string | null;
  ship_from_code: string | null;
  ship_from_address: unknown;
  price_amount: string;
  marketplace_sales_fee_unit_amount: string;
  seller_net_unit_amount: string;
  shipping_allowance_percentage_bps: number;
  terms_schedule_id: string | null;
  terms_agreement_id: string | null;
  terms_resolved_at: string;
  fee_locks: unknown;
  available_quantity: number;
  max_units_per_order: number | null;
  max_units_per_day: number | null;
  max_units_per_customer_account: number | null;
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
  const sellerClause = demand.sellerAccountId ? "AND listing.seller_account_id = $2" : "";

  if (demand.sellerAccountId) {
    values.push(demand.sellerAccountId);
  }

  const result = await db.query<OrderingSupplyCandidateRow>(
    `SELECT
       listing.listing_id,
       listing.seller_account_id,
       seller.display_name AS seller_display_name,
       listing.inventory_item_id,
       listing.catalog_catalog_item_id,
       listing.product_id,
       listing.item_title,
       listing.item_subtitle,
       listing.selected_options,
       listing.product_summary,
       listing.product_measure_snapshot,
       listing.graded_card,
       listing.storage_location_name,
       listing.ship_from_code,
       listing.ship_from_address,
       listing.price_amount::text AS price_amount,
       listing.marketplace_sales_fee_unit_amount::text AS marketplace_sales_fee_unit_amount,
       listing.seller_net_unit_amount::text AS seller_net_unit_amount,
       listing.shipping_allowance_percentage_bps,
       listing.terms_schedule_id,
       listing.terms_agreement_id,
       listing.terms_resolved_at::text AS terms_resolved_at,
       listing.fee_locks,
       listing.max_units_per_order,
       listing.max_units_per_day,
       listing.max_units_per_customer_account,
       LEAST(
         listing.quantity_cap,
         GREATEST(
           item.total_quantity - COALESCE(active_holds.held_quantity, 0),
           0
         )
       ) AS available_quantity,
       listing.updated_at::text AS updated_at
     FROM ordering_market_listing_inputs AS listing
     INNER JOIN ordering_inventory_item_inputs AS item
       ON item.item_id = listing.inventory_item_id
     LEFT JOIN ordering_account_pages AS seller
       ON seller.account_id = listing.seller_account_id
     LEFT JOIN (
       SELECT item_id, SUM(quantity)::integer AS held_quantity
       FROM ordering_inventory_hold_inputs
       WHERE status = 'active'
       GROUP BY item_id
     ) AS active_holds
       ON active_holds.item_id = item.item_id
     LEFT JOIN ordering_seller_order_capacity_inputs AS capacity
       ON capacity.seller_account_id = listing.seller_account_id
     LEFT JOIN (
       SELECT seller_account_id, count(*)::integer AS open_count
       FROM ordering_seller_open_order_claims
       WHERE status = 'claimed'
       GROUP BY seller_account_id
     ) AS open_claims
       ON open_claims.seller_account_id = listing.seller_account_id
     WHERE listing.status = 'active'
       AND listing.seller_listing_availability_status = 'available'
       AND listing.terms_resolved_at IS NOT NULL
       AND listing.product_id = $1
       -- Order Capacity enforcement (m127): an at-capacity seller's
       -- supply drops out of candidates the same way an away seller's
       -- does, so stale carts and checkout sessions fail closed before
       -- payment rather than create-then-cancel.
       AND (capacity.max_open_orders IS NULL OR COALESCE(open_claims.open_count, 0) < capacity.max_open_orders)
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
      sellerDisplayName: normalizeOptionalText(row.seller_display_name),
      inventoryItemId: row.inventory_item_id,
      catalogItemId: row.catalog_catalog_item_id as CatalogItemId,
      productId: row.product_id as ProductKey,
      itemTitle: row.item_title ?? demand.itemTitle,
      itemSubtitle: normalizeOptionalText(row.item_subtitle ?? demand.itemSubtitle),
      selectedOptions: Array.isArray(row.selected_options)
        ? normalizeVersionSelection(row.selected_options as VersionSelectedOptionEntry[])
        : normalizedSelection,
      productSummary: normalizeOptionalText(row.product_summary ?? demand.productSummary),
      productMeasureSnapshot: productMeasureFromUnknown(row.product_measure_snapshot),
      gradedCard: gradedCardFromUnknown(row.graded_card),
      storageLocationName: row.storage_location_name,
      shipFromCode: row.ship_from_code,
      shipFromAddress:
        typeof row.ship_from_address === "object" && row.ship_from_address !== null
          ? (row.ship_from_address as AddressSnapshot)
          : {
              name: "",
              line1: "",
              city: "",
              state: "",
              postalCode: "",
              country: "US",
            },
      priceAmount: row.price_amount,
      marketplaceSalesFeeUnitAmount: row.marketplace_sales_fee_unit_amount,
      sellerNetUnitAmount: row.seller_net_unit_amount,
      shippingAllowancePercentageBps: row.shipping_allowance_percentage_bps,
      termsScheduleId: row.terms_schedule_id,
      termsAgreementId: row.terms_agreement_id,
      termsResolvedAt: row.terms_resolved_at,
      feeLocks: availableFeeLocks(row, row.available_quantity),
      availableQuantity: row.available_quantity,
      maxUnitsPerOrder: row.max_units_per_order,
      maxUnitsPerDay: row.max_units_per_day,
      maxUnitsPerCustomerAccount: row.max_units_per_customer_account,
      updatedAt: row.updated_at,
    }))
    .filter((row) => row.availableQuantity > 0);
}

export async function getOrderingSupplyCandidateByListingId(
  db: PgQueryable,
  listingId: string,
  options: Readonly<{ allowCommitted?: boolean }> = {},
): Promise<MarketplaceSupplyCandidate | null> {
  const currentEligibilitySql = options.allowCommitted
    ? ""
    : `AND listing.status = 'active'
       AND listing.seller_listing_availability_status = 'available'`;
  const result = await db.query<OrderingSupplyCandidateRow>(
    `SELECT
       listing.listing_id,
       listing.seller_account_id,
       seller.display_name AS seller_display_name,
       listing.inventory_item_id,
       listing.catalog_catalog_item_id,
       listing.product_id,
       listing.item_title,
       listing.item_subtitle,
       listing.selected_options,
       listing.product_summary,
       listing.product_measure_snapshot,
       listing.graded_card,
       listing.storage_location_name,
       listing.ship_from_code,
       listing.ship_from_address,
       listing.price_amount::text AS price_amount,
       listing.marketplace_sales_fee_unit_amount::text AS marketplace_sales_fee_unit_amount,
       listing.seller_net_unit_amount::text AS seller_net_unit_amount,
       listing.shipping_allowance_percentage_bps,
       listing.terms_schedule_id,
       listing.terms_agreement_id,
       listing.terms_resolved_at::text AS terms_resolved_at,
       listing.fee_locks,
       listing.max_units_per_order,
       listing.max_units_per_day,
       listing.max_units_per_customer_account,
       LEAST(
         listing.quantity_cap,
         GREATEST(
           item.total_quantity - COALESCE(active_holds.held_quantity, 0),
           0
         )
       ) AS available_quantity,
       listing.updated_at::text AS updated_at
     FROM ordering_market_listing_inputs AS listing
     INNER JOIN ordering_inventory_item_inputs AS item
       ON item.item_id = listing.inventory_item_id
     LEFT JOIN ordering_account_pages AS seller
       ON seller.account_id = listing.seller_account_id
     LEFT JOIN (
       SELECT item_id, SUM(quantity)::integer AS held_quantity
       FROM ordering_inventory_hold_inputs
       WHERE status = 'active'
       GROUP BY item_id
     ) AS active_holds
       ON active_holds.item_id = item.item_id
     LEFT JOIN ordering_seller_order_capacity_inputs AS capacity
       ON capacity.seller_account_id = listing.seller_account_id
     LEFT JOIN (
       SELECT seller_account_id, count(*)::integer AS open_count
       FROM ordering_seller_open_order_claims
       WHERE status = 'claimed'
       GROUP BY seller_account_id
     ) AS open_claims
       ON open_claims.seller_account_id = listing.seller_account_id
     WHERE listing.terms_resolved_at IS NOT NULL
       AND listing.listing_id = $1
       -- Order Capacity enforcement (m127): see
       -- listOrderingSupplyCandidates above -- the locked-listing lookup
       -- must fail closed the same way so a stale locked listing whose
       -- seller has since hit capacity re-checks as unavailable.
       AND (capacity.max_open_orders IS NULL OR COALESCE(open_claims.open_count, 0) < capacity.max_open_orders)
       ${currentEligibilitySql}`,
    [listingId],
  );

  const row = result.rows[0];
  if (!row || row.available_quantity <= 0) {
    return null;
  }

  return {
    listingId: row.listing_id,
    sellerAccountId: row.seller_account_id as AccountId,
    sellerDisplayName: normalizeOptionalText(row.seller_display_name),
    inventoryItemId: row.inventory_item_id,
    catalogItemId: row.catalog_catalog_item_id as CatalogItemId,
    productId: row.product_id as ProductKey,
    itemTitle: row.item_title ?? "Item",
    itemSubtitle: normalizeOptionalText(row.item_subtitle),
    selectedOptions: Array.isArray(row.selected_options)
      ? normalizeVersionSelection(row.selected_options as VersionSelectedOptionEntry[])
      : [],
    productSummary: normalizeOptionalText(row.product_summary),
    productMeasureSnapshot: productMeasureFromUnknown(row.product_measure_snapshot),
    gradedCard: gradedCardFromUnknown(row.graded_card),
    storageLocationName: row.storage_location_name,
    shipFromCode: row.ship_from_code,
    shipFromAddress:
      typeof row.ship_from_address === "object" && row.ship_from_address !== null
        ? (row.ship_from_address as AddressSnapshot)
        : {
            name: "",
            line1: "",
            city: "",
            state: "",
            postalCode: "",
            country: "US",
          },
    priceAmount: row.price_amount,
    marketplaceSalesFeeUnitAmount: row.marketplace_sales_fee_unit_amount,
    sellerNetUnitAmount: row.seller_net_unit_amount,
    shippingAllowancePercentageBps: row.shipping_allowance_percentage_bps,
    termsScheduleId: row.terms_schedule_id,
    termsAgreementId: row.terms_agreement_id,
    termsResolvedAt: row.terms_resolved_at,
    feeLocks: availableFeeLocks(row, row.available_quantity),
    availableQuantity: row.available_quantity,
    maxUnitsPerOrder: row.max_units_per_order,
    maxUnitsPerDay: row.max_units_per_day,
    maxUnitsPerCustomerAccount: row.max_units_per_customer_account,
    updatedAt: row.updated_at,
  };
}

function availableFeeLocks(
  row: Pick<
    OrderingSupplyCandidateRow,
    | "fee_locks"
    | "marketplace_sales_fee_unit_amount"
    | "seller_net_unit_amount"
    | "shipping_allowance_percentage_bps"
    | "terms_schedule_id"
    | "terms_agreement_id"
    | "terms_resolved_at"
  >,
  availableQuantity: number,
): MarketplaceSupplyFeeLock[] {
  const recorded = Array.isArray(row.fee_locks)
    ? row.fee_locks.flatMap((entry): MarketplaceSupplyFeeLock[] => {
        if (!entry || typeof entry !== "object") return [];
        const lock = entry as Record<string, unknown>;
        const terms = lock.terms && typeof lock.terms === "object" ? (lock.terms as Record<string, unknown>) : {};
        const unitCount = Number(lock.unitCount);
        if (!Number.isInteger(unitCount) || unitCount <= 0) return [];
        return [
          {
            unitCount,
            marketplaceSalesFeePercentageBps:
              typeof terms.marketplaceSalesFeePercentageBps === "number"
                ? terms.marketplaceSalesFeePercentageBps
                : undefined,
            marketplaceSalesFeeFixedAmount:
              typeof terms.marketplaceSalesFeeFixedAmount === "string"
                ? terms.marketplaceSalesFeeFixedAmount
                : undefined,
            marketplaceSalesFeeCapAmount:
              typeof terms.marketplaceSalesFeeCapAmount === "string" || terms.marketplaceSalesFeeCapAmount === null
                ? terms.marketplaceSalesFeeCapAmount
                : undefined,
            marketplaceSalesFeeUnitAmount: String(lock.marketplaceSalesFeeUnitAmount),
            sellerNetUnitAmount: String(lock.sellerNetUnitAmount),
            shippingAllowancePercentageBps: Number(terms.shippingAllowancePercentageBps ?? 500),
            termsScheduleId: typeof terms.termsScheduleId === "string" ? terms.termsScheduleId : null,
            termsAgreementId: typeof terms.termsAgreementId === "string" ? terms.termsAgreementId : null,
            termsResolvedAt: String(terms.termsResolvedAt ?? row.terms_resolved_at),
          },
        ];
      })
    : [];
  const locks: MarketplaceSupplyFeeLock[] =
    recorded.length > 0
      ? recorded
      : [
          {
            unitCount: availableQuantity,
            marketplaceSalesFeeUnitAmount: row.marketplace_sales_fee_unit_amount,
            sellerNetUnitAmount: row.seller_net_unit_amount,
            shippingAllowancePercentageBps: row.shipping_allowance_percentage_bps,
            termsScheduleId: row.terms_schedule_id,
            termsAgreementId: row.terms_agreement_id,
            termsResolvedAt: row.terms_resolved_at,
          },
        ];

  let remaining = availableQuantity;
  const available: MarketplaceSupplyFeeLock[] = [];
  for (const lock of locks) {
    if (remaining <= 0) break;
    const unitCount = Math.min(lock.unitCount, remaining);
    if (unitCount > 0) available.push({ ...lock, unitCount });
    remaining -= unitCount;
  }
  return available.reverse();
}

function productMeasureFromUnknown(value: unknown) {
  return typeof value === "object" && value !== null ? (value as ProductMeasureSnapshot) : null;
}

function gradedCardFromUnknown(value: unknown): MarketplaceSupplyCandidate["gradedCard"] {
  if (!value || typeof value !== "object") {
    return null;
  }
  const record = value as Record<string, unknown>;
  const gradingCompany = String(record.gradingCompany ?? "").trim();
  const grade = String(record.grade ?? "").trim();
  if (!gradingCompany || !grade) {
    return null;
  }
  return {
    gradingCompany,
    grade,
    certificationNumber:
      typeof record.certificationNumber === "string" && record.certificationNumber.trim()
        ? record.certificationNumber.trim()
        : null,
  };
}

export type OrderingAcceptedOfferBatchInputRow = Readonly<{
  offer_id: string;
  buyer_account_id: string;
  seller_account_id: string;
  listing_id: string;
  inventory_item_id: string;
  listing_version: number;
  catalog_catalog_item_id: string;
  product_id: string;
  item_title: string;
  item_subtitle: string | null;
  selected_options: readonly VersionSelectedOptionEntry[];
  product_summary: string | null;
  price_amount: string;
  marketplace_sales_fee_percentage_bps: number;
  marketplace_sales_fee_fixed_amount: string;
  marketplace_sales_fee_cap_amount: string | null;
  marketplace_sales_fee_unit_amount: string;
  seller_net_unit_amount: string;
  shipping_allowance_percentage_bps: number;
  shipping_destination_snapshot: AddressSnapshot;
  terms_schedule_id: string | null;
  terms_agreement_id: string | null;
  terms_resolved_at: string;
  fee_quote_fingerprint: string;
  listing_evidence_policy_id: string | null;
  listing_evidence_policy_version: number | null;
  listing_evidence_policy_hash: string;
  listing_evidence_snapshot: MarketplaceOfferAcceptedPayload["listingEvidenceSnapshot"];
  quantity_requested: number;
  acceptance_batch_id: string | null;
  acceptance_batch_size: number | null;
}>;

export async function listAcceptedOfferBatchInputs(
  db: PgQueryable,
  acceptanceBatchId: string,
): Promise<readonly OrderingAcceptedOfferBatchInputRow[]> {
  const result = await db.query<
    Omit<OrderingAcceptedOfferBatchInputRow, "selected_options"> &
      Readonly<{
        selected_options: unknown;
      }>
  >(
    `SELECT
       offer_id,
       buyer_account_id,
       seller_account_id,
       listing_id,
       inventory_item_id,
       listing_version,
       catalog_catalog_item_id,
       product_id,
       item_title,
       item_subtitle,
       selected_options,
       product_summary,
       price_amount::text AS price_amount,
       marketplace_sales_fee_percentage_bps,
       marketplace_sales_fee_fixed_amount::text AS marketplace_sales_fee_fixed_amount,
       marketplace_sales_fee_cap_amount::text AS marketplace_sales_fee_cap_amount,
       marketplace_sales_fee_unit_amount::text AS marketplace_sales_fee_unit_amount,
       seller_net_unit_amount::text AS seller_net_unit_amount,
       shipping_allowance_percentage_bps,
       shipping_destination_snapshot,
       terms_schedule_id,
       terms_agreement_id,
       terms_resolved_at::text AS terms_resolved_at,
       fee_quote_fingerprint,
       listing_evidence_policy_id,
       listing_evidence_policy_version,
       listing_evidence_policy_hash,
       listing_evidence_snapshot,
       quantity_requested,
       acceptance_batch_id,
       acceptance_batch_size
     FROM ordering_offer_acceptance_inputs
     WHERE acceptance_batch_id = $1
     ORDER BY buyer_account_id ASC, offer_id ASC`,
    [acceptanceBatchId],
  );

  return result.rows.map((row) => ({
    ...row,
    selected_options: Array.isArray(row.selected_options)
      ? normalizeVersionSelection(row.selected_options as VersionSelectedOptionEntry[])
      : [],
    listing_evidence_snapshot: row.listing_evidence_snapshot,
  }));
}
