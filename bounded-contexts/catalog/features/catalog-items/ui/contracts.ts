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
  display_template_key: string | null;
  display_identity_hash: string | null;
  display_identity_resolved_at: string | null;
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
  display_template_key: string | null;
  display_identity_hash: string | null;
  display_identity_resolved_at: string | null;
  display_identity_publication: DisplayIdentityPublicationReadiness;
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

export type DisplayIdentityPublicationStatus = "current-resolved" | "degraded" | "unavailable" | "outdated";

export interface DisplayIdentityPublicationReadiness {
  status: DisplayIdentityPublicationStatus;
  reason_code: "display-identity-degraded" | "display-identity-unavailable" | "display-identity-outdated" | null;
  missing_tokens: string[];
  retryable: boolean;
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

export interface ProductContentSelectedOption {
  dimensionId: string;
  optionId: string;
}

export interface ProductContentTypeRef {
  content_type_id: string;
  key: string;
  display_name: LocalizedTextLike;
  status: string;
  sort_order: number;
  discovery_search_weight: number | null;
  updated_at: string;
}

export interface ProductContentInclusionPolicyRef {
  inclusion_policy_id: string;
  key: string;
  display_name: LocalizedTextLike;
  status: string;
  sort_order: number;
  updated_at: string;
}

export interface ProductContentLineDetail {
  lineId: string;
  containerCatalogItemId: string;
  containerSelectedOptions: ProductContentSelectedOption[] | null;
  containerProductId: string | null;
  containedCatalogItemId: string | null;
  containedSelectedOptions: ProductContentSelectedOption[] | null;
  containedProductId: string | null;
  quantity: number | null;
  contentTypeId: string;
  inclusionPolicyId: string | null;
  provenance: Record<string, unknown>;
  resolutionStatus: "resolved" | "unresolved";
  targetLifecycleStatus: string | null;
  resolvedFactHash: string;
  resolverVersion: number;
  resolvedAt: string;
  updatedAt: string;
}

export interface ProductContentsResolvedSnapshot {
  containerCatalogItemId: string;
  containerSelectedOptions: ProductContentSelectedOption[] | null;
  containerProductId: string | null;
  lines: ProductContentLineDetail[];
  resolvedFactHash: string;
  resolverVersion: number;
  resolvedAt: string;
}

export interface ProductContentLineInput {
  containedCatalogItemId?: string | null;
  containedSelectedOptions?: ProductContentSelectedOption[];
  quantity: number | null;
  contentTypeId: string;
  inclusionPolicyId?: string | null;
  provenance?: Record<string, unknown>;
}

export interface ReplaceProductContentsInput {
  containerSelectedOptions?: ProductContentSelectedOption[];
  lines: ProductContentLineInput[];
}

type LocalizedTextLike = {
  defaultLocale?: string;
  values?: Record<string, string>;
};

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
  reason_code:
    | "display-identity-degraded"
    | "display-identity-unavailable"
    | "display-identity-outdated"
    | "publication-precondition"
    | null;
  retryable: boolean;
  display_identity_readiness: DisplayIdentityPublicationStatus;
  missing_tokens: string[];
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
