import type {
  DiscoveryImageFallback,
  DiscoveryMarketSummary,
  DiscoveryProductAssetSet,
} from "../../../support/client-support/contracts";

export interface DiscoveryBrowseSetItem {
  catalog_item_id: string;
  slug: string;
  title: string;
  subtitle: string | null;
  image_urls: string[];
  product_asset_sets: DiscoveryProductAssetSet[];
  image_fallback: DiscoveryImageFallback | null;
  market_summary: DiscoveryMarketSummary | null;
}

export interface DiscoveryBrowseSetPage {
  reference_record_id: string;
  type_key: string;
  key: string;
  slug: string;
  name: string;
  code: string | null;
  game: string | null;
  release_date: string | null;
  item_count: number;
  items: DiscoveryBrowseSetItem[];
  updated_at: string;
}
