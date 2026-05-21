import { createAggregateRepository } from "@chase-sets/event-core/aggregate-repository";
import { createPassthroughDomainEventCodec } from "@chase-sets/event-core/codec";
import { createCommandHandler, type CommandHandler } from "@chase-sets/event-core/command-handler";
import type { EventStore } from "@chase-sets/event-core/event-store";
import { createProjector, type Projector } from "@chase-sets/event-core/projector";
import type { ProjectionCheckpointStore } from "@chase-sets/event-core/projector";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { createId } from "@chase-sets/primitives/typed-ids";
import { buildAgreementProjectionHandlers } from "../read-model/projection";
import { getAgreement, listAgreements } from "../read-model/queries";
import {
  decideCommercialAgreement,
  evolveCommercialAgreement,
  initialCommercialAgreementState,
  type CommercialAgreementCommand,
  type CommercialAgreementEvent,
  type CommercialAgreementState,
} from "../domain/domain";

type AgreementRuntimeDeps = Readonly<{
  eventStore: EventStore;
  checkpointStore: ProjectionCheckpointStore;
  db: PgQueryable;
}>;

export type AgreementServices = Readonly<{
  commandHandler: CommandHandler<CommercialAgreementCommand, CommercialAgreementState, CommercialAgreementEvent>;
  createAgreement: (
    params: Omit<Extract<CommercialAgreementCommand, { type: "CreateAgreement" }>, "type" | "agreementId">,
    context: EventStoreContext,
  ) => Promise<{ agreementId: string; version: number }>;
  listAgreements: (params: Readonly<{ limit?: number; offset?: number }>) => ReturnType<typeof listAgreements>;
  getAgreement: (agreementId: string) => ReturnType<typeof getAgreement>;
  projectors: readonly Projector[];
}>;

export function createAgreementRuntime(deps: AgreementRuntimeDeps): AgreementServices {
  const commandHandler = createCommandHandler({
    repository: createAggregateRepository({
      eventStore: deps.eventStore,
      codec: createPassthroughDomainEventCodec<CommercialAgreementEvent>(),
      initialState: () => initialCommercialAgreementState,
      evolve: evolveCommercialAgreement,
    }),
    evolve: evolveCommercialAgreement,
    decide: decideCommercialAgreement,
  });

  return {
    commandHandler,
    async createAgreement(params, context) {
      const agreementId = createId("cag");
      const result = await commandHandler({
        streamId: `commercial-terms.agreement-${agreementId}`,
        command: {
          type: "CreateAgreement",
          agreementId,
          ...params,
        },
        context,
      });
      return { agreementId, version: result.version };
    },
    listAgreements: (params) => listAgreements(deps.db, params),
    getAgreement: (agreementId) => getAgreement(deps.db, agreementId),
    projectors: [
      createProjector({
        projectorName: "commercial-terms-agreement-projection",
        eventStore: deps.eventStore,
        checkpointStore: deps.checkpointStore,
        handlers: buildAgreementProjectionHandlers(deps.db),
      }),
    ],
  };
}
