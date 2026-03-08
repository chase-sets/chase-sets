import { createPassthroughDomainEventCodec } from "../../../../contracts/event-core/codec";
import { createAggregateRepository } from "../../../../contracts/event-core/aggregate-repository";
import { createCommandHandler, type CommandHandler } from "../../../../contracts/event-core/command-handler";
import { createPostgresEventStore } from "../../../../contracts/event-core/postgres/event-store";
import { createPostgresProjectionStore } from "../../../../contracts/event-core/postgres/projection-store";
import { createProjector, type Projector } from "../../../../contracts/event-core/projector";
import type { PgTransactionalPool, PgQueryable } from "../../../../contracts/event-core/postgres/types";
import {
  type DimensionState,
  type DimensionCommand,
  type DimensionEvent,
  initialDimensionState,
  decideDimension,
  evolveDimension,
  type FieldState,
  type FieldCommand,
  type FieldEvent,
  initialFieldState,
  decideField,
  evolveField,
  type ComponentState,
  type ComponentCommand,
  type ComponentEvent,
  initialComponentState,
  decideComponent,
  evolveComponent,
  type BlueprintState,
  type BlueprintCommand,
  type BlueprintEvent,
  initialBlueprintState,
  decideBlueprint,
  evolveBlueprint,
  type CategoryState,
  type CategoryCommand,
  type CategoryEvent,
  initialCategoryState,
  decideCategory,
  evolveCategory,
  type CatalogItemState,
  type CatalogItemCommand,
  type CatalogItemEvent,
  initialCatalogItemState,
  decideCatalogItem,
  evolveCatalogItem,
} from "../..";
import { buildDimensionProjectionHandlers } from "./projections/dimension-projection";
import { buildFieldProjectionHandlers } from "./projections/field-projection";
import { buildComponentProjectionHandlers } from "./projections/component-projection";
import { buildBlueprintProjectionHandlers } from "./projections/blueprint-projection";
import { buildCategoryProjectionHandlers } from "./projections/category-projection";
import { buildCatalogItemProjectionHandlers } from "./projections/catalog-item-projection";
import { buildAdminPageProjectionHandlers } from "./projections/admin-page-projection";

export type CatalogServices = Readonly<{
  dimensionHandler: CommandHandler<DimensionCommand, DimensionState, DimensionEvent>;
  fieldHandler: CommandHandler<FieldCommand, FieldState, FieldEvent>;
  componentHandler: CommandHandler<ComponentCommand, ComponentState, ComponentEvent>;
  blueprintHandler: CommandHandler<BlueprintCommand, BlueprintState, BlueprintEvent>;
  categoryHandler: CommandHandler<CategoryCommand, CategoryState, CategoryEvent>;
  catalogItemHandler: CommandHandler<CatalogItemCommand, CatalogItemState, CatalogItemEvent>;
  projectors: readonly Projector[];
  pool: PgTransactionalPool;
  db: PgQueryable;
}>;

export function createCatalogServices(pool: PgTransactionalPool): CatalogServices {
  const eventStore = createPostgresEventStore({ pool });
  const checkpointStore = createPostgresProjectionStore({ db: pool });
  const db = pool as PgQueryable;

  const dimensionHandler = createCommandHandler({
    repository: createAggregateRepository({
      eventStore,
      codec: createPassthroughDomainEventCodec<DimensionEvent>(),
      initialState: () => initialDimensionState,
      evolve: evolveDimension,
    }),
    evolve: evolveDimension,
    decide: decideDimension,
  });

  const fieldHandler = createCommandHandler({
    repository: createAggregateRepository({
      eventStore,
      codec: createPassthroughDomainEventCodec<FieldEvent>(),
      initialState: () => initialFieldState,
      evolve: evolveField,
    }),
    evolve: evolveField,
    decide: decideField,
  });

  const componentHandler = createCommandHandler({
    repository: createAggregateRepository({
      eventStore,
      codec: createPassthroughDomainEventCodec<ComponentEvent>(),
      initialState: () => initialComponentState,
      evolve: evolveComponent,
    }),
    evolve: evolveComponent,
    decide: decideComponent,
  });

  const blueprintHandler = createCommandHandler({
    repository: createAggregateRepository({
      eventStore,
      codec: createPassthroughDomainEventCodec<BlueprintEvent>(),
      initialState: () => initialBlueprintState,
      evolve: evolveBlueprint,
    }),
    evolve: evolveBlueprint,
    decide: decideBlueprint,
  });

  const categoryHandler = createCommandHandler({
    repository: createAggregateRepository({
      eventStore,
      codec: createPassthroughDomainEventCodec<CategoryEvent>(),
      initialState: () => initialCategoryState,
      evolve: evolveCategory,
    }),
    evolve: evolveCategory,
    decide: decideCategory,
  });

  const catalogItemHandler = createCommandHandler({
    repository: createAggregateRepository({
      eventStore,
      codec: createPassthroughDomainEventCodec<CatalogItemEvent>(),
      initialState: () => initialCatalogItemState,
      evolve: evolveCatalogItem,
    }),
    evolve: evolveCatalogItem,
    decide: decideCatalogItem,
  });

  const projectors: Projector[] = [
    createProjector({
      projectorName: "catalog-dimension-projection",
      eventStore,
      checkpointStore,
      handlers: buildDimensionProjectionHandlers(db),
    }),
    createProjector({
      projectorName: "catalog-field-projection",
      eventStore,
      checkpointStore,
      handlers: buildFieldProjectionHandlers(db),
    }),
    createProjector({
      projectorName: "catalog-component-projection",
      eventStore,
      checkpointStore,
      handlers: buildComponentProjectionHandlers(db),
    }),
    createProjector({
      projectorName: "catalog-blueprint-projection",
      eventStore,
      checkpointStore,
      handlers: buildBlueprintProjectionHandlers(db),
    }),
    createProjector({
      projectorName: "catalog-category-projection",
      eventStore,
      checkpointStore,
      handlers: buildCategoryProjectionHandlers(db),
    }),
    createProjector({
      projectorName: "catalog-item-projection",
      eventStore,
      checkpointStore,
      handlers: buildCatalogItemProjectionHandlers(db),
    }),
    createProjector({
      projectorName: "catalog-admin-page-projection",
      eventStore,
      checkpointStore,
      handlers: buildAdminPageProjectionHandlers(db),
    }),
  ];

  return {
    dimensionHandler,
    fieldHandler,
    componentHandler,
    blueprintHandler,
    categoryHandler,
    catalogItemHandler,
    projectors,
    pool,
    db,
  };
}
