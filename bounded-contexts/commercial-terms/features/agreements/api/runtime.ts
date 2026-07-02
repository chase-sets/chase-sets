import { createAggregateCommandHandler } from "@chase-sets/event-core/aggregate-command-handler";
import { createPassthroughDomainEventCodec } from "@chase-sets/event-core/codec";
import type { CommandHandler } from "@chase-sets/event-core/command-handler";
import type { EventStore } from "@chase-sets/event-core/event-store";
import { createProjectionHandlerSet, type ProjectionHandlerSet } from "@chase-sets/event-core/projector";
import type { ProjectionCheckpointStore } from "@chase-sets/event-core/projector";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { createId } from "@chase-sets/primitives/typed-ids";
import { buildAgreementProjectionHandlers } from "../read-model/projection";
import {
  findOverlappingActiveAgreement,
  getAgreement,
  getCommercialTermsAccountReference,
  listAgreements,
} from "../read-model/queries";
import {
  decideCommercialAgreement,
  evolveCommercialAgreement,
  initialCommercialAgreementState,
  type CommercialAgreementCommand,
  type CommercialAgreementEvent,
  type CommercialAgreementState,
} from "../domain/domain";
import { CommercialTermsDomainError } from "../../../support/runtime-support/common";
import { normalizeAgreementAccountIdText } from "./account-id";

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
  reviseAgreement: (
    agreementId: string,
    params: Omit<Extract<CommercialAgreementCommand, { type: "ReviseAgreement" }>, "type">,
    context: EventStoreContext,
  ) => Promise<{ agreementId: string; version: number }>;
  listAgreements: (params: Readonly<{ limit?: number; offset?: number }>) => ReturnType<typeof listAgreements>;
  getAgreement: (agreementId: string) => ReturnType<typeof getAgreement>;
  projectors: readonly ProjectionHandlerSet[];
}>;

export function createAgreementRuntime(deps: AgreementRuntimeDeps): AgreementServices {
  const { commandHandler } = createAggregateCommandHandler({
    eventStore: deps.eventStore,
    codec: createPassthroughDomainEventCodec<CommercialAgreementEvent>(),
    initialState: () => initialCommercialAgreementState,
    evolve: evolveCommercialAgreement,
    decide: decideCommercialAgreement,
  });

  async function assertAccountExists(accountId: string) {
    const account = await getCommercialTermsAccountReference(deps.db, accountId);
    if (!account) {
      throw new CommercialTermsDomainError(`Account ${accountId} is not available for commercial terms.`);
    }
  }

  async function assertNoActiveOverlap(
    params: Readonly<{
      accountId: string;
      status: string;
      effectiveFrom: string;
      effectiveUntil: string | null;
      excludeAgreementId?: string | null;
    }>,
  ) {
    if (params.status !== "active") {
      return;
    }

    const overlap = await findOverlappingActiveAgreement(deps.db, params);
    if (overlap) {
      throw new CommercialTermsDomainError(
        `Active agreement ${overlap.agreement_id} already covers that account and effective window.`,
      );
    }
  }

  return {
    commandHandler,
    async createAgreement(params, context) {
      const agreementId = createId("cag");
      const accountId = normalizeAgreementAccountIdText(params.accountId);
      await assertAccountExists(accountId);
      await assertNoActiveOverlap({
        accountId,
        status: params.status,
        effectiveFrom: params.effectiveFrom,
        effectiveUntil: params.effectiveUntil,
      });
      const result = await commandHandler({
        streamId: `commercial-terms.agreement-${agreementId}`,
        command: {
          type: "CreateAgreement",
          agreementId,
          ...params,
          accountId,
        },
        context,
      });
      return { agreementId, version: result.version };
    },
    async reviseAgreement(agreementId, params, context) {
      const current = await getAgreement(deps.db, agreementId);
      if (!current) {
        throw new CommercialTermsDomainError("Agreement not found.");
      }
      await assertAccountExists(current.account_id);
      await assertNoActiveOverlap({
        accountId: current.account_id,
        status: params.status,
        effectiveFrom: params.effectiveFrom,
        effectiveUntil: params.effectiveUntil,
        excludeAgreementId: agreementId,
      });
      const result = await commandHandler({
        streamId: `commercial-terms.agreement-${agreementId}`,
        command: {
          type: "ReviseAgreement",
          ...params,
        },
        context,
      });
      return { agreementId, version: result.version };
    },
    listAgreements: (params) => listAgreements(deps.db, params),
    getAgreement: (agreementId) => getAgreement(deps.db, agreementId),
    projectors: [
      createProjectionHandlerSet({
        projectionName: "commercial-terms-agreement-projection",
        handlers: buildAgreementProjectionHandlers(deps.db),
      }),
    ],
  };
}
