export interface MarketplaceOfferListItem {
  offer_id: string;
  buyer_account_id: string;
  catalog_item_id: string;
  catalog_version_key: string;
  item_title: string;
  item_subtitle: string | null;
  version_selection: readonly { dimensionId: string; choiceId: string }[];
  version_summary: string | null;
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
