import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type { AddressSnapshot } from "@chase-sets/primitives/address-snapshot";
import type { VersionSelectedOptionEntry } from "../../../support/runtime-support/common";

type CheckoutCommercialAccountType = "personal" | "business" | "enterprise";

export type CheckoutCommercialTermsResolver = Readonly<{
  resolveListingTerms: (
    params: Readonly<{
      accountId: string;
      amount: string;
      effectiveAt?: string;
    }>,
  ) => Promise<{
    accountType: CheckoutCommercialAccountType;
    basisAmount: string;
    marketplaceSalesFeeUnitAmount: string;
    sellerNetUnitAmount: string;
    shippingAllowancePercentageBps: number;
    scheduleId: string | null;
    agreementId: string | null;
    resolvedAt: string;
  }>;
  resolvePublicStandardListingTerms: (
    params: Readonly<{
      accountType?: CheckoutCommercialAccountType;
      amount: string;
      effectiveAt?: string;
    }>,
  ) => Promise<{
    accountType: CheckoutCommercialAccountType;
    basisAmount: string;
    marketplaceSalesFeeUnitAmount: string;
    sellerNetUnitAmount: string;
    shippingAllowancePercentageBps: number;
    scheduleId: string;
    scheduleLabel: string;
    scheduleUpdatedAt: string;
    resolvedAt: string;
  }>;
}>;

export type CheckoutSellListLineRow = Readonly<{
  seller_account_id: string;
  line_id: string;
  line_type: "selected-offer" | "product";
  offer_id: string | null;
  listing_id: string | null;
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

export type CheckoutSellListConfirmationRow = Readonly<{
  seller_account_id: string;
  confirmation_id: string;
  confirmed_at: string;
  readiness_evidence: unknown;
  seller_evidence: unknown;
  handoff_summary: Readonly<{
    acceptedOfferCount?: number;
    publishedListingCount?: number;
    skippedLineCount?: number;
    skippedReasons?: readonly string[];
    lineOutcomes?: readonly Readonly<{
      lineId: string;
      itemTitle: string;
      status: "completed" | "partial" | "skipped";
      action: "accepted-offer" | "accepted-smart-match" | "published-listing" | "mixed" | "kept-in-sell-list";
      quantity: number;
      remainingQuantity: number;
      detail: string;
      references?: Readonly<{
        offerIds?: readonly string[];
        listingId?: string | null;
      }>;
    }>[];
    sideEffects?: Readonly<Record<string, string>>;
  }>;
}>;

export type CheckoutSellPayoutReadinessRow = Readonly<{
  account_id: string;
  status: "not-started" | "pending" | "ready" | "restricted";
  missing_requirements: readonly string[];
  updated_at: string | null;
}>;

type SellListPageRow = Omit<CheckoutSellListLineRow, "selected_options" | "line_type" | "fallback_mode"> & {
  selected_options: unknown;
  line_type: string;
  fallback_mode: string;
};

type SellListConfirmationPageRow = Omit<CheckoutSellListConfirmationRow, "handoff_summary"> & {
  handoff_summary: unknown;
};

type SellPayoutReadinessPageRow = Omit<CheckoutSellPayoutReadinessRow, "status" | "missing_requirements"> & {
  status: string;
  missing_requirements: unknown;
};

export type CheckoutSellListTermsPreview = Readonly<{
  account_type: "personal" | "business" | "enterprise";
  basis_amount: string;
  marketplace_sales_fee_unit_amount: string;
  seller_net_unit_amount: string;
  shipping_allowance_percentage_bps: number;
  schedule_id: string | null;
  agreement_id: string | null;
  resolved_at: string;
  fee_quote_fingerprint: string;
}>;

export type CheckoutSellListPublicStandardTermsPreview = Readonly<{
  account_type: "personal" | "business" | "enterprise";
  basis_amount: string;
  marketplace_sales_fee_unit_amount: string;
  seller_net_unit_amount: string;
  shipping_allowance_percentage_bps: number;
  source_kind: "public-standard-seller-terms";
  source_label: string;
  schedule_label: string;
  source_updated_at: string;
  resolved_at: string;
}>;

export type CheckoutSellOfferMatch = Readonly<{
  offer_id: string;
  buyer_account_id: string;
  catalog_catalog_item_id: string;
  product_id: string;
  item_title: string;
  item_subtitle: string | null;
  selected_options: readonly VersionSelectedOptionEntry[];
  product_summary: string | null;
  price_amount: string;
  quantity_requested: number;
  status: string;
  accepted_seller_account_id: string | null;
  accepted_at: string | null;
  created_at: string;
  updated_at: string;
  listing_id: string;
  listing_price_amount: string;
  listing_quantity_cap: number;
  listing_visible_quantity: number;
  offer_price_gap_amount: string;
  offer_to_listing_price_bps: number;
  buyer_display_name: string | null;
  buyer_average_rating: string | null;
  buyer_review_count: number;
  seller_available_quantity: number;
  seller_listing_availability_status: "available" | "unavailable";
  can_fulfill: boolean;
}>;

export type CheckoutSellListInventoryItemOption = Readonly<{
  item_id: string;
  catalog_catalog_item_id: string;
  product_id: string;
  item_language_code: string | null;
  item_title: string | null;
  item_subtitle: string | null;
  selected_options: readonly VersionSelectedOptionEntry[];
  product_summary: string | null;
  product_measure_snapshot: Readonly<Record<string, unknown>> | null;
  graded_card: unknown | null;
  storage_location_name: string;
  ship_from_code: string;
  ship_from_address: AddressSnapshot;
  available_quantity: number;
}>;

export type CheckoutSellListOfferReview = Readonly<{
  lineId: string;
  status: "ready" | "unavailable";
  terms: CheckoutSellListTermsPreview | CheckoutSellListPublicStandardTermsPreview | null;
  comparison: CheckoutSellListOfferTermsComparison | null;
  message: string | null;
}>;

export type CheckoutSellListOfferTermsComparisonField =
  | "seller-net"
  | "marketplace-fee"
  | "shipping-allowance"
  | "terms-source";

export type CheckoutSellListOfferTermsComparison = Readonly<{
  status: "same" | "changed" | "standard-preview-unavailable" | "final-unavailable";
  standardPreview: CheckoutSellListPublicStandardTermsPreview | null;
  changedFields: readonly CheckoutSellListOfferTermsComparisonField[];
}>;

export type CheckoutSellListProductOfferReview = Readonly<{
  lineId: string;
  status: "ready" | "unavailable";
  offers: readonly Readonly<{
    offer: CheckoutSellOfferMatch;
    terms: CheckoutSellListTermsPreview;
  }>[];
  message: string | null;
}>;

export type CheckoutSellListCompositeReview = Readonly<{
  offerReviews: readonly CheckoutSellListOfferReview[];
  productOfferReviews: readonly CheckoutSellListProductOfferReview[];
  inventoryItems: readonly CheckoutSellListInventoryItemOption[];
}>;

type SellOfferPageRow = Readonly<{
  offer_id: string;
  buyer_account_id: string;
  catalog_catalog_item_id: string;
  product_id: string;
  item_title: string;
  item_subtitle: string | null;
  selected_options: unknown;
  product_summary: string | null;
  price_amount: string;
  quantity_requested: number;
  status: string;
  accepted_seller_account_id: string | null;
  accepted_at: string | null;
  created_at: string;
  updated_at: string;
}>;

type SellOfferMatchRow = SellOfferPageRow &
  Readonly<{
    listing_id: string;
    listing_price_amount: string;
    listing_quantity_cap: number;
    listing_visible_quantity: number;
    offer_price_gap_amount: string;
    offer_to_listing_price_bps: number;
    buyer_display_name: string | null;
    buyer_average_rating: string | null;
    buyer_review_count: number;
    seller_available_quantity: number;
    seller_listing_availability_status: string | null;
  }>;

type SellInventoryItemRow = Omit<
  CheckoutSellListInventoryItemOption,
  "selected_options" | "ship_from_address" | "product_measure_snapshot"
> & {
  selected_options: unknown;
  ship_from_address: unknown;
  product_measure_snapshot: unknown;
};

function mapSellListLine(row: SellListPageRow): CheckoutSellListLineRow {
  return {
    ...row,
    line_type: row.line_type === "selected-offer" ? "selected-offer" : "product",
    fallback_mode: row.fallback_mode === "create-listing" ? "create-listing" : "none",
    selected_options: Array.isArray(row.selected_options) ? (row.selected_options as VersionSelectedOptionEntry[]) : [],
  };
}

function mapSelectedOptions(value: unknown): readonly VersionSelectedOptionEntry[] {
  return Array.isArray(value) ? (value as VersionSelectedOptionEntry[]) : [];
}

function mapRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === "object" && value !== null ? (value as Readonly<Record<string, unknown>>) : null;
}

function mapAddressSnapshot(value: unknown): AddressSnapshot {
  const source = mapRecord(value);
  return {
    name: String(source?.name ?? ""),
    company: source?.company === null || source?.company === undefined ? null : String(source.company),
    line1: String(source?.line1 ?? ""),
    line2: source?.line2 === null || source?.line2 === undefined ? null : String(source.line2),
    city: String(source?.city ?? ""),
    state: String(source?.state ?? ""),
    postalCode: String(source?.postalCode ?? ""),
    country: String(source?.country ?? "US"),
    phone: source?.phone === null || source?.phone === undefined ? null : String(source.phone),
    email: source?.email === null || source?.email === undefined ? null : String(source.email),
  };
}

function mapSellOfferRow(row: SellOfferPageRow) {
  return {
    ...row,
    selected_options: mapSelectedOptions(row.selected_options),
  };
}

function mapOfferMatch(row: SellOfferMatchRow): CheckoutSellOfferMatch {
  const offer = mapSellOfferRow(row);
  const sellerListingAvailabilityStatus =
    row.seller_listing_availability_status === "unavailable" ? "unavailable" : "available";
  return {
    ...offer,
    listing_id: row.listing_id,
    listing_price_amount: row.listing_price_amount,
    listing_quantity_cap: row.listing_quantity_cap,
    listing_visible_quantity: row.listing_visible_quantity,
    offer_price_gap_amount: row.offer_price_gap_amount,
    offer_to_listing_price_bps: row.offer_to_listing_price_bps,
    buyer_display_name: row.buyer_display_name,
    buyer_average_rating: row.buyer_average_rating,
    buyer_review_count: row.buyer_review_count,
    seller_available_quantity: row.seller_available_quantity,
    seller_listing_availability_status: sellerListingAvailabilityStatus,
    can_fulfill:
      sellerListingAvailabilityStatus === "available" &&
      offer.status === "submitted" &&
      row.seller_available_quantity >= offer.quantity_requested,
  };
}

function mapInventoryItem(row: SellInventoryItemRow): CheckoutSellListInventoryItemOption {
  return {
    ...row,
    selected_options: mapSelectedOptions(row.selected_options),
    product_measure_snapshot: mapRecord(row.product_measure_snapshot),
    ship_from_address: mapAddressSnapshot(row.ship_from_address),
  };
}

function createFeeQuoteFingerprint(
  quote: Readonly<{
    basis_amount: string;
    marketplace_sales_fee_unit_amount: string;
    seller_net_unit_amount: string;
    shipping_allowance_percentage_bps: number;
    schedule_id: string | null;
    agreement_id: string | null;
  }>,
) {
  return [
    quote.basis_amount,
    quote.marketplace_sales_fee_unit_amount,
    quote.seller_net_unit_amount,
    String(quote.shipping_allowance_percentage_bps),
    quote.schedule_id ?? "",
    quote.agreement_id ?? "",
  ].join("|");
}

async function quoteSellerTerms(
  commercialTermsResolver: CheckoutCommercialTermsResolver,
  sellerAccountId: string,
  priceAmount: string,
): Promise<CheckoutSellListTermsPreview> {
  const terms = await commercialTermsResolver.resolveListingTerms({
    accountId: sellerAccountId,
    amount: priceAmount,
  });
  const quote = {
    account_type: terms.accountType,
    basis_amount: terms.basisAmount,
    marketplace_sales_fee_unit_amount: terms.marketplaceSalesFeeUnitAmount,
    seller_net_unit_amount: terms.sellerNetUnitAmount,
    shipping_allowance_percentage_bps: terms.shippingAllowancePercentageBps,
    schedule_id: terms.scheduleId,
    agreement_id: terms.agreementId,
    resolved_at: terms.resolvedAt,
    fee_quote_fingerprint: "",
  };

  return { ...quote, fee_quote_fingerprint: createFeeQuoteFingerprint(quote) };
}

async function quotePublicStandardTerms(
  commercialTermsResolver: CheckoutCommercialTermsResolver,
  priceAmount: string,
): Promise<CheckoutSellListPublicStandardTermsPreview> {
  const terms = await commercialTermsResolver.resolvePublicStandardListingTerms({
    accountType: "personal",
    amount: priceAmount,
  });

  return {
    account_type: terms.accountType,
    basis_amount: terms.basisAmount,
    marketplace_sales_fee_unit_amount: terms.marketplaceSalesFeeUnitAmount,
    seller_net_unit_amount: terms.sellerNetUnitAmount,
    shipping_allowance_percentage_bps: terms.shippingAllowancePercentageBps,
    source_kind: "public-standard-seller-terms",
    source_label: "Standard seller terms",
    schedule_label: terms.scheduleLabel,
    source_updated_at: terms.scheduleUpdatedAt,
    resolved_at: terms.resolvedAt,
  };
}

function moneyCents(amount: string | null | undefined) {
  const normalized = String(amount ?? "0").trim();
  const [dollars = "0", cents = ""] = normalized.split(".");
  return Number(dollars) * 100 + Number((cents + "00").slice(0, 2));
}

function moneyValue(amount: string | null | undefined) {
  const value = Number(amount ?? 0);
  return Number.isFinite(value) ? value : 0;
}

function compareTermsWithStandard(
  finalTerms: CheckoutSellListTermsPreview,
  standardPreview: CheckoutSellListPublicStandardTermsPreview | null,
): CheckoutSellListOfferTermsComparison {
  if (!standardPreview) {
    return { status: "standard-preview-unavailable", standardPreview: null, changedFields: [] };
  }

  const changedFields: CheckoutSellListOfferTermsComparisonField[] = [];
  if (moneyCents(finalTerms.seller_net_unit_amount) !== moneyCents(standardPreview.seller_net_unit_amount)) {
    changedFields.push("seller-net");
  }
  if (
    moneyCents(finalTerms.marketplace_sales_fee_unit_amount) !==
    moneyCents(standardPreview.marketplace_sales_fee_unit_amount)
  ) {
    changedFields.push("marketplace-fee");
  }
  if (finalTerms.shipping_allowance_percentage_bps !== standardPreview.shipping_allowance_percentage_bps) {
    changedFields.push("shipping-allowance");
  }
  if (finalTerms.account_type !== standardPreview.account_type) {
    changedFields.push("terms-source");
  }

  return {
    status: changedFields.length > 0 ? "changed" : "same",
    standardPreview,
    changedFields,
  };
}

function selectedOfferMatchesLine(offer: ReturnType<typeof mapSellOfferRow>, line: CheckoutSellListLineRow) {
  return (
    offer.catalog_catalog_item_id === line.catalog_catalog_item_id &&
    (!line.product_id || offer.product_id === line.product_id)
  );
}

function selectedOfferUnavailableMessage(offer: ReturnType<typeof mapSellOfferRow> | null | undefined, error: unknown) {
  if (offer === null) {
    return error instanceof Error ? error.message : "Offer not found.";
  }
  if (offer === undefined) {
    return error instanceof Error ? error.message : "Offer terms are unavailable.";
  }
  if (offer.status !== "submitted") {
    return offer.status === "accepted"
      ? "Offer has already been accepted."
      : `Offer is no longer submitted (${offer.status}).`;
  }

  const message = error instanceof Error ? error.message : "";
  if (message === "Offer not found.") {
    return "Create a matching listing before accepting this offer.";
  }

  return message || "Offer terms are unavailable.";
}

function normalizePayoutReadinessStatus(status: string): CheckoutSellPayoutReadinessRow["status"] {
  switch (status) {
    case "pending":
    case "ready":
    case "restricted":
      return status;
    default:
      return "not-started";
  }
}

function mapPayoutReadiness(row: SellPayoutReadinessPageRow): CheckoutSellPayoutReadinessRow {
  return {
    ...row,
    status: normalizePayoutReadinessStatus(row.status),
    missing_requirements: Array.isArray(row.missing_requirements)
      ? row.missing_requirements.filter((value): value is string => typeof value === "string")
      : [],
  };
}

export function createEmptySellPayoutReadiness(accountId: string): CheckoutSellPayoutReadinessRow {
  return {
    account_id: accountId,
    status: "not-started",
    missing_requirements: ["provider-onboarding", "seller-agreement"],
    updated_at: null,
  };
}

export async function listSellListLines(db: PgQueryable, sellerAccountId: string): Promise<CheckoutSellListLineRow[]> {
  const result = await db.query<SellListPageRow>(
    `SELECT
       seller_account_id,
       line_id,
       line_type,
       offer_id,
       listing_id,
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

export async function getLatestSellListConfirmation(
  db: PgQueryable,
  sellerAccountId: string,
): Promise<CheckoutSellListConfirmationRow | null> {
  const result = await db.query<SellListConfirmationPageRow>(
    `SELECT
       seller_account_id,
       confirmation_id,
       confirmed_at,
       readiness_evidence,
       seller_evidence,
       handoff_summary
     FROM checkout_sell_list_confirmation_pages
     WHERE seller_account_id = $1
     ORDER BY confirmed_at DESC, confirmation_id DESC
     LIMIT 1`,
    [sellerAccountId],
  );

  const row = result.rows[0];
  if (row) {
    return mapSellListConfirmation(row);
  }

  return null;
}

function mapSellListConfirmation(row: SellListConfirmationPageRow): CheckoutSellListConfirmationRow {
  return {
    ...row,
    handoff_summary:
      typeof row.handoff_summary === "object" && row.handoff_summary !== null
        ? (row.handoff_summary as CheckoutSellListConfirmationRow["handoff_summary"])
        : {},
  };
}

export async function getSellListConfirmation(
  db: PgQueryable,
  sellerAccountId: string,
  confirmationId: string,
): Promise<CheckoutSellListConfirmationRow | null> {
  const result = await db.query<SellListConfirmationPageRow>(
    `SELECT
       seller_account_id,
       confirmation_id,
       confirmed_at,
       readiness_evidence,
       seller_evidence,
       handoff_summary
     FROM checkout_sell_list_confirmation_pages
     WHERE seller_account_id = $1
       AND confirmation_id = $2
     LIMIT 1`,
    [sellerAccountId, confirmationId],
  );

  const row = result.rows[0];
  return row ? mapSellListConfirmation(row) : null;
}

export async function getSellPayoutReadiness(
  db: PgQueryable,
  accountId: string,
): Promise<CheckoutSellPayoutReadinessRow> {
  const result = await db.query<SellPayoutReadinessPageRow>(
    `SELECT
       account_id,
       status,
       missing_requirements,
       updated_at
     FROM checkout_sell_payout_readiness_pages
     WHERE account_id = $1`,
    [accountId],
  );

  const row = result.rows[0];
  return row ? mapPayoutReadiness(row) : createEmptySellPayoutReadiness(accountId);
}

async function getSellOffer(db: PgQueryable, offerId: string) {
  const result = await db.query<SellOfferPageRow>(
    `SELECT
       offer_id,
       buyer_account_id,
       catalog_catalog_item_id,
       product_id,
       item_title,
       item_subtitle,
       selected_options,
       product_summary,
       price_amount::text AS price_amount,
       quantity_requested,
       status,
       accepted_seller_account_id,
       accepted_at::text AS accepted_at,
       created_at::text AS created_at,
       updated_at::text AS updated_at
     FROM checkout_sell_offer_pages
     WHERE offer_id = $1
     LIMIT 1`,
    [offerId],
  );

  const row = result.rows[0];
  return row ? mapSellOfferRow(row) : null;
}

const offerMatchSelectSql = `
  offer.offer_id,
  offer.buyer_account_id,
  offer.catalog_catalog_item_id,
  offer.product_id,
  offer.item_title,
  offer.item_subtitle,
  offer.selected_options,
  offer.product_summary,
  offer.price_amount::text AS price_amount,
  offer.quantity_requested,
  offer.status,
  offer.accepted_seller_account_id,
  offer.accepted_at::text AS accepted_at,
  offer.created_at::text AS created_at,
  offer.updated_at::text AS updated_at,
  buyer.display_name AS buyer_display_name,
  buyer.average_rating::text AS buyer_average_rating,
  COALESCE(buyer.review_count, 0)::integer AS buyer_review_count,
  matched_listing.listing_id,
  matched_listing.listing_price_amount::text AS listing_price_amount,
  matched_listing.listing_quantity_cap,
  matched_listing.listing_visible_quantity,
  matched_listing.listing_visible_quantity AS seller_available_quantity,
  (matched_listing.listing_price_amount - offer.price_amount)::numeric(12,2)::text AS offer_price_gap_amount,
  CASE
    WHEN matched_listing.listing_price_amount > 0
      THEN ROUND((offer.price_amount / matched_listing.listing_price_amount) * 10000)::integer
    ELSE 0
  END AS offer_to_listing_price_bps,
  'available' AS seller_listing_availability_status`;

function offerMatchListingJoinSql(sellerAccountSql: string) {
  return `
  INNER JOIN LATERAL (
    SELECT
      option.listing_id,
      option.price_amount AS listing_price_amount,
      option.listing_quantity_cap,
      LEAST(
        option.listing_quantity_cap,
        GREATEST(
          COALESCE(option.supply_total_quantity, option.listing_quantity_cap) - COALESCE(option.active_held_quantity, 0),
          0
        )
      )::integer AS listing_visible_quantity
    FROM checkout_marketplace_seller_options AS option
    WHERE option.seller_account_id = ${sellerAccountSql}
      AND option.status = 'active'
      AND option.product_id = offer.product_id
    ORDER BY
      CASE
        WHEN option.price_amount > 0 THEN offer.price_amount / option.price_amount
        ELSE 0
      END DESC,
      option.price_amount ASC,
      option.updated_at DESC,
      option.listing_id ASC
    LIMIT 1
  ) AS matched_listing ON TRUE`;
}

export async function getCheckoutSellOfferMatch(
  db: PgQueryable,
  sellerAccountId: string,
  offerId: string,
): Promise<CheckoutSellOfferMatch | null> {
  const result = await db.query<SellOfferMatchRow>(
    `SELECT ${offerMatchSelectSql}
     FROM checkout_sell_offer_pages AS offer
     ${offerMatchListingJoinSql("$1")}
     LEFT JOIN checkout_seller_accounts AS buyer
       ON buyer.account_id = offer.buyer_account_id
     WHERE offer.offer_id = $2
       AND offer.status = 'submitted'
       AND EXISTS (
         SELECT 1
         FROM checkout_marketplace_seller_options AS option
         WHERE option.seller_account_id = $1
           AND option.status = 'active'
           AND option.product_id = offer.product_id
       )`,
    [sellerAccountId, offerId],
  );

  const row = result.rows[0];
  return row ? mapOfferMatch(row) : null;
}

async function listCheckoutSellOfferMatches(
  db: PgQueryable,
  params: Readonly<{
    sellerAccountId: string;
    productIds: readonly string[];
    excludedOfferIds?: readonly string[];
    limit?: number;
  }>,
): Promise<CheckoutSellOfferMatch[]> {
  const productIds = [...new Set(params.productIds.map((value) => value.trim()).filter(Boolean))];
  if (productIds.length === 0) {
    return [];
  }

  const excludedOfferIds = [...new Set((params.excludedOfferIds ?? []).map((value) => value.trim()).filter(Boolean))];
  const result = await db.query<SellOfferMatchRow>(
    `SELECT ${offerMatchSelectSql}
     FROM checkout_sell_offer_pages AS offer
     ${offerMatchListingJoinSql("$1")}
     LEFT JOIN checkout_seller_accounts AS buyer
       ON buyer.account_id = offer.buyer_account_id
     WHERE offer.status = 'submitted'
       AND offer.product_id = ANY($2::text[])
       AND NOT (offer.offer_id = ANY($3::text[]))
       AND matched_listing.listing_visible_quantity >= offer.quantity_requested
     ORDER BY
       offer_to_listing_price_bps DESC,
       offer.price_amount DESC,
       offer.quantity_requested DESC,
       offer.created_at ASC,
       offer.offer_id ASC
     LIMIT $4`,
    [params.sellerAccountId, productIds, excludedOfferIds, Math.max(1, Math.min(params.limit ?? 250, 250))],
  );

  return result.rows.map(mapOfferMatch);
}

export async function listCheckoutSellListInventoryItems(
  db: PgQueryable,
  sellerAccountId: string,
): Promise<CheckoutSellListInventoryItemOption[]> {
  const result = await db.query<SellInventoryItemRow>(
    `SELECT
       item.item_id,
       item.catalog_catalog_item_id,
       item.product_id,
       catalog.language_code AS item_language_code,
       catalog.title AS item_title,
       catalog.subtitle AS item_subtitle,
       item.selected_options,
       NULL::text AS product_summary,
       NULL::jsonb AS product_measure_snapshot,
       item.graded_card,
       location.name AS storage_location_name,
       location.ship_from_code,
       location.ship_from_address,
       GREATEST(item.total_quantity - COALESCE(active_holds.held_quantity, 0), 0)::integer AS available_quantity
     FROM checkout_supply_items AS item
     INNER JOIN checkout_supply_locations AS location
       ON location.storage_location_id = item.storage_location_id
      AND location.account_id = item.account_id
      AND location.is_archived = false
     LEFT JOIN checkout_catalog_items AS catalog
       ON catalog.catalog_item_id = item.catalog_catalog_item_id
     LEFT JOIN (
       SELECT item_id, SUM(quantity)::integer AS held_quantity
       FROM checkout_supply_holds
       WHERE status = 'active'
       GROUP BY item_id
     ) AS active_holds
       ON active_holds.item_id = item.item_id
     WHERE item.account_id = $1
       AND item.catalog_catalog_item_id IS NOT NULL
       AND item.product_id IS NOT NULL
       AND GREATEST(item.total_quantity - COALESCE(active_holds.held_quantity, 0), 0) > 0
     ORDER BY item.updated_at DESC, item.item_id ASC`,
    [sellerAccountId],
  );

  return result.rows.map(mapInventoryItem);
}

export async function loadCheckoutSellListCompositeReview(
  db: PgQueryable,
  commercialTermsResolver: CheckoutCommercialTermsResolver,
  params: Readonly<{
    sellerAccountId: string;
    lines: readonly CheckoutSellListLineRow[];
    includeStandardComparison?: boolean;
  }>,
): Promise<CheckoutSellListCompositeReview> {
  const selectedOfferLines = params.lines.filter((line) => line.line_type === "selected-offer" && line.offer_id);
  const productLines = params.lines.filter((line) => line.line_type === "product");
  const selectedOfferIds = selectedOfferLines.map((line) => line.offer_id as string);
  const offerRows = new Map(
    await Promise.all(selectedOfferIds.map(async (offerId) => [offerId, await getSellOffer(db, offerId)] as const)),
  );
  const standardPreviewByPrice = new Map<string, Promise<CheckoutSellListPublicStandardTermsPreview | null>>();
  const standardPreviewForPrice = (priceAmount: string | null | undefined) => {
    if (!params.includeStandardComparison || !priceAmount) {
      return Promise.resolve(null);
    }
    if (!standardPreviewByPrice.has(priceAmount)) {
      standardPreviewByPrice.set(
        priceAmount,
        quotePublicStandardTerms(commercialTermsResolver, priceAmount).catch(() => null),
      );
    }
    return standardPreviewByPrice.get(priceAmount)!;
  };

  const offerReviews = await Promise.all(
    selectedOfferLines.map(async (line): Promise<CheckoutSellListOfferReview> => {
      const offer = offerRows.get(line.offer_id!) ?? null;
      const standardPreviewPromise = standardPreviewForPrice(line.offer_price_amount);
      try {
        if (!offer) {
          throw new Error("Offer not found.");
        }
        if (!selectedOfferMatchesLine(offer, line)) {
          throw new Error("Selected offer no longer matches this Sell List line.");
        }
        if (offer.status !== "submitted") {
          throw new Error("Offer is no longer submitted.");
        }
        const [terms, standardPreview] = await Promise.all([
          quoteSellerTerms(commercialTermsResolver, params.sellerAccountId, offer.price_amount),
          standardPreviewPromise,
        ]);
        return {
          lineId: line.line_id,
          status: "ready",
          terms,
          comparison: params.includeStandardComparison ? compareTermsWithStandard(terms, standardPreview) : null,
          message: null,
        };
      } catch (error) {
        const standardPreview = await standardPreviewPromise;
        return {
          lineId: line.line_id,
          status: "unavailable",
          terms: null,
          comparison: params.includeStandardComparison
            ? { status: "final-unavailable", standardPreview, changedFields: [] }
            : null,
          message: selectedOfferUnavailableMessage(offer, error),
        };
      }
    }),
  );

  const productOfferMatches = await listCheckoutSellOfferMatches(db, {
    sellerAccountId: params.sellerAccountId,
    productIds: productLines.map((line) => line.product_id),
    excludedOfferIds: selectedOfferIds,
    limit: Math.min(250, Math.max(50, productLines.length * 20)),
  });
  const productOfferReviews = await Promise.all(
    productLines.map(async (line): Promise<CheckoutSellListProductOfferReview> => {
      const lineMatches = productOfferMatches
        .filter((offer) => offer.product_id === line.product_id)
        .sort(
          (left, right) =>
            right.offer_to_listing_price_bps - left.offer_to_listing_price_bps ||
            Number(right.price_amount) - Number(left.price_amount) ||
            left.offer_id.localeCompare(right.offer_id),
        );
      const offers: Array<CheckoutSellListProductOfferReview["offers"][number]> = [];
      let remainingQuantity = line.quantity;

      for (const offer of lineMatches) {
        if (remainingQuantity <= 0) {
          break;
        }
        if (offer.quantity_requested > remainingQuantity) {
          continue;
        }
        try {
          offers.push({
            offer,
            terms: await quoteSellerTerms(commercialTermsResolver, params.sellerAccountId, offer.price_amount),
          });
          remainingQuantity -= offer.quantity_requested;
        } catch {
          // Stale terms should not block other local matches from being reviewed.
        }
      }

      return {
        lineId: line.line_id,
        status: offers.length > 0 ? "ready" : "unavailable",
        offers: offers.sort(
          (left, right) =>
            moneyValue(right.terms.seller_net_unit_amount) - moneyValue(left.terms.seller_net_unit_amount) ||
            Number(right.offer.can_fulfill) - Number(left.offer.can_fulfill) ||
            (right.offer.buyer_review_count ?? 0) - (left.offer.buyer_review_count ?? 0) ||
            new Date(right.offer.created_at).getTime() - new Date(left.offer.created_at).getTime() ||
            right.offer.quantity_requested - left.offer.quantity_requested ||
            left.offer.offer_id.localeCompare(right.offer.offer_id),
        ),
        message: offers.length > 0 ? null : "No matching offers are currently ready for this product.",
      };
    }),
  );

  return {
    offerReviews,
    productOfferReviews,
    inventoryItems: productLines.length > 0 ? await listCheckoutSellListInventoryItems(db, params.sellerAccountId) : [],
  };
}

export async function loadCheckoutGuestSellListOfferReviews(
  commercialTermsResolver: CheckoutCommercialTermsResolver,
  lines: readonly CheckoutSellListLineRow[],
): Promise<readonly CheckoutSellListOfferReview[]> {
  const selectedOfferLines = lines.filter((line) => line.line_type === "selected-offer" && line.offer_price_amount);
  const previewByPrice = new Map<string, Promise<CheckoutSellListPublicStandardTermsPreview | null>>();
  const previewForPrice = (priceAmount: string) => {
    if (!previewByPrice.has(priceAmount)) {
      previewByPrice.set(
        priceAmount,
        quotePublicStandardTerms(commercialTermsResolver, priceAmount).catch(() => null),
      );
    }
    return previewByPrice.get(priceAmount)!;
  };

  return Promise.all(
    selectedOfferLines.map(async (line) => {
      const terms = line.offer_price_amount ? await previewForPrice(line.offer_price_amount) : null;
      return {
        lineId: line.line_id,
        status: terms ? ("ready" as const) : ("unavailable" as const),
        terms,
        comparison: null,
        message: terms ? null : "Public standard seller terms are temporarily unavailable.",
      };
    }),
  );
}
