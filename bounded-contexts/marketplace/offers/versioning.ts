export type MarketplaceVersionSelectionEntry = Readonly<{
  dimensionId: string;
  choiceId: string;
}>;

export type MarketplaceVersionApplicabilityClause = Readonly<{
  dimensionId: string;
  choiceIds: string[];
}>;

export type MarketplaceVersionChoice = Readonly<{
  choiceId: string;
  code: string;
  labels?: Array<{ locale: string; value: string }>;
}>;

export type MarketplaceVersionDimension = Readonly<{
  dimensionId: string;
  dimensionName: string;
  required: boolean;
  appliesWhen: MarketplaceVersionApplicabilityClause[];
  allowedChoices: MarketplaceVersionChoice[];
}>;

export type MarketplaceVersionSchema = Readonly<{
  canonicalDimensionOrder: Array<{ dimensionId: string; dimensionName: string }>;
  dimensions: MarketplaceVersionDimension[];
}>;

export type MarketplaceCatalogVersionDescriptor = Readonly<{
  catalogVersionKey: string;
  selection: MarketplaceVersionSelectionEntry[];
}>;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function normalizeRequiredText(value: string, message: string) {
  const normalized = value.trim();
  assert(normalized.length > 0, message);
  return normalized;
}

function selectionEntriesToRecord(
  selection: readonly MarketplaceVersionSelectionEntry[],
): Record<string, string> {
  return Object.fromEntries(
    selection.map((entry) => [entry.dimensionId, entry.choiceId]),
  );
}

function isDimensionActive(
  dimension: MarketplaceVersionDimension,
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

function normalizeSelection(
  selection: readonly MarketplaceVersionSelectionEntry[],
) {
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

export function createMarketplaceCatalogVersionDescriptor(input: Readonly<{
  catalogItemId: string;
  versionSchema: MarketplaceVersionSchema | null;
  selection: readonly MarketplaceVersionSelectionEntry[];
}>): MarketplaceCatalogVersionDescriptor {
  const catalogItemId = normalizeRequiredText(
    input.catalogItemId,
    "Catalog item id is required.",
  );
  const schema = input.versionSchema;
  const selection = normalizeSelection(input.selection);

  if (!schema || schema.dimensions.length === 0) {
    assert(
      selection.length === 0,
      "Selection is not allowed for this catalog item.",
    );
    return {
      catalogVersionKey: `${catalogItemId}::`,
      selection: [],
    };
  }

  const selections = selectionEntriesToRecord(selection);

  for (const dimension of schema.canonicalDimensionOrder
    .map((entry) =>
      schema.dimensions.find((candidate) => candidate.dimensionId === entry.dimensionId),
    )
    .filter(
      (dimension): dimension is MarketplaceVersionDimension => dimension !== undefined,
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

  return {
    catalogVersionKey: `${catalogItemId}::${schema.canonicalDimensionOrder
      .map((entry) => `${entry.dimensionId}:${selections[entry.dimensionId] ?? "-"}`)
      .join("|")}`,
    selection: schema.canonicalDimensionOrder
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
      .filter(
        (entry): entry is MarketplaceVersionSelectionEntry => entry !== null,
      ),
  };
}
