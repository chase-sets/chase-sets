import { createPassthroughDomainEventCodec } from "@chase-sets/event-core/codec";
import { createAggregateRepository } from "@chase-sets/event-core/aggregate-repository";
import { createCommandHandler, type CommandHandler } from "@chase-sets/event-core/command-handler";
import { createProjectionHandlerSet, type ProjectionHandlerSet } from "@chase-sets/event-core/projector";
import type { CatalogRuntimeDeps } from "../../../support/authoring-support/runtime-support";
import { withCatalogAdminRealtimeInvalidation } from "../../../support/projection-support/realtime-invalidation";
import {
  createBulkLifecycleOperations,
  type BulkLifecycleOperations,
  type BulkSelection,
} from "../../../support/runtime-support/bulk-lifecycle";
import {
  decideReferenceRecord,
  decideReferenceType,
  evolveReferenceRecord,
  evolveReferenceType,
  initialReferenceRecordState,
  initialReferenceTypeState,
  type ReferenceRecordCommand,
  type ReferenceRecordEvent,
  type ReferenceRecordState,
  type ReferenceTypeCommand,
  type ReferenceTypeEvent,
  type ReferenceTypeState,
} from "../domain/domain";
import {
  getReferenceRecord,
  getReferenceType,
  listReferenceRecordBulkRows,
  listReferenceRecordIds,
  listReferenceRecords,
  listReferenceTypeBulkRows,
  listReferenceTypeIds,
  listReferenceTypes,
  type ReferenceRecordListParams,
  type ReferenceTypeListParams,
} from "../read-model/queries";
import { buildReferenceDataProjectionHandlers } from "../read-model/projection";

export type ReferenceDataServices = Readonly<{
  referenceTypeCommandHandler: CommandHandler<ReferenceTypeCommand, ReferenceTypeState, ReferenceTypeEvent>;
  referenceRecordCommandHandler: CommandHandler<ReferenceRecordCommand, ReferenceRecordState, ReferenceRecordEvent>;
  listReferenceTypes: (params?: Parameters<typeof listReferenceTypes>[1]) => ReturnType<typeof listReferenceTypes>;
  getReferenceType: (referenceTypeId: string) => ReturnType<typeof getReferenceType>;
  listReferenceRecords: (
    params?: Parameters<typeof listReferenceRecords>[1],
  ) => ReturnType<typeof listReferenceRecords>;
  getReferenceRecord: (referenceRecordId: string) => ReturnType<typeof getReferenceRecord>;
  referenceTypeBulkLifecycle: BulkLifecycleOperations<
    ReferenceTypeListParams,
    ReferenceTypeCommand,
    ReferenceTypeState,
    ReferenceTypeEvent
  >;
  referenceRecordBulkLifecycle: BulkLifecycleOperations<
    ReferenceRecordListParams,
    ReferenceRecordCommand,
    ReferenceRecordState,
    ReferenceRecordEvent
  >;
  projectors: readonly ProjectionHandlerSet[];
}>;

export function createReferenceDataRuntime(deps: CatalogRuntimeDeps): ReferenceDataServices {
  const referenceTypeCommandHandler = createCommandHandler({
    repository: createAggregateRepository({
      eventStore: deps.eventStore,
      codec: createPassthroughDomainEventCodec<ReferenceTypeEvent>(),
      initialState: () => initialReferenceTypeState,
      evolve: evolveReferenceType,
    }),
    evolve: evolveReferenceType,
    decide: decideReferenceType,
  });
  const referenceRecordCommandHandler = createCommandHandler({
    repository: createAggregateRepository({
      eventStore: deps.eventStore,
      codec: createPassthroughDomainEventCodec<ReferenceRecordEvent>(),
      initialState: () => initialReferenceRecordState,
      evolve: evolveReferenceRecord,
    }),
    evolve: evolveReferenceRecord,
    decide: decideReferenceRecord,
  });
  const projectionHandlers = buildReferenceDataProjectionHandlers(deps.db);

  const projectors = [
    createProjectionHandlerSet({
      projectionName: "catalog-reference-data-projection",
      handlers: {
        ...withCatalogAdminRealtimeInvalidation(
          {
            "catalog.reference-type.created": projectionHandlers["catalog.reference-type.created"],
            "catalog.reference-type.revised": projectionHandlers["catalog.reference-type.revised"],
            "catalog.reference-type.published": projectionHandlers["catalog.reference-type.published"],
            "catalog.reference-type.deprecated": projectionHandlers["catalog.reference-type.deprecated"],
            "catalog.reference-type.archived": projectionHandlers["catalog.reference-type.archived"],
          },
          deps.db,
          { projectionName: "catalog-reference-data-projection", surface: "reference-types" },
        ),
        ...withCatalogAdminRealtimeInvalidation(
          {
            "catalog.reference-record.created": projectionHandlers["catalog.reference-record.created"],
            "catalog.reference-record.revised": projectionHandlers["catalog.reference-record.revised"],
            "catalog.reference-record.published": projectionHandlers["catalog.reference-record.published"],
            "catalog.reference-record.deprecated": projectionHandlers["catalog.reference-record.deprecated"],
            "catalog.reference-record.archived": projectionHandlers["catalog.reference-record.archived"],
          },
          deps.db,
          { projectionName: "catalog-reference-data-projection", surface: "reference-records" },
        ),
      },
    }),
  ];
  const referenceTypeBulkLifecycle = createBulkLifecycleOperations<
    ReferenceTypeListParams,
    ReferenceTypeCommand,
    ReferenceTypeState,
    ReferenceTypeEvent
  >({
    actions: [
      {
        action: "publish",
        readyStatus: "draft",
        command: { type: "PublishReferenceType" },
        streamId: (id) => `catalog.reference-type-${id}`,
        blockedReason: (status) => `Only draft Reference Types can be published. Current status: ${status}.`,
      },
      {
        action: "deprecate",
        readyStatus: "active",
        command: { type: "DeprecateReferenceType" },
        streamId: (id) => `catalog.reference-type-${id}`,
        blockedReason: (status) => `Only active Reference Types can be deprecated. Current status: ${status}.`,
      },
      {
        action: "archive",
        readyStatus: "deprecated",
        command: { type: "ArchiveReferenceType" },
        streamId: (id) => `catalog.reference-type-${id}`,
        blockedReason: (status) => `Only deprecated Reference Types can be archived. Current status: ${status}.`,
      },
    ],
    commandHandler: referenceTypeCommandHandler,
    resolveIds: (selection: BulkSelection<ReferenceTypeListParams>) =>
      selection.mode === "ids" ? Promise.resolve(selection.ids) : listReferenceTypeIds(deps.db, selection.query),
    loadRows: (ids) => listReferenceTypeBulkRows(deps.db, ids),
  });
  const referenceRecordBulkLifecycle = createBulkLifecycleOperations<
    ReferenceRecordListParams,
    ReferenceRecordCommand,
    ReferenceRecordState,
    ReferenceRecordEvent
  >({
    actions: [
      {
        action: "publish",
        readyStatus: "draft",
        command: { type: "PublishReferenceRecord" },
        streamId: (id) => `catalog.reference-record-${id}`,
        blockedReason: (status) => `Only draft Reference Records can be published. Current status: ${status}.`,
      },
      {
        action: "deprecate",
        readyStatus: "active",
        command: { type: "DeprecateReferenceRecord" },
        streamId: (id) => `catalog.reference-record-${id}`,
        blockedReason: (status) => `Only active Reference Records can be deprecated. Current status: ${status}.`,
      },
      {
        action: "archive",
        readyStatus: "deprecated",
        command: { type: "ArchiveReferenceRecord" },
        streamId: (id) => `catalog.reference-record-${id}`,
        blockedReason: (status) => `Only deprecated Reference Records can be archived. Current status: ${status}.`,
      },
    ],
    commandHandler: referenceRecordCommandHandler,
    resolveIds: (selection: BulkSelection<ReferenceRecordListParams>) =>
      selection.mode === "ids" ? Promise.resolve(selection.ids) : listReferenceRecordIds(deps.db, selection.query),
    loadRows: (ids) => listReferenceRecordBulkRows(deps.db, ids),
  });

  return {
    referenceTypeCommandHandler,
    referenceRecordCommandHandler,
    listReferenceTypes: (params) => listReferenceTypes(deps.db, params),
    getReferenceType: (referenceTypeId) => getReferenceType(deps.db, referenceTypeId),
    listReferenceRecords: (params) => listReferenceRecords(deps.db, params),
    getReferenceRecord: (referenceRecordId) => getReferenceRecord(deps.db, referenceRecordId),
    referenceTypeBulkLifecycle,
    referenceRecordBulkLifecycle,
    projectors,
  };
}
