import { createPassthroughDomainEventCodec } from "@chase-sets/event-core/codec";
import { createAggregateRepository } from "@chase-sets/event-core/aggregate-repository";
import {
  createCommandHandler,
  type CommandHandler,
} from "@chase-sets/event-core/command-handler";
import { createProjector, type Projector } from "@chase-sets/event-core/projector";
import type { CatalogRuntimeDeps } from "../../../support/authoring-support/runtime-support";
import {
  createBulkLifecycleOperations,
  type BulkLifecycleOperations,
  type BulkSelection,
} from "../../../support/runtime-support/bulk-lifecycle";
import {
  type ComponentState,
  type ComponentCommand,
  type ComponentEvent,
  initialComponentState,
  decideComponent,
  evolveComponent,
} from "../domain/domain";
import {
  getComponentDetail,
  listComponentBulkRows,
  listComponentIds,
  listComponents,
  type ComponentListParams,
} from "../read-model/queries";
import { buildCatalogAdminComponentProjectionHandlers } from "../read-model/admin-projection";
import { buildComponentProjectionHandlers } from "../read-model/projection";

export type ComponentServices = Readonly<{
  commandHandler: CommandHandler<ComponentCommand, ComponentState, ComponentEvent>;
  listComponents: (
    params?: Parameters<typeof listComponents>[1],
  ) => ReturnType<typeof listComponents>;
  getComponentDetail: (
    componentId: string,
  ) => ReturnType<typeof getComponentDetail>;
  bulkLifecycle: BulkLifecycleOperations<ComponentListParams, ComponentCommand, ComponentState, ComponentEvent>;
  projectors: readonly Projector[];
}>;

export function createComponentRuntime(
  deps: CatalogRuntimeDeps,
): ComponentServices {
  const commandHandler = createCommandHandler({
    repository: createAggregateRepository({
      eventStore: deps.eventStore,
      codec: createPassthroughDomainEventCodec<ComponentEvent>(),
      initialState: () => initialComponentState,
      evolve: evolveComponent,
    }),
    evolve: evolveComponent,
    decide: decideComponent,
  });

  const projectors = [
    createProjector({
      projectorName: "catalog-component-projection",
      eventStore: deps.eventStore,
      checkpointStore: deps.checkpointStore,
      handlers: buildComponentProjectionHandlers(deps.db),
    }),
    createProjector({
      projectorName: "catalog-admin-component-detail-projection",
      eventStore: deps.eventStore,
      checkpointStore: deps.checkpointStore,
      handlers: buildCatalogAdminComponentProjectionHandlers(deps.db),
    }),
  ];
  const bulkLifecycle = createBulkLifecycleOperations<ComponentListParams, ComponentCommand, ComponentState, ComponentEvent>({
    actions: [
      {
        action: "activate",
        readyStatus: "draft",
        command: { type: "ActivateComponent" },
        streamId: (id) => `catalog.component-${id}`,
        blockedReason: (status) => `Only draft Components can be activated. Current status: ${status}.`,
      },
      {
        action: "deprecate",
        readyStatus: "active",
        command: { type: "DeprecateComponent" },
        streamId: (id) => `catalog.component-${id}`,
        blockedReason: (status) => `Only active Components can be deprecated. Current status: ${status}.`,
      },
      {
        action: "archive",
        readyStatus: "deprecated",
        command: { type: "ArchiveComponent" },
        streamId: (id) => `catalog.component-${id}`,
        blockedReason: (status) => `Only deprecated Components can be archived. Current status: ${status}.`,
      },
    ],
    commandHandler,
    resolveIds: (selection: BulkSelection<ComponentListParams>) =>
      selection.mode === "ids" ? Promise.resolve(selection.ids) : listComponentIds(deps.db, selection.query),
    loadRows: (ids) => listComponentBulkRows(deps.db, ids),
    projectors,
  });

  return {
    commandHandler,
    listComponents: (params) => listComponents(deps.db, params),
    getComponentDetail: (componentId) => getComponentDetail(deps.db, componentId),
    bulkLifecycle,
    projectors,
  };
}
