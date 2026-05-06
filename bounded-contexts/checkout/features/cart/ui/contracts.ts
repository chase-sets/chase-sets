export interface CheckoutCartLine {
  buyer_account_id: string;
  line_id: string;
  catalog_catalog_item_id: string;
  product_id: string;
  item_title: string;
  item_subtitle: string | null;
  item_image_url: string | null;
  selected_options: readonly { dimensionId: string; optionId: string }[];
  product_summary: string | null;
  quantity: number;
  fulfillment_mode: "optimize" | "locked-listing";
  locked_listing_id: string | null;
  seller_preference_id: string | null;
  availability_state: "available" | "unavailable" | "changed" | "waiting-for-supply";
  seller_options: readonly {
    listing_id: string;
    seller_display_name: string | null;
    price_amount: string;
    available_quantity: number;
    product_summary: string | null;
  }[];
  created_at: string;
  updated_at: string;
}
