import type { TypedUlid } from "@chase-sets/primitives/typed-ids";

export type CartLineId = TypedUlid<"cli">;
export type OrderLineId = TypedUlid<"oli">;

export type ShippingOption = "standard" | "expedited" | "priority";
export type OrderStatus =
  | "pending-reservation"
  | "pending-payment"
  | "ready-for-fulfillment"
  | "cancelled";
export type OrderSourceType = "cart-checkout" | "offer-acceptance" | "buy-now";

export type VersionSelectedOptionEntry = Readonly<{
  dimensionId: string;
  optionId: string;
}>;

export type OrderingVersionApplicabilityClause = Readonly<{
  dimensionId: string;
  optionIds: string[];
}>;

export type OrderingVersionChoice = Readonly<{
  optionId: string;
  code: string;
  labels?: Array<{ locale: string; value: string }>;
}>;

export type OrderingVersionDimension = Readonly<{
  dimensionId: string;
  dimensionName: string;
  required: boolean;
  appliesWhen: OrderingVersionApplicabilityClause[];
  allowedOptions: OrderingVersionChoice[];
}>;

export type OrderingVersionSchema = Readonly<{
  canonicalDimensionOrder: Array<{ dimensionId: string; dimensionName: string }>;
  dimensions: OrderingVersionDimension[];
}>;

export type OrderingProductDescriptor = Readonly<{
  productId: string;
  selection: VersionSelectedOptionEntry[];
}>;

export class OrderingDomainError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "OrderingDomainError";
  }
}

export function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new OrderingDomainError(message);
  }
}

export function assertNever(value: never): never {
  throw new OrderingDomainError(`Unhandled variant: ${JSON.stringify(value)}`);
}

export function ensurePositiveInteger(value: number, message: string) {
  assert(Number.isInteger(value) && value > 0, message);
  return value;
}

export function normalizeRequiredText(value: string, message: string): string {
  const normalized = value.trim();
  assert(normalized.length > 0, message);
  return normalized;
}

export function normalizeOptionalText(value?: string | null): string | null {
  const normalized = value?.trim() ?? "";
  return normalized.length > 0 ? normalized : null;
}

export function normalizeMoneyAmount(
  value: string,
  options: Readonly<{ allowZero?: boolean; fieldName?: string }> = {},
) {
  const normalized = value.trim();
  const fieldName = options.fieldName ?? "Amount";

  assert(
    /^\d+(\.\d{1,2})?$/.test(normalized),
    `${fieldName} must be a valid decimal.`,
  );

  const numeric = Number.parseFloat(normalized);
  assert(
    options.allowZero ? numeric >= 0 : numeric > 0,
    `${fieldName} must be ${options.allowZero ? "zero or greater" : "greater than zero"}.`,
  );

  return numeric.toFixed(2);
}

export function moneyToNumber(value: string) {
  return Number.parseFloat(normalizeMoneyAmount(value, { allowZero: true }));
}

export function numberToMoneyAmount(value: number) {
  assert(Number.isFinite(value) && value >= 0, "Monetary values cannot be negative.");
  return value.toFixed(2);
}

export function normalizeVersionSelection(
  value: readonly VersionSelectedOptionEntry[],
): VersionSelectedOptionEntry[] {
  const normalized = value
    .map((entry) => ({
      dimensionId: normalizeRequiredText(
        entry.dimensionId,
        "Selected options must include a dimension.",
      ),
      optionId: normalizeRequiredText(
        entry.optionId,
        "Selected options must include an option.",
      ),
    }))
    .sort((left, right) =>
      left.dimensionId.localeCompare(right.dimensionId) ||
      left.optionId.localeCompare(right.optionId),
    );

  const seen = new Set<string>();
  for (const entry of normalized) {
    assert(
      !seen.has(entry.dimensionId),
      "Selected options cannot include duplicate dimensions.",
    );
    seen.add(entry.dimensionId);
  }

  return normalized;
}

export function buildDemandSignature(productId: string) {
  return normalizeRequiredText(
    String(productId),
    "Product id is required.",
  );
}

function selectionEntriesToRecord(
  selection: readonly VersionSelectedOptionEntry[],
): Record<string, string> {
  return Object.fromEntries(
    selection.map((entry) => [entry.dimensionId, entry.optionId]),
  );
}

function isDimensionActive(
  dimension: OrderingVersionDimension,
  selections: Record<string, string>,
) {
  return dimension.appliesWhen.every((clause) => {
    const selectedOptionId = selections[clause.dimensionId];
    return (
      selectedOptionId !== undefined &&
      clause.optionIds.includes(selectedOptionId)
    );
  });
}

export function createOrderingProductDescriptor(input: Readonly<{
  catalogItemId: string;
  productSchema: OrderingVersionSchema | null;
  selection: readonly VersionSelectedOptionEntry[];
}>): OrderingProductDescriptor {
  const catalogItemId = normalizeRequiredText(
    input.catalogItemId,
    "Catalog item id is required.",
  );
  const selection = normalizeVersionSelection(input.selection);
  const schema = input.productSchema;

  if (!schema || schema.dimensions.length === 0) {
    assert(
      selection.length === 0,
      "Selection is not allowed for this catalog item.",
    );
    return {
      productId: `${catalogItemId}::`,
      selection: [],
    };
  }

  const selections = selectionEntriesToRecord(selection);

  for (const dimension of schema.canonicalDimensionOrder
    .map((entry) =>
      schema.dimensions.find((candidate) => candidate.dimensionId === entry.dimensionId),
    )
    .filter(
      (dimension): dimension is OrderingVersionDimension => dimension !== undefined,
    )) {
    const active = isDimensionActive(dimension, selections);
    const selectedOptionId = selections[dimension.dimensionId];

    if (!active) {
      assert(
        selectedOptionId === undefined,
        "Selection cannot include inactive dimensions.",
      );
      continue;
    }

    if (selectedOptionId === undefined) {
      assert(
        !dimension.required,
        `Selection must include ${dimension.dimensionName}.`,
      );
      continue;
    }

    assert(
      dimension.allowedOptions.some((option) => option.optionId === selectedOptionId),
      `Selection must use an allowed option for ${dimension.dimensionName}.`,
    );
  }

  assert(
    selection.every((entry) =>
      schema.dimensions.some((dimension) => dimension.dimensionId === entry.dimensionId),
    ),
    "Selection cannot include unknown dimensions.",
  );

  return {
    productId: `${catalogItemId}::${schema.canonicalDimensionOrder
      .map((entry) => `${entry.dimensionId}:${selections[entry.dimensionId] ?? "-"}`)
      .join("|")}`,
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
      .filter((entry): entry is VersionSelectedOptionEntry => entry !== null),
  };
}

export function normalizeShippingOption(value: string): ShippingOption {
  switch (value.trim()) {
    case "standard":
      return "standard";
    case "expedited":
      return "expedited";
    case "priority":
      return "priority";
    default:
      throw new OrderingDomainError("Shipping option is not supported.");
  }
}
