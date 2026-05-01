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
import type {
  MoneyMovementGateway,
  MoneyMovementWebhookEvent,
} from "@chase-sets/money-movement";
import {
  createNoopSettlementOperationsRecorder,
  type SettlementOperationsRecorder,
} from "./operations";
import { buildPayoutProjectionHandlers } from "../read-model/projection";
import {
  getPayout,
  getPayoutByProviderPayoutReference,
  listPayouts,
  type SettlementPayoutRow,
} from "../read-model/queries";
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
  moneyMovementGateway: MoneyMovementGateway;
  operationsRecorder?: SettlementOperationsRecorder;
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
      providerStatus?: string | null;
      providerFailureCode?: string | null;
      providerFailureMessage?: string | null;
      failedAt?: string;
    }>,
    context: EventStoreContext,
  ) => Promise<{ payoutId: string; version: number }>;
  processMoneyMovementWebhook: (
    params: Readonly<{ rawBody: string; signatureHeader: string | null }>,
    context: EventStoreContext,
  ) => Promise<{ received: boolean; ignored: boolean }>;
  reconcileProviderPayout: (
    params: Readonly<{ providerPayoutReference: string }>,
    context: EventStoreContext,
  ) => Promise<{ received: boolean; ignored: boolean }>;
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
  const operationsRecorder =
    deps.operationsRecorder ?? createNoopSettlementOperationsRecorder();
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

  async function recordOperation(
    event: Omit<
      Parameters<SettlementOperationsRecorder["record"]>[0],
      "occurredAt"
    > & Partial<Pick<Parameters<SettlementOperationsRecorder["record"]>[0], "occurredAt">>,
  ) {
    await operationsRecorder.record({
      ...event,
      providerName: event.providerName ?? deps.moneyMovementGateway.providerName,
      occurredAt: event.occurredAt ?? new Date().toISOString(),
    });
  }

  async function failPayoutAndReverseWallet(
    params: Readonly<{
      payoutId: string;
      accountId: string;
      failureReason?: string | null;
      providerStatus?: string | null;
      providerFailureCode?: string | null;
      providerFailureMessage?: string | null;
      failedAt?: string;
      amount?: string;
      currencyCode?: string;
    }>,
    context: EventStoreContext,
  ) {
    const payout = await getPayout(deps.db, params.payoutId, params.accountId) ??
      (params.amount && params.currencyCode
        ? {
            payout_id: params.payoutId,
            account_id: params.accountId,
            amount: params.amount,
            currency_code: params.currencyCode,
          }
        : null);
    if (!payout) {
      throw new SettlementDomainError("Payout was not found.");
    }
    const failedAt = params.failedAt ?? new Date().toISOString();
    const result = await commandHandler({
      streamId: `settlement.payout-${params.payoutId}`,
      command: {
        type: "FailPayout",
        failureReason: params.failureReason ?? null,
        providerStatus: params.providerStatus ?? null,
        providerFailureCode: params.providerFailureCode ?? null,
        providerFailureMessage: params.providerFailureMessage ?? null,
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
            params.providerFailureMessage ??
            `Reversed failed payout ${payout.payout_id}`,
          postedAt: failedAt,
        },
        context,
      );
      await recordOperation({
        kind: "payout-reversal-posted",
        accountId: payout.account_id,
        payoutId: payout.payout_id,
        amount: payout.amount,
        currencyCode: payout.currency_code,
        reason:
          params.failureReason ??
          params.providerFailureMessage ??
          `Reversed failed payout ${payout.payout_id}`,
      });
    }

    return {
      payoutId: params.payoutId,
      version: result.version,
    };
  }

  async function handleMoneyMovementEvent(
    event: MoneyMovementWebhookEvent,
    context: EventStoreContext,
  ) {
    switch (event.kind) {
      case "payout-completed": {
        const payout = await getPayoutByProviderPayoutReference(
          deps.db,
          event.providerPayoutReference,
        );
        if (!payout) {
          await recordOperation({
            kind: "money-movement-webhook-ignored",
            providerEventId: event.providerEventId,
            providerPayoutReference: event.providerPayoutReference,
            reason: "Payout not found for provider payout reference.",
          });
          return { received: true, ignored: true };
        }
        const result = await commandHandler({
          streamId: `settlement.payout-${payout.payout_id}`,
          command: {
            type: "CompletePayout",
            providerStatus: event.providerStatus,
            completedAt: event.occurredAt,
          },
          context,
        });
        if (result.newEvents.length > 0) {
          await recordOperation({
            kind: "payout-completed",
            providerEventId: event.providerEventId,
            accountId: payout.account_id,
            payoutId: payout.payout_id,
            providerPayoutReference: event.providerPayoutReference,
            occurredAt: event.occurredAt,
          });
        }
        return { received: true, ignored: result.newEvents.length === 0 };
      }
      case "payout-failed": {
        const payout = await getPayoutByProviderPayoutReference(
          deps.db,
          event.providerPayoutReference,
        );
        if (!payout) {
          await recordOperation({
            kind: "money-movement-webhook-ignored",
            providerEventId: event.providerEventId,
            providerPayoutReference: event.providerPayoutReference,
            reason: "Payout not found for provider payout reference.",
          });
          return { received: true, ignored: true };
        }
        await failPayoutAndReverseWallet(
          {
            payoutId: payout.payout_id,
            accountId: payout.account_id,
            failureReason: event.failureMessage,
            providerStatus: event.providerStatus,
            providerFailureCode: event.failureCode,
            providerFailureMessage: event.failureMessage,
            failedAt: event.occurredAt,
          },
          context,
        );
        await recordOperation({
          kind: "payout-failed",
          providerEventId: event.providerEventId,
          accountId: payout.account_id,
          payoutId: payout.payout_id,
          providerPayoutReference: event.providerPayoutReference,
          reason: event.failureMessage,
          occurredAt: event.occurredAt,
        });
        return { received: true, ignored: false };
      }
      case "payout-readiness-updated":
        await deps.payoutReadiness.recordProviderReadinessFromWebhook(
          {
            providerReference: event.providerReference,
            readiness: event.readiness,
            recordedAt: event.occurredAt,
          },
          context,
        );
        return { received: true, ignored: false };
    }
  }

  return {
    commandHandler,
    listPayouts: (params) => listPayouts(deps.db, params),
    getPayout: (payoutId, accountId) => getPayout(deps.db, payoutId, accountId),
    async schedulePayout(params, context) {
      await recordOperation({
        kind: "payout-requested",
        accountId: params.accountId,
        amount: params.amount,
        currencyCode: "usd",
      });
      const wallet = await deps.wallets.getWallet(params.accountId);
      const readiness = await deps.payoutReadiness.getPayoutReadiness(params.accountId);
      const amount = normalizeMoneyAmount(params.amount, {
        fieldName: "Payout amount",
      });
      const currencyCode = normalizeCurrencyCode(wallet.currency_code);

      if (readiness.status !== "ready") {
        throw new SettlementDomainError(
          "Payout setup must be complete before scheduling payouts.",
        );
      }
      if (!readiness.provider_reference) {
        throw new SettlementDomainError(
          "Payout setup must include a provider account.",
        );
      }

      if (compareMoney(wallet.available_balance_amount, amount) < 0) {
        throw new SettlementDomainError("Available balance is too low for this payout.");
      }
      const platformBalance = await deps.moneyMovementGateway.retrievePlatformBalance({
        currencyCode,
      });
      if (compareMoney(platformBalance.availableAmount, amount) < 0) {
        await recordOperation({
          kind: "platform-balance-insufficient",
          accountId: params.accountId,
          amount,
          currencyCode,
          reason: `Available platform balance ${platformBalance.availableAmount} is below requested payout amount.`,
        });
        throw new SettlementDomainError("Platform balance is too low for this payout.");
      }

      const payoutId = createId("pyo") as PayoutId;
      const scheduledAt = new Date().toISOString();
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

      try {
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

        const transfer =
          await deps.moneyMovementGateway.transferPlatformBalanceToConnectedAccount({
            payoutId,
            accountId: params.accountId,
            providerReference: readiness.provider_reference,
            amount,
            currencyCode,
            idempotencyKey: `settlement:payout:${payoutId}:transfer`,
          });
        await recordOperation({
          kind: "provider-transfer-submitted",
          accountId: params.accountId,
          payoutId,
          amount,
          currencyCode,
          providerTransferReference: transfer.providerTransferReference,
        });
        const providerPayout =
          await deps.moneyMovementGateway.createConnectedAccountPayout({
            payoutId,
            accountId: params.accountId,
            providerReference: readiness.provider_reference,
            amount,
            currencyCode,
            idempotencyKey: `settlement:payout:${payoutId}:payout`,
          });
        await recordOperation({
          kind: "provider-payout-submitted",
          accountId: params.accountId,
          payoutId,
          amount,
          currencyCode,
          providerPayoutReference: providerPayout.providerPayoutReference,
        });

        await commandHandler({
          streamId: `settlement.payout-${payoutId}`,
          command: {
            type: "MarkPayoutInTransit",
            providerTransferReference: transfer.providerTransferReference,
            providerPayoutReference: providerPayout.providerPayoutReference,
            providerStatus: providerPayout.providerStatus,
            sentAt: new Date().toISOString(),
          },
          context,
        });
      } catch (error) {
        await recordOperation({
          kind: "payout-failed",
          accountId: params.accountId,
          payoutId,
          amount,
          currencyCode,
          reason:
            error instanceof Error
              ? error.message
              : "Provider payout submission failed.",
        });
        await failPayoutAndReverseWallet(
          {
            payoutId,
            accountId: params.accountId,
            failureReason:
              error instanceof Error
                ? error.message
                : "Provider payout submission failed.",
            providerStatus: "failed",
            providerFailureMessage:
              error instanceof Error
                ? error.message
                : "Provider payout submission failed.",
            amount,
            currencyCode,
          },
          context,
        );
      }

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
          providerTransferReference: null,
          providerPayoutReference: null,
          providerStatus: null,
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
          providerStatus: null,
          completedAt: params.completedAt ?? new Date().toISOString(),
        },
        context,
      });

      return {
        payoutId: params.payoutId,
        version: result.version,
      };
    },
    failPayout: failPayoutAndReverseWallet,
    async processMoneyMovementWebhook(params, context) {
      const event = await deps.moneyMovementGateway.parseMoneyMovementWebhook(params);
      if (!event) {
        await recordOperation({
          kind: "money-movement-webhook-ignored",
          reason: "Provider webhook event was unsupported.",
        });
        return { received: true, ignored: true };
      }
      return handleMoneyMovementEvent(event, context);
    },
    async reconcileProviderPayout(params, context) {
      const payout = await getPayoutByProviderPayoutReference(
        deps.db,
        params.providerPayoutReference,
      );
      if (!payout) {
        await recordOperation({
          kind: "money-movement-webhook-ignored",
          providerPayoutReference: params.providerPayoutReference,
          reason: "Payout not found during reconciliation.",
        });
        return { received: true, ignored: true };
      }

      const readiness = await deps.payoutReadiness.getPayoutReadiness(
        payout.account_id,
      );
      if (!readiness.provider_reference) {
        throw new SettlementDomainError(
          "Payout setup must include a provider account for reconciliation.",
        );
      }

      const providerPayout =
        await deps.moneyMovementGateway.retrieveConnectedAccountPayout({
          providerReference: readiness.provider_reference,
          providerPayoutReference: params.providerPayoutReference,
        });

      if (["paid", "succeeded", "completed"].includes(providerPayout.providerStatus)) {
        const result = await commandHandler({
          streamId: `settlement.payout-${payout.payout_id}`,
          command: {
            type: "CompletePayout",
            providerStatus: providerPayout.providerStatus,
            completedAt: new Date().toISOString(),
          },
          context,
        });
        if (result.newEvents.length > 0) {
          await recordOperation({
            kind: "payout-completed",
            accountId: payout.account_id,
            payoutId: payout.payout_id,
            providerPayoutReference: params.providerPayoutReference,
          });
        }
        return { received: true, ignored: result.newEvents.length === 0 };
      }

      if (["failed", "canceled", "cancelled"].includes(providerPayout.providerStatus)) {
        await failPayoutAndReverseWallet(
          {
            payoutId: payout.payout_id,
            accountId: payout.account_id,
            failureReason: providerPayout.failureMessage,
            providerStatus: providerPayout.providerStatus,
            providerFailureCode: providerPayout.failureCode,
            providerFailureMessage: providerPayout.failureMessage,
          },
          context,
        );
        await recordOperation({
          kind: "payout-failed",
          accountId: payout.account_id,
          payoutId: payout.payout_id,
          providerPayoutReference: params.providerPayoutReference,
          reason: providerPayout.failureMessage,
        });
        return { received: true, ignored: false };
      }

      return { received: true, ignored: true };
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
