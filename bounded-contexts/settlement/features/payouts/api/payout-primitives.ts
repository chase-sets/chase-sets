import type { AggregateRepository } from "@chase-sets/event-core/aggregate-repository";
import type { DomainEventCodec } from "@chase-sets/event-core/codec";
import { recordCommittedEvents } from "@chase-sets/event-core/consistency";
import type { CommandHandler } from "@chase-sets/event-core/command-handler";
import { applyEvents } from "@chase-sets/event-core/domain";
import { readCompleteStream } from "@chase-sets/event-core/complete-stream";
import type { EventStoreError } from "@chase-sets/event-core/event-store";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import { isDurableJobHandoffError } from "@chase-sets/platform-runtime/durable-job-store";
import { deriveDisplayReferenceOrRaw } from "@chase-sets/primitives/display-reference";
import { sumMoneyAmounts } from "@chase-sets/primitives/money";
import type { AccountId, LedgerEntryId, PayoutId } from "@chase-sets/primitives/typed-ids";
import {
  normalizeCurrencyCode,
  normalizeMoneyAmount,
  SettlementDomainError,
} from "../../../support/runtime-support/common";
import { classifySettlementProviderError, type SettlementOperationsRecorder } from "./operations";
import { getPayout, listActivePayoutIdsInUtcMonth } from "../read-model/queries";
import {
  decidePayout,
  evolvePayout,
  payoutMonthStreamId,
  planPayoutMonthFailure,
  type PayoutCommand,
  type PayoutEvent,
  type PayoutMonthEvent,
  type PayoutMonthState,
  type PayoutState,
} from "../domain/domain";
import type { PayoutCommandSnapshot, PayoutReconciliationJobProgress, PayoutRuntimeDeps } from "./runtime";

type PayoutWalletLedgerEntry = Readonly<{
  ledgerEntryId?: string;
  kind?: string;
  direction?: string;
  payoutId?: string | null;
  amount?: string;
  currencyCode?: string;
}>;

export type PayoutAggregates = Readonly<{
  commandHandler: CommandHandler<PayoutCommand, PayoutState, PayoutEvent>;
  repository: AggregateRepository<PayoutState, PayoutEvent>;
  payoutMonthRepository: AggregateRepository<PayoutMonthState, PayoutMonthEvent>;
  payoutCodec: DomainEventCodec<PayoutEvent>;
  payoutMonthCodec: DomainEventCodec<PayoutMonthEvent>;
}>;

export type PayoutPrimitives = ReturnType<typeof createPayoutPrimitives>;

export function payoutDebitLedgerEntryId(payoutId: string): LedgerEntryId {
  return `led_payout_${payoutId}` as LedgerEntryId;
}

function payoutReversalLedgerEntryId(payoutId: string): LedgerEntryId {
  return `led_payout_reversal_${payoutId}` as LedgerEntryId;
}

export function payoutFeeDebitLedgerEntryId(payoutId: string): LedgerEntryId {
  return `led_payout_fee_${payoutId}` as LedgerEntryId;
}

function payoutFeeReversalLedgerEntryId(payoutId: string): LedgerEntryId {
  return `led_payout_fee_reversal_${payoutId}` as LedgerEntryId;
}

export function payoutAmounts(value: object) {
  const fields = value as Readonly<Record<string, unknown>>;
  const legacyAmount = typeof fields.amount === "string" ? fields.amount : null;
  const requestedAmount = typeof fields.requested_amount === "string" ? fields.requested_amount : legacyAmount;
  const feeAmount = typeof fields.fee_amount === "string" ? fields.fee_amount : "0.00";
  const netAmount = typeof fields.net_amount === "string" ? fields.net_amount : legacyAmount;
  if (!requestedAmount || !netAmount) {
    throw new SettlementDomainError("Payout amounts were not found.");
  }
  return { requestedAmount, feeAmount, netAmount } as const;
}

function isDuplicateLedgerEntryError(error: unknown) {
  return error instanceof Error && error.message === "Ledger entry has already been posted.";
}

export function isConcurrencyConflict(error: unknown): error is EventStoreError {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "concurrency_conflict");
}

export function providerErrorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

export function isTerminalProviderFailure(error: unknown) {
  return ["missing_provider_account", "provider_validation"].includes(classifySettlementProviderError(error));
}

export function requirePayoutSnapshot(state: PayoutState, version: number): PayoutCommandSnapshot {
  if (
    !state.payoutId ||
    !state.accountId ||
    !state.requestedAmount ||
    state.feeAmount === null ||
    !state.netAmount ||
    !state.currencyCode ||
    !state.status ||
    !state.requestedAt
  ) {
    throw new SettlementDomainError("Payout command did not produce a committed payout snapshot.");
  }

  return {
    payout_id: state.payoutId,
    account_id: state.accountId,
    requested_amount: state.requestedAmount,
    fee_amount: state.feeAmount,
    net_amount: state.netAmount,
    currency_code: state.currencyCode,
    destination_reference: state.destinationReference,
    note: state.note,
    status: state.status,
    provider_transfer_reference: state.providerTransferReference,
    provider_payout_reference: state.providerPayoutReference,
    provider_status: state.providerStatus,
    provider_failure_code: state.providerFailureCode,
    provider_failure_message: state.providerFailureMessage,
    requested_at: state.requestedAt,
    sent_at: state.sentAt,
    completed_at: state.completedAt,
    failed_at: state.failedAt,
    failure_reason: state.failureReason,
    updated_at: state.completedAt ?? state.failedAt ?? state.sentAt ?? state.requestedAt,
    version,
  };
}

export function calculateCanonicalMoneyOrThrow<T>(message: string, calculate: () => T): T {
  try {
    return calculate();
  } catch (error) {
    if (error instanceof Error && error.name === "Error" && error.message.startsWith("Money ")) {
      throw new SettlementDomainError(message);
    }
    throw error;
  }
}

export function payoutReconciliationJobProgress(
  phase: PayoutReconciliationJobProgress["phase"],
  completed: number,
  total: number,
  message: string | null,
): PayoutReconciliationJobProgress {
  return {
    phase,
    completed,
    total,
    message,
  };
}

export function isPayoutReconciliationJobHandoff(error: unknown, input?: { signal?: AbortSignal }) {
  return isDurableJobHandoffError(error, input);
}

/**
 * The payout transaction and ledger primitives that more than one behavior
 * family needs: the request lifecycle, provider-event processing and
 * reconciliation all record provider references and fail payouts through the
 * same atomic payout/month appends and fixed reversal ledger identities.
 */
export function createPayoutPrimitives(
  deps: Pick<PayoutRuntimeDeps, "eventStore" | "db" | "wallets" | "moneyMovementGateway">,
  aggregates: PayoutAggregates,
  operationsRecorder: SettlementOperationsRecorder,
) {
  const { commandHandler, repository, payoutMonthRepository, payoutCodec, payoutMonthCodec } = aggregates;

  async function recordOperation(
    event: Omit<Parameters<SettlementOperationsRecorder["record"]>[0], "occurredAt"> &
      Partial<Pick<Parameters<SettlementOperationsRecorder["record"]>[0], "occurredAt">>,
  ) {
    await operationsRecorder.record({
      ...event,
      providerName: event.providerName ?? deps.moneyMovementGateway.providerName,
      occurredAt: event.occurredAt ?? new Date().toISOString(),
    });
  }

  async function recordPayoutProviderReferences(
    params: Readonly<{
      payoutId: string;
      providerTransferReference?: string | null;
      providerPayoutReference?: string | null;
      providerStatus?: string | null;
      recordedAt?: string;
    }>,
    context: EventStoreContext,
  ) {
    const result = await commandHandler({
      streamId: `settlement.payout-${params.payoutId}`,
      command: {
        type: "RecordPayoutProviderReferences",
        providerTransferReference: params.providerTransferReference ?? null,
        providerPayoutReference: params.providerPayoutReference ?? null,
        providerStatus: params.providerStatus ?? null,
        recordedAt: params.recordedAt ?? new Date().toISOString(),
      },
      context,
    });

    return {
      payoutId: params.payoutId as PayoutId,
      version: result.version,
      payout: requirePayoutSnapshot(result.state, result.version),
    };
  }

  async function getCommittedPayoutLedgerEntry(accountId: string, ledgerEntryId: LedgerEntryId) {
    const events = await readCompleteStream(deps.eventStore, {
      streamId: `settlement.wallet-${accountId}`,
    });
    return (
      events
        .filter((event) => event.eventType === "settlement.wallet.ledger-entry-posted")
        .map((event) => event.payload as PayoutWalletLedgerEntry)
        .find((entry) => entry.ledgerEntryId === ledgerEntryId) ?? null
    );
  }

  function requireAtomicPayoutAppend() {
    const appendToStreams = deps.eventStore.appendToStreams;
    if (!appendToStreams) {
      throw new SettlementDomainError("Atomic payout month writes are unavailable.");
    }
    return appendToStreams;
  }

  async function activePayoutBaselineIds(accountId: string, at: string) {
    return (await listActivePayoutIdsInUtcMonth(deps.db, { accountId, at })) as readonly PayoutId[];
  }

  async function commitPayoutFailure(
    params: Readonly<{
      payoutId: string;
      accountId: string;
      failureReason?: string | null;
      providerStatus?: string | null;
      providerFailureCode?: string | null;
      providerFailureMessage?: string | null;
      failedAt: string;
    }>,
    context: EventStoreContext,
  ) {
    const appendToStreams = requireAtomicPayoutAppend();
    const payoutStreamId = `settlement.payout-${params.payoutId}`;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const payout = await repository.load(payoutStreamId);
      if (!payout.state.payoutId) {
        throw new SettlementDomainError("Payout was not found.");
      }
      if (!payout.state.requestedAt) {
        throw new SettlementDomainError("Payout request month was not found.");
      }
      const monthStreamId = payoutMonthStreamId(params.accountId as AccountId, payout.state.requestedAt);
      const month = await payoutMonthRepository.load(monthStreamId);
      const payoutEvents = decidePayout(payout.state, {
        type: "FailPayout",
        failureReason: params.failureReason ?? null,
        providerStatus: params.providerStatus ?? null,
        providerFailureCode: params.providerFailureCode ?? null,
        providerFailureMessage: params.providerFailureMessage ?? null,
        failedAt: params.failedAt,
      });
      const baselineActivePayoutIds = month.state.initialized
        ? []
        : await activePayoutBaselineIds(params.accountId, payout.state.requestedAt);
      const monthEvents = planPayoutMonthFailure(month.state, {
        accountId: params.accountId as AccountId,
        payoutId: params.payoutId as PayoutId,
        failedAt: params.failedAt,
        baselineActivePayoutIds,
      });
      if (payoutEvents.length === 0 && monthEvents.length === 0) {
        return {
          payoutId: params.payoutId,
          version: payout.version,
          payout: requirePayoutSnapshot(payout.state, payout.version),
        };
      }
      try {
        const stored = await appendToStreams([
          {
            streamId: monthStreamId,
            expectedVersion: month.version,
            context,
            events: monthEvents.map(payoutMonthCodec.encode),
          },
          {
            streamId: payoutStreamId,
            expectedVersion: payout.version,
            context,
            events: payoutEvents.map(payoutCodec.encode),
          },
        ]);
        recordCommittedEvents(
          stored.flatMap((result) => result.storedEvents),
          "settlement",
        );
        const nextState = applyEvents(payout.state, evolvePayout, payoutEvents);
        return {
          payoutId: params.payoutId,
          version: payout.version + payoutEvents.length,
          payout: requirePayoutSnapshot(nextState, payout.version + payoutEvents.length),
        };
      } catch (error) {
        if (!isConcurrencyConflict(error) || attempt === 4) {
          throw error;
        }
      }
    }
    throw new SettlementDomainError("Payout failure did not converge.");
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
      netAmount?: string;
      feeAmount?: string;
      currencyCode?: string;
    }>,
    context: EventStoreContext,
  ) {
    const payout =
      (await getPayout(deps.db, params.payoutId, params.accountId)) ??
      (params.netAmount && params.feeAmount && params.currencyCode
        ? {
            payout_id: params.payoutId,
            account_id: params.accountId,
            amount: params.netAmount,
            requested_amount: calculateCanonicalMoneyOrThrow("Payout requested amount must be valid.", () =>
              sumMoneyAmounts([params.netAmount!, params.feeAmount!]),
            ),
            fee_amount: params.feeAmount,
            net_amount: params.netAmount,
            currency_code: params.currencyCode,
          }
        : null);
    if (!payout) {
      throw new SettlementDomainError("Payout was not found.");
    }
    const amounts = payoutAmounts(payout);
    const failedAt = params.failedAt ?? new Date().toISOString();
    const result = await commitPayoutFailure({ ...params, failedAt }, context);
    const reversals = [
      {
        debitLedgerEntryId: payoutDebitLedgerEntryId(payout.payout_id),
        reversalLedgerEntryId: payoutReversalLedgerEntryId(payout.payout_id),
        kind: "payout-reversal",
        fallbackAmount: amounts.netAmount,
      },
      {
        debitLedgerEntryId: payoutFeeDebitLedgerEntryId(payout.payout_id),
        reversalLedgerEntryId: payoutFeeReversalLedgerEntryId(payout.payout_id),
        kind: "fee",
        fallbackAmount: amounts.feeAmount,
      },
    ] as const;
    for (const reversal of reversals) {
      const debitEntry = await getCommittedPayoutLedgerEntry(payout.account_id, reversal.debitLedgerEntryId);
      const reversalEntry = await getCommittedPayoutLedgerEntry(payout.account_id, reversal.reversalLedgerEntryId);
      if (!debitEntry || reversalEntry) {
        continue;
      }
      const reversalAmount = normalizeMoneyAmount(debitEntry.amount ?? reversal.fallbackAmount, {
        fieldName: "Payout reversal amount",
        allowZero: reversal.kind === "fee",
      });
      try {
        await deps.wallets.postEntry(
          {
            accountId: payout.account_id as AccountId,
            ledgerEntryId: reversal.reversalLedgerEntryId,
            kind: reversal.kind,
            direction: "credit",
            amount: reversalAmount,
            currencyCode: normalizeCurrencyCode(payout.currency_code),
            fundsStatus: "available",
            payoutId: payout.payout_id as PayoutId,
            description:
              params.failureReason ??
              params.providerFailureMessage ??
              `Reversed failed payout ${deriveDisplayReferenceOrRaw(payout.payout_id as PayoutId)}`,
            postedAt: failedAt,
          },
          context,
        );
      } catch (error) {
        if (!isDuplicateLedgerEntryError(error)) {
          throw error;
        }
      }
      await recordOperation({
        kind: "payout-reversal-posted",
        accountId: payout.account_id,
        payoutId: payout.payout_id,
        amount: reversalAmount,
        currencyCode: payout.currency_code,
        reason:
          params.failureReason ??
          params.providerFailureMessage ??
          `Reversed failed payout ${deriveDisplayReferenceOrRaw(payout.payout_id as PayoutId)}`,
      });
    }

    return {
      payoutId: params.payoutId,
      version: result.version,
      payout: result.payout,
    };
  }

  return {
    ...aggregates,
    recordOperation,
    recordPayoutProviderReferences,
    requireAtomicPayoutAppend,
    activePayoutBaselineIds,
    failPayoutAndReverseWallet,
  };
}
