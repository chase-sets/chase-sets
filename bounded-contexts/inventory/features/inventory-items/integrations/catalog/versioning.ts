import type { ProductKey } from "@chase-sets/primitives/catalog-identity";
import {
  getOrderedProductSelectionDimensions,
  getProductSelectionOptionLabel,
  isProductSelectionDimensionActive,
  normalizeProductSelection,
  productSelectionEntriesToRecord,
  recordToProductSelectionEntries,
  toProductSelectionFields,
  type ProductSelectionField,
} from "@chase-sets/product-selection";
import { assert } from "../../../../support/runtime-support/common";

export type InventorySelectedOptionEntry = Readonly<{
  dimensionId: string;
  optionId: string;
}>;

export type InventoryProductApplicabilityClause = Readonly<{
  dimensionId: string;
  optionIds: string[];
}>;

export type InventoryProductOption = Readonly<{
  optionId: string;
  code: string;
  label_i18n?: unknown;
  label: string;
}>;

export type InventoryProductDimension = Readonly<{
  dimensionId: string;
  dimensionName: string;
  required: boolean;
  appliesWhen: InventoryProductApplicabilityClause[];
  allowedOptions: InventoryProductOption[];
}>;

export type InventoryProductSchema = Readonly<{
  canonicalDimensionOrder: Array<{ dimensionId: string; dimensionName: string }>;
  dimensions: InventoryProductDimension[];
}>;

export type InventoryProductDescriptor = Readonly<{
  productId: ProductKey;
  selection: InventorySelectedOptionEntry[];
}>;

export function toInventoryItemProductSchema(schema: InventoryProductSchema | null): InventoryProductSchema | null {
  return schema;
}

// The dimension-selection algorithm (ordering, appliesWhen activation, normalization, and
// label formatting) is owned by @chase-sets/product-selection - the single implementation
// shared with marketplace's listing picker and inventory's own import-row picker. These
// re-exports keep this module's established names stable for existing consumers.
export const getOptionLabel = getProductSelectionOptionLabel;
export const isDimensionActive = isProductSelectionDimensionActive;
export const getOrderedDimensions = getOrderedProductSelectionDimensions;
export const normalizeSelectedOptionsForSchema = normalizeProductSelection;

export function selectionEntriesToRecord(selection: readonly InventorySelectedOptionEntry[]): Record<string, string> {
  return productSelectionEntriesToRecord(selection);
}

export function recordToSelectionEntries(
  schema: InventoryProductSchema,
  selections: Record<string, string>,
): InventorySelectedOptionEntry[] {
  return recordToProductSelectionEntries(schema, selections);
}

/** Ready-to-render dimension fields for a catalog-item picker UI (search + select + this). */
export function toInventoryProductSelectionFields(
  schema: InventoryProductSchema | null,
  selections: Record<string, string>,
): ProductSelectionField[] {
  return toProductSelectionFields(schema, selections);
}

export function parseSelectedOptionsInput(value: unknown): InventorySelectedOptionEntry[] {
  if (Array.isArray(value)) {
    return value
      .map((entry) => {
        if (
          typeof entry === "object" &&
          entry !== null &&
          typeof (entry as Record<string, unknown>).dimensionId === "string" &&
          typeof (entry as Record<string, unknown>).optionId === "string"
        ) {
          return {
            dimensionId: String((entry as Record<string, unknown>).dimensionId),
            optionId: String((entry as Record<string, unknown>).optionId),
          };
        }

        return null;
      })
      .filter((entry): entry is InventorySelectedOptionEntry => entry !== null);
  }

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) {
      return [];
    }

    return parseSelectedOptionsInput(JSON.parse(trimmed));
  }

  return [];
}

export function createInventoryProductDescriptor(
  input: Readonly<{
    catalogItemId: string;
    productSchema: InventoryProductSchema | null;
    selection: readonly InventorySelectedOptionEntry[];
  }>,
): InventoryProductDescriptor {
  const catalogItemId = input.catalogItemId.trim();
  assert(catalogItemId.length > 0, "Catalog item id is required.");

  const selection = validateSelectedOptions(input.productSchema, input.selection);
  if (!input.productSchema || input.productSchema.dimensions.length === 0) {
    return {
      productId: `${catalogItemId}::` as ProductKey,
      selection: [],
    };
  }

  const selections = selectionEntriesToRecord(selection);

  return {
    productId: `${catalogItemId}::${input.productSchema.canonicalDimensionOrder
      .map((entry) => `${entry.dimensionId}:${selections[entry.dimensionId] ?? "-"}`)
      .join("|")}` as ProductKey,
    selection: recordToSelectionEntries(input.productSchema, selections),
  };
}

export function validateSelectedOptions(
  schema: InventoryProductSchema | null,
  selection: readonly InventorySelectedOptionEntry[],
): InventorySelectedOptionEntry[] {
  if (!schema || schema.dimensions.length === 0) {
    assert(selection.length === 0, "Selected options are not allowed for this catalog item.");
    return [];
  }

  const selections = selectionEntriesToRecord(selection);
  const seenDimensionIds = new Set<string>();

  for (const entry of selection) {
    assert(!seenDimensionIds.has(entry.dimensionId), "Selected options may include each dimension at most once.");
    seenDimensionIds.add(entry.dimensionId);
  }

  for (const dimension of getOrderedDimensions(schema)) {
    const active = isDimensionActive(dimension, selections);
    const selectedOptionId = selections[dimension.dimensionId];

    if (!active) {
      assert(selectedOptionId === undefined, "Selected options cannot include inactive dimensions.");
      continue;
    }

    if (selectedOptionId === undefined) {
      assert(!dimension.required, `Selected options must include ${dimension.dimensionName}.`);
      continue;
    }

    assert(
      dimension.allowedOptions.some((option) => option.optionId === selectedOptionId),
      `Selected options must use an allowed option for ${dimension.dimensionName}.`,
    );
  }

  assert(
    selection.every((entry) => schema.dimensions.some((dimension) => dimension.dimensionId === entry.dimensionId)),
    "Selected options cannot include unknown dimensions.",
  );

  return recordToSelectionEntries(schema, selections);
}

export function summarizeSelectedOptions(
  schema: InventoryProductSchema | null,
  selection: readonly InventorySelectedOptionEntry[],
): string {
  if (!schema || selection.length === 0) {
    return "";
  }

  const selections = selectionEntriesToRecord(selection);

  return getOrderedDimensions(schema)
    .map((dimension) => {
      const optionId = selections[dimension.dimensionId];
      if (!optionId) {
        return null;
      }

      const option = dimension.allowedOptions.find((candidate) => candidate.optionId === optionId);
      if (!option) {
        return null;
      }

      return `${dimension.dimensionName}: ${getOptionLabel(option)}`;
    })
    .filter((entry): entry is string => entry !== null)
    .join(" | ");
}
