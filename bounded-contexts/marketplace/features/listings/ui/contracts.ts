export interface MarketplaceListingListItem {
  listing_id: string;
  account_id: string;
  inventory_item_id: string;
  catalog_catalog_item_id: string;
  product_id: string;
  item_title: string | null;
  item_subtitle: string | null;
  selected_options: readonly { dimensionId: string; optionId: string }[];
  product_summary: string | null;
  graded_card: MarketplaceGradedCardDetails | null;
  storage_location_name: string | null;
  ship_from_code: string | null;
  price_amount: string;
  marketplace_fee_unit_amount: string;
  seller_net_unit_amount: string;
  terms_schedule_id: string | null;
  terms_agreement_id: string | null;
  terms_resolved_at: string | null;
  fee_quote_fingerprint: string;
  quantity_cap: number;
  status: string;
  created_at: string;
  updated_at: string;
}

export interface MarketplaceGradedCardDetails {
  gradingCompany: string;
  grade: string;
  certificationNumber: string | null;
  population: {
    populationAtGrade: number | null;
    populationHigher: number | null;
    source: string | null;
    asOf: string | null;
  } | null;
  conditionDescriptors: string[];
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

export interface MarketplaceListingInventoryItemOption {
  item_id: string;
  catalog_catalog_item_id: string;
  product_id: string;
  item_title: string | null;
  item_subtitle: string | null;
  selected_options: readonly { dimensionId: string; optionId: string }[];
  product_summary: string | null;
  graded_card: MarketplaceGradedCardDetails | null;
  storage_location_name: string;
  ship_from_code: string;
  available_quantity: number;
}

export interface MarketplaceListingTermsPreview {
  account_type: "personal" | "business" | "enterprise";
  basis_amount: string;
  marketplace_fee_unit_amount: string;
  seller_net_unit_amount: string;
  schedule_id: string | null;
  agreement_id: string | null;
  resolved_at: string;
  fee_quote_fingerprint: string;
}

export interface MarketplaceListingFeeHistoryEntry {
  event_type: string;
  stream_version: number;
  price_amount: string | null;
  quantity_cap: number | null;
  marketplace_fee_unit_amount: string | null;
  seller_net_unit_amount: string | null;
  terms_schedule_id: string | null;
  terms_agreement_id: string | null;
  terms_resolved_at: string | null;
  fee_quote_fingerprint: string | null;
  recorded_at: string;
  performed_by_user_id: string | null;
}
