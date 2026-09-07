/**
 * The public Cart line every HTTP, MCP, client, and UI consumer sees.
 *
 * `buyer_account_id` is deliberately absent. It is internal source provenance
 * that tells Cart and Checkout Session which stream a union-sourced line came
 * from; publishing it would hand any reader the retained anonymous key -- or
 * the claimant Account -- behind a line they can already see.
 */
export interface CheckoutCartLine {
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
  selected_options: readonly { dimensionId: string; optionId: string }[];
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
  seller_options: readonly {
    listing_id: string;
    seller_account_id?: string | null;
    seller_slug?: string | null;
    seller_display_name: string | null;
    seller_average_rating?: string | null;
    seller_review_count?: number;
    price_amount: string;
    available_quantity: number;
    product_summary: string | null;
    product_measure_snapshot: Readonly<Record<string, unknown>> | null;
  }[];
  created_at: string;
  updated_at: string;
}
