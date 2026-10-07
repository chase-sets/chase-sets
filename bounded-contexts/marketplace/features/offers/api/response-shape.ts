const publicOfferFields = [
  "offer_id",
  "buyer_account_id",
  "catalog_catalog_item_id",
  "product_id",
  "item_title",
  "item_subtitle",
  "selected_options",
  "product_summary",
  "price_amount",
  "price_currency_code",
  "last_stream_version",
  "quantity_requested",
  "status",
  "accepted_seller_account_id",
  "accepted_listing_id",
  "accepted_inventory_item_id",
  "listing_evidence_policy_hash",
  "listing_evidence_snapshot_hash",
  "accepted_seller_average_rating",
  "accepted_seller_review_count",
  "accepted_at",
  "created_at",
  "updated_at",
  "listing_id",
  "listing_price_amount",
  "listing_price_currency_code",
  "listing_stream_version",
  "listing_quantity_cap",
  "listing_visible_quantity",
  "offer_price_gap_amount",
  "offer_to_listing_price_bps",
  "buyer_display_name",
  "buyer_average_rating",
  "buyer_review_count",
  "seller_available_quantity",
  "seller_listing_availability_status",
  "can_fulfill",
  "managed_status",
] as const;
type PublicOfferField = (typeof publicOfferFields)[number];
type PublicOffer<T> = Pick<T, Extract<keyof T, PublicOfferField>>;

/** Public, seller, MCP and realtime paths share a positive field allowlist. */
export function omitPrivateOfferResponseFields<T extends object>(offer: T): PublicOffer<T> {
  const source = offer as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const field of publicOfferFields) if (field in source) result[field] = source[field];
  if (Array.isArray(result.selected_options)) {
    result.selected_options = result.selected_options.map(
      ({ dimensionId, optionId }: { dimensionId: string; optionId: string }) => ({ dimensionId, optionId }),
    );
  }
  if (
    result.managed_status != null &&
    !["unavailable", "held", "refresh_required"].includes(String(result.managed_status))
  )
    result.managed_status = "unavailable";
  if (result.managed_status) result.can_fulfill = false;
  return result as PublicOffer<T>;
}

export function publicOfferListResponse<T extends object>(response: { items: readonly T[]; total: number }) {
  return {
    items: response.items.map(omitPrivateOfferResponseFields),
    total: response.total,
  };
}
