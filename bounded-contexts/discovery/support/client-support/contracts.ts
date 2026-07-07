export type DiscoveryProductAssetRole = "source" | "thumbnail" | "search-card" | "catalog-detail";

export interface DiscoveryPublicStandardTermsPreview {
  account_type: string;
  basis_amount: string;
  marketplace_sales_fee_unit_amount: string;
  seller_net_unit_amount: string;
  shipping_allowance_percentage_bps: number;
  source_kind: "public-standard-seller-terms";
  source_label: string;
  schedule_label: string;
  source_updated_at: string;
  resolved_at: string;
}

export interface DiscoveryProductAssetVariant {
  role: DiscoveryProductAssetRole;
  width: number;
  height: number;
  density: 1 | 2 | null;
  mediaType: "image/webp";
  storageKey: string;
  publicUrl: string;
  byteSize: number;
  generatedAt: string;
}

export interface DiscoveryProductAssetSet {
  kind: "product-image";
  sourceHash: string;
  source: DiscoveryProductAssetVariant;
  variants: DiscoveryProductAssetVariant[];
}

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
  product_asset_sets: DiscoveryProductAssetSet[];
  image_fallback: DiscoveryImageFallback | null;
  market_summary: DiscoveryMarketSummary | null;
  updated_at: string;
}

export interface DiscoveryImageFallback {
  url: string;
  alt: string;
  usage: "permanent" | "loading-only";
  variants: Record<
    string,
    {
      oneX?: string;
      twoX?: string;
    }
  >;
}

export interface DiscoverySearchResponse {
  items: DiscoverySearchItem[];
  facets: DiscoveryFacetGroup[];
  total: number | null;
  count: number;
  nextCursor: string | null;
}

export interface DiscoveryFacetValue {
  id: string;
  label: string;
  count: number;
  selected: boolean;
}

export interface DiscoveryFacetGroup {
  id: string;
  kind: "field" | "reference" | "dimension";
  label: string;
  values: DiscoveryFacetValue[];
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
    label_i18n?: unknown;
    label: string;
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
  reference?: DiscoveryReferenceRecordRef | null;
}

export interface DiscoveryReferenceRecordRef {
  referenceId: string;
  typeKey: string;
  key: string;
  name: string;
  attributes: unknown;
  relationships: Array<{
    relationshipType: string;
    referenceId: string;
    reference?: DiscoveryReferenceRecordRef;
  }>;
  status: string;
}

export interface CategoryRef {
  categoryId: string;
  slug: string;
  name: string;
}

export interface DiscoveryProductContentSelectedOption {
  dimensionId: string;
  optionId: string;
}

export interface DiscoveryProductContentItemRef {
  catalog_item_id: string;
  slug: string;
  title: string;
  subtitle: string | null;
  status: string;
}

export interface DiscoveryProductContentLine {
  line_id: string;
  container_catalog_item_id: string;
  container_selected_options: DiscoveryProductContentSelectedOption[] | null;
  container_product_id: string | null;
  container_item: DiscoveryProductContentItemRef | null;
  contained_catalog_item_id: string | null;
  contained_selected_options: DiscoveryProductContentSelectedOption[] | null;
  contained_product_id: string | null;
  contained_item: DiscoveryProductContentItemRef | null;
  quantity: number | null;
  content_type_id: string;
  content_type_label: string;
  inclusion_policy_id: string | null;
  inclusion_policy_label: string | null;
  resolution_status: "resolved" | "unresolved";
  target_lifecycle_status: string | null;
  updated_at: string;
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
  product_asset_sets: DiscoveryProductAssetSet[];
  image_fallback: DiscoveryImageFallback | null;
  product_schema: ProductSchema | null;
  market_summary: DiscoveryMarketSummary | null;
  market_listings: DiscoveryMarketListing[];
  offer_demand_matches: DiscoveryOffer[];
  contents: DiscoveryProductContentLine[];
  included_in: DiscoveryProductContentLine[];
  updated_at: string;
}

export interface DiscoveryMarketSummary {
  lowest_price_amount: string | null;
  active_listing_count: number;
  total_visible_quantity: number;
}

export interface DiscoveryGradedCardDetails {
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
  registryVerification?: {
    state: "verified" | "mismatch" | "unavailable";
    provider: string;
    verifiedAt: string | null;
    lookupUrl: string | null;
  } | null;
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
  graded_card?: DiscoveryGradedCardDetails | null;
  storage_location_name: string | null;
  ship_from_code: string | null;
  price_amount: string;
  shipping_allowance_percentage_bps: number;
  quantity_cap: number;
  max_units_per_order?: number | null;
  max_units_per_day?: number | null;
  max_units_per_customer_account?: number | null;
  status: string;
  seller_slug?: string | null;
  seller_listing_availability_status?: "available" | "unavailable";
  seller_listing_availability_reason_category?: string | null;
  seller_listing_available_again_on?: string | null;
  seller_display_name: string | null;
  seller_average_rating?: string | null;
  seller_review_count?: number;
  google_shopping_structured_data_payload?: DiscoveryGoogleShoppingStructuredDataPayload | null;
  visible_quantity: number;
  created_at: string;
  updated_at: string;
}

export interface DiscoveryGoogleShoppingStructuredDataPayload {
  offerId: string;
  title: string;
  description: string;
  link: string;
  imageLink: string;
  priceAmount: string;
  currencyCode: string;
  availability: "in stock" | "out of stock";
  condition: string;
  brand?: string;
  gtin?: string;
  mpn?: string;
  productType?: string;
}

export interface DiscoveryPublicListing extends DiscoveryMarketListing {
  seller_slug: string | null;
  seller_display_name: string | null;
  seller_average_rating?: string | null;
  seller_review_count?: number;
}

export interface DiscoveryPublicAccount {
  account_id: string;
  account_slug: string;
  account_display_name: string | null;
  status: string;
  average_rating?: string | null;
  review_count?: number;
  active_listing_count: number;
  updated_at: string;
  recent_reviews: DiscoveryPublicAccountReview[];
  listings: DiscoveryPublicListing[];
}

export interface DiscoveryPublicAccountReview {
  review_id: string;
  author_account_id: string;
  author_display_name: string | null;
  author_role: string;
  rating: number;
  feedback: string | null;
  submitted_at: string | null;
  updated_at: string;
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
  buyer_slug?: string | null;
  buyer_average_rating?: string | null;
  buyer_review_count?: number;
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
  buyer_slug?: string | null;
  buyer_average_rating?: string | null;
  buyer_review_count?: number;
  public_standard_terms_preview?: DiscoveryPublicStandardTermsPreview | null;
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

export interface DiscoveryListingTermsPreview {
  marketplace_sales_fee_unit_amount: string;
  seller_net_unit_amount: string;
  shipping_allowance_percentage_bps: number;
  source_label: string;
  schedule_label: string;
  source_updated_at: string;
  resolved_at: string;
}

export interface DiscoveryAccountOfferMatchWithTerms extends DiscoveryAccountOfferMatch {
  acceptance_terms: DiscoveryListingTermsPreview | null;
}

export interface DiscoveryItemDetailSellerOverlay {
  accountOfferMatches: DiscoveryAccountOfferMatchWithTerms[];
  sellerInventoryItems: DiscoverySellerInventoryItem[];
  hasListingStockLocation: boolean;
  selectedSellerListing: DiscoveryMarketListing | null;
}
