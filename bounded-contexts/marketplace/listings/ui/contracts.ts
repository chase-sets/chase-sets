export interface MarketplaceListingListItem {
  listing_id: string;
  account_id: string;
  inventory_record_id: string;
  catalog_item_id: string;
  item_title: string | null;
  item_subtitle: string | null;
  version_selection: readonly { dimensionId: string; choiceId: string }[];
  version_summary: string | null;
  condition: string;
  storage_location_name: string | null;
  ship_from_code: string | null;
  price_amount: string;
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
  item_title: string | null;
  item_subtitle: string | null;
  version_summary: string | null;
  condition: string;
  storage_location_name: string;
  ship_from_code: string;
  available_quantity: number;
}
