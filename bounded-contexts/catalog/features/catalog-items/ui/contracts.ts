import type { BlueprintRef } from "../../blueprints/ui/contracts";
import type { CategoryRef } from "../../categories/ui/contracts";

export interface CatalogItemListItem {
  catalog_item_id: string;
  language_code: string;
  title_i18n: unknown;
  title: string;
  subtitle_i18n: unknown;
  subtitle: string | null;
  blueprint: BlueprintRef | null;
  status: string;
  tags: string[];
  updated_at: string;
}

export interface CatalogItemDetail {
  catalog_item_id: string;
  language_code: string;
  title_i18n: unknown;
  title: string;
  subtitle_i18n: unknown;
  subtitle: string | null;
  description_i18n: unknown;
  description: string;
  blueprint: BlueprintRef | null;
  status: string;
  field_values: Array<{ fieldId: string; fieldName: string; value: unknown }>;
  categories: CategoryRef[];
  external_product_references: Array<{
    providerKey: string;
    externalKey: string;
    selectedOptions: Array<{ dimensionId: string; optionId: string }>;
    updatedAt: string;
  }>;
  tags: string[];
  image_urls: string[];
  updated_at: string;
}
