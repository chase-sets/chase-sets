import { createAggregateCommandHandler } from "@chase-sets/event-core/aggregate-command-handler";
import { createPassthroughDomainEventCodec } from "@chase-sets/event-core/codec";
import type { CommandHandler } from "@chase-sets/event-core/command-handler";
import type { EventStore } from "@chase-sets/event-core/event-store";
import { createProjectionHandlerSet, type ProjectionHandlerSet } from "@chase-sets/event-core/projector";
import type { ProjectionCheckpointStore } from "@chase-sets/event-core/projector";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type { PolicyRuntime } from "@chase-sets/platform-policy/runtime";
import type { NotificationOutbox } from "@chase-sets/outbound-messaging";
import type { AccountId, LedgerEntryId, OrderId, PaymentId, PayoutId } from "@chase-sets/primitives/typed-ids";
import { settlementClearancePolicy, type SettlementClearancePolicyValue } from "../domain/clearance-policy";
import {
  getLedgerSaleCreditTotalForMonth,
  getWallet,
  listExpiredActiveSpendHolds,
  listNegativeBalanceAccounts,
  listNegativeBalanceCollectionsCandidates,
  listPendingCreditEntriesMaturedBy,
  listWalletEntries,
  type SettlementLedgerEntryRow,
  type SettlementWalletRow,
} from "../read-model/queries";
import { buildWalletProjectionHandlers } from "../read-model/projection";
import { buildWalletAdjustmentProjectionHandlers } from "../read-model/wallet-adjustment-projection";
import {
  getWalletAdjustmentForAccount,
  type SettlementWalletAdjustmentAccountDetailRow,
} from "../read-model/wallet-adjustment-queries";
import {
  decideWallet,
  evolveWallet,
  initialWalletState,
  type WalletLedgerEntryPostedEvent,
  type WalletCommand,
  type WalletEvent,
  type WalletSpendHoldPlacedEvent,
  type WalletSpendHoldReleaseReason,
  type WalletState,
} from "../domain/domain";
import {
  SettlementDomainError,
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
  negativeBalancePolicy?: NegativeBalancePolicy;
  /** The settlement-owned platform-policy runtime; absent falls back to the compiled clearance-policy default. */
  policies?: Pick<PolicyRuntime, "resolvePolicy">;
  /** Enqueues Wallet Adjustment account notices; omitted in tests that don't exercise notifications. */
  notificationOutbox?: NotificationOutbox;
}>;

export type NegativeBalancePolicy = Readonly<{
  collectionsThresholdAmount: string;
  collectionsGracePeriodDays: number;
}>;

export const defaultNegativeBalancePolicy: NegativeBalancePolicy = {
  collectionsThresholdAmount: "100.00",
  collectionsGracePeriodDays: 14,
};

export type PostedLedgerEntrySnapshot = Readonly<{
  ledger_entry_id: string;
  account_id: string;
  kind: string;
  direction: string;
  amount: string;
  currency_code: string;
  funds_status: string;
  order_id: string | null;
  payment_id: string | null;
  payout_id: string | null;
  description: string | null;
  posted_at: string;
  available_at: string | null;
  updated_at: string;
}>;

export type WalletServices = Readonly<{
  commandHandler: CommandHandler<WalletCommand, WalletState, WalletEvent>;
  /** Loads the wallet aggregate state from the event store, so callers can read the authoritative balance without waiting on the read model. */
  loadWalletState: (accountId: AccountId) => Promise<WalletState>;
  getWallet: (accountId: string) => Promise<SettlementWalletRow>;
  listWalletEntries: (
    params: Readonly<{ accountId: string; limit?: number; offset?: number }>,
  ) => Promise<{ items: SettlementLedgerEntryRow[]; total: number }>;
  /** Self-scoped, account-safe Wallet Adjustment detail lookup for the account-facing ledger detail surface; returns null for any adjustment not owned by `accountId`. */
  getWalletAdjustmentForAccount: (
    params: Readonly<{ reference: string; accountId: string }>,
  ) => Promise<SettlementWalletAdjustmentAccountDetailRow | null>;
  listNegativeBalanceAccounts: (
    params?: Readonly<{ limit?: number; offset?: number }>,
  ) => Promise<{ items: SettlementWalletRow[]; total: number }>;
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
      allowNegativeBalance?: boolean;
    }>,
    context: EventStoreContext,
  ) => Promise<{ accountId: AccountId; version: number; entry: PostedLedgerEntrySnapshot }>;
  releasePendingEntry: (
    params: Readonly<{
      accountId: AccountId;
      ledgerEntryId: LedgerEntryId;
      availableAt?: string;
    }>,
    context: EventStoreContext,
  ) => Promise<{ accountId: AccountId; version: number }>;
  /**
   * Authoritatively reserves buyer-spend credit at checkout / payment creation.
   * Commits under optimistic concurrency with a bounded retry, so two concurrent
   * checkouts against the same wallet serialize: the second re-reads the first's
   * hold and is capped to the balance still unheld. Returns the amount actually
   * held, which may be less than requested (or "0.00") under contention.
   */
  placeSpendHold: (
    params: Readonly<{
      accountId: AccountId;
      holdId: string;
      paymentId?: PaymentId | null;
      amount: string;
      currencyCode?: CurrencyCode;
      placedAt?: string;
      expiresAt?: string | null;
    }>,
    context: EventStoreContext,
  ) => Promise<{ accountId: AccountId; holdId: string; heldAmount: string }>;
  /** Releases a buyer-spend hold, returning the reserved amount to spendable availability. Idempotent; no-op for an unknown or already-released hold. */
  releaseSpendHold: (
    params: Readonly<{
      accountId: AccountId;
      holdId: string;
      reason: WalletSpendHoldReleaseReason;
      releasedAt?: string;
    }>,
    context: EventStoreContext,
  ) => Promise<{ accountId: AccountId; holdId: string; released: boolean }>;
  /** Releases active spend holds whose expiry has elapsed -- the backstop against holds leaking on payments that never conclude. */
  sweepExpiredSpendHolds: (
    params: Readonly<{ now?: string; limit?: number }>,
    context: EventStoreContext,
  ) => Promise<{ released: number; skipped: number }>;
  releaseMaturePendingSaleCredits: (
    params: Readonly<{
      now?: string;
      limit?: number;
      claimOwnerId?: string;
      claimTtlMs?: number;
    }>,
    context: EventStoreContext,
  ) => Promise<{ released: number; skipped: number }>;
  evaluateNegativeBalanceCollections: (
    params: Readonly<{
      now?: string;
      limit?: number;
      collectionsThresholdAmount?: string;
      collectionsGracePeriodDays?: number;
    }>,
    context: EventStoreContext,
  ) => Promise<{ escalated: number; skipped: number }>;
  /** Cross-context read for platform-operations' tape-vs-ledger GMV reconciliation drift alarm. */
  getLedgerSaleCreditTotalForMonth: (params: Readonly<{ yearMonth: string }>) => Promise<string>;
  projectors: readonly ProjectionHandlerSet[];
}>;

/** Bounded compare-and-set attempts for spend-hold commits (matches the commercial-terms policy-window commit). */
const SPEND_HOLD_MAX_COMMIT_ATTEMPTS = 5;

function isConcurrencyConflict(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "concurrency_conflict");
}

function postedEntrySnapshot(event: WalletLedgerEntryPostedEvent): PostedLedgerEntrySnapshot {
  return {
    ledger_entry_id: event.data.ledgerEntryId,
    account_id: event.data.accountId,
    kind: event.data.kind,
    direction: event.data.direction,
    amount: event.data.amount,
    currency_code: event.data.currencyCode,
    funds_status: event.data.fundsStatus,
    order_id: event.data.orderId,
    payment_id: event.data.paymentId,
    payout_id: event.data.payoutId,
    description: event.data.description,
    posted_at: event.data.postedAt,
    available_at: null,
    updated_at: event.data.postedAt,
  };
}

export function createWalletRuntime(deps: WalletRuntimeDeps): WalletServices {
  const negativeBalancePolicy = deps.negativeBalancePolicy ?? defaultNegativeBalancePolicy;
  const { commandHandler, repository } = createAggregateCommandHandler({
    eventStore: deps.eventStore,
    codec: createPassthroughDomainEventCodec<WalletEvent>(),
    initialState: () => initialWalletState,
    evolve: evolveWallet,
    decide: decideWallet,
  });

  /**
   * Resolves the settlement clearance policy in effect at `at`. When no
   * `policies` runtime is wired (standalone/test usage) this falls back to
   * the compiled launch values -- an empty or absent policy table can never
   * break the maturity release hot path.
   */
  async function resolveClearancePolicy(at?: string): Promise<SettlementClearancePolicyValue> {
    if (!deps.policies) {
      return settlementClearancePolicy.defaultValue;
    }
    const resolved = await deps.policies.resolvePolicy(settlementClearancePolicy, at ? { at } : undefined);
    return resolved.value;
  }

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

  async function releaseSpendHoldImpl(
    params: Readonly<{
      accountId: AccountId;
      holdId: string;
      reason: WalletSpendHoldReleaseReason;
      releasedAt?: string;
    }>,
    context: EventStoreContext,
  ): Promise<{ accountId: AccountId; holdId: string; released: boolean }> {
    const releasedAt = params.releasedAt ?? new Date().toISOString();
    const streamId = `settlement.wallet-${params.accountId}`;

    for (let attempt = 0; attempt < SPEND_HOLD_MAX_COMMIT_ATTEMPTS; attempt += 1) {
      try {
        const result = await commandHandler({
          streamId,
          command: {
            type: "ReleaseSpendHold",
            holdId: params.holdId,
            reason: params.reason,
            releasedAt,
          },
          context,
        });
        const released = result.newEvents.some((event) => event.type === "settlement.wallet.spend-hold-released");
        return { accountId: params.accountId, holdId: params.holdId, released };
      } catch (error) {
        if (!isConcurrencyConflict(error) || attempt === SPEND_HOLD_MAX_COMMIT_ATTEMPTS - 1) {
          throw error;
        }
      }
    }
    throw new SettlementDomainError("Spend hold release did not converge.");
  }

  return {
    commandHandler,
    loadWalletState: async (accountId) => {
      const loaded = await repository.load(`settlement.wallet-${accountId}`);
      return loaded.state;
    },
    getWallet: (accountId) => getWallet(deps.db, accountId),
    listWalletEntries: (params) => listWalletEntries(deps.db, params),
    getWalletAdjustmentForAccount: (params) => getWalletAdjustmentForAccount(deps.db, params),
    listNegativeBalanceAccounts: (params = {}) => listNegativeBalanceAccounts(deps.db, params),
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
          allowNegativeBalance: params.allowNegativeBalance,
        },
        context,
      });
      const entryEvent = result.newEvents.find(
        (event): event is WalletLedgerEntryPostedEvent => event.type === "settlement.wallet.ledger-entry-posted",
      );
      if (!entryEvent) {
        throw new SettlementDomainError("Wallet command did not produce a committed ledger entry snapshot.");
      }

      return {
        accountId: params.accountId,
        version: result.version,
        entry: postedEntrySnapshot(entryEvent),
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
    async placeSpendHold(params, context) {
      const placedAt = params.placedAt ?? new Date().toISOString();
      const currencyCode = normalizeCurrencyCode(params.currencyCode ?? "usd");
      const amount = normalizeMoneyAmount(params.amount, { fieldName: "Spend hold amount", allowZero: true });
      await ensureWallet({ accountId: params.accountId, currencyCode, openedAt: placedAt }, context);
      const streamId = `settlement.wallet-${params.accountId}`;

      // Bounded compare-and-set retry mirroring the commercial-terms policy-window
      // commit: each attempt re-loads the wallet stream, re-decides against fresh
      // in-aggregate state, and appends with the loaded version. A concurrent hold
      // that committed first makes this append conflict; the retry then observes
      // that hold and the decider caps this reservation to the balance still
      // unheld. That is the exact mechanism that closes the double-spend race.
      for (let attempt = 0; attempt < SPEND_HOLD_MAX_COMMIT_ATTEMPTS; attempt += 1) {
        try {
          const result = await commandHandler({
            streamId,
            command: {
              type: "PlaceSpendHold",
              holdId: params.holdId,
              paymentId: params.paymentId ?? null,
              amount,
              currencyCode,
              placedAt,
              expiresAt: params.expiresAt ?? null,
            },
            context,
          });
          const placed = result.newEvents.find(
            (event): event is WalletSpendHoldPlacedEvent => event.type === "settlement.wallet.spend-hold-placed",
          );
          if (placed) {
            return { accountId: params.accountId, holdId: params.holdId, heldAmount: placed.data.amount };
          }
          // No event: either an idempotent replay of an existing hold, or nothing
          // was spendable. Report the effective active reservation for this id.
          const existing = result.state.spendHolds.find(
            (hold) => hold.holdId === params.holdId && hold.status === "active",
          );
          return { accountId: params.accountId, holdId: params.holdId, heldAmount: existing?.amount ?? "0.00" };
        } catch (error) {
          if (!isConcurrencyConflict(error) || attempt === SPEND_HOLD_MAX_COMMIT_ATTEMPTS - 1) {
            throw error;
          }
        }
      }
      throw new SettlementDomainError("Spend hold placement did not converge.");
    },
    releaseSpendHold: (params, context) => releaseSpendHoldImpl(params, context),
    async sweepExpiredSpendHolds(params, context) {
      const now = params.now ?? new Date().toISOString();
      const expired = await listExpiredActiveSpendHolds(deps.db, { now, limit: params.limit });
      let released = 0;
      let skipped = 0;

      for (const hold of expired) {
        const result = await releaseSpendHoldImpl(
          {
            accountId: hold.account_id as AccountId,
            holdId: hold.hold_id,
            reason: "expired",
            releasedAt: now,
          },
          context,
        );
        if (result.released) {
          released += 1;
        } else {
          skipped += 1;
        }
      }

      return { released, skipped };
    },
    async releaseMaturePendingSaleCredits(params, context) {
      const now = params.now ?? new Date().toISOString();
      const clearancePolicy = await resolveClearancePolicy(now);
      const entries = await listPendingCreditEntriesMaturedBy(deps.db, {
        now,
        baseClearanceDays: clearancePolicy.baseClearanceDays,
        extendedClearanceDays: clearancePolicy.extendedClearanceDays,
        highValueThresholdAmount: clearancePolicy.highValueThresholdAmount,
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
    async evaluateNegativeBalanceCollections(params, context) {
      const now = params.now ?? new Date().toISOString();
      const collectionsThresholdAmount =
        params.collectionsThresholdAmount ?? negativeBalancePolicy.collectionsThresholdAmount;
      const collectionsGracePeriodDays =
        params.collectionsGracePeriodDays ?? negativeBalancePolicy.collectionsGracePeriodDays;
      const candidates = await listNegativeBalanceCollectionsCandidates(deps.db, {
        now,
        thresholdAmount: collectionsThresholdAmount,
        gracePeriodDays: collectionsGracePeriodDays,
        limit: params.limit,
      });
      let escalated = 0;
      let skipped = 0;

      for (const candidate of candidates) {
        const result = await commandHandler({
          streamId: `settlement.wallet-${candidate.account_id}`,
          command: {
            type: "EvaluateNegativeBalanceCollections",
            collectionsThresholdAmount,
            collectionsGracePeriodDays,
            evaluatedAt: now,
          },
          context,
        });
        if (result.newEvents.some((event) => event.type === "settlement.wallet.negative-balance-collections-opened")) {
          escalated += 1;
        } else {
          skipped += 1;
        }
      }

      return { escalated, skipped };
    },
    getLedgerSaleCreditTotalForMonth: (params) => getLedgerSaleCreditTotalForMonth(deps.db, params),
    projectors: [
      createProjectionHandlerSet({
        projectionName: "settlement-wallet-projection",
        handlers: {
          ...buildWalletProjectionHandlers(deps.db),
          ...buildWalletAdjustmentProjectionHandlers(deps.db, deps.notificationOutbox),
        },
      }),
    ],
  };
}
