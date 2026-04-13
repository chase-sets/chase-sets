import type {
  VersionDimension,
  VersionSchema,
} from "../../../support/client-support/contracts";

type VersionChoice = VersionDimension["allowedChoices"][number];

export function getChoiceLabel(choice: VersionChoice): string {
  if (choice.labels && choice.labels.length > 0) {
    return choice.labels[0].value;
  }

  return choice.code;
}

export function isDimensionActive(
  dimension: VersionDimension,
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

export function getOrderedDimensions(schema: VersionSchema): VersionDimension[] {
  return schema.canonicalDimensionOrder
    .map((order) =>
      schema.dimensions.find((dimension) => dimension.dimensionId === order.dimensionId),
    )
    .filter((dimension): dimension is VersionDimension => dimension !== undefined);
}

export function getOrderedActiveDimensions(
  schema: VersionSchema,
  selections: Record<string, string>,
): VersionDimension[] {
  return getOrderedDimensions(schema).filter((dimension) =>
    isDimensionActive(dimension, selections),
  );
}

export function normalizeSelectionsForSchema(
  schema: VersionSchema,
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

export function summarizeSelections(
  schema: VersionSchema,
  selections: Record<string, string>,
): Array<{ dimensionName: string; choiceLabel: string }> {
  return getOrderedActiveDimensions(schema, selections)
    .map((dimension) => {
      const selectedChoiceId = selections[dimension.dimensionId];
      const selectedChoice = dimension.allowedChoices.find((choice) => choice.choiceId === selectedChoiceId);

      if (!selectedChoice) {
        return null;
      }

      return {
        dimensionName: dimension.dimensionName,
        choiceLabel: getChoiceLabel(selectedChoice),
      };
    })
    .filter((selection): selection is { dimensionName: string; choiceLabel: string } => selection !== null);
}

export function createDiscoveryCatalogVersionDescriptor(input: Readonly<{
  catalogItemId: string;
  versionSchema: VersionSchema | null;
  selection: readonly { dimensionId: string; choiceId: string }[];
}>): Readonly<{
  catalogVersionKey: string;
  selection: { dimensionId: string; choiceId: string }[];
}> {
  const catalogItemId = input.catalogItemId.trim();
  if (!catalogItemId) {
    throw new Error("Catalog item id is required.");
  }

  if (!input.versionSchema || input.versionSchema.dimensions.length === 0) {
    if (input.selection.length > 0) {
      throw new Error("Selection is not allowed for this catalog item.");
    }

    return {
      catalogVersionKey: `${catalogItemId}::`,
      selection: [],
    };
  }

  const normalizedSelection = normalizeSelectionsForSchema(
    input.versionSchema,
    Object.fromEntries(
      input.selection.map((entry) => [entry.dimensionId.trim(), entry.choiceId.trim()]),
    ),
  );

  const orderedSelection = getOrderedDimensions(input.versionSchema)
    .map((dimension) => {
      const choiceId = normalizedSelection[dimension.dimensionId];
      if (!choiceId) {
        return null;
      }

      return {
        dimensionId: dimension.dimensionId,
        choiceId,
      };
    })
    .filter(
      (entry): entry is { dimensionId: string; choiceId: string } => entry !== null,
    );

  return {
    catalogVersionKey: `${catalogItemId}::${input.versionSchema.canonicalDimensionOrder
      .map((entry) => `${entry.dimensionId}:${normalizedSelection[entry.dimensionId] ?? "-"}`)
      .join("|")}`,
    selection: orderedSelection,
  };
}
