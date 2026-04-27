import type {
  VersionDimension,
  VersionSchema,
} from "../../../support/client-support/contracts";

type VersionChoice = VersionDimension["allowedOptions"][number];

export function getOptionLabel(option: VersionChoice): string {
  if (option.labels && option.labels.length > 0) {
    return option.labels[0].value;
  }

  return option.code;
}

export function isDimensionActive(
  dimension: VersionDimension,
  selections: Record<string, string>,
): boolean {
  return dimension.appliesWhen.every((clause) => {
    const selectedOptionId = selections[clause.dimensionId];
    return (
      selectedOptionId !== undefined &&
      clause.optionIds.includes(selectedOptionId)
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

export function normalizeProductSearchOptionsForSchema(
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

    const allowedOptionIds = dimension.allowedOptions.map((option) => option.optionId);
    const selectedOptionId = nextSelections[dimension.dimensionId];

    if (selectedOptionId !== undefined && allowedOptionIds.includes(selectedOptionId)) {
      continue;
    }

    delete nextSelections[dimension.dimensionId];
  }

  return nextSelections;
}

export function normalizeSelectedOptionssForSchema(
  schema: VersionSchema,
  selections: Record<string, string>,
): Record<string, string> {
  return normalizeProductSearchOptionsForSchema(schema, selections);
}

export function isProductSelectionComplete(
  schema: VersionSchema,
  selections: Record<string, string>,
): boolean {
  const normalizedSelections = normalizeProductSearchOptionsForSchema(schema, selections);

  return getOrderedActiveDimensions(schema, normalizedSelections).every((dimension) => {
    if (!dimension.required) {
      return true;
    }

    return normalizedSelections[dimension.dimensionId] !== undefined;
  });
}

export function summarizeSelections(
  schema: VersionSchema,
  selections: Record<string, string>,
): Array<{ dimensionName: string; optionLabel: string }> {
  return getOrderedActiveDimensions(schema, selections)
    .map((dimension) => {
      const selectedOptionId = selections[dimension.dimensionId];
      const selectedOption = dimension.allowedOptions.find((option) => option.optionId === selectedOptionId);

      if (!selectedOption) {
        return null;
      }

      return {
        dimensionName: dimension.dimensionName,
        optionLabel: getOptionLabel(selectedOption),
      };
    })
    .filter((selection): selection is { dimensionName: string; optionLabel: string } => selection !== null);
}

export function createDiscoveryProductDescriptor(input: Readonly<{
  catalogItemId: string;
  productSchema: VersionSchema | null;
  selection: readonly { dimensionId: string; optionId: string }[];
}>): Readonly<{
  productId: string;
  selection: { dimensionId: string; optionId: string }[];
}> {
  const catalogItemId = input.catalogItemId.trim();
  if (!catalogItemId) {
    throw new Error("Catalog item id is required.");
  }

  if (!input.productSchema || input.productSchema.dimensions.length === 0) {
    if (input.selection.length > 0) {
      throw new Error("Selection is not allowed for this catalog item.");
    }

    return {
      productId: `${catalogItemId}::`,
      selection: [],
    };
  }

  const normalizedSelection = normalizeProductSearchOptionsForSchema(
    input.productSchema,
    Object.fromEntries(
      input.selection.map((entry) => [entry.dimensionId.trim(), entry.optionId.trim()]),
    ),
  );

  for (const dimension of getOrderedActiveDimensions(input.productSchema, normalizedSelection)) {
    if (dimension.required && normalizedSelection[dimension.dimensionId] === undefined) {
      throw new Error(`Selection must include ${dimension.dimensionName}.`);
    }
  }

  const orderedSelection = getOrderedDimensions(input.productSchema)
    .map((dimension) => {
      const optionId = normalizedSelection[dimension.dimensionId];
      if (!optionId) {
        return null;
      }

      return {
        dimensionId: dimension.dimensionId,
        optionId,
      };
    })
    .filter(
      (entry): entry is { dimensionId: string; optionId: string } => entry !== null,
    );

  return {
    productId: `${catalogItemId}::${input.productSchema.canonicalDimensionOrder
      .map((entry) => `${entry.dimensionId}:${normalizedSelection[entry.dimensionId] ?? "-"}`)
      .join("|")}`,
    selection: orderedSelection,
  };
}
