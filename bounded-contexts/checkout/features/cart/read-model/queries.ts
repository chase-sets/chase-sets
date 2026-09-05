import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { CheckoutDomainError, type VersionSelectedOptionEntry } from "../../../support/runtime-support/common";

export const CART_SELLER_OPTIONS_PER_LINE_LIMIT = 25;

export type CheckoutCartLineRow = Readonly<{
  buyer_account_id: string;
  line_id: string;
  catalog_catalog_item_id: string;
  product_id: string;
  item_language_code: string | null;
  item_title: string;
  item_subtitle: string | null;
  item_image_url: string | null;
  item_image_srcset: string | null;
  item_image_loading_url: string | null;
  item_image_loading_alt: string | null;
  item_image_loading_srcset: string | null;
  selected_options: readonly VersionSelectedOptionEntry[];
  product_summary: string | null;
  quantity: number;
  fulfillment_mode: "optimize" | "locked-listing";
  locked_listing_id: string | null;
  selected_listing_id: string | null;
  selected_listing_seller_account_id: string | null;
  selected_listing_seller_display_name: string | null;
  selected_listing_seller_slug: string | null;
  selected_listing_price_amount: string | null;
  selected_listing_snapshot_source: string | null;
  selected_listing_snapshot_captured_at: string | null;
  seller_preference_id: string | null;
  availability_state: "available" | "unavailable" | "changed" | "waiting-for-supply";
  seller_options: readonly CheckoutCartSellerOptionRow[];
  created_at: string;
  updated_at: string;
}>;

export type CheckoutCartSellerOptionRow = Readonly<{
  listing_id: string;
  seller_account_id: string | null;
  seller_slug: string | null;
  seller_display_name: string | null;
  seller_average_rating: string | null;
  seller_review_count: number;
  price_amount: string;
  available_quantity: number;
  product_summary: string | null;
  product_measure_snapshot: Readonly<Record<string, unknown>> | null;
}>;

export type CheckoutCartClaimRow = Readonly<{
  source_owner_key: string;
  account_id: string;
}>;

type CartLinePageRow = Readonly<{
  buyer_account_id: string;
  line_id: string;
  catalog_catalog_item_id: string;
  product_id: string;
  item_language_code: string | null;
  item_title: string;
  item_subtitle: string | null;
  item_image_url: string | null;
  item_image_srcset: string | null;
  item_image_loading_url: string | null;
  item_image_loading_alt: string | null;
  item_image_loading_srcset: string | null;
  selected_options: unknown;
  product_summary: string | null;
  quantity: number;
  fulfillment_mode: string;
  locked_listing_id: string | null;
  selected_listing_id: string | null;
  selected_listing_seller_account_id: string | null;
  selected_listing_seller_display_name: string | null;
  selected_listing_seller_slug: string | null;
  selected_listing_price_amount: string | null;
  selected_listing_snapshot_source: string | null;
  selected_listing_snapshot_captured_at: string | null;
  seller_preference_id: string | null;
  availability_state: string;
  seller_options: unknown;
  created_at: string;
  updated_at: string;
}>;

function mapSellerOption(value: unknown): CheckoutCartSellerOptionRow | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const source = value as Record<string, unknown>;
  const listingId = String(source.listing_id ?? "").trim();
  const priceAmount = String(source.price_amount ?? "").trim();
  const availableQuantity = Number(source.available_quantity ?? 0);

  if (!listingId || !priceAmount || !Number.isFinite(availableQuantity) || availableQuantity <= 0) {
    return null;
  }

  return {
    listing_id: listingId,
    seller_account_id:
      source.seller_account_id === null || source.seller_account_id === undefined
        ? null
        : String(source.seller_account_id).trim() || null,
    seller_slug:
      source.seller_slug === null || source.seller_slug === undefined
        ? null
        : String(source.seller_slug).trim() || null,
    seller_display_name:
      source.seller_display_name === null || source.seller_display_name === undefined
        ? null
        : String(source.seller_display_name).trim() || null,
    seller_average_rating:
      source.seller_average_rating === null || source.seller_average_rating === undefined
        ? null
        : String(source.seller_average_rating).trim() || null,
    seller_review_count: Number.isFinite(Number(source.seller_review_count)) ? Number(source.seller_review_count) : 0,
    price_amount: priceAmount,
    available_quantity: availableQuantity,
    product_summary:
      source.product_summary === null || source.product_summary === undefined
        ? null
        : String(source.product_summary).trim() || null,
    product_measure_snapshot:
      typeof source.product_measure_snapshot === "object" && source.product_measure_snapshot !== null
        ? (source.product_measure_snapshot as Readonly<Record<string, unknown>>)
        : null,
  };
}

function mapNullableText(value: unknown) {
  return value === null || value === undefined ? null : String(value).trim() || null;
}

function mapCartLineRow(row: CartLinePageRow): CheckoutCartLineRow {
  return {
    ...row,
    fulfillment_mode: row.fulfillment_mode === "locked-listing" ? "locked-listing" : "optimize",
    availability_state:
      row.availability_state === "unavailable" ||
      row.availability_state === "changed" ||
      row.availability_state === "waiting-for-supply"
        ? row.availability_state
        : "available",
    selected_listing_id: mapNullableText(row.selected_listing_id),
    selected_listing_seller_account_id: mapNullableText(row.selected_listing_seller_account_id),
    selected_listing_seller_display_name: mapNullableText(row.selected_listing_seller_display_name),
    selected_listing_seller_slug: mapNullableText(row.selected_listing_seller_slug),
    selected_listing_price_amount: mapNullableText(row.selected_listing_price_amount),
    selected_listing_snapshot_source: mapNullableText(row.selected_listing_snapshot_source),
    selected_listing_snapshot_captured_at: mapNullableText(row.selected_listing_snapshot_captured_at),
    selected_options: Array.isArray(row.selected_options) ? (row.selected_options as VersionSelectedOptionEntry[]) : [],
    seller_options: Array.isArray(row.seller_options)
      ? row.seller_options
          .map(mapSellerOption)
          .filter((option): option is CheckoutCartSellerOptionRow => option !== null)
      : [],
  };
}

export type CheckoutCartClaimPair = Readonly<{
  sourceOwnerKey: string;
  accountId: string;
}>;

/**
 * Writes the operational Cart Claim alias and verifies what is actually stored.
 *
 * The insert is immutable -- conflicts do nothing -- so this never transfers
 * ownership, and the read-back is what makes the call honest: a row naming a
 * different Account is a conflict that must surface, not be overwritten and not
 * be reported as a successful claim. Because the insert is idempotent, both the
 * first claim and a later repair of a committed-event/missing-alias state run
 * exactly the same statement pair.
 *
 * The caller supplies the database handle, so a projector passes its own
 * transaction and this helper never opens or commits one of its own.
 */
export async function reconcileCheckoutCartClaim(db: PgQueryable, claim: CheckoutCartClaimPair): Promise<void> {
  await db.query(
    `INSERT INTO checkout_cart_claims (source_owner_key, account_id)
     VALUES ($1, $2)
     ON CONFLICT (source_owner_key) DO NOTHING`,
    [claim.sourceOwnerKey, claim.accountId],
  );

  const stored = await db.query<CheckoutCartClaimRow>(
    `SELECT claim.source_owner_key, claim.account_id
     FROM checkout_cart_claims AS claim
     WHERE claim.source_owner_key = $1`,
    [claim.sourceOwnerKey],
  );
  const storedClaim = stored.rows[0];

  if (!storedClaim) {
    throw new CheckoutDomainError("Cart claim alias was not stored.", "cart_claim_not_reconciled");
  }

  if (storedClaim.account_id !== claim.accountId) {
    throw new CheckoutDomainError("Cart claim alias is held by a different account.", "cart_claim_conflict");
  }
}

/**
 * Whether an owner key can resolve across more than its own stream.
 *
 * Only an Account can claim, which is the `starts_with($1, 'acc_')` predicate
 * the union resolver applies below. An anonymous key therefore always resolves
 * to exactly itself, and callers can skip work that could only ever confirm
 * that. Keeping the rule here keeps it next to the SQL it mirrors.
 */
export function ownerKeyCanHoldClaims(ownerKey: string): boolean {
  return ownerKey.startsWith("acc_");
}

/**
 * Lists the anonymous source keys an Account has claimed, smallest first under
 * the deterministic `C` collation.
 *
 * This is routing breadth, never authorization: it answers "which streams may
 * hold a line this Account owns", and each resulting write is still authorized
 * by the claimed stream's own evolved state. A lagging or hand-deleted alias can
 * therefore only narrow a sweep -- which a retry finishes -- and can never widen
 * one into a stream the Account does not own, because that stream refuses.
 *
 * Only an Account can hold claims, so a non-Account key is answered without a
 * round trip, keeping the anonymous request path free of a query that can only
 * ever return no rows.
 */
export async function listClaimedCartOwnerKeys(db: PgQueryable, accountId: string): Promise<string[]> {
  if (!ownerKeyCanHoldClaims(accountId)) {
    return [];
  }

  const result = await db.query<Pick<CheckoutCartClaimRow, "source_owner_key">>(
    `SELECT claim.source_owner_key
     FROM checkout_cart_claims AS claim
     WHERE claim.account_id = $1
     ORDER BY claim.source_owner_key COLLATE "C" ASC`,
    [accountId],
  );

  return result.rows.map((row) => row.source_owner_key);
}

/**
 * Resolves the cart lines a requested owner may read, in one statement.
 *
 * Requested owners are the primary owner key, every source key that owner has
 * claimed (Account reads only), and an optional presented anonymous key. They
 * are deduplicated before ranking so a key that is both claimed and presented
 * contributes one requested owner rather than multiplying rows.
 *
 * A `line_id` held by more than one requested owner resolves to exactly one
 * whole row: the Account's own row wins, then the newest claimed row, then the
 * lexicographically smallest source owner under the deterministic `C` collation,
 * and a presented-only source last. Output puts the logical Account union
 * (own plus claimed) first and the presented-only rows after it, each ordered
 * `updated_at DESC, line_id ASC` -- which is exactly the shipped two-group order
 * when the owner has no claims.
 */
async function resolveCartLines(
  db: PgQueryable,
  ownerKey: string,
  presentedAnonymousCartId: string | null,
  includeClaimedOwners: boolean,
): Promise<CheckoutCartLineRow[]> {
  const result = await db.query<CartLinePageRow>(
    `WITH requested_owners AS (
       SELECT candidate_owner.owner_id, MIN(candidate_owner.owner_precedence) AS owner_precedence
       FROM (
         SELECT $1::text AS owner_id, 0::integer AS owner_precedence
         UNION ALL
         SELECT claim.source_owner_key AS owner_id, 1::integer AS owner_precedence
         FROM checkout_cart_claims AS claim
         WHERE $4::boolean
           AND starts_with($1::text, 'acc_')
           AND claim.account_id = $1::text
         UNION ALL
         SELECT $2::text AS owner_id, 2::integer AS owner_precedence
         WHERE $2::text IS NOT NULL
       ) AS candidate_owner
       GROUP BY candidate_owner.owner_id
     ),
     ranked_lines AS (
       SELECT
         cart_line.*,
         requested_owner.owner_precedence,
         ROW_NUMBER() OVER (
           PARTITION BY cart_line.line_id
           ORDER BY
             requested_owner.owner_precedence ASC,
             cart_line.updated_at DESC,
             requested_owner.owner_id COLLATE "C" ASC
         ) AS owner_line_rank
       FROM requested_owners AS requested_owner
       INNER JOIN checkout_cart_line_pages AS cart_line
         ON cart_line.buyer_account_id = requested_owner.owner_id
     ),
     winning_lines AS (
       SELECT
         ranked_line.*,
         CASE WHEN ranked_line.owner_precedence <= 1 THEN 0 ELSE 1 END AS owner_output_group
       FROM ranked_lines AS ranked_line
       WHERE ranked_line.owner_line_rank = 1
     )
     SELECT
       line.buyer_account_id,
       line.line_id,
       line.catalog_catalog_item_id,
       line.product_id,
       line.item_language_code,
       line.item_title,
       line.item_subtitle,
       line.item_image_url,
       line.item_image_srcset,
       line.item_image_loading_url,
       line.item_image_loading_alt,
       line.item_image_loading_srcset,
       line.selected_options,
       line.product_summary,
       line.quantity,
       line.fulfillment_mode,
       line.locked_listing_id,
       line.selected_listing_id,
       line.selected_listing_seller_account_id,
       line.selected_listing_seller_display_name,
       line.selected_listing_seller_slug,
       line.selected_listing_price_amount::text AS selected_listing_price_amount,
       line.selected_listing_snapshot_source,
       line.selected_listing_snapshot_captured_at::text AS selected_listing_snapshot_captured_at,
       line.seller_preference_id,
       line.availability_state,
       opt.seller_options,
       line.created_at,
       line.updated_at
     FROM winning_lines AS line
     LEFT JOIN LATERAL (
       SELECT COALESCE(
         json_agg(
           json_build_object(
             'listing_id', o.listing_id,
             'seller_account_id', o.seller_account_id,
             'seller_slug', COALESCE(seller.slug, o.seller_slug),
             'seller_display_name', COALESCE(seller.display_name, o.seller_display_name),
             'seller_average_rating', COALESCE(seller.average_rating, o.seller_average_rating)::text,
             'seller_review_count', COALESCE(seller.rating_count, o.seller_review_count, 0),
             'price_amount', o.price_amount::text,
             'available_quantity', LEAST(
               o.listing_quantity_cap,
               GREATEST(
                 COALESCE(o.supply_total_quantity, o.listing_quantity_cap) - COALESCE(o.active_held_quantity, 0),
                 0
               )
             ),
             'product_summary', o.product_summary,
             'product_measure_snapshot', o.product_measure_snapshot
           )
           ORDER BY o.price_amount ASC, o.listing_id ASC
         ),
         '[]'::json
       ) AS seller_options
       FROM (
         SELECT
           option.listing_id,
           option.seller_account_id,
           option.seller_slug,
           option.seller_display_name,
           option.seller_average_rating,
           option.seller_review_count,
           option.price_amount,
           option.listing_quantity_cap,
           option.supply_total_quantity,
           option.active_held_quantity,
           option.product_summary,
           option.product_measure_snapshot
         FROM checkout_marketplace_seller_options option
         WHERE option.product_id = line.product_id
           AND option.status = 'active'
           -- At-capacity sellers (m127 #4883) drop out of both the
           -- alternative-listing candidates and, for a locked line, the
           -- readiness re-check (selectedCartReadinessListing looks the
           -- locked listing_id up in this same result set).
           AND option.at_capacity = false
           AND LEAST(
             option.listing_quantity_cap,
             GREATEST(
               COALESCE(option.supply_total_quantity, option.listing_quantity_cap) -
                 COALESCE(option.active_held_quantity, 0),
               0
             )
           ) > 0
         ORDER BY option.price_amount ASC, option.listing_id ASC
         LIMIT $3
       ) o
       LEFT JOIN checkout_seller_accounts seller
         ON seller.account_id = o.seller_account_id
     ) opt ON true
     ORDER BY line.owner_output_group ASC, line.updated_at DESC, line.line_id ASC`,
    [ownerKey, presentedAnonymousCartId, CART_SELLER_OPTIONS_PER_LINE_LIMIT, includeClaimedOwners],
  );

  return result.rows.map(mapCartLineRow);
}

export async function listCartLines(
  db: PgQueryable,
  buyerAccountId: string,
  presentedAnonymousCartId?: string | null,
): Promise<CheckoutCartLineRow[]> {
  return resolveCartLines(db, buyerAccountId, presentedAnonymousCartId ?? null, true);
}

/**
 * Resolves only the lines the supplied owner key holds itself -- no claimed keys
 * and no presented key -- through the same SQL and seller-option enrichment.
 *
 * A caller that must address one aggregate needs this instead of filtering a
 * resolved union afterwards: matching a line that lives on a claimed source
 * stream and then commanding the Account stream targets an aggregate where that
 * line does not exist.
 */
export async function listOwnCartLines(db: PgQueryable, ownerKey: string): Promise<CheckoutCartLineRow[]> {
  return resolveCartLines(db, ownerKey, null, false);
}
