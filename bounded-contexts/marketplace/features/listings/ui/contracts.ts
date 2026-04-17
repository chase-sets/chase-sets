export interface MarketplaceListingListItem {
  listing_id: string;
  account_id: string;
  inventory_record_id: string;
  catalog_item_id: string;
  catalog_version_key: string;
  item_title: string | null;
  item_subtitle: string | null;
  version_selection: readonly { dimensionId: string; choiceId: string }[];
  version_summary: string | null;
  storage_location_name: string | null;
  ship_from_code: string | null;
  price_amount: string;
  marketplace_fee_amount: string | null;
  payment_fee_amount: string | null;
  seller_net_amount: string | null;
  terms_schedule_id: string | null;
  terms_agreement_id: string | null;
  terms_resolved_at: string | null;
  quantity_cap: number;
  status: string;
  created_at: string;
  updated_at: string;
}

export interface MarketplaceListingDetail extends MarketplaceListingListItem {}

export interface MarketplaceMarketSummary {
  lowest_price_amount: string | null;
  active_listing_count: number;
  total_visible_quantity: number;
}

export interface MarketplaceItemListing extends MarketplaceListingListItem {
  seller_display_name: string | null;
  visible_quantity: number;
}

export interface MarketplaceListingInventoryRecordOption {
  record_id: string;
  catalog_item_id: string;
  catalog_version_key: string;
  item_title: string | null;
  item_subtitle: string | null;
  version_summary: string | null;
  storage_location_name: string;
  ship_from_code: string;
  available_quantity: number;
}

export interface MarketplaceListingTermsPreview {
  account_type: "personal" | "business" | "enterprise";
  basis_amount: string;
  marketplace_fee_amount: string;
  payment_fee_amount: string;
  seller_net_amount: string;
  schedule_id: string | null;
  agreement_id: string | null;
  resolved_at: string;
}
