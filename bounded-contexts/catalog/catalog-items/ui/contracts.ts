import type { BlueprintRef } from "../../blueprints/ui/contracts";
import type { CategoryRef } from "../../categories/ui/contracts";

export interface CatalogItemListItem {
  item_id: string;
  title: string;
  subtitle: string | null;
  blueprint: BlueprintRef | null;
  status: string;
  tags: string[];
  updated_at: string;
}

export interface CatalogItemDetail {
  item_id: string;
  title: string;
  subtitle: string | null;
  description: string;
  blueprint: BlueprintRef | null;
  status: string;
  field_values: Array<{ fieldId: string; fieldName: string; value: unknown }>;
  categories: CategoryRef[];
  tags: string[];
  image_urls: string[];
  updated_at: string;
}

