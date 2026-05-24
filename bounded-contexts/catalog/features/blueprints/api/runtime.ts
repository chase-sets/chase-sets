import { createPassthroughDomainEventCodec } from "@chase-sets/event-core/codec";
import { createAggregateRepository } from "@chase-sets/event-core/aggregate-repository";
import { createCommandHandler, type CommandHandler } from "@chase-sets/event-core/command-handler";
import { createProjector, type Projector } from "@chase-sets/event-core/projector";
import type { CatalogRuntimeDeps } from "../../../support/authoring-support/runtime-support";
import { withCatalogAdminRealtimeInvalidation } from "../../../support/projection-support/realtime-invalidation";
import {
  createBulkLifecycleOperations,
  type BulkLifecycleOperations,
  type BulkSelection,
} from "../../../support/runtime-support/bulk-lifecycle";
import {
  type BlueprintState,
  type BlueprintCommand,
  type BlueprintEvent,
  initialBlueprintState,
  decideBlueprint,
  evolveBlueprint,
} from "../domain/domain";
import {
  getBlueprintDetail,
  listBlueprintBulkRows,
  listBlueprintIds,
  listBlueprints,
  type BlueprintListParams,
} from "../read-model/queries";
import { buildCatalogAdminBlueprintProjectionHandlers } from "../read-model/admin-projection";
import { buildBlueprintProjectionHandlers } from "../read-model/projection";

export type BlueprintServices = Readonly<{
  commandHandler: CommandHandler<BlueprintCommand, BlueprintState, BlueprintEvent>;
  listBlueprints: (params?: Parameters<typeof listBlueprints>[1]) => ReturnType<typeof listBlueprints>;
  getBlueprintDetail: (blueprintId: string) => ReturnType<typeof getBlueprintDetail>;
  bulkLifecycle: BulkLifecycleOperations<BlueprintListParams, BlueprintCommand, BlueprintState, BlueprintEvent>;
  projectors: readonly Projector[];
}>;

export function createBlueprintRuntime(deps: CatalogRuntimeDeps): BlueprintServices {
  const commandHandler = createCommandHandler({
    repository: createAggregateRepository({
      eventStore: deps.eventStore,
      codec: createPassthroughDomainEventCodec<BlueprintEvent>(),
      initialState: () => initialBlueprintState,
      evolve: evolveBlueprint,
    }),
    evolve: evolveBlueprint,
    decide: decideBlueprint,
  });

  const projectors = [
    createProjector({
      projectorName: "catalog-blueprint-projection",
      eventStore: deps.eventStore,
      checkpointStore: deps.checkpointStore,
      handlers: withCatalogAdminRealtimeInvalidation(buildBlueprintProjectionHandlers(deps.db), deps.db, {
        projectionName: "catalog-blueprint-projection",
        surface: "blueprints",
      }),
    }),
    createProjector({
      projectorName: "catalog-admin-blueprint-detail-projection",
      eventStore: deps.eventStore,
      checkpointStore: deps.checkpointStore,
      handlers: buildCatalogAdminBlueprintProjectionHandlers(deps.db),
    }),
  ];
  const bulkLifecycle = createBulkLifecycleOperations<
    BlueprintListParams,
    BlueprintCommand,
    BlueprintState,
    BlueprintEvent
  >({
    actions: [
      {
        action: "publish",
        readyStatus: "draft",
        command: { type: "PublishBlueprint" },
        streamId: (id) => `catalog.blueprint-${id}`,
        blockedReason: (status) => `Only draft Blueprints can be published. Current status: ${status}.`,
      },
      {
        action: "deprecate",
        readyStatus: "active",
        command: { type: "DeprecateBlueprint" },
        streamId: (id) => `catalog.blueprint-${id}`,
        blockedReason: (status) => `Only active Blueprints can be deprecated. Current status: ${status}.`,
      },
      {
        action: "archive",
        readyStatus: "deprecated",
        command: { type: "ArchiveBlueprint" },
        streamId: (id) => `catalog.blueprint-${id}`,
        blockedReason: (status) => `Only deprecated Blueprints can be archived. Current status: ${status}.`,
      },
    ],
    commandHandler,
    resolveIds: (selection: BulkSelection<BlueprintListParams>) =>
      selection.mode === "ids" ? Promise.resolve(selection.ids) : listBlueprintIds(deps.db, selection.query),
    loadRows: (ids) => listBlueprintBulkRows(deps.db, ids),
  });

  return {
    commandHandler,
    listBlueprints: (params) => listBlueprints(deps.db, params),
    getBlueprintDetail: (blueprintId) => getBlueprintDetail(deps.db, blueprintId),
    bulkLifecycle,
    projectors,
  };
}
