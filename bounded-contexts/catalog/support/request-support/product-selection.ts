import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type { ProductKey } from "@chase-sets/primitives/catalog-identity";
import { z } from "zod";
import type { CatalogItemId, DimensionId, OptionId, SelectedOptionEntry } from "../../ids";
import { getBlueprintProductResolutionRules } from "../../features/blueprints/read-model/queries";
import { getCatalogItemDetail } from "../../features/catalog-items/read-model/queries";
import { listSelectedOptionApplicability } from "../../features/dimensions/read-model/queries";
import {
  resolveProduct,
  type ProductDefiningBlueprint,
  type SelectedOptionApplicability,
} from "../runtime-support/versioning";

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

  const row = await getBlueprintProductResolutionRules(db, item.blueprint_id);
  if (!row) return { availability: "unavailable", product: null };
  const blueprint = parseBlueprint(row.dimension_rules, row.canonical_dimension_order);
  if (!blueprint) return { availability: "unavailable", product: null };
  const optionApplicability = parseOptionApplicability(
    await listSelectedOptionApplicability(db, selection.selectedOptions),
  );
  if (!optionApplicability) return { availability: "unavailable", product: null };

  try {
    const resolved = resolveProduct({
      catalogItemId: selection.catalogItemId,
      blueprint,
      optionApplicability,
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

const applicabilityClausesSchema = z.array(
  z.object({
    dimensionId: z.string().transform((id) => id as DimensionId),
    optionIds: z.array(z.string().transform((id) => id as OptionId)),
  }),
);

const storedOptionApplicabilitySchema = z.array(
  z
    .object({
      dimension_id: z.string().min(1),
      option_id: z.string().min(1),
      applies_when: applicabilityClausesSchema,
    })
    .transform((row) => ({
      dimensionId: row.dimension_id as DimensionId,
      optionId: row.option_id as OptionId,
      appliesWhen: row.applies_when,
    })),
);

export function parseOptionApplicability(rows: unknown): SelectedOptionApplicability[] | null {
  const result = storedOptionApplicabilitySchema.safeParse(rows);
  return result.success ? result.data : null;
}

const storedBlueprintSchema = z.object({
  dimensionRules: z.array(
    z.object({
      dimensionId: z
        .string()
        .min(1)
        .transform((id) => id as DimensionId),
      required: z.boolean(),
      allowedOptionIds: z.array(z.string().transform((id) => id as OptionId)),
      appliesWhen: applicabilityClausesSchema.optional().default([]),
    }),
  ),
  canonicalDimensionOrder: z.array(
    z
      .string()
      .min(1)
      .transform((id) => id as DimensionId),
  ),
});

export function parseBlueprint(dimensionRules: unknown, canonicalOrder: unknown): ProductDefiningBlueprint | null {
  const result = storedBlueprintSchema.safeParse({ dimensionRules, canonicalDimensionOrder: canonicalOrder });
  return result.success ? result.data : null;
}
