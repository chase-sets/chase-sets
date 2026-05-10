import type { LocalizedTextMap } from "@chase-sets/localization";

export interface CategoryRef {
  categoryId: string;
  name: string;
}

export interface CategoryListItem {
  category_id: string;
  key: string;
  name_i18n: LocalizedTextMap;
  name: string;
  description_i18n: LocalizedTextMap;
  description: string;
  status: string;
  parent_category: CategoryRef | null;
  display_order: number;
  updated_at: string;
}

export interface CategoryDetail extends CategoryListItem {}
