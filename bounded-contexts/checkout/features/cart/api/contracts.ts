import type { CheckoutCartReadAuthority } from "../domain/domain";
import type { CheckoutCartLineRow } from "../read-model/queries";
import type { CheckoutCartLine } from "../ui/contracts";

export type { CheckoutCartLine } from "../ui/contracts";
export type { CartReadinessDecisionInput, CartReadinessSnapshot } from "../domain/readiness";
export type { CheckoutCartReadAuthority, CheckoutCartSourceStanding } from "../domain/domain";

export function normalizePresentedAnonymousCartId(value: string | null | undefined) {
  const normalized = value?.trim() ?? "";
  return normalized.startsWith("anon_") ? normalized : null;
}

/**
 * The Cart-owned read authority answer as services hand it to callers.
 *
 * `clearRetainedAnonymousCartCookie` is internal metadata carried only by a
 * decided refusal, and the union is shaped so that is a type-level guarantee:
 * `indeterminate` cannot express the field at all, so a transient store failure
 * can never be mistaken for evidence that a retained cookie is worthless. It is
 * never a public response field and never an error code: its only planned
 * consumer is the retained-anonymous-cart cookie-clearing slice, and until
 * that lands nothing reads it.
 */
export type CheckoutCartSourceAuthority =
  | Readonly<{ status: "accepted"; acceptedVia: "possession" | "account" }>
  | Readonly<{ status: "refused"; clearRetainedAnonymousCartCookie: true }>
  | Readonly<{ status: "indeterminate" }>;

/** Attaches the internal cookie-clear classification to a decided refusal, and to nothing else. */
export function classifyCheckoutCartSourceAuthority(authority: CheckoutCartReadAuthority): CheckoutCartSourceAuthority {
  return authority.status === "refused" ? { status: "refused", clearRetainedAnonymousCartCookie: true } : authority;
}

/**
 * Projects an internal Cart line row onto the public contract.
 *
 * This is a closed allowlist rather than an owner-key deletion: a field reaches
 * a public payload only by being named here, so a later internal column cannot
 * leak by simply existing on the row. `buyer_account_id` is the field this
 * boundary exists to drop; internal callers keep reading it straight off the
 * row.
 */
export function toPublicCheckoutCartLine(line: CheckoutCartLineRow): CheckoutCartLine {
  return {
    line_id: line.line_id,
    catalog_catalog_item_id: line.catalog_catalog_item_id,
    product_id: line.product_id,
    item_language_code: line.item_language_code,
    item_title: line.item_title,
    item_subtitle: line.item_subtitle,
    item_image_url: line.item_image_url,
    item_image_srcset: line.item_image_srcset,
    item_image_loading_url: line.item_image_loading_url,
    item_image_loading_alt: line.item_image_loading_alt,
    item_image_loading_srcset: line.item_image_loading_srcset,
    selected_options: line.selected_options,
    product_summary: line.product_summary,
    quantity: line.quantity,
    fulfillment_mode: line.fulfillment_mode,
    locked_listing_id: line.locked_listing_id,
    selected_listing_id: line.selected_listing_id,
    selected_listing_seller_account_id: line.selected_listing_seller_account_id,
    selected_listing_seller_display_name: line.selected_listing_seller_display_name,
    selected_listing_seller_slug: line.selected_listing_seller_slug,
    selected_listing_price_amount: line.selected_listing_price_amount,
    selected_listing_snapshot_source: line.selected_listing_snapshot_source,
    selected_listing_snapshot_captured_at: line.selected_listing_snapshot_captured_at,
    seller_preference_id: line.seller_preference_id,
    availability_state: line.availability_state,
    seller_options: line.seller_options.map((option) => ({
      listing_id: option.listing_id,
      seller_account_id: option.seller_account_id,
      seller_slug: option.seller_slug,
      seller_display_name: option.seller_display_name,
      seller_average_rating: option.seller_average_rating,
      seller_review_count: option.seller_review_count,
      price_amount: option.price_amount,
      available_quantity: option.available_quantity,
      product_summary: option.product_summary,
      product_measure_snapshot: option.product_measure_snapshot,
    })),
    created_at: line.created_at,
    updated_at: line.updated_at,
  };
}

export function toPublicCheckoutCartLines(lines: readonly CheckoutCartLineRow[]): CheckoutCartLine[] {
  return lines.map(toPublicCheckoutCartLine);
}
