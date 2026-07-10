import { assert } from "./common";
import type { ProductKey } from "@chase-sets/primitives/catalog-identity";
import type { CatalogItemId, OptionId, DimensionId, SelectedOptionEntry as TypedSelectedOptionEntry } from "../../ids";

export type ProductSelectionEntry = Readonly<{
  dimensionId: string;
  optionId: string;
}>;

export type ProductDescriptor = Readonly<{
  productId: ProductKey;
  selectedOptions: ProductSelectionEntry[];
}>;

export type ProductApplicabilityClause = Readonly<{
  dimensionId: string;
  optionIds: string[];
}>;

export type ProductDimension = Readonly<{
  dimensionId: string;
  required: boolean;
  allowedOptionIds: string[];
  appliesWhen: ProductApplicabilityClause[];
}>;

export type ProductSchema = Readonly<{
  canonicalDimensionOrder: string[];
  dimensions: ProductDimension[];
}>;

export type ProductDimensionRule = Readonly<{
  dimensionId: DimensionId;
  required: boolean;
  allowedOptionIds: readonly OptionId[];
  appliesWhen?: readonly ProductDimensionApplicabilityClause[];
}>;

export type ProductDimensionApplicabilityClause = Readonly<{
  dimensionId: DimensionId;
  optionIds: readonly OptionId[];
}>;

export type ProductDefiningBlueprint = Readonly<{
  dimensionRules: readonly ProductDimensionRule[];
  canonicalDimensionOrder: DimensionId[];
}>;

export type ProductResolutionInput = Readonly<{
  catalogItemId: CatalogItemId;
  blueprint: ProductDefiningBlueprint;
  selectedOptions: readonly TypedSelectedOptionEntry[];
}>;

export function resolveProduct(input: ProductResolutionInput): ProductDescriptor {
  assert(
    hasExactDimensionSet(
      input.blueprint.dimensionRules.map((rule) => rule.dimensionId),
      input.blueprint.canonicalDimensionOrder,
    ),
    "Product resolution requires a canonical order for every blueprint dimension.",
  );

  const selection = normalizeSelectedOptions(input.selectedOptions);
  const selectionByDimension = new Map<DimensionId, OptionId>(
    selection.map((entry) => [entry.dimensionId, entry.optionId]),
  );

  for (const dimensionRule of input.blueprint.dimensionRules) {
    const isActive = isDimensionRuleActive(dimensionRule, selectionByDimension);
    const selectedOptionId = selectionByDimension.get(dimensionRule.dimensionId);

    if (!isActive) {
      assert(selectedOptionId === undefined, "Selections cannot include inactive dimensions.");
      continue;
    }

    if (selectedOptionId === undefined) {
      assert(!dimensionRule.required, "Selections must include every required dimension.");
      continue;
    }

    if (dimensionRule.allowedOptionIds.length > 0) {
      assert(
        dimensionRule.allowedOptionIds.includes(selectedOptionId),
        "Selections must use only options allowed by the blueprint.",
      );
    }
  }

  assert(
    selection.every((entry) => input.blueprint.dimensionRules.some((rule) => rule.dimensionId === entry.dimensionId)),
    "Selections cannot include dimensions not defined by the blueprint.",
  );

  const orderedSelection = input.blueprint.canonicalDimensionOrder
    .map((dimensionId) => {
      const optionId = selectionByDimension.get(dimensionId);

      if (optionId === undefined) {
        return null;
      }

      return {
        dimensionId,
        optionId,
      };
    })
    .filter((entry): entry is TypedSelectedOptionEntry => entry !== null);

  return {
    productId: createProductKey(
      `${input.catalogItemId}::${input.blueprint.canonicalDimensionOrder
        .map((dimensionId) => {
          const optionId = selectionByDimension.get(dimensionId);

          return `${dimensionId}:${optionId ?? "-"}`;
        })
        .join("|")}`,
    ),
    selectedOptions: orderedSelection.map(toProductSelectionEntry),
  };
}

export function toProductSchema(blueprint: ProductDefiningBlueprint): ProductSchema {
  return {
    canonicalDimensionOrder: blueprint.canonicalDimensionOrder.map((dimensionId) => String(dimensionId)),
    dimensions: blueprint.dimensionRules.map((rule) => ({
      dimensionId: String(rule.dimensionId),
      required: rule.required,
      allowedOptionIds: rule.allowedOptionIds.map((optionId) => String(optionId)),
      appliesWhen: (rule.appliesWhen ?? []).map((clause) => ({
        dimensionId: String(clause.dimensionId),
        optionIds: clause.optionIds.map((optionId) => String(optionId)),
      })),
    })),
  };
}

export function normalizeSelectedOptions(selection: readonly TypedSelectedOptionEntry[]): TypedSelectedOptionEntry[] {
  const seenDimensionIds = new Set<string>();

  for (const entry of selection) {
    assert(!seenDimensionIds.has(entry.dimensionId), "Selections may include at most one option per dimension.");
    seenDimensionIds.add(entry.dimensionId);
  }

  return [...selection];
}

export function toProductSelectionEntry(selectionEntry: TypedSelectedOptionEntry): ProductSelectionEntry {
  return {
    dimensionId: String(selectionEntry.dimensionId),
    optionId: String(selectionEntry.optionId),
  };
}

export function createProductKey(value: string): ProductKey {
  return value as ProductKey;
}

function hasExactDimensionSet(left: readonly DimensionId[], right: readonly DimensionId[]): boolean {
  if (left.length !== right.length) {
    return false;
  }

  const remaining = new Set<string>(left);

  for (const value of right) {
    if (!remaining.has(value)) {
      return false;
    }

    remaining.delete(value);
  }

  return remaining.size === 0;
}

function isDimensionRuleActive(
  rule: ProductDimensionRule,
  selectionByDimension: ReadonlyMap<DimensionId, OptionId>,
): boolean {
  return (rule.appliesWhen ?? []).every((clause) => {
    const selectedOptionId = selectionByDimension.get(clause.dimensionId);
    return selectedOptionId !== undefined && clause.optionIds.includes(selectedOptionId);
  });
}
