import { createAggregateCommandHandler } from "@chase-sets/event-core/aggregate-command-handler";
import { createPassthroughDomainEventCodec } from "@chase-sets/event-core/codec";
import type { CommandHandler } from "@chase-sets/event-core/command-handler";
import type { EventStore } from "@chase-sets/event-core/event-store";
import { createProjectionHandlerSet, type ProjectionHandlerSet } from "@chase-sets/event-core/projector";
import type { ProjectionCheckpointStore } from "@chase-sets/event-core/projector";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type { AccountId, LedgerEntryId, OrderId, PaymentId, PayoutId } from "@chase-sets/primitives/typed-ids";
import {
  getWallet,
  listPendingCreditEntriesMaturedBy,
  listWalletEntries,
  type SettlementLedgerEntryRow,
  type SettlementWalletRow,
} from "../read-model/queries";
import { buildWalletProjectionHandlers } from "../read-model/projection";
import {
  decideWallet,
  evolveWallet,
  initialWalletState,
  type WalletCommand,
  type WalletEvent,
  type WalletState,
} from "../domain/domain";
import {
  normalizeCurrencyCode,
  normalizeLedgerEntryDirection,
  normalizeLedgerEntryFundsStatus,
  normalizeLedgerEntryKind,
  normalizeMoneyAmount,
  type CurrencyCode,
  type LedgerEntryDirection,
  type LedgerEntryFundsStatus,
  type LedgerEntryKind,
} from "../../../support/runtime-support/common";

type WalletRuntimeDeps = Readonly<{
  eventStore: EventStore;
  checkpointStore: ProjectionCheckpointStore;
  db: PgQueryable;
}>;

export type WalletServices = Readonly<{
  commandHandler: CommandHandler<WalletCommand, WalletState, WalletEvent>;
  getWallet: (accountId: string) => Promise<SettlementWalletRow>;
  listWalletEntries: (
    params: Readonly<{ accountId: string; limit?: number; offset?: number }>,
  ) => Promise<{ items: SettlementLedgerEntryRow[]; total: number }>;
  ensureWallet: (
    params: Readonly<{
      accountId: AccountId;
      currencyCode?: CurrencyCode;
      openedAt?: string;
    }>,
    context: EventStoreContext,
  ) => Promise<void>;
  postEntry: (
    params: Readonly<{
      accountId: AccountId;
      ledgerEntryId: LedgerEntryId;
      kind: LedgerEntryKind;
      direction: LedgerEntryDirection;
      amount: string;
      currencyCode?: CurrencyCode;
      fundsStatus?: LedgerEntryFundsStatus;
      orderId?: OrderId | null;
      paymentId?: PaymentId | null;
      payoutId?: PayoutId | null;
      description?: string | null;
      postedAt?: string;
    }>,
    context: EventStoreContext,
  ) => Promise<{ accountId: AccountId; version: number }>;
  releasePendingEntry: (
    params: Readonly<{
      accountId: AccountId;
      ledgerEntryId: LedgerEntryId;
      availableAt?: string;
    }>,
    context: EventStoreContext,
  ) => Promise<{ accountId: AccountId; version: number }>;
  releaseMaturePendingSaleCredits: (
    params: Readonly<{
      now?: string;
      limit?: number;
      claimOwnerId?: string;
      claimTtlMs?: number;
    }>,
    context: EventStoreContext,
  ) => Promise<{ released: number; skipped: number }>;
  projectors: readonly ProjectionHandlerSet[];
}>;

export function createWalletRuntime(deps: WalletRuntimeDeps): WalletServices {
  const { commandHandler } = createAggregateCommandHandler({
    eventStore: deps.eventStore,
    codec: createPassthroughDomainEventCodec<WalletEvent>(),
    initialState: () => initialWalletState,
    evolve: evolveWallet,
    decide: decideWallet,
  });

  async function ensureWallet(
    params: Readonly<{
      accountId: AccountId;
      currencyCode?: CurrencyCode;
      openedAt?: string;
    }>,
    context: EventStoreContext,
  ) {
    await commandHandler({
      streamId: `settlement.wallet-${params.accountId}`,
      command: {
        type: "OpenWallet",
        accountId: params.accountId,
        currencyCode: normalizeCurrencyCode(params.currencyCode ?? "usd"),
        openedAt: params.openedAt ?? new Date().toISOString(),
      },
      context,
    });
  }

  return {
    commandHandler,
    getWallet: (accountId) => getWallet(deps.db, accountId),
    listWalletEntries: (params) => listWalletEntries(deps.db, params),
    ensureWallet,
    async postEntry(params, context) {
      const postedAt = params.postedAt ?? new Date().toISOString();
      const currencyCode = normalizeCurrencyCode(params.currencyCode ?? "usd");

      await ensureWallet(
        {
          accountId: params.accountId,
          currencyCode,
          openedAt: postedAt,
        },
        context,
      );

      const result = await commandHandler({
        streamId: `settlement.wallet-${params.accountId}`,
        command: {
          type: "PostLedgerEntry",
          ledgerEntryId: params.ledgerEntryId,
          kind: normalizeLedgerEntryKind(params.kind),
          direction: normalizeLedgerEntryDirection(params.direction),
          amount: normalizeMoneyAmount(params.amount, {
            fieldName: "Ledger entry amount",
          }),
          currencyCode,
          fundsStatus: normalizeLedgerEntryFundsStatus(params.fundsStatus ?? "available"),
          orderId: params.orderId ?? null,
          paymentId: params.paymentId ?? null,
          payoutId: params.payoutId ?? null,
          description: params.description ?? null,
          postedAt,
        },
        context,
      });

      return {
        accountId: params.accountId,
        version: result.version,
      };
    },
    async releasePendingEntry(params, context) {
      const result = await commandHandler({
        streamId: `settlement.wallet-${params.accountId}`,
        command: {
          type: "MarkLedgerEntryAvailable",
          ledgerEntryId: params.ledgerEntryId,
          availableAt: params.availableAt ?? new Date().toISOString(),
        },
        context,
      });

      return {
        accountId: params.accountId,
        version: result.version,
      };
    },
    async releaseMaturePendingSaleCredits(params, context) {
      const now = params.now ?? new Date().toISOString();
      const entries = await listPendingCreditEntriesMaturedBy(deps.db, {
        now,
        limit: params.limit,
        claimOwnerId: params.claimOwnerId,
        claimTtlMs: params.claimTtlMs,
      });
      let released = 0;
      let skipped = 0;

      for (const entry of entries) {
        try {
          await commandHandler({
            streamId: `settlement.wallet-${entry.account_id}`,
            command: {
              type: "MarkLedgerEntryAvailable",
              ledgerEntryId: entry.ledger_entry_id as LedgerEntryId,
              availableAt: now,
            },
            context,
          });
          released += 1;
        } catch (error) {
          if (error instanceof Error && error.message === "Ledger entry is already available.") {
            skipped += 1;
            continue;
          }
          throw error;
        }
      }

      return { released, skipped };
    },
    projectors: [
      createProjectionHandlerSet({
        projectionName: "settlement-wallet-projection",
        handlers: buildWalletProjectionHandlers(deps.db),
      }),
    ],
  };
}
