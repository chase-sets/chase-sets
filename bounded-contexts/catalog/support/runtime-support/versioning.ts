import { assert } from "./common";
import type { Branded } from "@chase-sets/primitives/brand";
import type {
  CatalogItemId,
  ChoiceId,
  DimensionId,
  SelectionEntry,
} from "../../ids";

export type CatalogVersionKey = Branded<string, "CatalogVersionKey">;

export type CatalogSelectionEntry = Readonly<{
  dimensionId: string;
  choiceId: string;
}>;

export type CatalogVersionDescriptor = Readonly<{
  versionKey: CatalogVersionKey;
  selection: CatalogSelectionEntry[];
}>;

export type CatalogVersionApplicabilityClause = Readonly<{
  dimensionId: string;
  choiceIds: string[];
}>;

export type CatalogVersionDimension = Readonly<{
  dimensionId: string;
  required: boolean;
  allowedChoiceIds: string[];
  appliesWhen: CatalogVersionApplicabilityClause[];
}>;

export type CatalogVersionSchema = Readonly<{
  canonicalDimensionOrder: string[];
  dimensions: CatalogVersionDimension[];
}>;

export type CatalogVersionDimensionRule = Readonly<{
  dimensionId: DimensionId;
  required: boolean;
  allowedChoiceIds: readonly ChoiceId[];
  appliesWhen?: readonly CatalogVersionDimensionApplicabilityClause[];
}>;

export type CatalogVersionDimensionApplicabilityClause = Readonly<{
  dimensionId: DimensionId;
  choiceIds: readonly ChoiceId[];
}>;

export type VersionableBlueprint = Readonly<{
  dimensionRules: readonly CatalogVersionDimensionRule[];
  canonicalDimensionOrder: DimensionId[];
}>;

export type VersionResolutionInput = Readonly<{
  itemId: CatalogItemId;
  blueprint: VersionableBlueprint;
  selection: readonly SelectionEntry[];
}>;

export function resolveCatalogVersion(
  input: VersionResolutionInput,
): CatalogVersionDescriptor {
  assert(
    hasExactDimensionSet(
      input.blueprint.dimensionRules.map((rule) => rule.dimensionId),
      input.blueprint.canonicalDimensionOrder,
    ),
    "Version resolution requires a canonical order for every blueprint dimension.",
  );

  const selection = normalizeSelection(input.selection);
  const selectionByDimension = new Map<DimensionId, ChoiceId>(
    selection.map((entry) => [entry.dimensionId, entry.choiceId]),
  );

  for (const dimensionRule of input.blueprint.dimensionRules) {
    const isActive = isDimensionRuleActive(dimensionRule, selectionByDimension);
    const selectedChoiceId = selectionByDimension.get(dimensionRule.dimensionId);

    if (!isActive) {
      assert(
        selectedChoiceId === undefined,
        "Selections cannot include inactive dimensions.",
      );
      continue;
    }

    if (selectedChoiceId === undefined) {
      assert(
        !dimensionRule.required,
        "Selections must include every required dimension.",
      );
      continue;
    }

    if (dimensionRule.allowedChoiceIds.length > 0) {
      assert(
        dimensionRule.allowedChoiceIds.includes(selectedChoiceId),
        "Selections must use only choices allowed by the blueprint.",
      );
    }
  }

  assert(
    selection.every((entry) =>
      input.blueprint.dimensionRules.some(
        (rule) => rule.dimensionId === entry.dimensionId,
      ),
    ),
    "Selections cannot include dimensions not defined by the blueprint.",
  );

  const orderedSelection = input.blueprint.canonicalDimensionOrder
    .map((dimensionId) => {
      const choiceId = selectionByDimension.get(dimensionId);

      if (choiceId === undefined) {
        return null;
      }

      return {
        dimensionId,
        choiceId,
      };
    })
    .filter((entry): entry is SelectionEntry => entry !== null);

  return {
    versionKey: createCatalogVersionKey(
      `${input.itemId}::${input.blueprint.canonicalDimensionOrder
        .map((dimensionId) => {
          const choiceId = selectionByDimension.get(dimensionId);

          return `${dimensionId}:${choiceId ?? "-"}`;
        })
        .join("|")}`,
    ),
    selection: orderedSelection.map(toCatalogSelectionEntry),
  };
}

export function toCatalogVersionSchema(
  blueprint: VersionableBlueprint,
): CatalogVersionSchema {
  return {
    canonicalDimensionOrder: blueprint.canonicalDimensionOrder.map((dimensionId) =>
      String(dimensionId),
    ),
    dimensions: blueprint.dimensionRules.map((rule) => ({
      dimensionId: String(rule.dimensionId),
      required: rule.required,
      allowedChoiceIds: rule.allowedChoiceIds.map((choiceId) => String(choiceId)),
      appliesWhen: (rule.appliesWhen ?? []).map((clause) => ({
        dimensionId: String(clause.dimensionId),
        choiceIds: clause.choiceIds.map((choiceId) => String(choiceId)),
      })),
    })),
  };
}

export function normalizeSelection(
  selection: readonly SelectionEntry[],
): SelectionEntry[] {
  const seenDimensionIds = new Set<string>();

  for (const entry of selection) {
    assert(
      !seenDimensionIds.has(entry.dimensionId),
      "Selections may include at most one choice per dimension.",
    );
    seenDimensionIds.add(entry.dimensionId);
  }

  return [...selection];
}

export function toCatalogSelectionEntry(
  selectionEntry: SelectionEntry,
): CatalogSelectionEntry {
  return {
    dimensionId: String(selectionEntry.dimensionId),
    choiceId: String(selectionEntry.choiceId),
  };
}

export function createCatalogVersionKey(value: string): CatalogVersionKey {
  return value as CatalogVersionKey;
}

function hasExactDimensionSet(
  left: readonly DimensionId[],
  right: readonly DimensionId[],
): boolean {
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
  rule: CatalogVersionDimensionRule,
  selectionByDimension: ReadonlyMap<DimensionId, ChoiceId>,
): boolean {
  return (rule.appliesWhen ?? []).every((clause) => {
    const selectedChoiceId = selectionByDimension.get(clause.dimensionId);
    return (
      selectedChoiceId !== undefined &&
      clause.choiceIds.includes(selectedChoiceId)
    );
  });
}

