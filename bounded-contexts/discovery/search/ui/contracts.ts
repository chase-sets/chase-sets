export interface DiscoverySearchItem {
  item_id: string;
  title: string;
  subtitle: string | null;
  description: string;
  blueprint_id: string | null;
  blueprint_name: string | null;
  status: string;
  category_names: string[];
  tags: string[];
  image_urls: string[];
  updated_at: string;
}

export interface DiscoverySearchResponse {
  items: DiscoverySearchItem[];
  total: number;
  count: number;
}
