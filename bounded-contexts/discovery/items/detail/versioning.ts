import type {
  VersionDimension,
  VersionSchema,
} from "../client-support/contracts";

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
