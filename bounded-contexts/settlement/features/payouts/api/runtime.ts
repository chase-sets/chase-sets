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
import { createId } from "@chase-sets/primitives/typed-ids";
import type { AccountId, LedgerEntryId, PayoutId } from "@chase-sets/primitives/typed-ids";
import {
  compareMoney,
  normalizeCurrencyCode,
  normalizeMoneyAmount,
  SettlementDomainError,
} from "../../../support/runtime-support/common";
import { buildPayoutProjectionHandlers } from "../read-model/projection";
import { getPayout, listPayouts, type SettlementPayoutRow } from "../read-model/queries";
import type { WalletServices } from "../../wallets/api/runtime";
import type { PayoutReadinessServices } from "../../payout-readiness/api/runtime";
import {
  decidePayout,
  evolvePayout,
  initialPayoutState,
  type PayoutCommand,
  type PayoutEvent,
  type PayoutState,
} from "../domain/domain";

type PayoutRuntimeDeps = Readonly<{
  eventStore: EventStore;
  checkpointStore: ProjectionCheckpointStore;
  db: PgQueryable;
  wallets: WalletServices;
  payoutReadiness: PayoutReadinessServices;
}>;

export type PayoutServices = Readonly<{
  commandHandler: CommandHandler<PayoutCommand, PayoutState, PayoutEvent>;
  listPayouts: (
    params: Readonly<{ accountId: string; limit?: number; offset?: number }>,
  ) => Promise<{ items: SettlementPayoutRow[]; total: number }>;
  getPayout: (payoutId: string, accountId: string) => Promise<SettlementPayoutRow | null>;
  schedulePayout: (
    params: Readonly<{
      accountId: AccountId;
      amount: string;
      destinationReference?: string | null;
      note?: string | null;
    }>,
    context: EventStoreContext,
  ) => Promise<{ payoutId: PayoutId; version: number }>;
  markPayoutInTransit: (
    params: Readonly<{ payoutId: string; accountId: string; sentAt?: string }>,
    context: EventStoreContext,
  ) => Promise<{ payoutId: string; version: number }>;
  completePayout: (
    params: Readonly<{ payoutId: string; accountId: string; completedAt?: string }>,
    context: EventStoreContext,
  ) => Promise<{ payoutId: string; version: number }>;
  failPayout: (
    params: Readonly<{
      payoutId: string;
      accountId: string;
      failureReason?: string | null;
      failedAt?: string;
    }>,
    context: EventStoreContext,
  ) => Promise<{ payoutId: string; version: number }>;
  projectors: readonly Projector[];
}>;

async function requireExistingPayout(
  db: PgQueryable,
  payoutId: string,
  accountId: string,
) {
  const payout = await getPayout(db, payoutId, accountId);
  if (!payout) {
    throw new SettlementDomainError("Payout was not found.");
  }
  return payout;
}

export function createPayoutRuntime(
  deps: PayoutRuntimeDeps,
): PayoutServices {
  const commandHandler = createCommandHandler({
    repository: createAggregateRepository({
      eventStore: deps.eventStore,
      codec: createPassthroughDomainEventCodec<PayoutEvent>(),
      initialState: () => initialPayoutState,
      evolve: evolvePayout,
    }),
    evolve: evolvePayout,
    decide: decidePayout,
  });

  return {
    commandHandler,
    listPayouts: (params) => listPayouts(deps.db, params),
    getPayout: (payoutId, accountId) => getPayout(deps.db, payoutId, accountId),
    async schedulePayout(params, context) {
      const wallet = await deps.wallets.getWallet(params.accountId);
      const readiness = await deps.payoutReadiness.getPayoutReadiness(params.accountId);
      const amount = normalizeMoneyAmount(params.amount, {
        fieldName: "Payout amount",
      });

      if (readiness.status !== "ready") {
        throw new SettlementDomainError(
          "Payout setup must be complete before scheduling payouts.",
        );
      }

      if (compareMoney(wallet.available_balance_amount, amount) < 0) {
        throw new SettlementDomainError("Available balance is too low for this payout.");
      }

      const payoutId = createId("pyo") as PayoutId;
      const scheduledAt = new Date().toISOString();
      const currencyCode = normalizeCurrencyCode(wallet.currency_code);
      const result = await commandHandler({
        streamId: `settlement.payout-${payoutId}`,
        command: {
          type: "SchedulePayout",
          payoutId,
          accountId: params.accountId,
          amount,
          currencyCode,
          destinationReference: params.destinationReference ?? null,
          note: params.note ?? null,
          scheduledAt,
        },
        context,
      });

      await deps.wallets.postEntry(
        {
          accountId: params.accountId,
          ledgerEntryId: createId("led") as LedgerEntryId,
          kind: "payout",
          direction: "debit",
          amount,
          currencyCode,
          fundsStatus: "available",
          payoutId,
          description: params.note ?? `Payout ${payoutId}`,
          postedAt: scheduledAt,
        },
        context,
      );

      return {
        payoutId,
        version: result.version,
      };
    },
    async markPayoutInTransit(params, context) {
      await requireExistingPayout(deps.db, params.payoutId, params.accountId);
      const result = await commandHandler({
        streamId: `settlement.payout-${params.payoutId}`,
        command: {
          type: "MarkPayoutInTransit",
          sentAt: params.sentAt ?? new Date().toISOString(),
        },
        context,
      });

      return {
        payoutId: params.payoutId,
        version: result.version,
      };
    },
    async completePayout(params, context) {
      await requireExistingPayout(deps.db, params.payoutId, params.accountId);
      const result = await commandHandler({
        streamId: `settlement.payout-${params.payoutId}`,
        command: {
          type: "CompletePayout",
          completedAt: params.completedAt ?? new Date().toISOString(),
        },
        context,
      });

      return {
        payoutId: params.payoutId,
        version: result.version,
      };
    },
    async failPayout(params, context) {
      const payout = await requireExistingPayout(deps.db, params.payoutId, params.accountId);
      const failedAt = params.failedAt ?? new Date().toISOString();
      const result = await commandHandler({
        streamId: `settlement.payout-${params.payoutId}`,
        command: {
          type: "FailPayout",
          failureReason: params.failureReason ?? null,
          failedAt,
        },
        context,
      });

      if (result.newEvents.length > 0) {
        await deps.wallets.postEntry(
          {
            accountId: payout.account_id as AccountId,
            ledgerEntryId: createId("led") as LedgerEntryId,
            kind: "payout-reversal",
            direction: "credit",
            amount: payout.amount,
            currencyCode: normalizeCurrencyCode(payout.currency_code),
            fundsStatus: "available",
            payoutId: payout.payout_id as PayoutId,
            description:
              params.failureReason ??
              `Reversed failed payout ${payout.payout_id}`,
            postedAt: failedAt,
          },
          context,
        );
      }

      return {
        payoutId: params.payoutId,
        version: result.version,
      };
    },
    projectors: [
      createProjector({
        projectorName: "settlement-payout-projection",
        eventStore: deps.eventStore,
        checkpointStore: deps.checkpointStore,
        handlers: buildPayoutProjectionHandlers(deps.db),
      }),
    ],
  };
}
