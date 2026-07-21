import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { localizedTextMapFromEnglish, type LocalizedTextMap } from "../../../support/runtime-support/common";
import type {
  ProductContentLineSnapshot,
  ProductContentProvenance,
  ProductContentSelectedOption,
} from "../api/runtime";
import { catalogIsoUtcListSql } from "../../../support/runtime-support/iso-utc-timestamp";

export type CatalogProductContentTypeRow = Readonly<{
  content_type_id: string;
  key: string;
  display_name: LocalizedTextMap;
  status: string;
  sort_order: number;
  discovery_search_weight: number | null;
  updated_at: string;
}>;

export type CatalogProductContentInclusionPolicyRow = Readonly<{
  inclusion_policy_id: string;
  key: string;
  display_name: LocalizedTextMap;
  status: string;
  sort_order: number;
  updated_at: string;
}>;

export type CatalogResolvedProductContentRow = ProductContentLineSnapshot &
  Readonly<{
    resolvedFactHash: string;
    resolverVersion: number;
    resolvedAt: string;
    updatedAt: string;
  }>;

type ProductContentTypeDbRow = Readonly<{
  content_type_id: string;
  key: string;
  display_name: unknown;
  status: string;
  sort_order: number;
  discovery_search_weight: string | number | null;
  updated_at: string;
}>;

type ProductContentInclusionPolicyDbRow = Readonly<{
  inclusion_policy_id: string;
  key: string;
  display_name: unknown;
  status: string;
  sort_order: number;
  updated_at: string;
}>;

type ResolvedProductContentDbRow = Readonly<{
  line_id: string;
  container_catalog_item_id: string;
  container_selected_options: unknown;
  container_product_id: string | null;
  contained_catalog_item_id: string | null;
  contained_selected_options: unknown;
  contained_product_id: string | null;
  quantity: number | null;
  content_type_id: string;
  content_type_display_name: unknown;
  content_type_discovery_search_weight: string | number | null;
  inclusion_policy_id: string | null;
  inclusion_policy_display_name: unknown;
  provenance: unknown;
  resolution_status: "resolved" | "unresolved";
  target_lifecycle_status: string | null;
  resolved_fact_hash: string;
  resolver_version: number;
  resolved_at: string;
  updated_at: string;
}>;

export async function listProductContentTypes(db: PgQueryable): Promise<CatalogProductContentTypeRow[]> {
  const result = await db.query<ProductContentTypeDbRow>(
    catalogIsoUtcListSql(
      `SELECT *
     FROM catalog_product_content_types
     ORDER BY sort_order ASC, key ASC`,
      "updated_at",
    ),
  );

  return result.rows.map((row) => ({
    ...row,
    display_name: localizedTextMapFromUnknown(row.display_name),
    discovery_search_weight: row.discovery_search_weight === null ? null : Number(row.discovery_search_weight),
  }));
}

export async function listProductContentInclusionPolicies(
  db: PgQueryable,
): Promise<CatalogProductContentInclusionPolicyRow[]> {
  const result = await db.query<ProductContentInclusionPolicyDbRow>(
    catalogIsoUtcListSql(
      `SELECT *
     FROM catalog_product_content_inclusion_policies
     ORDER BY sort_order ASC, key ASC`,
      "updated_at",
    ),
  );

  return result.rows.map((row) => ({
    ...row,
    display_name: localizedTextMapFromUnknown(row.display_name),
  }));
}

export async function listProductContentsForContainer(
  db: PgQueryable,
  containerCatalogItemId: string,
): Promise<CatalogResolvedProductContentRow[]> {
  const result = await db.query<ResolvedProductContentDbRow>(
    catalogIsoUtcListSql(
      `SELECT *
     FROM catalog_resolved_product_contents
     WHERE container_catalog_item_id = $1
     ORDER BY content_type_id ASC, line_id ASC`,
      "resolved_at",
      "updated_at",
    ),
    [containerCatalogItemId],
  );

  return result.rows.map(resolvedProductContentRowFromDb);
}

export async function listProductContainersForContained(
  db: PgQueryable,
  containedCatalogItemId: string,
): Promise<CatalogResolvedProductContentRow[]> {
  const result = await db.query<ResolvedProductContentDbRow>(
    catalogIsoUtcListSql(
      `SELECT *
     FROM catalog_resolved_product_contents
     WHERE contained_catalog_item_id = $1
     ORDER BY content_type_id ASC, line_id ASC`,
      "resolved_at",
      "updated_at",
    ),
    [containedCatalogItemId],
  );

  return result.rows.map(resolvedProductContentRowFromDb);
}

function resolvedProductContentRowFromDb(row: ResolvedProductContentDbRow): CatalogResolvedProductContentRow {
  return {
    lineId: row.line_id,
    containerCatalogItemId: row.container_catalog_item_id,
    containerSelectedOptions: selectedOptionsFromUnknown(row.container_selected_options),
    containerProductId: row.container_product_id,
    containedCatalogItemId: row.contained_catalog_item_id,
    containedSelectedOptions: selectedOptionsFromUnknown(row.contained_selected_options),
    containedProductId: row.contained_product_id,
    quantity: row.quantity,
    contentTypeId: row.content_type_id,
    contentTypeDisplayName: localizedTextMapFromUnknown(row.content_type_display_name),
    contentTypeDiscoverySearchWeight:
      row.content_type_discovery_search_weight === null ? null : Number(row.content_type_discovery_search_weight),
    inclusionPolicyId: row.inclusion_policy_id,
    inclusionPolicyDisplayName: row.inclusion_policy_display_name
      ? localizedTextMapFromUnknown(row.inclusion_policy_display_name)
      : null,
    provenance: provenanceFromUnknown(row.provenance),
    resolutionStatus: row.resolution_status,
    targetLifecycleStatus: row.target_lifecycle_status,
    resolvedFactHash: row.resolved_fact_hash,
    resolverVersion: row.resolver_version,
    resolvedAt: row.resolved_at,
    updatedAt: row.updated_at,
  };
}

function selectedOptionsFromUnknown(value: unknown): readonly ProductContentSelectedOption[] | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry) => {
      if (typeof entry !== "object" || entry === null) {
        return null;
      }
      const candidate = entry as { dimensionId?: unknown; optionId?: unknown };
      return typeof candidate.dimensionId === "string" && typeof candidate.optionId === "string"
        ? { dimensionId: candidate.dimensionId, optionId: candidate.optionId }
        : null;
    })
    .filter((entry): entry is ProductContentSelectedOption => entry !== null);
}

function localizedTextMapFromUnknown(value: unknown): LocalizedTextMap {
  return typeof value === "object" && value !== null ? (value as LocalizedTextMap) : localizedTextMapFromEnglish("");
}

function provenanceFromUnknown(value: unknown): ProductContentProvenance {
  return typeof value === "object" && value !== null ? (value as ProductContentProvenance) : {};
}
