import type { AddressSnapshot } from "@chase-sets/primitives/address-snapshot";

export interface MarketplaceOffer {
  offer_id: string;
  buyer_account_id: string;
  catalog_catalog_item_id: string;
  product_id: string;
  item_title: string;
  item_subtitle: string | null;
  selected_options: readonly { dimensionId: string; optionId: string }[];
  product_summary: string | null;
  shipping_destination_snapshot: AddressSnapshot;
  price_amount: string;
  quantity_requested: number;
  status: string;
  accepted_seller_account_id: string | null;
  accepted_seller_average_rating?: string | null;
  accepted_seller_review_count?: number;
  accepted_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface SubmittedOfferListItem extends MarketplaceOffer {}
export interface SubmittedOfferDetail extends MarketplaceOffer {}

export interface OfferMatchListItem extends MarketplaceOffer {
  listing_id: string;
  listing_price_amount: string;
  listing_quantity_cap: number;
  listing_visible_quantity: number;
  offer_price_gap_amount: string;
  offer_to_listing_price_bps: number;
  buyer_display_name: string | null;
  buyer_average_rating?: string | null;
  buyer_review_count?: number;
  seller_available_quantity: number;
  seller_listing_availability_status: "available" | "unavailable";
  can_fulfill: boolean;
}

export interface OfferMatchDetail extends OfferMatchListItem {}
