export type MarketplaceVersionSelectedOptionEntry = Readonly<{
  dimensionId: string;
  optionId: string;
}>;

export type MarketplaceVersionApplicabilityClause = Readonly<{
  dimensionId: string;
  optionIds: string[];
}>;

export type MarketplaceVersionChoice = Readonly<{
  optionId: string;
  code: string;
  label_i18n?: unknown;
  label: string;
}>;

export type MarketplaceVersionDimension = Readonly<{
  dimensionId: string;
  dimensionName: string;
  required: boolean;
  appliesWhen: MarketplaceVersionApplicabilityClause[];
  allowedOptions: MarketplaceVersionChoice[];
}>;

export type MarketplaceVersionSchema = Readonly<{
  canonicalDimensionOrder: Array<{ dimensionId: string; dimensionName: string }>;
  dimensions: MarketplaceVersionDimension[];
}>;

export type MarketplaceProductDescriptor = Readonly<{
  productId: ProductKey;
  selection: MarketplaceVersionSelectedOptionEntry[];
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

function selectionEntriesToRecord(selection: readonly MarketplaceVersionSelectedOptionEntry[]): Record<string, string> {
  return Object.fromEntries(selection.map((entry) => [entry.dimensionId, entry.optionId]));
}

function isDimensionActive(dimension: MarketplaceVersionDimension, selections: Record<string, string>) {
  return dimension.appliesWhen.every((clause) => {
    const selectedOptionId = selections[clause.dimensionId];
    return selectedOptionId !== undefined && clause.optionIds.includes(selectedOptionId);
  });
}

function normalizeSelectedOptions(selection: readonly MarketplaceVersionSelectedOptionEntry[]) {
  const normalized = selection
    .map((entry) => ({
      dimensionId: normalizeRequiredText(entry.dimensionId, "Selection must include a dimension."),
      optionId: normalizeRequiredText(entry.optionId, "Selection must include an option."),
    }))
    .sort(
      (left, right) => left.dimensionId.localeCompare(right.dimensionId) || left.optionId.localeCompare(right.optionId),
    );

  const seen = new Set<string>();
  for (const entry of normalized) {
    assert(!seen.has(entry.dimensionId), "Selection cannot include duplicate dimensions.");
    seen.add(entry.dimensionId);
  }

  return normalized;
}

export function createMarketplaceProductDescriptor(
  input: Readonly<{
    catalogItemId: string;
    productSchema: MarketplaceVersionSchema | null;
    selection: readonly MarketplaceVersionSelectedOptionEntry[];
  }>,
): MarketplaceProductDescriptor {
  const catalogItemId = normalizeRequiredText(input.catalogItemId, "Catalog item id is required.");
  const schema = input.productSchema;
  const selection = normalizeSelectedOptions(input.selection);

  if (!schema || schema.dimensions.length === 0) {
    assert(selection.length === 0, "Selection is not allowed for this catalog item.");
    return {
      productId: `${catalogItemId}::` as ProductKey,
      selection: [],
    };
  }

  const selections = selectionEntriesToRecord(selection);

  for (const dimension of schema.canonicalDimensionOrder
    .map((entry) => schema.dimensions.find((candidate) => candidate.dimensionId === entry.dimensionId))
    .filter((dimension): dimension is MarketplaceVersionDimension => dimension !== undefined)) {
    const active = isDimensionActive(dimension, selections);
    const selectedOptionId = selections[dimension.dimensionId];

    if (!active) {
      assert(selectedOptionId === undefined, "Selection cannot include inactive dimensions.");
      continue;
    }

    if (selectedOptionId === undefined) {
      assert(!dimension.required, `Selection must include ${dimension.dimensionName}.`);
      continue;
    }

    assert(
      dimension.allowedOptions.some((option) => option.optionId === selectedOptionId),
      `Selection must use an allowed option for ${dimension.dimensionName}.`,
    );
  }

  assert(
    selection.every((entry) => schema.dimensions.some((dimension) => dimension.dimensionId === entry.dimensionId)),
    "Selection cannot include unknown dimensions.",
  );

  return {
    productId: `${catalogItemId}::${schema.canonicalDimensionOrder
      .map((entry) => `${entry.dimensionId}:${selections[entry.dimensionId] ?? "-"}`)
      .join("|")}` as ProductKey,
    selection: schema.canonicalDimensionOrder
      .map((entry) => {
        const optionId = selections[entry.dimensionId];
        if (!optionId) {
          return null;
        }

        return {
          dimensionId: entry.dimensionId,
          optionId,
        };
      })
      .filter((entry): entry is MarketplaceVersionSelectedOptionEntry => entry !== null),
  };
}
import type { ProductKey } from "@chase-sets/primitives/catalog-identity";
