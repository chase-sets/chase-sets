export interface DiscoverySearchItem {
  catalog_item_id: string;
  slug: string;
  language_code: string;
  title_i18n: unknown;
  title: string;
  subtitle_i18n: unknown;
  subtitle: string | null;
  description_i18n: unknown;
  description: string;
  blueprint_id: string | null;
  blueprint_name: string | null;
  status: string;
  category_names: string[];
  category_slugs: string[];
  tags: string[];
  image_urls: string[];
  market_summary: DiscoveryMarketSummary | null;
  updated_at: string;
}

export interface DiscoverySearchResponse {
  items: DiscoverySearchItem[];
  total: number | null;
  count: number;
  nextCursor: string | null;
}

export interface ProductApplicabilityClause {
  dimensionId: string;
  optionIds: string[];
}

export interface ProductDimension {
  dimensionId: string;
  dimensionName: string;
  valueKind: "unordered" | "ordered" | "numeric";
  required: boolean;
  appliesWhen: ProductApplicabilityClause[];
  allowedOptions: Array<{
    optionId: string;
    code: string;
    labels?: Array<{ locale: string; value: string }>;
    displayOrder: number;
    numericValue: number | null;
  }>;
}

export interface ProductSchema {
  canonicalDimensionOrder: Array<{ dimensionId: string; dimensionName: string }>;
  dimensions: ProductDimension[];
}

export interface FieldValue {
  fieldId: string;
  fieldName: string;
  value: unknown;
}

export interface CategoryRef {
  categoryId: string;
  slug: string;
  name: string;
}

export interface DiscoveryItemDetail {
  catalog_item_id: string;
  slug: string;
  language_code: string;
  title_i18n: unknown;
  title: string;
  subtitle_i18n: unknown;
  subtitle: string | null;
  description_i18n: unknown;
  description: string;
  blueprint_id: string | null;
  blueprint: { blueprintId: string; name: string } | null;
  status: string;
  field_values: FieldValue[];
  categories: CategoryRef[];
  tags: string[];
  image_urls: string[];
  product_schema: ProductSchema | null;
  market_summary: DiscoveryMarketSummary | null;
  market_listings: DiscoveryMarketListing[];
  buyer_offer_matches: DiscoveryOffer[];
  updated_at: string;
}

export interface DiscoveryMarketSummary {
  lowest_price_amount: string | null;
  active_listing_count: number;
  total_visible_quantity: number;
}

export interface DiscoveryMarketListing {
  listing_id: string;
  listing_slug: string;
  product_slug: string;
  account_id: string;
  inventory_item_id: string;
  catalog_catalog_item_id: string;
  catalog_item_slug?: string | null;
  product_id: string;
  item_title: string | null;
  item_subtitle: string | null;
  selected_options: readonly { dimensionId: string; optionId: string }[];
  product_summary: string | null;
  storage_location_name: string | null;
  ship_from_code: string | null;
  price_amount: string;
  shipping_allowance_percentage_bps: number;
  quantity_cap: number;
  status: string;
  seller_display_name: string | null;
  visible_quantity: number;
  created_at: string;
  updated_at: string;
}

export interface DiscoveryPublicListing extends DiscoveryMarketListing {
  seller_slug: string | null;
  seller_display_name: string | null;
}

export interface DiscoveryPublicSeller {
  account_id: string;
  seller_slug: string;
  seller_display_name: string | null;
  status: string;
  active_listing_count: number;
  updated_at: string;
  listings: DiscoveryPublicListing[];
}

export interface DiscoverySitemapUrl {
  path: string;
  updated_at: string;
}

export interface DiscoveryAccountOfferMatch {
  offer_id: string;
  buyer_account_id: string;
  buyer_display_name: string | null;
  catalog_catalog_item_id: string;
  product_id: string;
  item_title: string;
  item_subtitle: string | null;
  selected_options: readonly { dimensionId: string; optionId: string }[];
  product_summary: string | null;
  price_amount: string;
  quantity_requested: number;
  status: string;
  accepted_seller_account_id: string | null;
  accepted_at: string | null;
  seller_available_quantity: number;
  can_fulfill: boolean;
  in_sell_list: boolean;
  created_at: string;
  updated_at: string;
}

export interface DiscoveryOffer {
  offer_id: string;
  buyer_account_id: string;
  buyer_display_name: string | null;
  catalog_catalog_item_id: string;
  product_id: string;
  item_title: string;
  item_subtitle: string | null;
  selected_options: readonly { dimensionId: string; optionId: string }[];
  product_summary: string | null;
  price_amount: string;
  quantity_requested: number;
  status: string;
  accepted_seller_account_id: string | null;
  accepted_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface DiscoverySellerInventoryItem {
  item_id: string;
  catalog_catalog_item_id: string;
  product_id: string;
  item_title: string | null;
  item_subtitle: string | null;
  selected_options: readonly { dimensionId: string; optionId: string }[];
  product_summary: string | null;
  storage_location_name: string;
  ship_from_code: string;
  available_quantity: number;
}
