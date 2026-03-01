import type { Branded } from "../../contracts/primitives/brand";
import type { TypedUlid } from "../../contracts/primitives/typed-ids";

export type CatalogItemId = TypedUlid<"cat">;

export type DimensionId = Branded<string, "DimensionId">;

export type ChoiceId = Branded<string, "ChoiceId">;

export type FieldId = Branded<string, "FieldId">;

export type ComponentId = Branded<string, "ComponentId">;

export type BlueprintId = Branded<string, "BlueprintId">;

export type CategoryId = Branded<string, "CategoryId">;

export type SelectionEntry = Readonly<{
  dimensionId: DimensionId;
  choiceId: ChoiceId;
}>;
