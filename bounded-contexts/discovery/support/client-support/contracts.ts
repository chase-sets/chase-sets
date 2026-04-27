export interface DiscoverySearchItem {
  catalog_item_id: string;
  title: string;
  subtitle: string | null;
  description: string;
  blueprint_id: string | null;
  blueprint_name: string | null;
  status: string;
  category_names: string[];
  tags: string[];
  image_urls: string[];
  market_summary: DiscoveryMarketSummary | null;
  updated_at: string;
}

export interface DiscoverySearchResponse {
  items: DiscoverySearchItem[];
  total: number;
  count: number;
}

export interface VersionApplicabilityClause {
  dimensionId: string;
  optionIds: string[];
}

export interface VersionDimension {
  dimensionId: string;
  dimensionName: string;
  required: boolean;
  appliesWhen: VersionApplicabilityClause[];
  allowedOptions: Array<{
    optionId: string;
    code: string;
    labels?: Array<{ locale: string; value: string }>;
  }>;
}

export interface VersionSchema {
  canonicalDimensionOrder: Array<{ dimensionId: string; dimensionName: string }>;
  dimensions: VersionDimension[];
}

export interface FieldValue {
  fieldId: string;
  fieldName: string;
  value: unknown;
}

export interface CategoryRef {
  categoryId: string;
  name: string;
}

export interface DiscoveryItemDetail {
  catalog_item_id: string;
  title: string;
  subtitle: string | null;
  description: string;
  blueprint_id: string | null;
  blueprint: { blueprintId: string; name: string } | null;
  status: string;
  field_values: FieldValue[];
  categories: CategoryRef[];
  tags: string[];
  image_urls: string[];
  product_schema: VersionSchema | null;
  market_summary: DiscoveryMarketSummary | null;
  market_listings: DiscoveryMarketListing[];
  updated_at: string;
}

export interface DiscoveryMarketSummary {
  lowest_price_amount: string | null;
  active_listing_count: number;
  total_visible_quantity: number;
}

export interface DiscoveryMarketListing {
  listing_id: string;
  account_id: string;
  inventory_record_id: string;
  catalog_catalog_item_id: string;
  product_id: string;
  item_title: string | null;
  item_subtitle: string | null;
  selected_options: readonly { dimensionId: string; optionId: string }[];
  product_summary: string | null;
  storage_location_name: string | null;
  ship_from_code: string | null;
  price_amount: string;
  quantity_cap: number;
  status: string;
  seller_display_name: string | null;
  visible_quantity: number;
  created_at: string;
  updated_at: string;
}
