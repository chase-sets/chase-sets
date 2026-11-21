export interface MarketplaceOffer {
  offer_id: string;
  buyer_account_id: string;
  catalog_catalog_item_id: string;
  product_id: string;
  item_title: string;
  item_subtitle: string | null;
  selected_options: readonly { dimensionId: string; optionId: string }[];
  product_summary: string | null;
  price_amount: string;
  price_currency_code: string | null;
  last_stream_version: number;
  quantity_requested: number;
  status: string;
  accepted_seller_account_id: string | null;
  accepted_seller_average_rating?: string | null;
  accepted_seller_review_count?: number;
  accepted_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface SubmittedOfferListItem extends MarketplaceOffer {
  offers_away?: boolean;
}
export interface SubmittedOfferDetail extends MarketplaceOffer {}
export interface PublicOfferDetail extends MarketplaceOffer {}

interface OfferMatchBase extends MarketplaceOffer {
  buyer_display_name: string | null;
  buyer_average_rating?: string | null;
  buyer_review_count?: number;
  managed_status?: "unavailable" | "held" | "refresh_required" | null;
}

export interface ListingOfferMatchListItem extends OfferMatchBase {
  fill_source: "listing";
  listing_id: string;
  listing_price_amount: string;
  listing_price_currency_code: string;
  listing_stream_version: number;
  listing_quantity_cap: number;
  listing_visible_quantity: number;
  offer_price_gap_amount: string;
  offer_to_listing_price_bps: number;
  seller_available_quantity: number;
  seller_listing_availability_status: "available" | "unavailable";
  can_fulfill: boolean;
}

/** A Match the seller could fill from inventory; it has no Listing keys until the seller lists the item. */
export interface InventoryOfferMatchListItem extends OfferMatchBase {
  fill_source: "inventory";
  can_fulfill: false;
  inventory_item_id: string;
  inventory_available_quantity: number;
}

export type OfferMatchListItem = ListingOfferMatchListItem | InventoryOfferMatchListItem;

export type OfferMatchDetail = OfferMatchListItem;

export type SubmittedOfferStatus = "submitted" | "paused" | "withdrawn" | "accepted";
export type SubmittedOfferStatusFilter = "all" | SubmittedOfferStatus;
export type SubmittedOfferStatusCounts = Readonly<Record<SubmittedOfferStatus, number>>;
export type SubmittedOfferLifecycleAction = "pause" | "resume" | "withdraw";
export type SubmittedOfferLifecycleOutcome =
  | Readonly<{ offerId: string; outcome: "changed" | "unchanged"; status: string; version: number }>
  | Readonly<{ offerId: string; outcome: "rejected"; code: string }>;
