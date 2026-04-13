import { assert } from "../../../../support/runtime-support/common";

export type InventoryVersionSelectionEntry = Readonly<{
  dimensionId: string;
  choiceId: string;
}>;

export type InventoryVersionApplicabilityClause = Readonly<{
  dimensionId: string;
  choiceIds: string[];
}>;

export type InventoryVersionChoice = Readonly<{
  choiceId: string;
  code: string;
  labels?: Array<{ locale: string; value: string }>;
}>;

export type InventoryVersionDimension = Readonly<{
  dimensionId: string;
  dimensionName: string;
  required: boolean;
  appliesWhen: InventoryVersionApplicabilityClause[];
  allowedChoices: InventoryVersionChoice[];
}>;

export type InventoryVersionSchema = Readonly<{
  canonicalDimensionOrder: Array<{ dimensionId: string; dimensionName: string }>;
  dimensions: InventoryVersionDimension[];
}>;

export type InventoryCatalogVersionDescriptor = Readonly<{
  catalogVersionKey: string;
  selection: InventoryVersionSelectionEntry[];
}>;

export function toInventoryRecordVersionSchema(
  schema: InventoryVersionSchema | null,
): InventoryVersionSchema | null {
  return schema;
}

export function getChoiceLabel(choice: InventoryVersionChoice): string {
  if (choice.labels && choice.labels.length > 0) {
    return choice.labels[0].value;
  }

  return choice.code;
}

export function isDimensionActive(
  dimension: InventoryVersionDimension,
  selections: Record<string, string>,
): boolean {
  return dimension.appliesWhen.every((clause) => {
    const selectedChoiceId = selections[clause.dimensionId];
    return (
      selectedChoiceId !== undefined &&
      clause.choiceIds.includes(selectedChoiceId)
    );
  });
}

export function getOrderedDimensions(
  schema: InventoryVersionSchema,
): InventoryVersionDimension[] {
  return schema.canonicalDimensionOrder
    .map((order) =>
      schema.dimensions.find((dimension) => dimension.dimensionId === order.dimensionId),
    )
    .filter((dimension): dimension is InventoryVersionDimension => dimension !== undefined);
}

export function normalizeSelectionsForSchema(
  schema: InventoryVersionSchema,
  selections: Record<string, string>,
): Record<string, string> {
  const nextSelections = { ...selections };

  for (const dimension of getOrderedDimensions(schema)) {
    const active = isDimensionActive(dimension, nextSelections);

    if (!active) {
      delete nextSelections[dimension.dimensionId];
      continue;
    }

    const allowedChoiceIds = dimension.allowedChoices.map((choice) => choice.choiceId);
    const selectedChoiceId = nextSelections[dimension.dimensionId];

    if (selectedChoiceId !== undefined && allowedChoiceIds.includes(selectedChoiceId)) {
      continue;
    }

    if (dimension.required && allowedChoiceIds.length > 0) {
      nextSelections[dimension.dimensionId] = allowedChoiceIds[0];
      continue;
    }

    delete nextSelections[dimension.dimensionId];
  }

  return nextSelections;
}

export function selectionEntriesToRecord(
  selection: readonly InventoryVersionSelectionEntry[],
): Record<string, string> {
  return Object.fromEntries(
    selection.map((entry) => [entry.dimensionId, entry.choiceId]),
  );
}

export function recordToSelectionEntries(
  schema: InventoryVersionSchema,
  selections: Record<string, string>,
): InventoryVersionSelectionEntry[] {
  return getOrderedDimensions(schema)
    .map((dimension) => {
      const choiceId = selections[dimension.dimensionId];
      if (!choiceId) {
        return null;
      }

      return {
        dimensionId: dimension.dimensionId,
        choiceId,
      };
    })
    .filter(
      (entry): entry is InventoryVersionSelectionEntry => entry !== null,
    );
}

export function parseVersionSelectionInput(
  value: unknown,
): InventoryVersionSelectionEntry[] {
  if (Array.isArray(value)) {
    return value
      .map((entry) => {
        if (
          typeof entry === "object" &&
          entry !== null &&
          typeof (entry as Record<string, unknown>).dimensionId === "string" &&
          typeof (entry as Record<string, unknown>).choiceId === "string"
        ) {
          return {
            dimensionId: String((entry as Record<string, unknown>).dimensionId),
            choiceId: String((entry as Record<string, unknown>).choiceId),
          };
        }

        return null;
      })
      .filter(
        (entry): entry is InventoryVersionSelectionEntry => entry !== null,
      );
  }

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) {
      return [];
    }

    return parseVersionSelectionInput(JSON.parse(trimmed));
  }

  return [];
}

export function createInventoryCatalogVersionDescriptor(input: Readonly<{
  catalogItemId: string;
  versionSchema: InventoryVersionSchema | null;
  selection: readonly InventoryVersionSelectionEntry[];
}>): InventoryCatalogVersionDescriptor {
  const catalogItemId = input.catalogItemId.trim();
  assert(catalogItemId.length > 0, "Catalog item id is required.");

  const selection = validateVersionSelection(input.versionSchema, input.selection);
  if (!input.versionSchema || input.versionSchema.dimensions.length === 0) {
    return {
      catalogVersionKey: `${catalogItemId}::`,
      selection: [],
    };
  }

  const selections = selectionEntriesToRecord(selection);

  return {
    catalogVersionKey: `${catalogItemId}::${input.versionSchema.canonicalDimensionOrder
      .map((entry) => `${entry.dimensionId}:${selections[entry.dimensionId] ?? "-"}`)
      .join("|")}`,
    selection: recordToSelectionEntries(input.versionSchema, selections),
  };
}

export function validateVersionSelection(
  schema: InventoryVersionSchema | null,
  selection: readonly InventoryVersionSelectionEntry[],
): InventoryVersionSelectionEntry[] {
  if (!schema || schema.dimensions.length === 0) {
    assert(
      selection.length === 0,
      "Version selection is not allowed for this catalog item.",
    );
    return [];
  }

  const selections = selectionEntriesToRecord(selection);
  const seenDimensionIds = new Set<string>();

  for (const entry of selection) {
    assert(
      !seenDimensionIds.has(entry.dimensionId),
      "Version selection may include each dimension at most once.",
    );
    seenDimensionIds.add(entry.dimensionId);
  }

  for (const dimension of getOrderedDimensions(schema)) {
    const active = isDimensionActive(dimension, selections);
    const selectedChoiceId = selections[dimension.dimensionId];

    if (!active) {
      assert(
        selectedChoiceId === undefined,
        "Version selection cannot include inactive dimensions.",
      );
      continue;
    }

    if (selectedChoiceId === undefined) {
      assert(
        !dimension.required,
        `Version selection must include ${dimension.dimensionName}.`,
      );
      continue;
    }

    assert(
      dimension.allowedChoices.some((choice) => choice.choiceId === selectedChoiceId),
      `Version selection must use an allowed choice for ${dimension.dimensionName}.`,
    );
  }

  assert(
    selection.every((entry) =>
      schema.dimensions.some((dimension) => dimension.dimensionId === entry.dimensionId),
    ),
    "Version selection cannot include unknown dimensions.",
  );

  return recordToSelectionEntries(schema, selections);
}

export function summarizeVersionSelection(
  schema: InventoryVersionSchema | null,
  selection: readonly InventoryVersionSelectionEntry[],
): string {
  if (!schema || selection.length === 0) {
    return "";
  }

  const selections = selectionEntriesToRecord(selection);

  return getOrderedDimensions(schema)
    .map((dimension) => {
      const choiceId = selections[dimension.dimensionId];
      if (!choiceId) {
        return null;
      }

      const choice = dimension.allowedChoices.find(
        (candidate) => candidate.choiceId === choiceId,
      );
      if (!choice) {
        return null;
      }

      return `${dimension.dimensionName}: ${getChoiceLabel(choice)}`;
    })
    .filter((entry): entry is string => entry !== null)
    .join(" | ");
}
