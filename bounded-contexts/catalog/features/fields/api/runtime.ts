import { createPassthroughDomainEventCodec } from "@chase-sets/event-core/codec";
import { createAggregateCommandHandler } from "@chase-sets/event-core/aggregate-command-handler";
import type { CommandHandler } from "@chase-sets/event-core/command-handler";
import { createProjectionHandlerSet, type ProjectionHandlerSet } from "@chase-sets/event-core/projector";
import type { CatalogRuntimeDeps } from "../../../support/authoring-support/runtime-support";
import { withCatalogAdminRealtimeInvalidation } from "../../../support/projection-support/realtime-invalidation";
import {
  createBulkLifecycleOperations,
  type BulkLifecycleOperations,
  type BulkSelection,
} from "../../../support/runtime-support/bulk-lifecycle";
import {
  type FieldState,
  type FieldCommand,
  type FieldEvent,
  initialFieldState,
  decideField,
  evolveField,
} from "../domain/domain";
import { getField, listFieldBulkRows, listFieldIds, listFields, type FieldListParams } from "../read-model/queries";
import { buildFieldProjectionHandlers } from "../read-model/projection";

export type FieldServices = Readonly<{
  commandHandler: CommandHandler<FieldCommand, FieldState, FieldEvent>;
  listFields: (params?: Parameters<typeof listFields>[1]) => ReturnType<typeof listFields>;
  getField: (fieldId: string) => ReturnType<typeof getField>;
  bulkLifecycle: BulkLifecycleOperations<FieldListParams, FieldCommand, FieldState, FieldEvent>;
  projectors: readonly ProjectionHandlerSet[];
}>;

export function createFieldRuntime(deps: CatalogRuntimeDeps): FieldServices {
  const { commandHandler } = createAggregateCommandHandler({
    eventStore: deps.eventStore,
    codec: createPassthroughDomainEventCodec<FieldEvent>(),
    initialState: () => initialFieldState,
    evolve: evolveField,
    decide: decideField,
  });

  const projectors = [
    createProjectionHandlerSet({
      projectionName: "catalog-field-projection",
      handlers: withCatalogAdminRealtimeInvalidation(buildFieldProjectionHandlers(deps.db), deps.db, {
        projectionName: "catalog-field-projection",
        surface: "fields",
      }),
    }),
  ];
  const bulkLifecycle = createBulkLifecycleOperations<FieldListParams, FieldCommand, FieldState, FieldEvent>({
    actions: [
      {
        action: "activate",
        readyStatus: "draft",
        command: { type: "ActivateField" },
        streamId: (id) => `catalog.field-${id}`,
        blockedReason: (status) => `Only draft Fields can be activated. Current status: ${status}.`,
      },
      {
        action: "deprecate",
        readyStatus: "active",
        command: { type: "DeprecateField" },
        streamId: (id) => `catalog.field-${id}`,
        blockedReason: (status) => `Only active Fields can be deprecated. Current status: ${status}.`,
      },
      {
        action: "archive",
        readyStatus: "deprecated",
        command: { type: "ArchiveField" },
        streamId: (id) => `catalog.field-${id}`,
        blockedReason: (status) => `Only deprecated Fields can be archived. Current status: ${status}.`,
      },
    ],
    commandHandler,
    resolveIds: (selection: BulkSelection<FieldListParams>) =>
      selection.mode === "ids" ? Promise.resolve(selection.ids) : listFieldIds(deps.db, selection.query),
    loadRows: (ids) => listFieldBulkRows(deps.db, ids),
  });

  return {
    commandHandler,
    listFields: (params) => listFields(deps.db, params),
    getField: (fieldId) => getField(deps.db, fieldId),
    bulkLifecycle,
    projectors,
  };
}
