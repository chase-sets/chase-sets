import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type { ProductKey } from "@chase-sets/primitives/catalog-identity";
import type { CatalogItemId, DimensionId, OptionId, SelectedOptionEntry } from "../../ids";
import { getBlueprintDetail } from "../../features/blueprints/read-model/queries";
import { getCatalogItemDetail } from "../../features/catalog-items/read-model/queries";
import { resolveProduct, type ProductDefiningBlueprint } from "../runtime-support/versioning";

export type CatalogProductSelection = Readonly<{
  catalogItemId: CatalogItemId;
  productId: ProductKey;
  selectedOptions: readonly Readonly<{ dimensionId: string; optionId: string }>[];
}>;

export type CatalogProductSelectionResolution = Readonly<{
  availability: "active" | "retired" | "missing" | "unavailable";
  product: CatalogProductSelection | null;
}>;

export async function resolveCatalogProductSelection(
  db: PgQueryable,
  selection: CatalogProductSelection,
): Promise<CatalogProductSelectionResolution> {
  const item = await getCatalogItemDetail(db, selection.catalogItemId);
  if (!item) return { availability: "missing", product: null };
  if (item.status === "archived" || item.status === "removed") {
    return { availability: "retired", product: null };
  }
  if (item.status !== "active") return { availability: "unavailable", product: null };

  try {
    if (!item.blueprint_id) {
      if (selection.selectedOptions.length > 0) return { availability: "active", product: null };
      return {
        availability: "active",
        product: {
          catalogItemId: selection.catalogItemId,
          productId: `${selection.catalogItemId}::` as ProductKey,
          selectedOptions: [],
        },
      };
    }

    const blueprint = await getBlueprintDetail(db, item.blueprint_id);
    if (!blueprint) return { availability: "unavailable", product: null };
    const resolved = resolveProduct({
      catalogItemId: selection.catalogItemId,
      blueprint: parseBlueprint(blueprint.dimension_rules, blueprint.canonical_dimension_order),
      selectedOptions: selection.selectedOptions.map((entry) => ({
        dimensionId: entry.dimensionId as DimensionId,
        optionId: entry.optionId as OptionId,
      })) satisfies readonly SelectedOptionEntry[],
    });
    return {
      availability: "active",
      product: {
        catalogItemId: selection.catalogItemId,
        productId: resolved.productId,
        selectedOptions: resolved.selectedOptions,
      },
    };
  } catch {
    return { availability: "active", product: null };
  }
}

function parseBlueprint(dimensionRules: unknown, canonicalOrder: unknown): ProductDefiningBlueprint {
  const rules = Array.isArray(dimensionRules) ? dimensionRules : [];
  const order = Array.isArray(canonicalOrder) ? canonicalOrder : [];
  return {
    dimensionRules: rules.map((value) => {
      const rule = asRecord(value);
      const appliesWhen = Array.isArray(rule.appliesWhen) ? rule.appliesWhen : [];
      return {
        dimensionId: String(rule.dimensionId ?? "") as DimensionId,
        required: Boolean(rule.required),
        allowedOptionIds: (Array.isArray(rule.allowedOptionIds) ? rule.allowedOptionIds : []).map(
          (optionId) => String(optionId) as OptionId,
        ),
        appliesWhen: appliesWhen.map((value) => {
          const clause = asRecord(value);
          return {
            dimensionId: String(clause.dimensionId ?? "") as DimensionId,
            optionIds: (Array.isArray(clause.optionIds) ? clause.optionIds : []).map(
              (optionId) => String(optionId) as OptionId,
            ),
          };
        }),
      };
    }),
    canonicalDimensionOrder: order.map((dimensionId) => String(dimensionId) as DimensionId),
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
