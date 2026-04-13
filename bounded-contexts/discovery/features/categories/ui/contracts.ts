export interface DiscoveryCategoryItem {
  category_id: string;
  key: string;
  name: string;
  description: string;
  status: string;
  parent_category_id: string | null;
  item_count: number;
  display_order: number;
  updated_at: string;
}

export interface CategoryListResponse {
  items: DiscoveryCategoryItem[];
  total: number;
  count: number;
}

