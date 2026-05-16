import { createPassthroughDomainEventCodec } from "@chase-sets/event-core/codec";
import { createAggregateRepository } from "@chase-sets/event-core/aggregate-repository";
import {
  createCommandHandler,
  type CommandHandler,
} from "@chase-sets/event-core/command-handler";
import { createProjector, type Projector } from "@chase-sets/event-core/projector";
import type { CatalogRuntimeDeps } from "../../../support/authoring-support/runtime-support";
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
  listReferenceRecords,
  listReferenceTypes,
} from "../read-model/queries";
import { buildReferenceDataProjectionHandlers } from "../read-model/projection";

export type ReferenceDataServices = Readonly<{
  referenceTypeCommandHandler: CommandHandler<
    ReferenceTypeCommand,
    ReferenceTypeState,
    ReferenceTypeEvent
  >;
  referenceRecordCommandHandler: CommandHandler<
    ReferenceRecordCommand,
    ReferenceRecordState,
    ReferenceRecordEvent
  >;
  listReferenceTypes: (
    params?: Parameters<typeof listReferenceTypes>[1],
  ) => ReturnType<typeof listReferenceTypes>;
  getReferenceType: (referenceTypeId: string) => ReturnType<typeof getReferenceType>;
  listReferenceRecords: (
    params?: Parameters<typeof listReferenceRecords>[1],
  ) => ReturnType<typeof listReferenceRecords>;
  getReferenceRecord: (
    referenceRecordId: string,
  ) => ReturnType<typeof getReferenceRecord>;
  projectors: readonly Projector[];
}>;

export function createReferenceDataRuntime(
  deps: CatalogRuntimeDeps,
): ReferenceDataServices {
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

  return {
    referenceTypeCommandHandler,
    referenceRecordCommandHandler,
    listReferenceTypes: (params) => listReferenceTypes(deps.db, params),
    getReferenceType: (referenceTypeId) => getReferenceType(deps.db, referenceTypeId),
    listReferenceRecords: (params) => listReferenceRecords(deps.db, params),
    getReferenceRecord: (referenceRecordId) => getReferenceRecord(deps.db, referenceRecordId),
    projectors: [
      createProjector({
        projectorName: "catalog-reference-data-projection",
        eventStore: deps.eventStore,
        checkpointStore: deps.checkpointStore,
        handlers: buildReferenceDataProjectionHandlers(deps.db),
      }),
    ],
  };
}
