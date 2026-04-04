import type { Branded } from "@chase-sets/primitives/brand";
import { assert } from "./common";

export type CatalogVersionKey = Branded<string, "CatalogVersionKey">;

export type CatalogSelectionEntry = Readonly<{
  dimensionId: string;
  choiceId: string;
}>;

export type CatalogVersionApplicabilityClause = Readonly<{
  dimensionId: string;
  choiceIds: string[];
}>;

export type CatalogVersionChoice = Readonly<{
  choiceId: string;
  code: string;
  labels?: Array<{ locale: string; value: string }>;
}>;

export type CatalogVersionDimension = Readonly<{
  dimensionId: string;
  dimensionName: string;
  required: boolean;
  appliesWhen: CatalogVersionApplicabilityClause[];
  allowedChoices: CatalogVersionChoice[];
}>;

export type CatalogVersionSchema = Readonly<{
  canonicalDimensionOrder: Array<{ dimensionId: string; dimensionName: string }>;
  dimensions: CatalogVersionDimension[];
}>;

export type CatalogVersionDescriptor = Readonly<{
  versionKey: CatalogVersionKey;
  selection: CatalogSelectionEntry[];
}>;

export type SellableUnitDescriptor = Readonly<{
  catalogItemId: string;
  catalogVersionKey: CatalogVersionKey;
  selection: CatalogSelectionEntry[];
}>;

export class SellableUnitError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "SellableUnitError";
  }
}

function normalizeRequiredText(value: string, message: string) {
  const normalized = value.trim();
  assert(normalized.length > 0, message);
  return normalized;
}

function selectionEntriesToRecord(
  selection: readonly CatalogSelectionEntry[],
): Record<string, string> {
  return Object.fromEntries(
    selection.map((entry) => [entry.dimensionId, entry.choiceId]),
  );
}

function isDimensionActive(
  dimension: CatalogVersionDimension,
  selections: Record<string, string>,
) {
  return dimension.appliesWhen.every((clause) => {
    const selectedChoiceId = selections[clause.dimensionId];
    return (
      selectedChoiceId !== undefined &&
      clause.choiceIds.includes(selectedChoiceId)
    );
  });
}

function hasExactDimensionSet(left: readonly string[], right: readonly string[]) {
  if (left.length !== right.length) {
    return false;
  }

  const remaining = new Set(left);
  for (const value of right) {
    if (!remaining.has(value)) {
      return false;
    }
    remaining.delete(value);
  }

  return remaining.size === 0;
}

export function createCatalogVersionKey(value: string): CatalogVersionKey {
  return value as CatalogVersionKey;
}

export function normalizeCatalogSelection(
  selection: readonly CatalogSelectionEntry[],
): CatalogSelectionEntry[] {
  const normalized = selection
    .map((entry) => ({
      dimensionId: normalizeRequiredText(
        entry.dimensionId,
        "Selection must include a dimension.",
      ),
      choiceId: normalizeRequiredText(
        entry.choiceId,
        "Selection must include a choice.",
      ),
    }))
    .sort((left, right) =>
      left.dimensionId.localeCompare(right.dimensionId) ||
      left.choiceId.localeCompare(right.choiceId),
    );

  const seen = new Set<string>();
  for (const entry of normalized) {
    assert(
      !seen.has(entry.dimensionId),
      "Selection cannot include duplicate dimensions.",
    );
    seen.add(entry.dimensionId);
  }

  return normalized;
}

export function resolveCatalogVersionDescriptor(input: Readonly<{
  catalogItemId: string;
  versionSchema: CatalogVersionSchema | null;
  selection: readonly CatalogSelectionEntry[];
}>): CatalogVersionDescriptor {
  const catalogItemId = normalizeRequiredText(
    input.catalogItemId,
    "Catalog item id is required.",
  );
  const selection = normalizeCatalogSelection(input.selection);
  const schema = input.versionSchema;

  if (!schema || schema.dimensions.length === 0) {
    assert(
      selection.length === 0,
      "Selection is not allowed for this catalog item.",
    );
    return {
      versionKey: createCatalogVersionKey(`${catalogItemId}::`),
      selection: [],
    };
  }

  assert(
    hasExactDimensionSet(
      schema.dimensions.map((dimension) => dimension.dimensionId),
      schema.canonicalDimensionOrder.map((entry) => entry.dimensionId),
    ),
    "Version schema requires a canonical order for every dimension.",
  );

  const selections = selectionEntriesToRecord(selection);

  for (const dimension of schema.canonicalDimensionOrder
    .map((entry) =>
      schema.dimensions.find((candidate) => candidate.dimensionId === entry.dimensionId),
    )
    .filter(
      (dimension): dimension is CatalogVersionDimension => dimension !== undefined,
    )) {
    const active = isDimensionActive(dimension, selections);
    const selectedChoiceId = selections[dimension.dimensionId];

    if (!active) {
      assert(
        selectedChoiceId === undefined,
        "Selection cannot include inactive dimensions.",
      );
      continue;
    }

    if (selectedChoiceId === undefined) {
      assert(
        !dimension.required,
        `Selection must include ${dimension.dimensionName}.`,
      );
      continue;
    }

    assert(
      dimension.allowedChoices.some((choice) => choice.choiceId === selectedChoiceId),
      `Selection must use an allowed choice for ${dimension.dimensionName}.`,
    );
  }

  assert(
    selection.every((entry) =>
      schema.dimensions.some((dimension) => dimension.dimensionId === entry.dimensionId),
    ),
    "Selection cannot include unknown dimensions.",
  );

  const orderedSelection = schema.canonicalDimensionOrder
    .map((entry) => {
      const choiceId = selections[entry.dimensionId];
      if (!choiceId) {
        return null;
      }

      return {
        dimensionId: entry.dimensionId,
        choiceId,
      };
    })
    .filter((entry): entry is CatalogSelectionEntry => entry !== null);

  return {
    versionKey: createCatalogVersionKey(
      `${catalogItemId}::${schema.canonicalDimensionOrder
        .map((entry) => `${entry.dimensionId}:${selections[entry.dimensionId] ?? "-"}`)
        .join("|")}`,
    ),
    selection: orderedSelection,
  };
}

export function resolveSellableUnitDescriptor(input: Readonly<{
  catalogItemId: string;
  versionSchema: CatalogVersionSchema | null;
  selection: readonly CatalogSelectionEntry[];
}>): SellableUnitDescriptor {
  const version = resolveCatalogVersionDescriptor(input);

  return {
    catalogItemId: input.catalogItemId.trim(),
    catalogVersionKey: version.versionKey,
    selection: version.selection,
  };
}
