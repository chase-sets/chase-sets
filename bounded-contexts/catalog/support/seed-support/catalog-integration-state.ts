import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { blueprintSeedRequirements } from "../../features/blueprints/api/seed";
import { evolveBlueprint, initialBlueprintState, type BlueprintEvent } from "../../features/blueprints/domain/domain";
import { categorySeedRequirements } from "../../features/categories/api/seed";
import { evolveCategory, initialCategoryState, type CategoryEvent } from "../../features/categories/domain/domain";
import { componentSeedRequirements } from "../../features/components/api/seed";
import { evolveComponent, initialComponentState, type ComponentEvent } from "../../features/components/domain/domain";
import { dimensionSeedRequirements } from "../../features/dimensions/api/seed";
import { evolveDimension, initialDimensionState, type DimensionEvent } from "../../features/dimensions/domain/domain";
import { fieldSeedRequirements } from "../../features/fields/api/seed";
import { evolveField, initialFieldState, type FieldEvent } from "../../features/fields/domain/domain";
import { referenceDataSeedRequirements } from "../../features/reference-data/api/seed";
import {
  evolveReferenceRecord,
  evolveReferenceType,
  initialReferenceRecordState,
  initialReferenceTypeState,
  type ReferenceRecordEvent,
  type ReferenceTypeEvent,
} from "../../features/reference-data/domain/domain";
import { loadSeedAggregateState } from "./aggregate-state";

export const catalogIntegrationSeedRequirements = [
  ...dimensionSeedRequirements,
  ...fieldSeedRequirements,
  ...referenceDataSeedRequirements,
  ...componentSeedRequirements,
  ...blueprintSeedRequirements,
  ...categorySeedRequirements,
] as const;

export type CatalogIntegrationSeedRequirement = (typeof catalogIntegrationSeedRequirements)[number];

export type CatalogIntegrationSeedAggregateState = Readonly<{
  aggregateName: CatalogIntegrationSeedRequirement["aggregateName"];
  id: string;
  key: string;
  streamId: string;
  kind: "absent" | "draft" | "active";
  status: "draft" | "active";
  eventCount: number;
}>;

export async function inspectCatalogIntegrationSeedState(
  db: PgQueryable,
): Promise<readonly CatalogIntegrationSeedAggregateState[]> {
  const states: CatalogIntegrationSeedAggregateState[] = [];
  for (const requirement of catalogIntegrationSeedRequirements) {
    const aggregate = await loadRequiredAggregate(db, requirement);
    states.push({
      aggregateName: requirement.aggregateName,
      id: requirement.id,
      key: requirement.key,
      streamId: requirement.streamId,
      kind: aggregate.kind,
      status: aggregate.kind === "active" ? "active" : "draft",
      eventCount: aggregate.events.length,
    });
  }
  return states;
}

export async function assertCatalogIntegrationSeedComplete(db: PgQueryable): Promise<void> {
  const states = await inspectCatalogIntegrationSeedState(db);
  const incomplete = states.filter((state) => state.kind !== "active");
  if (incomplete.length === 0) {
    return;
  }
  throw new Error(
    `Catalog integration bootstrap did not converge to present-and-active aggregate state: ${incomplete
      .map((state) => `${state.aggregateName} '${state.key}'=${state.kind}`)
      .join(", ")}.`,
  );
}

function loadRequiredAggregate(db: PgQueryable, requirement: CatalogIntegrationSeedRequirement) {
  switch (requirement.aggregateName) {
    case "Dimension":
      return loadSeedAggregateState<typeof initialDimensionState, DimensionEvent>({
        db,
        aggregateName: requirement.aggregateName,
        streamId: requirement.streamId,
        createdEventType: "catalog.dimension.created",
        createdIdField: "dimensionId",
        expectedId: requirement.id,
        expectedKey: requirement.key,
        initialState: initialDimensionState,
        evolve: evolveDimension,
      });
    case "Field":
      return loadSeedAggregateState<typeof initialFieldState, FieldEvent>({
        db,
        aggregateName: requirement.aggregateName,
        streamId: requirement.streamId,
        createdEventType: "catalog.field.created",
        createdIdField: "fieldId",
        expectedId: requirement.id,
        expectedKey: requirement.key,
        initialState: initialFieldState,
        evolve: evolveField,
      });
    case "Reference Type":
      return loadSeedAggregateState<typeof initialReferenceTypeState, ReferenceTypeEvent>({
        db,
        aggregateName: requirement.aggregateName,
        streamId: requirement.streamId,
        createdEventType: "catalog.reference-type.created",
        createdIdField: "referenceTypeId",
        expectedId: requirement.id,
        expectedKey: requirement.key,
        initialState: initialReferenceTypeState,
        evolve: evolveReferenceType,
      });
    case "Reference Record":
      return loadSeedAggregateState<typeof initialReferenceRecordState, ReferenceRecordEvent>({
        db,
        aggregateName: requirement.aggregateName,
        streamId: requirement.streamId,
        createdEventType: "catalog.reference-record.created",
        createdIdField: "referenceRecordId",
        expectedId: requirement.id,
        expectedKey: requirement.key,
        keyScope: { field: "typeKey", value: requirement.typeKey },
        initialState: initialReferenceRecordState,
        evolve: evolveReferenceRecord,
        validateIdentity: (state) => {
          if (state.typeKey !== requirement.typeKey) {
            throw new Error(
              `Catalog integration bootstrap Reference Record '${requirement.key}' expected type key '${requirement.typeKey}', but found '${state.typeKey ?? "null"}'.`,
            );
          }
        },
      });
    case "Component":
      return loadSeedAggregateState<typeof initialComponentState, ComponentEvent>({
        db,
        aggregateName: requirement.aggregateName,
        streamId: requirement.streamId,
        createdEventType: "catalog.component.created",
        createdIdField: "componentId",
        expectedId: requirement.id,
        expectedKey: requirement.key,
        initialState: initialComponentState,
        evolve: evolveComponent,
      });
    case "Blueprint":
      return loadSeedAggregateState<typeof initialBlueprintState, BlueprintEvent>({
        db,
        aggregateName: requirement.aggregateName,
        streamId: requirement.streamId,
        createdEventType: "catalog.blueprint.created",
        createdIdField: "blueprintId",
        expectedId: requirement.id,
        expectedKey: requirement.key,
        initialState: initialBlueprintState,
        evolve: evolveBlueprint,
      });
    case "Category":
      return loadSeedAggregateState<typeof initialCategoryState, CategoryEvent>({
        db,
        aggregateName: requirement.aggregateName,
        streamId: requirement.streamId,
        createdEventType: "catalog.category.created",
        createdIdField: "categoryId",
        expectedId: requirement.id,
        expectedKey: requirement.key,
        initialState: initialCategoryState,
        evolve: evolveCategory,
      });
  }
}
