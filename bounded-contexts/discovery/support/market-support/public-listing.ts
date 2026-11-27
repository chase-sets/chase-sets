// The fields a public Listing serves, on the listing and account reads and on the realtime
// listing patch. Rows are read with `listing.*`, so a stored column reaches buyers only when it
// is named here.
export const DISCOVERY_PUBLIC_LISTING_FIELDS = [
  "listing_id",
  "listing_slug",
  "product_slug",
  "account_id",
  "seller_slug",
  "seller_display_name",
  "seller_listing_availability_status",
  "seller_listing_availability_reason_category",
  "seller_listing_available_again_on",
  "seller_available_again_at",
  "seller_at_capacity",
  "seller_average_rating",
  "seller_review_count",
  "seller_badges",
  "seller_founder_number",
  "google_shopping_structured_data_payload",
  "catalog_catalog_item_id",
  "catalog_item_slug",
  "product_id",
  "item_title",
  "item_subtitle",
  "selected_options",
  "product_summary",
  "graded_card",
  "ship_from_code",
  "price_amount",
  "price_currency_code",
  "listing_stream_version",
  "shipping_allowance_percentage_bps",
  "max_units_per_order",
  "max_units_per_day",
  "max_units_per_customer_account",
  "status",
  "visible_quantity",
  "created_at",
  "updated_at",
] as const;

export type DiscoveryPublicListingField = (typeof DISCOVERY_PUBLIC_LISTING_FIELDS)[number];

/** Copies the public fields the row carries; a field it does not carry stays absent. */
export function pickDiscoveryPublicListingFields<Row extends object>(
  row: Row,
): Pick<Row, Extract<keyof Row, DiscoveryPublicListingField>> {
  const source = row as Readonly<Record<string, unknown>>;
  const picked: Record<string, unknown> = {};
  for (const field of DISCOVERY_PUBLIC_LISTING_FIELDS) {
    if (Object.hasOwn(source, field)) picked[field] = source[field];
  }
  return picked as Pick<Row, Extract<keyof Row, DiscoveryPublicListingField>>;
}
