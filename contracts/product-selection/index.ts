// Canonical schema-driven product selection logic. A "product selection" is the set of
// dimension -> option choices (e.g. condition, grading company, grade) a buyer or seller
// makes against a catalog item's product schema. This module is the single implementation
// shared by every bounded context that renders or validates a product selection picker
// (inventory item intake, listing creation, import-row resolution): it is imported both
// client-side (form state) and server-side (request validation), so it must stay pure -
// no React, no fetch, no environment reads.

export type ProductSelectionOption = Readonly<{
  optionId: string;
  code?: string;
  label?: string;
}>;

export type ProductSelectionApplicabilityClause = Readonly<{
  dimensionId: string;
  optionIds: readonly string[];
}>;

export type ProductSelectionDimension = Readonly<{
  dimensionId: string;
  dimensionName: string;
  required?: boolean;
  appliesWhen?: readonly ProductSelectionApplicabilityClause[];
  allowedOptions: readonly ProductSelectionOption[];
}>;

export type ProductSelectionSchema = Readonly<{
  canonicalDimensionOrder: readonly Readonly<{ dimensionId: string }>[];
  dimensions: readonly ProductSelectionDimension[];
}>;

export type ProductSelectionEntry = Readonly<{
  dimensionId: string;
  optionId: string;
}>;

export type ProductSelectionRecord = Readonly<Record<string, string>>;

/**
 * Orders a schema's dimensions by its canonical dimension order, dropping any dimension
 * referenced by the order that no longer exists on the schema.
 */
export function getOrderedProductSelectionDimensions(schema: ProductSelectionSchema): ProductSelectionDimension[] {
  return schema.canonicalDimensionOrder
    .map((entry) => schema.dimensions.find((dimension) => dimension.dimensionId === entry.dimensionId))
    .filter((dimension): dimension is ProductSelectionDimension => dimension !== undefined);
}

/**
 * A dimension is active when every clause of its `appliesWhen` guard is satisfied by the
 * current selections (e.g. "condition" only applies when form = raw). Dimensions with no
 * guard are always active.
 */
export function isProductSelectionDimensionActive(
  dimension: ProductSelectionDimension,
  selections: ProductSelectionRecord,
): boolean {
  return (dimension.appliesWhen ?? []).every((clause) => {
    const selectedOptionId = selections[clause.dimensionId];
    return selectedOptionId !== undefined && clause.optionIds.includes(selectedOptionId);
  });
}

/**
 * Returns, in canonical order, only the dimensions that are currently active given the
 * supplied selections.
 */
export function getOrderedActiveProductSelectionDimensions(
  schema: ProductSelectionSchema,
  selections: ProductSelectionRecord,
): ProductSelectionDimension[] {
  return getOrderedProductSelectionDimensions(schema).filter((dimension) =>
    isProductSelectionDimensionActive(dimension, selections),
  );
}

/**
 * Repairs a selection record against a schema: drops selections for inactive or unknown
 * dimensions, defaults required active dimensions to their first allowed option, and drops
 * selections that no longer name an allowed option. Safe to call after every field change.
 */
export function normalizeProductSelection(
  schema: ProductSelectionSchema,
  selections: ProductSelectionRecord,
): Record<string, string> {
  const next: Record<string, string> = { ...selections };

  for (const dimension of getOrderedProductSelectionDimensions(schema)) {
    if (!isProductSelectionDimensionActive(dimension, next)) {
      delete next[dimension.dimensionId];
      continue;
    }

    const allowedOptionIds = dimension.allowedOptions.map((option) => option.optionId);
    const selectedOptionId = next[dimension.dimensionId];

    if (selectedOptionId !== undefined && allowedOptionIds.includes(selectedOptionId)) {
      continue;
    }

    if (dimension.required && allowedOptionIds.length > 0) {
      next[dimension.dimensionId] = allowedOptionIds[0]!;
      continue;
    }

    delete next[dimension.dimensionId];
  }

  return next;
}

export function getProductSelectionOptionLabel(option: ProductSelectionOption): string {
  return option.label || option.code || option.optionId;
}

export function productSelectionEntriesToRecord(entries: readonly ProductSelectionEntry[]): Record<string, string> {
  return Object.fromEntries(entries.map((entry) => [entry.dimensionId, entry.optionId]));
}

export function recordToProductSelectionEntries(
  schema: ProductSelectionSchema,
  selections: ProductSelectionRecord,
): ProductSelectionEntry[] {
  return getOrderedProductSelectionDimensions(schema)
    .map((dimension) => {
      const optionId = selections[dimension.dimensionId];
      if (!optionId) {
        return null;
      }

      return { dimensionId: dimension.dimensionId, optionId };
    })
    .filter((entry): entry is ProductSelectionEntry => entry !== null);
}

/** Ready-to-render field description for a generic "one select per active dimension" picker UI. */
export type ProductSelectionFieldOption = Readonly<{
  value: string;
  label: string;
}>;

export type ProductSelectionField = Readonly<{
  dimensionId: string;
  label: string;
  value: string;
  options: readonly ProductSelectionFieldOption[];
}>;

/**
 * Projects a schema + current selections into the ordered, active fields a picker UI should
 * render - one entry per active dimension, with its allowed options already label-formatted.
 */
export function toProductSelectionFields(
  schema: ProductSelectionSchema | null | undefined,
  selections: ProductSelectionRecord,
): ProductSelectionField[] {
  if (!schema) {
    return [];
  }

  return getOrderedActiveProductSelectionDimensions(schema, selections).map((dimension) => ({
    dimensionId: dimension.dimensionId,
    label: dimension.dimensionName,
    value: selections[dimension.dimensionId] ?? "",
    options: dimension.allowedOptions.map((option) => ({
      value: option.optionId,
      label: getProductSelectionOptionLabel(option),
    })),
  }));
}
