import type { CategoryRef } from "../../shared/ui/api/contracts";

export interface CategoryListItem {
  category_id: string;
  key: string;
  name: string;
  description: string;
  status: string;
  parent_category: CategoryRef | null;
  display_order: number;
  updated_at: string;
}

export interface CategoryDetail extends CategoryListItem {}
