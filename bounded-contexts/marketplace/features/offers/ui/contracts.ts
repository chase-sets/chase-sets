export interface MarketplaceOfferListItem {
  offer_id: string;
  buyer_account_id: string;
  catalog_catalog_item_id: string;
  product_id: string;
  item_title: string;
  item_subtitle: string | null;
  selected_options: readonly { dimensionId: string; optionId: string }[];
  product_summary: string | null;
  price_amount: string;
  quantity_requested: number;
  status: string;
  created_at: string;
  updated_at: string;
}

export interface MarketplaceBuyerOfferDetail extends MarketplaceOfferListItem {}

export interface MarketplaceSellerOfferListItem extends MarketplaceOfferListItem {
  buyer_display_name: string | null;
}

export interface MarketplaceSellerOfferDetail
  extends MarketplaceSellerOfferListItem {}
