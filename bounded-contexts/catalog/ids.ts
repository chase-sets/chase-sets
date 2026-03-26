import type { TypedUlid } from "@chase-sets/primitives/typed-ids";

export type CatalogItemId = TypedUlid<"cat">;

export type DimensionId = TypedUlid<"dim">;

export type ChoiceId = TypedUlid<"chc">;

export type FieldId = TypedUlid<"fld">;

export type ComponentId = TypedUlid<"cmp">;

export type BlueprintId = TypedUlid<"bpr">;

export type CategoryId = TypedUlid<"ctg">;

export type SelectionEntry = Readonly<{
  dimensionId: DimensionId;
  choiceId: ChoiceId;
}>;

