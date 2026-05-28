import type { BlueprintRef } from "../../blueprints/ui/contracts";
import type { CategoryRef } from "../../categories/ui/contracts";
import type { ProductAssetSet } from "../../../support/runtime-support/product-assets";

export interface CatalogItemListItem {
  catalog_item_id: string;
  language_code: string;
  title_i18n: unknown;
  title: string;
  subtitle_i18n: unknown;
  subtitle: string | null;
  blueprint: BlueprintRef | null;
  status: string;
  source_providers: string[];
  tags: string[];
  updated_at: string;
}

export interface CatalogItemImageFallback {
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
  field_values: Array<{
    fieldId: string;
    fieldName: string;
    value: unknown;
    reference?: CatalogReferenceRecordRef | null;
  }>;
  categories: CategoryRef[];
  external_catalog_item_references: Array<{
    providerKey: string;
    externalKey: string;
    updatedAt: string;
  }>;
  external_product_references: Array<{
    providerKey: string;
    externalKey: string;
    selectedOptions: Array<{ dimensionId: string; optionId: string }>;
    updatedAt: string;
  }>;
  tags: string[];
  image_urls: string[];
  product_asset_sets: ProductAssetSet[];
  image_fallback: CatalogItemImageFallback | null;
  updated_at: string;
}

export interface CatalogReferenceRecordRef {
  referenceId: string;
  typeKey: string;
  key: string;
  name: string;
  attributes: unknown;
  relationships: Array<{
    relationshipType: string;
    referenceId: string;
    reference?: CatalogReferenceRecordRef;
  }>;
  status: string;
}

export interface BulkPublishCandidate {
  catalog_item_id: string;
  title: string;
  subtitle: string | null;
  status: string;
  blueprint_id: string | null;
  blueprint_name: string | null;
  source_providers: string[];
  outcome: "ready" | "blocked" | "published" | "failed" | "skipped";
  reason: string | null;
  required_field_ids: string[];
}

export interface BulkPublishPreview {
  mode: "ids" | "filter";
  item_ids: string[];
  total: number;
  ready_count: number;
  blocked_count: number;
  candidates: BulkPublishCandidate[];
}

export interface BulkPublishResult {
  item_ids: string[];
  total: number;
  published_count: number;
  failed_count: number;
  skipped_count: number;
  candidates: BulkPublishCandidate[];
}

export type BulkEditCatalogItemAction =
  | "assignBlueprint"
  | "assignCategory"
  | "removeCategory"
  | "setTags"
  | "mergeTags"
  | "clearTags";

export type BulkEditCatalogItemOperation =
  | { action: "assignBlueprint"; blueprintId: string }
  | { action: "assignCategory"; categoryId: string }
  | { action: "removeCategory"; categoryId: string }
  | { action: "setTags"; tags: string[] }
  | { action: "mergeTags"; tags: string[] }
  | { action: "clearTags" };

export interface BulkEditCatalogItemCandidate {
  catalog_item_id: string;
  title: string;
  status: string;
  blueprint_id: string | null;
  category_ids: string[];
  tags: string[];
  outcome: "ready" | "blocked" | "succeeded" | "skipped" | "failed";
  reason: string | null;
}

export interface BulkEditCatalogItemPreview {
  mode: "ids" | "filter";
  action: BulkEditCatalogItemAction;
  item_ids: string[];
  total: number;
  ready_count: number;
  blocked_count: number;
  candidates: BulkEditCatalogItemCandidate[];
}

export interface BulkEditCatalogItemResult {
  action: BulkEditCatalogItemAction;
  item_ids: string[];
  total: number;
  succeeded_count: number;
  skipped_count: number;
  failed_count: number;
  candidates: BulkEditCatalogItemCandidate[];
}
