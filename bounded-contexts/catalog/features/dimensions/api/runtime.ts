import { createPassthroughDomainEventCodec } from "@chase-sets/event-core/codec";
import { createAggregateRepository } from "@chase-sets/event-core/aggregate-repository";
import {
  createCommandHandler,
  type CommandHandler,
} from "@chase-sets/event-core/command-handler";
import { createProjector, type Projector } from "@chase-sets/event-core/projector";
import type { CatalogRuntimeDeps } from "../../../support/authoring-support/runtime-support";
import { withCatalogAdminRealtimeInvalidation } from "../../../support/projection-support/realtime-invalidation";
import {
  createBulkLifecycleOperations,
  type BulkLifecycleOperations,
  type BulkSelection,
} from "../../../support/runtime-support/bulk-lifecycle";
import {
  type DimensionState,
  type DimensionCommand,
  type DimensionEvent,
  initialDimensionState,
  decideDimension,
  evolveDimension,
} from "../domain/domain";
import {
  getDimension,
  listDimensionBulkRows,
  listDimensionIds,
  listDimensions,
  type DimensionListParams,
} from "../read-model/queries";
import { buildDimensionProjectionHandlers } from "../read-model/projection";

export type DimensionServices = Readonly<{
  commandHandler: CommandHandler<DimensionCommand, DimensionState, DimensionEvent>;
  listDimensions: (
    params?: Parameters<typeof listDimensions>[1],
  ) => ReturnType<typeof listDimensions>;
  getDimension: (dimensionId: string) => ReturnType<typeof getDimension>;
  bulkLifecycle: BulkLifecycleOperations<DimensionListParams, DimensionCommand, DimensionState, DimensionEvent>;
  projectors: readonly Projector[];
}>;

export function createDimensionRuntime(
  deps: CatalogRuntimeDeps,
): DimensionServices {
  const commandHandler = createCommandHandler({
    repository: createAggregateRepository({
      eventStore: deps.eventStore,
      codec: createPassthroughDomainEventCodec<DimensionEvent>(),
      initialState: () => initialDimensionState,
      evolve: evolveDimension,
    }),
    evolve: evolveDimension,
    decide: decideDimension,
  });

  const projectors = [
    createProjector({
      projectorName: "catalog-dimension-projection",
      eventStore: deps.eventStore,
      checkpointStore: deps.checkpointStore,
      handlers: withCatalogAdminRealtimeInvalidation(
        buildDimensionProjectionHandlers(deps.db),
        deps.db,
        { projectionName: "catalog-dimension-projection", surface: "dimensions" },
      ),
    }),
  ];
  const bulkLifecycle = createBulkLifecycleOperations<DimensionListParams, DimensionCommand, DimensionState, DimensionEvent>({
    actions: [
      {
        action: "activate",
        readyStatus: "draft",
        command: { type: "ActivateDimension" },
        streamId: (id) => `catalog.dimension-${id}`,
        blockedReason: (status) => `Only draft Dimensions can be activated. Current status: ${status}.`,
      },
      {
        action: "deprecate",
        readyStatus: "active",
        command: { type: "DeprecateDimension" },
        streamId: (id) => `catalog.dimension-${id}`,
        blockedReason: (status) => `Only active Dimensions can be deprecated. Current status: ${status}.`,
      },
      {
        action: "archive",
        readyStatus: "deprecated",
        command: { type: "ArchiveDimension" },
        streamId: (id) => `catalog.dimension-${id}`,
        blockedReason: (status) => `Only deprecated Dimensions can be archived. Current status: ${status}.`,
      },
    ],
    commandHandler,
    resolveIds: (selection: BulkSelection<DimensionListParams>) =>
      selection.mode === "ids" ? Promise.resolve(selection.ids) : listDimensionIds(deps.db, selection.query),
    loadRows: (ids) => listDimensionBulkRows(deps.db, ids),
    projectors,
  });

  return {
    commandHandler,
    listDimensions: (params) => listDimensions(deps.db, params),
    getDimension: (dimensionId) => getDimension(deps.db, dimensionId),
    bulkLifecycle,
    projectors,
  };
}
