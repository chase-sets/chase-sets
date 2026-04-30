import { createAggregateRepository } from "@chase-sets/event-core/aggregate-repository";
import { createPassthroughDomainEventCodec } from "@chase-sets/event-core/codec";
import {
  createCommandHandler,
  type CommandHandler,
} from "@chase-sets/event-core/command-handler";
import type { EventStore } from "@chase-sets/event-core/event-store";
import { createProjector, type Projector } from "@chase-sets/event-core/projector";
import type { ProjectionCheckpointStore } from "@chase-sets/event-core/projector";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type { AccountId } from "@chase-sets/primitives/typed-ids";
import {
  normalizePayoutReadinessStatus,
  type PayoutReadinessStatus,
} from "../../../support/runtime-support/common";
import {
  decidePayoutReadiness,
  evolvePayoutReadiness,
  initialPayoutReadinessState,
  type PayoutReadinessCommand,
  type PayoutReadinessEvent,
  type PayoutReadinessState,
} from "../domain/domain";
import { buildPayoutReadinessProjectionHandlers } from "../read-model/projection";
import {
  getPayoutReadiness,
  type SettlementPayoutReadinessRow,
} from "../read-model/queries";

type PayoutReadinessRuntimeDeps = Readonly<{
  eventStore: EventStore;
  checkpointStore: ProjectionCheckpointStore;
  db: PgQueryable;
}>;

export type PayoutReadinessServices = Readonly<{
  commandHandler: CommandHandler<
    PayoutReadinessCommand,
    PayoutReadinessState,
    PayoutReadinessEvent
  >;
  getPayoutReadiness: (accountId: string) => Promise<SettlementPayoutReadinessRow>;
  recordProviderReadiness: (
    params: Readonly<{
      accountId: AccountId;
      status: PayoutReadinessStatus | string;
      missingRequirements?: readonly string[];
      providerReference?: string | null;
      recordedAt?: string;
    }>,
    context: EventStoreContext,
  ) => Promise<{ accountId: AccountId; version: number }>;
  projectors: readonly Projector[];
}>;

export function createPayoutReadinessRuntime(
  deps: PayoutReadinessRuntimeDeps,
): PayoutReadinessServices {
  const commandHandler = createCommandHandler({
    repository: createAggregateRepository({
      eventStore: deps.eventStore,
      codec: createPassthroughDomainEventCodec<PayoutReadinessEvent>(),
      initialState: () => initialPayoutReadinessState,
      evolve: evolvePayoutReadiness,
    }),
    evolve: evolvePayoutReadiness,
    decide: decidePayoutReadiness,
  });

  return {
    commandHandler,
    getPayoutReadiness: (accountId) => getPayoutReadiness(deps.db, accountId),
    async recordProviderReadiness(params, context) {
      const result = await commandHandler({
        streamId: `settlement.payout-readiness-${params.accountId}`,
        command: {
          type: "RecordPayoutReadiness",
          accountId: params.accountId,
          status: normalizePayoutReadinessStatus(params.status),
          missingRequirements: params.missingRequirements ?? [],
          providerReference: params.providerReference ?? null,
          recordedAt: params.recordedAt ?? new Date().toISOString(),
        },
        context,
      });

      return {
        accountId: params.accountId,
        version: result.version,
      };
    },
    projectors: [
      createProjector({
        projectorName: "settlement-payout-readiness-projection",
        eventStore: deps.eventStore,
        checkpointStore: deps.checkpointStore,
        handlers: buildPayoutReadinessProjectionHandlers(deps.db),
      }),
    ],
  };
}
