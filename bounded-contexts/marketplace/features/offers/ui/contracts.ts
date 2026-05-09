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
  accepted_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface SubmittedOfferListItem extends MarketplaceOffer {}
export interface SubmittedOfferDetail extends MarketplaceOffer {}

export interface OfferMatchListItem extends MarketplaceOffer {
  buyer_display_name: string | null;
  seller_available_quantity: number;
  can_fulfill: boolean;
  in_sell_list: boolean;
}

export interface OfferMatchDetail extends OfferMatchListItem {}
