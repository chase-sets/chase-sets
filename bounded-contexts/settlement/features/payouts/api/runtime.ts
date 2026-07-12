import { createAggregateCommandHandler } from "@chase-sets/event-core/aggregate-command-handler";
import { createPassthroughDomainEventCodec } from "@chase-sets/event-core/codec";
import type { CommandHandler } from "@chase-sets/event-core/command-handler";
import type { EventStore } from "@chase-sets/event-core/event-store";
import { createProjectionHandlerSet, type ProjectionHandlerSet } from "@chase-sets/event-core/projector";
import type { ProjectionCheckpointStore } from "@chase-sets/event-core/projector";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import {
  createDurableJobExecutionContext,
  createDurableJobProgressCheckpoint,
  createPostgresDurableJobStore,
  isDurableJobHandoffError,
  runDurableJobSideEffect,
  type DurableJobEvent,
  type DurableJobExecutionContext,
  type DurableJobPublicSnapshot,
  type DurableJobRecord,
  toDurableJobPublicSnapshot,
} from "@chase-sets/platform-runtime/durable-job-store";
import {
  createPostgresDurableJobWorkUnitStore,
  isDurableJobWorkUnitTerminalAccepted,
  type DurableJobWorkUnitRecord,
  type DurableJobWorkUnitSummary,
  type DurableJobWorkUnitTerminalOutcome,
} from "@chase-sets/platform-runtime/durable-job-work-units";
import { createNoopNotificationOutbox, type NotificationOutbox } from "@chase-sets/outbound-messaging";
import {
  hasProcessedProviderWebhookEvent as hasProcessedProviderWebhookInboxEvent,
  recordProviderWebhookEvent as recordProviderWebhookInboxEvent,
} from "@chase-sets/provider-webhook-inbox";
import { deriveDisplayReferenceOrRaw } from "@chase-sets/primitives/display-reference";
import { createId } from "@chase-sets/primitives/typed-ids";
import type { AccountId, LedgerEntryId, PayoutId } from "@chase-sets/primitives/typed-ids";
import type { PolicyRuntime } from "@chase-sets/platform-policy/runtime";
import {
  compareMoney,
  normalizeCurrencyCode,
  normalizeMoneyAmount,
  SettlementDomainError,
  type PayoutStatus,
} from "../../../support/runtime-support/common";
import { moneyStatusDetails } from "@chase-sets/http/money-status";
import type { MoneyMovementGateway, MoneyMovementWebhookEvent } from "@chase-sets/money-movement";
import {
  classifySettlementProviderError,
  createNoopSettlementOperationsRecorder,
  type SettlementOperationsRecorder,
} from "./operations";
import {
  assertPayoutAmountWithinPolicy,
  payoutAmountPolicy,
  settlementPayoutBoundsPolicy,
  type SettlementPayoutBoundsPolicyValue,
} from "../domain/payout-policy";
import { buildPayoutProjectionHandlers } from "../read-model/projection";
import {
  SETTLEMENT_PAYOUT_TRANSACTIONAL_EMAIL_PROJECTION,
  buildSettlementPayoutTransactionalEmailProjectionHandlers,
} from "../integrations/transactional-email/transactional-email-projector";
import {
  getPayout,
  getAccountPayoutRiskSummary,
  getPayoutByProviderOperationReference,
  getPayoutByProviderPayoutReference,
  listSettlementProviderOperationsForPayout,
  listSettlementProviderIdempotencyKeys,
  listSettlementReconciliationRuns,
  listPayoutsNeedingReconciliation,
  renewPayoutReconciliationWorkClaim,
  listPayouts,
  recordSettlementReconciliationRun,
  recordSettlementProviderIdempotencyKey,
  recordSettlementProviderOperationFailed,
  recordSettlementProviderOperationPending,
  recordSettlementProviderOperationSucceeded,
  type SettlementReconciliationRunRow,
  type SettlementProviderIdempotencyKeyRow,
  type SettlementProviderOperationRow,
  type SettlementPayoutRow,
} from "../read-model/queries";
import type { WalletServices } from "../../wallets/api/runtime";
import { getAccountActiveSupportHoldAmount, type SettlementWalletRow } from "../../wallets/read-model/queries";
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
  notificationOutbox?: NotificationOutbox;
  payoutDestinationFrictionPolicy?: Partial<PayoutDestinationFrictionPolicy>;
  sensitiveActionVerifier?: SensitiveActionVerifier;
  /** The settlement-owned platform-policy runtime; absent falls back to the compiled payout-bounds default. */
  policies?: Pick<PolicyRuntime, "resolvePolicy">;
}>;

export type PayoutDestinationFrictionPolicy = Readonly<{
  enabled: boolean;
  coolingPeriodMs: number;
  requireStepUpForAccountManagement: boolean;
}>;

export type SensitiveActionVerifier = (
  input: Readonly<{
    accountId: AccountId;
    userId?: string | null;
    token: string;
    purpose: "payout-request" | "payout-account-management";
  }>,
) => Promise<boolean>;

type PayoutWalletLedgerEntry = Readonly<{
  ledgerEntryId?: string;
  kind?: string;
  direction?: string;
  payoutId?: string | null;
}>;

export type PayoutReconciliationJobPayload = Readonly<{
  accountId: string;
  limit: number;
}>;

export type PayoutReconciliationJobProgress = Readonly<{
  phase: "queued" | "processing" | "completed" | "failed";
  completed: number;
  total: number;
  message: string | null;
}>;

export type PayoutReconciliationJobResult = Readonly<{
  checked: number;
  reconciled: number;
  ignored: number;
  skipped: number;
  errors: readonly Readonly<{ payoutId: string; message: string }>[];
}>;

type PayoutReconciliationWorkUnitPayload = Readonly<{
  payoutId: string;
  providerPayoutReference: string | null;
}>;

type PayoutReconciliationWorkUnitResult = Readonly<{
  payoutId: string;
  status: "reconciled" | "ignored" | "skipped" | "failed";
  message: string | null;
}>;

export type PayoutReconciliationJob = DurableJobRecord<
  PayoutReconciliationJobPayload,
  PayoutReconciliationJobProgress,
  PayoutReconciliationJobResult
>;

export type PayoutReconciliationJobStatus = DurableJobPublicSnapshot<
  PayoutReconciliationJobProgress,
  PayoutReconciliationJobResult
>;

export function toPayoutReconciliationJobStatus(job: PayoutReconciliationJob): PayoutReconciliationJobStatus {
  return toDurableJobPublicSnapshot(job);
}

export type PayoutCommandSnapshot = Readonly<{
  payout_id: string;
  account_id: string;
  amount: string;
  currency_code: string;
  destination_reference: string | null;
  note: string | null;
  status: PayoutStatus;
  provider_transfer_reference: string | null;
  provider_payout_reference: string | null;
  provider_status: string | null;
  provider_failure_code: string | null;
  provider_failure_message: string | null;
  requested_at: string;
  sent_at: string | null;
  completed_at: string | null;
  failed_at: string | null;
  failure_reason: string | null;
  updated_at: string;
  version: number;
}>;

export type PayoutServices = Readonly<{
  commandHandler: CommandHandler<PayoutCommand, PayoutState, PayoutEvent>;
  listPayouts: (
    params: Readonly<{ accountId: string; limit?: number; offset?: number }>,
  ) => Promise<{ items: SettlementPayoutRow[]; total: number }>;
  getPayout: (payoutId: string, accountId: string) => Promise<SettlementPayoutRow | null>;
  getPayoutMoneyTimeline: (params: Readonly<{ payoutId: string; accountId: string }>) => Promise<
    Readonly<{
      payout_id: string;
      account_id: string;
      items: readonly Readonly<{
        occurred_at: string;
        kind: string;
        label: string;
        reference: string | null;
        amount: string | null;
        currency_code: string | null;
      }>[];
    }>
  >;
  listPayoutsNeedingReconciliation: (
    params?: Readonly<{
      limit?: number;
      filter?: string | null;
      accountId?: string | null;
      claimOwnerId?: string;
      claimTtlMs?: number;
    }>,
  ) => Promise<SettlementPayoutRow[]>;
  listProviderIdempotencyKeys: (
    params: Readonly<{ accountId: string; limit?: number }>,
  ) => Promise<SettlementProviderIdempotencyKeyRow[]>;
  listReconciliationRuns: (params?: Readonly<{ limit?: number }>) => Promise<SettlementReconciliationRunRow[]>;
  listNegativeBalanceAccounts: (
    params?: Readonly<{ limit?: number; offset?: number }>,
  ) => Promise<{ items: SettlementWalletRow[]; total: number }>;
  getPlatformBalanceForecast: (params?: Readonly<{ currencyCode?: "usd" }>) => Promise<
    Readonly<{
      currency_code: string;
      available_amount: string;
      pending_payout_demand_amount: string;
      forecast_after_pending_demand_amount: string;
    }>
  >;
  getProviderHealth: () => Promise<
    Readonly<{
      provider_name: string;
      adapter_mode: "fake" | "provider";
      webhook_signature_required: boolean;
      platform_balance_supported: boolean;
      connected_account_payouts_supported: boolean;
    }>
  >;
  previewPayoutRequest: (
    params: Readonly<{ accountId: AccountId; amount: string }>,
    context: EventStoreContext,
  ) => Promise<
    Readonly<{
      account_id: string;
      requested_amount: string;
      currency_code: string;
      available_balance_amount: string;
      platform_available_amount: string;
      estimated_wallet_balance_after: string;
      can_request: boolean;
      unavailable_reasons: readonly string[];
      unavailable_reason_details: readonly Readonly<{
        code: string;
        message: string;
      }>[];
    }>
  >;
  requestPayout: (
    params: Readonly<{
      accountId: AccountId;
      amount: string;
      destinationReference?: string | null;
      note?: string | null;
      notificationEmail?: string | null;
      actorUserId?: string | null;
      sensitiveActionToken?: string | null;
    }>,
    context: EventStoreContext,
  ) => Promise<{ payoutId: PayoutId; version: number; payout: PayoutCommandSnapshot }>;
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
  ) => Promise<{ payoutId: string; version: number; payout: PayoutCommandSnapshot }>;
  processMoneyMovementWebhook: (
    params: Readonly<{ rawBody: string; signatureHeader: string | null }>,
    context: EventStoreContext,
  ) => Promise<{ received: boolean; ignored: boolean }>;
  reconcileProviderPayout: (
    params: Readonly<{ providerPayoutReference: string }>,
    context: EventStoreContext,
  ) => Promise<{ received: boolean; ignored: boolean }>;
  reconcilePayoutsNeedingAttention: (
    params: Readonly<{ accountId?: string | null; limit?: number; claimOwnerId?: string; claimTtlMs?: number }>,
    context: EventStoreContext,
    jobContext?: DurableJobExecutionContext<PayoutReconciliationJobProgress, PayoutReconciliationJobResult>,
  ) => Promise<{
    checked: number;
    reconciled: number;
    ignored: number;
    skipped: number;
    errors: readonly Readonly<{ payoutId: string; message: string }>[];
  }>;
  enqueuePayoutReconciliationJob: (
    params: Readonly<{ limit?: number }>,
    context: EventStoreContext,
  ) => Promise<PayoutReconciliationJob>;
  getPayoutReconciliationJob: (jobId: string) => Promise<PayoutReconciliationJob | null>;
  listPayoutReconciliationJobEvents: (
    jobId: string,
    afterSequence?: number,
  ) => Promise<
    readonly DurableJobEvent<
      PayoutReconciliationJobPayload,
      PayoutReconciliationJobProgress,
      PayoutReconciliationJobResult
    >[]
  >;
  waitForPayoutReconciliationJobEvents: (jobId: string, signal?: AbortSignal) => Promise<void>;
  prunePayoutReconciliationJobRetention: (input?: {
    completedBefore?: string | Date;
    limit?: number;
  }) => Promise<number>;
  processNextPayoutReconciliationJob: (input: {
    claimOwnerId: string;
    claimTtlMs: number;
    workflowMaxActiveClaims?: number;
    jobMaxActiveClaims?: number;
    laneName?: string | null;
    signal?: AbortSignal;
    throwIfLeaseLost?: () => void;
  }) => Promise<number>;
  getPayoutReconciliationWorkUnitSummary: (input?: { jobId?: string | null }) => Promise<DurableJobWorkUnitSummary>;
  projectors: readonly ProjectionHandlerSet[];
}>;

async function requireExistingPayout(db: PgQueryable, payoutId: string, accountId: string) {
  const payout = await getPayout(db, payoutId, accountId);
  if (!payout) {
    throw new SettlementDomainError("Payout was not found.");
  }
  return payout;
}

function providerObjectReferenceFromEvent(event: MoneyMovementWebhookEvent) {
  if (event.kind === "payout-readiness-updated") {
    return event.providerReference;
  }
  return event.kind === "payout-completed" || event.kind === "payout-failed" ? event.providerPayoutReference : null;
}

function payoutDebitLedgerEntryId(payoutId: string): LedgerEntryId {
  return `led_payout_${payoutId}` as LedgerEntryId;
}

function payoutReversalLedgerEntryId(payoutId: string): LedgerEntryId {
  return `led_payout_reversal_${payoutId}` as LedgerEntryId;
}

function isDuplicateLedgerEntryError(error: unknown) {
  return error instanceof Error && error.message === "Ledger entry has already been posted.";
}

function providerErrorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

function isTerminalProviderFailure(error: unknown) {
  return ["missing_provider_account", "provider_validation"].includes(classifySettlementProviderError(error));
}

function payoutReadinessIsStale(updatedAt: string | null) {
  if (!updatedAt) {
    return false;
  }
  return Date.now() - Date.parse(updatedAt) > 30 * 24 * 60 * 60 * 1000;
}

type PayoutReadinessSnapshot = Awaited<ReturnType<PayoutReadinessServices["getPayoutReadiness"]>>;

function payoutReadinessStalenessIsOnlySetupBlocker(readiness: PayoutReadinessSnapshot) {
  return (
    readiness.status === "ready" &&
    Boolean(readiness.provider_reference) &&
    readiness.missing_requirements.length === 0 &&
    payoutReadinessIsStale(readiness.updated_at)
  );
}

const DEFAULT_PAYOUT_DESTINATION_FRICTION_POLICY: PayoutDestinationFrictionPolicy = {
  enabled: true,
  coolingPeriodMs: 24 * 60 * 60 * 1000,
  requireStepUpForAccountManagement: true,
};

function payoutDestinationFrictionPolicy(
  policy?: Partial<PayoutDestinationFrictionPolicy>,
): PayoutDestinationFrictionPolicy {
  return {
    ...DEFAULT_PAYOUT_DESTINATION_FRICTION_POLICY,
    ...policy,
  };
}

function payoutDestinationCoolingWindowEndsAt(
  readiness: PayoutReadinessSnapshot,
  policy: PayoutDestinationFrictionPolicy,
  nowMs = Date.now(),
) {
  if (!policy.enabled || !readiness.payout_destination_changed_at) {
    return null;
  }
  const changedAtMs = Date.parse(readiness.payout_destination_changed_at);
  if (!Number.isFinite(changedAtMs)) {
    return null;
  }
  const endsAtMs = changedAtMs + policy.coolingPeriodMs;
  return nowMs < endsAtMs ? new Date(endsAtMs).toISOString() : null;
}

function requirePayoutSnapshot(state: PayoutState, version: number): PayoutCommandSnapshot {
  if (
    !state.payoutId ||
    !state.accountId ||
    !state.amount ||
    !state.currencyCode ||
    !state.status ||
    !state.requestedAt
  ) {
    throw new SettlementDomainError("Payout command did not produce a committed payout snapshot.");
  }

  return {
    payout_id: state.payoutId,
    account_id: state.accountId,
    amount: state.amount,
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

function subtractMoney(left: string, right: string) {
  return (Number.parseFloat(left) - Number.parseFloat(right)).toFixed(2);
}

/**
 * Resolves the settlement payout-bounds policy in effect at `at`. When no
 * `policies` runtime is wired (standalone/test usage) this falls back to the
 * compiled launch bounds -- an empty or absent policy table can never break
 * the payout request hot path.
 */
async function resolvePayoutBoundsPolicy(
  deps: Pick<PayoutRuntimeDeps, "policies">,
  at?: string,
): Promise<SettlementPayoutBoundsPolicyValue> {
  if (!deps.policies) {
    return payoutAmountPolicy;
  }
  const resolved = await deps.policies.resolvePolicy(settlementPayoutBoundsPolicy, at ? { at } : undefined);
  return resolved.value;
}

export function createPayoutRuntime(deps: PayoutRuntimeDeps): PayoutServices {
  const jobStore = createPostgresDurableJobStore<
    PayoutReconciliationJobPayload,
    PayoutReconciliationJobProgress,
    PayoutReconciliationJobResult
  >(deps.db, {
    jobsTable: "settlement_payout_reconciliation_jobs",
    eventsTable: "settlement_payout_reconciliation_job_events",
  });
  const workUnitStore = createPostgresDurableJobWorkUnitStore<
    PayoutReconciliationJobPayload,
    PayoutReconciliationJobProgress,
    PayoutReconciliationJobResult,
    PayoutReconciliationWorkUnitPayload,
    PayoutReconciliationWorkUnitResult
  >(
    deps.db,
    {
      jobsTable: "settlement_payout_reconciliation_jobs",
      eventsTable: "settlement_payout_reconciliation_job_events",
      workUnitsTable: "settlement_payout_reconciliation_work_units",
    },
    {
      workflowName: "settlement.payout-reconciliation",
    },
  );
  const notificationOutbox = deps.notificationOutbox ?? createNoopNotificationOutbox();
  const operationsRecorder = deps.operationsRecorder ?? createNoopSettlementOperationsRecorder();
  const destinationFrictionPolicy = payoutDestinationFrictionPolicy(deps.payoutDestinationFrictionPolicy);
  const sensitiveActionVerifier = deps.sensitiveActionVerifier ?? (async () => false);
  const { commandHandler, repository } = createAggregateCommandHandler({
    eventStore: deps.eventStore,
    codec: createPassthroughDomainEventCodec<PayoutEvent>(),
    initialState: () => initialPayoutState,
    evolve: evolvePayout,
    decide: decidePayout,
  });

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

  async function verifySensitiveAction(input: Parameters<SensitiveActionVerifier>[0]) {
    if (!input.token.trim()) {
      return false;
    }
    return sensitiveActionVerifier(input);
  }

  async function getCommittedPayout(payoutId: PayoutId | null) {
    if (!payoutId) {
      return null;
    }
    const loaded = await repository.load(`settlement.payout-${payoutId}`);
    return loaded.state.payoutId ? requirePayoutSnapshot(loaded.state, loaded.version) : null;
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

  async function recordProviderWebhookEvent(event: MoneyMovementWebhookEvent) {
    return recordProviderWebhookInboxEvent(deps.db, {
      tableName: "settlement_money_movement_webhook_events",
      providerEventId: event.providerEventId,
      providerName: deps.moneyMovementGateway.providerName,
      eventKind: event.kind,
      providerObjectReference: providerObjectReferenceFromEvent(event),
    });
  }

  async function hasProcessedProviderWebhookEvent(event: MoneyMovementWebhookEvent) {
    return hasProcessedProviderWebhookInboxEvent(deps.db, {
      tableName: "settlement_money_movement_webhook_events",
      providerEventId: event.providerEventId,
    });
  }

  async function refreshPayoutReadinessWhenStalenessIsOnlyBlocker(
    accountId: AccountId,
    readiness: PayoutReadinessSnapshot,
    context: EventStoreContext,
  ) {
    if (!payoutReadinessStalenessIsOnlySetupBlocker(readiness)) {
      return readiness;
    }

    return deps.payoutReadiness.refreshProviderReadiness(
      {
        accountId,
        providerReference: readiness.provider_reference,
      },
      context,
    );
  }

  async function getCommittedPayoutLedgerEntry(accountId: string, ledgerEntryId: LedgerEntryId) {
    const events = await deps.eventStore.readStream({
      streamId: `settlement.wallet-${accountId}`,
    });
    return (
      events
        .filter((event) => event.eventType === "settlement.wallet.ledger-entry-posted")
        .map((event) => event.payload as PayoutWalletLedgerEntry)
        .find((entry) => entry.ledgerEntryId === ledgerEntryId) ?? null
    );
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
    const payout =
      (await getPayout(deps.db, params.payoutId, params.accountId)) ??
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
    const debitLedgerEntryId = payoutDebitLedgerEntryId(payout.payout_id);
    const reversalLedgerEntryId = payoutReversalLedgerEntryId(payout.payout_id);
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

    const debitEntry = await getCommittedPayoutLedgerEntry(payout.account_id, debitLedgerEntryId);
    const reversalEntry = await getCommittedPayoutLedgerEntry(payout.account_id, reversalLedgerEntryId);
    if (debitEntry && !reversalEntry) {
      try {
        await deps.wallets.postEntry(
          {
            accountId: payout.account_id as AccountId,
            ledgerEntryId: reversalLedgerEntryId,
            kind: "payout-reversal",
            direction: "credit",
            amount: payout.amount,
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
        amount: payout.amount,
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
      payout: requirePayoutSnapshot(result.state, result.version),
    };
  }

  async function handleMoneyMovementEvent(event: MoneyMovementWebhookEvent, context: EventStoreContext) {
    switch (event.kind) {
      case "payout-completed": {
        const payout =
          (await getPayoutByProviderPayoutReference(deps.db, event.providerPayoutReference)) ??
          (await getPayoutByProviderOperationReference(deps.db, event.providerPayoutReference)) ??
          (await getCommittedPayout(event.payoutId));
        if (!payout) {
          await recordOperation({
            kind: "money-movement-webhook-ignored",
            providerEventId: event.providerEventId,
            providerPayoutReference: event.providerPayoutReference,
            reason: "Payout not found for provider payout reference.",
          });
          throw new SettlementDomainError("Payout was not found for provider webhook.");
        }
        if (payout.status === "failed") {
          await recordOperation({
            kind: "money-movement-webhook-ignored",
            providerEventId: event.providerEventId,
            accountId: payout.account_id,
            payoutId: payout.payout_id,
            providerPayoutReference: event.providerPayoutReference,
            reason: "Provider reports paid for a locally failed payout; operator review is required.",
            occurredAt: event.occurredAt,
          });
          return { received: true, ignored: true };
        }
        if (!payout.provider_payout_reference) {
          await recordPayoutProviderReferences(
            {
              payoutId: payout.payout_id,
              providerPayoutReference: event.providerPayoutReference,
              providerStatus: event.providerStatus,
              recordedAt: event.occurredAt,
            },
            context,
          );
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
        const payout =
          (await getPayoutByProviderPayoutReference(deps.db, event.providerPayoutReference)) ??
          (await getPayoutByProviderOperationReference(deps.db, event.providerPayoutReference)) ??
          (await getCommittedPayout(event.payoutId));
        if (!payout) {
          await recordOperation({
            kind: "money-movement-webhook-ignored",
            providerEventId: event.providerEventId,
            providerPayoutReference: event.providerPayoutReference,
            reason: "Payout not found for provider payout reference.",
          });
          throw new SettlementDomainError("Payout was not found for provider webhook.");
        }
        if (!payout.provider_payout_reference && payout.status !== "failed") {
          await recordPayoutProviderReferences(
            {
              payoutId: payout.payout_id,
              providerPayoutReference: event.providerPayoutReference,
              providerStatus: event.providerStatus,
              recordedAt: event.occurredAt,
            },
            context,
          );
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
            amount: payout.amount,
            currencyCode: payout.currency_code,
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
        if (
          !(await deps.payoutReadiness.recordProviderReadinessFromWebhook(
            {
              providerReference: event.providerReference,
              readiness: event.readiness,
              recordedAt: event.occurredAt,
            },
            context,
          ))
        ) {
          throw new SettlementDomainError("Payout readiness target is not ready for provider webhook processing.");
        }
        return { received: true, ignored: false };
    }
  }

  async function reconcileProviderPayout(
    params: Readonly<{ providerPayoutReference: string }>,
    context: EventStoreContext,
    options: Readonly<{ signal?: AbortSignal }> = {},
  ) {
    const payout = await getPayoutByProviderPayoutReference(deps.db, params.providerPayoutReference);
    if (!payout) {
      await recordOperation({
        kind: "money-movement-webhook-ignored",
        providerPayoutReference: params.providerPayoutReference,
        reason: "Payout not found during reconciliation.",
      });
      return { received: true, ignored: true };
    }

    const readiness = await deps.payoutReadiness.getPayoutReadiness(payout.account_id);
    if (!readiness.provider_reference) {
      throw new SettlementDomainError("Payout setup must include a provider account for reconciliation.");
    }

    const providerPayout = await deps.moneyMovementGateway.retrieveConnectedAccountPayout(
      {
        providerReference: readiness.provider_reference,
        providerPayoutReference: params.providerPayoutReference,
      },
      options,
    );

    if (["paid", "succeeded", "completed"].includes(providerPayout.providerStatus)) {
      if (payout.status === "failed") {
        await recordOperation({
          kind: "money-movement-webhook-ignored",
          accountId: payout.account_id,
          payoutId: payout.payout_id,
          providerPayoutReference: params.providerPayoutReference,
          reason: "Provider reports paid for a locally failed payout; operator review is required.",
        });
        return { received: true, ignored: true };
      }
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
  }

  function providerOperationByKind(
    operations: readonly SettlementProviderOperationRow[],
    operationKind: string,
  ): SettlementProviderOperationRow | null {
    return operations.find((operation) => operation.operation_kind === operationKind) ?? null;
  }

  function providerOperationRequest(
    operation: SettlementProviderOperationRow | null,
    payout: SettlementPayoutRow,
    providerReference: string,
  ) {
    const request = operation?.request_json && typeof operation.request_json === "object" ? operation.request_json : {};
    const values = request as Record<string, unknown>;
    return {
      payoutId: typeof values.payoutId === "string" ? values.payoutId : payout.payout_id,
      accountId: typeof values.accountId === "string" ? values.accountId : payout.account_id,
      providerReference: typeof values.providerReference === "string" ? values.providerReference : providerReference,
      amount: typeof values.amount === "string" ? values.amount : payout.amount,
      currencyCode: normalizeCurrencyCode(
        typeof values.currencyCode === "string" ? values.currencyCode : payout.currency_code,
      ),
    };
  }

  async function reconcilePayoutProviderState(
    payout: SettlementPayoutRow,
    context: EventStoreContext,
  ): Promise<{ received: boolean; ignored: boolean }> {
    const readiness = await deps.payoutReadiness.getPayoutReadiness(payout.account_id);
    if (!readiness.provider_reference) {
      throw new SettlementDomainError("Payout setup must include a provider account for reconciliation.");
    }

    const operations = await listSettlementProviderOperationsForPayout(deps.db, payout.payout_id);
    const transferOperation = providerOperationByKind(operations, "platform-transfer-create");
    const payoutOperation = providerOperationByKind(operations, "connected-account-payout-create");
    let providerTransferReference =
      payout.provider_transfer_reference ?? transferOperation?.provider_object_reference ?? null;

    if (!providerTransferReference) {
      const transferOperationKey = transferOperation?.operation_key ?? `payout:${payout.payout_id}:transfer`;
      const transferIdempotencyKey =
        transferOperation?.idempotency_key ?? `settlement:payout:${payout.payout_id}:transfer`;
      const request = providerOperationRequest(transferOperation, payout, readiness.provider_reference);
      await recordSettlementProviderOperationPending(deps.db, {
        operationKey: transferOperationKey,
        providerName: deps.moneyMovementGateway.providerName,
        operationKind: "platform-transfer-create",
        accountId: request.accountId,
        payoutId: request.payoutId,
        idempotencyKey: transferIdempotencyKey,
        request,
      });
      try {
        const transfer = await deps.moneyMovementGateway.transferPlatformBalanceToConnectedAccount({
          payoutId: request.payoutId as PayoutId,
          accountId: request.accountId as AccountId,
          providerReference: request.providerReference,
          amount: request.amount,
          currencyCode: request.currencyCode,
          idempotencyKey: transferIdempotencyKey,
        });
        providerTransferReference = transfer.providerTransferReference;
        await recordSettlementProviderOperationSucceeded(deps.db, {
          operationKey: transferOperationKey,
          providerObjectReference: transfer.providerTransferReference,
        });
        await recordSettlementProviderIdempotencyKey(deps.db, {
          operationKey: transferOperationKey,
          providerName: deps.moneyMovementGateway.providerName,
          operationKind: "platform-transfer-create",
          accountId: request.accountId,
          payoutId: request.payoutId,
          providerObjectReference: transfer.providerTransferReference,
          idempotencyKey: transferIdempotencyKey,
          createdAt: new Date().toISOString(),
        });
        await recordPayoutProviderReferences(
          {
            payoutId: payout.payout_id,
            providerTransferReference: transfer.providerTransferReference,
          },
          context,
        );
      } catch (error) {
        const providerFailureMessage = providerErrorMessage(error, "Provider transfer reconciliation failed.");
        await recordSettlementProviderOperationFailed(deps.db, {
          operationKey: transferOperationKey,
          errorMessage: providerFailureMessage,
        });
        if (isTerminalProviderFailure(error)) {
          await failPayoutAndReverseWallet(
            {
              payoutId: payout.payout_id,
              accountId: payout.account_id,
              failureReason: "Payout account details need review.",
              providerStatus: "failed",
              providerFailureMessage,
              failedAt: new Date().toISOString(),
            },
            context,
          );
          return { received: true, ignored: false };
        }
        return { received: true, ignored: true };
      }
    } else if (!payout.provider_transfer_reference) {
      await recordPayoutProviderReferences(
        {
          payoutId: payout.payout_id,
          providerTransferReference,
        },
        context,
      );
    }

    const providerPayoutReference =
      payout.provider_payout_reference ?? payoutOperation?.provider_object_reference ?? null;
    if (providerPayoutReference) {
      if (!payout.provider_payout_reference) {
        await recordPayoutProviderReferences(
          {
            payoutId: payout.payout_id,
            providerTransferReference,
            providerPayoutReference,
          },
          context,
        );
      }
      return reconcileProviderPayout({ providerPayoutReference }, context);
    }

    const payoutOperationKey = payoutOperation?.operation_key ?? `payout:${payout.payout_id}:payout`;
    const payoutIdempotencyKey = payoutOperation?.idempotency_key ?? `settlement:payout:${payout.payout_id}:payout`;
    const request = providerOperationRequest(payoutOperation, payout, readiness.provider_reference);
    await recordSettlementProviderOperationPending(deps.db, {
      operationKey: payoutOperationKey,
      providerName: deps.moneyMovementGateway.providerName,
      operationKind: "connected-account-payout-create",
      accountId: request.accountId,
      payoutId: request.payoutId,
      idempotencyKey: payoutIdempotencyKey,
      request,
    });

    try {
      const providerPayout = await deps.moneyMovementGateway.createConnectedAccountPayout({
        payoutId: request.payoutId as PayoutId,
        accountId: request.accountId as AccountId,
        providerReference: request.providerReference,
        amount: request.amount,
        currencyCode: request.currencyCode,
        idempotencyKey: payoutIdempotencyKey,
      });
      await recordSettlementProviderOperationSucceeded(deps.db, {
        operationKey: payoutOperationKey,
        providerObjectReference: providerPayout.providerPayoutReference,
      });
      await recordSettlementProviderIdempotencyKey(deps.db, {
        operationKey: payoutOperationKey,
        providerName: deps.moneyMovementGateway.providerName,
        operationKind: "connected-account-payout-create",
        accountId: request.accountId,
        payoutId: request.payoutId,
        providerObjectReference: providerPayout.providerPayoutReference,
        idempotencyKey: payoutIdempotencyKey,
        createdAt: new Date().toISOString(),
      });
      await recordPayoutProviderReferences(
        {
          payoutId: payout.payout_id,
          providerTransferReference,
          providerPayoutReference: providerPayout.providerPayoutReference,
          providerStatus: providerPayout.providerStatus,
        },
        context,
      );

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
        return { received: true, ignored: result.newEvents.length === 0 };
      }

      const result = await commandHandler({
        streamId: `settlement.payout-${payout.payout_id}`,
        command: {
          type: "MarkPayoutInTransit",
          providerTransferReference,
          providerPayoutReference: providerPayout.providerPayoutReference,
          providerStatus: providerPayout.providerStatus,
          sentAt: new Date().toISOString(),
        },
        context,
      });
      return { received: true, ignored: result.newEvents.length === 0 };
    } catch (error) {
      await recordSettlementProviderOperationFailed(deps.db, {
        operationKey: payoutOperationKey,
        errorMessage: providerErrorMessage(error, "Provider payout reconciliation failed."),
      });
      return { received: true, ignored: true };
    }
  }

  const reconcilePayoutsNeedingAttention: PayoutServices["reconcilePayoutsNeedingAttention"] = async (
    params,
    context,
    jobContext,
  ) => {
    const startedAt = new Date().toISOString();
    const payouts = await listPayoutsNeedingReconciliation(deps.db, {
      accountId: params.accountId,
      limit: params.limit,
      claimOwnerId: params.claimOwnerId,
      claimTtlMs: params.claimTtlMs,
    });
    const progressCheckpoint = jobContext ? createPayoutReconciliationProgressCheckpoint(jobContext) : null;
    let reconciled = 0;
    let ignored = 0;
    let skipped = 0;
    const errors: Array<Readonly<{ payoutId: string; message: string }>> = [];
    let completed = 0;

    for (const payout of payouts) {
      jobContext?.throwIfCancelled();
      if (params.claimOwnerId && params.claimTtlMs) {
        const claimRenewed = await renewPayoutReconciliationWorkClaim(deps.db, {
          payoutId: payout.payout_id,
          claimOwnerId: params.claimOwnerId,
          claimTtlMs: params.claimTtlMs,
        });
        if (!claimRenewed) {
          throw new SettlementDomainError("Payout reconciliation work claim was lost before processing completed.");
        }
      }

      try {
        const providerPayoutReference = payout.provider_payout_reference;
        const result = await runDurableJobSideEffect(
          jobContext,
          (signal) =>
            providerPayoutReference
              ? reconcileProviderPayout({ providerPayoutReference }, context, { signal })
              : reconcilePayoutProviderState(payout, context),
          {
            renewIntervalMs: 5_000,
            claimLostMessage: "Payout reconciliation job claim was lost while reconciling a payout.",
          },
        );
        if (result.ignored) {
          ignored += 1;
        } else {
          reconciled += 1;
        }
      } catch (error) {
        if (isPayoutReconciliationJobHandoff(error, jobContext)) {
          throw error;
        }

        errors.push({
          payoutId: payout.payout_id,
          message: error instanceof Error ? error.message : "Reconciliation failed.",
        });
      }
      completed += 1;
      await progressCheckpoint?.checkpoint(
        payoutReconciliationJobProgress("processing", completed, payouts.length, "Reconciled payout."),
        compactPayoutReconciliationJobResult({ checked: completed, reconciled, ignored, skipped }),
      );
    }

    const result = {
      checked: payouts.length,
      reconciled,
      ignored,
      skipped,
      errors,
    };
    await recordSettlementReconciliationRun(deps.db, {
      reconciliationRunId: createId("rec"),
      kind: "payouts",
      checked: result.checked,
      reconciled: result.reconciled,
      ignored: result.ignored,
      skipped: result.skipped,
      errorCount: result.errors.length,
      status: result.errors.length > 0 ? "completed-with-errors" : "completed",
      summary: result,
      startedAt,
      completedAt: new Date().toISOString(),
    });

    return result;
  };

  return {
    commandHandler,
    listPayouts: (params) => listPayouts(deps.db, params),
    getPayout: (payoutId, accountId) => getPayout(deps.db, payoutId, accountId),
    async getPayoutMoneyTimeline(params) {
      const payout = await requireExistingPayout(deps.db, params.payoutId, params.accountId);
      const [walletEntries, idempotencyKeys] = await Promise.all([
        deps.wallets.listWalletEntries({
          accountId: params.accountId,
          limit: 250,
        }),
        listSettlementProviderIdempotencyKeys(deps.db, {
          accountId: params.accountId,
          limit: 100,
        }),
      ]);
      const items = [
        {
          occurred_at: payout.requested_at,
          kind: "payout-requested",
          label: "Payout requested",
          reference: payout.display_reference,
          amount: payout.amount,
          currency_code: payout.currency_code,
        },
        ...walletEntries.items
          .filter((entry) => entry.payout_id === payout.payout_id)
          .map((entry) => ({
            occurred_at: entry.posted_at,
            kind: `wallet-${entry.kind}`,
            label: entry.direction === "credit" ? "Wallet credited" : "Wallet debited",
            reference: entry.ledger_entry_id,
            amount: entry.amount,
            currency_code: entry.currency_code,
          })),
        ...idempotencyKeys
          .filter((entry) => entry.payout_id === payout.payout_id)
          .map((entry) => ({
            occurred_at: entry.created_at,
            kind: entry.operation_kind,
            label: "Provider operation submitted",
            reference: entry.provider_object_reference ?? entry.operation_key,
            amount: null,
            currency_code: null,
          })),
        ...(payout.sent_at
          ? [
              {
                occurred_at: payout.sent_at,
                kind: "provider-payout-submitted",
                label: "Provider payout submitted",
                reference: payout.provider_payout_reference,
                amount: payout.amount,
                currency_code: payout.currency_code,
              },
            ]
          : []),
        ...(payout.completed_at
          ? [
              {
                occurred_at: payout.completed_at,
                kind: "payout-completed",
                label: "Payout completed",
                reference: payout.provider_payout_reference,
                amount: payout.amount,
                currency_code: payout.currency_code,
              },
            ]
          : []),
        ...(payout.failed_at
          ? [
              {
                occurred_at: payout.failed_at,
                kind: "payout-failed",
                label: "Payout failed",
                reference: payout.provider_payout_reference,
                amount: payout.amount,
                currency_code: payout.currency_code,
              },
            ]
          : []),
      ].sort((left, right) => left.occurred_at.localeCompare(right.occurred_at));

      return {
        payout_id: payout.payout_id,
        account_id: payout.account_id,
        items,
      };
    },
    listPayoutsNeedingReconciliation: (params) => listPayoutsNeedingReconciliation(deps.db, params),
    listProviderIdempotencyKeys: (params) => listSettlementProviderIdempotencyKeys(deps.db, params),
    listReconciliationRuns: (params) => listSettlementReconciliationRuns(deps.db, params),
    listNegativeBalanceAccounts: (params = {}) => deps.wallets.listNegativeBalanceAccounts(params),
    async getPlatformBalanceForecast(params) {
      const currencyCode = normalizeCurrencyCode(params?.currencyCode ?? "usd");
      const [platformBalance, payouts] = await Promise.all([
        deps.moneyMovementGateway.retrievePlatformBalance({ currencyCode }),
        listPayoutsNeedingReconciliation(deps.db, {
          limit: 500,
          filter: "in-transit",
        }),
      ]);
      const pendingDemand = payouts
        .filter((payout) => payout.currency_code === currencyCode)
        .reduce((sum, payout) => sum + Number.parseFloat(payout.amount), 0)
        .toFixed(2);

      return {
        currency_code: currencyCode,
        available_amount: platformBalance.availableAmount,
        pending_payout_demand_amount: pendingDemand,
        forecast_after_pending_demand_amount: (
          Number.parseFloat(platformBalance.availableAmount) - Number.parseFloat(pendingDemand)
        ).toFixed(2),
      };
    },
    async getProviderHealth() {
      await recordOperation({
        kind: "provider-health-checked",
      });
      return {
        provider_name: deps.moneyMovementGateway.providerName,
        adapter_mode: deps.moneyMovementGateway.providerName === "fake" ? "fake" : "provider",
        webhook_signature_required: deps.moneyMovementGateway.providerName !== "fake",
        platform_balance_supported: true,
        connected_account_payouts_supported: true,
      };
    },
    async previewPayoutRequest(params, context) {
      const wallet = await deps.wallets.getWallet(params.accountId);
      let readiness = await deps.payoutReadiness.getPayoutReadiness(params.accountId);
      const currencyCode = normalizeCurrencyCode(wallet.currency_code);
      const amount = normalizeMoneyAmount(params.amount, {
        fieldName: "Payout amount",
      });
      const [riskSummary, platformBalance, activeSupportHoldAmount, payoutBoundsPolicy] = await Promise.all([
        getAccountPayoutRiskSummary(deps.db, params.accountId),
        deps.moneyMovementGateway.retrievePlatformBalance({ currencyCode }),
        getAccountActiveSupportHoldAmount(deps.db, params.accountId),
        resolvePayoutBoundsPolicy(deps),
      ]);
      const unavailableReasons: string[] = [];
      const payoutAvailableBalanceAmount = subtractMoney(wallet.available_balance_amount, activeSupportHoldAmount);

      if (payoutReadinessStalenessIsOnlySetupBlocker(readiness)) {
        try {
          readiness = await refreshPayoutReadinessWhenStalenessIsOnlyBlocker(params.accountId, readiness, context);
        } catch {
          unavailableReasons.push("payout-setup-refresh-required");
        }
      }
      if (readiness.status !== "ready" || !readiness.provider_reference) {
        unavailableReasons.push("payout-setup-incomplete");
      }
      if (readiness.status === "ready" && payoutReadinessIsStale(readiness.updated_at)) {
        unavailableReasons.push("payout-setup-refresh-required");
      }
      if (readiness.missing_requirements.length > 0) {
        unavailableReasons.push("provider-requirements-open");
      }
      if (payoutDestinationCoolingWindowEndsAt(readiness, destinationFrictionPolicy)) {
        unavailableReasons.push("payout-destination-cooling-period");
      }
      if (compareMoney(payoutAvailableBalanceAmount, "0.00") <= 0) {
        unavailableReasons.push("no-available-wallet-balance");
      }
      if (
        wallet.negative_balance_status !== "in-good-standing" ||
        compareMoney(wallet.available_balance_amount, "0.00") < 0
      ) {
        unavailableReasons.push("negative-balance-active");
      }
      if (
        compareMoney(payoutAvailableBalanceAmount, "0.00") <= 0 &&
        compareMoney(wallet.pending_balance_amount, "0.00") > 0
      ) {
        unavailableReasons.push("payout-release-hold-active");
      }
      if (compareMoney(amount, payoutBoundsPolicy.minimumAmount) < 0) {
        unavailableReasons.push("amount-below-minimum");
      }
      if (compareMoney(amount, payoutBoundsPolicy.maximumAmount) > 0) {
        unavailableReasons.push("amount-above-maximum");
      }
      if (compareMoney(payoutAvailableBalanceAmount, amount) < 0) {
        unavailableReasons.push("amount-exceeds-available-balance");
      }
      if (compareMoney(activeSupportHoldAmount, "0.00") > 0) {
        unavailableReasons.push("support-hold-active");
      }
      if (compareMoney(platformBalance.availableAmount, amount) < 0) {
        unavailableReasons.push("platform-balance-insufficient");
      }
      if (riskSummary.failed_payout_count > 0) {
        unavailableReasons.push("recent-payout-failure");
      }
      if (riskSummary.stale_requested_payout_count > 0) {
        unavailableReasons.push("payout-reconciliation-required");
      }

      const uniqueReasons = [...new Set(unavailableReasons)];
      return {
        account_id: params.accountId,
        requested_amount: amount,
        currency_code: currencyCode,
        available_balance_amount: payoutAvailableBalanceAmount,
        platform_available_amount: platformBalance.availableAmount,
        estimated_wallet_balance_after:
          compareMoney(payoutAvailableBalanceAmount, amount) >= 0
            ? subtractMoney(payoutAvailableBalanceAmount, amount)
            : "0.00",
        can_request: uniqueReasons.length === 0,
        unavailable_reasons: uniqueReasons,
        unavailable_reason_details: moneyStatusDetails(uniqueReasons),
      };
    },
    async requestPayout(params, context) {
      await recordOperation({
        kind: "payout-requested",
        accountId: params.accountId,
        amount: params.amount,
        currencyCode: "usd",
      });
      const wallet = await deps.wallets.getWallet(params.accountId);
      let readiness = await deps.payoutReadiness.getPayoutReadiness(params.accountId);
      const currencyCode = normalizeCurrencyCode(wallet.currency_code);
      const payoutBoundsPolicy = await resolvePayoutBoundsPolicy(deps);
      const amount = assertPayoutAmountWithinPolicy(params.amount, currencyCode, payoutBoundsPolicy);
      try {
        readiness = await refreshPayoutReadinessWhenStalenessIsOnlyBlocker(params.accountId, readiness, context);
      } catch {
        await recordOperation({
          kind: "payout-request-blocked-by-setup",
          accountId: params.accountId,
          amount,
          currencyCode,
          readinessStatus: readiness.status,
          providerReference: readiness.provider_reference,
          missingRequirementCount: readiness.missing_requirements.length,
          staleReadiness: true,
          safeCategory: "setup_stale",
        });
        throw new SettlementDomainError("Payout setup status must be refreshed before requesting a payout.");
      }
      if (readiness.status !== "ready") {
        await recordOperation({
          kind: "payout-request-blocked-by-setup",
          accountId: params.accountId,
          amount,
          currencyCode,
          readinessStatus: readiness.status,
          providerReference: readiness.provider_reference,
          missingRequirementCount: readiness.missing_requirements.length,
          staleReadiness: payoutReadinessIsStale(readiness.updated_at),
          safeCategory: "setup_incomplete",
        });
        throw new SettlementDomainError("Payout setup must be complete before requesting payouts.");
      }
      if (!readiness.provider_reference) {
        await recordOperation({
          kind: "payout-request-blocked-by-setup",
          accountId: params.accountId,
          amount,
          currencyCode,
          readinessStatus: readiness.status,
          providerReference: readiness.provider_reference,
          missingRequirementCount: readiness.missing_requirements.length,
          staleReadiness: payoutReadinessIsStale(readiness.updated_at),
          safeCategory: "missing_provider_account",
        });
        throw new SettlementDomainError("Payout setup must include a provider account.");
      }
      if (payoutReadinessIsStale(readiness.updated_at)) {
        await recordOperation({
          kind: "payout-request-blocked-by-setup",
          accountId: params.accountId,
          amount,
          currencyCode,
          readinessStatus: readiness.status,
          providerReference: readiness.provider_reference,
          missingRequirementCount: readiness.missing_requirements.length,
          staleReadiness: true,
          safeCategory: "setup_stale",
        });
        throw new SettlementDomainError("Payout setup status must be refreshed before requesting a payout.");
      }
      if (readiness.missing_requirements.length > 0) {
        await recordOperation({
          kind: "payout-request-blocked-by-setup",
          accountId: params.accountId,
          amount,
          currencyCode,
          readinessStatus: readiness.status,
          providerReference: readiness.provider_reference,
          missingRequirementCount: readiness.missing_requirements.length,
          staleReadiness: false,
          safeCategory: "requirements_open",
        });
        throw new SettlementDomainError("Payout setup requirements must be resolved before requesting a payout.");
      }
      const coolingWindowEndsAt = payoutDestinationCoolingWindowEndsAt(readiness, destinationFrictionPolicy);
      if (coolingWindowEndsAt) {
        const verified = await verifySensitiveAction({
          accountId: params.accountId,
          userId: params.actorUserId ?? null,
          token: params.sensitiveActionToken ?? "",
          purpose: "payout-request",
        });
        if (!verified) {
          await recordOperation({
            kind: "payout-request-blocked-by-destination-friction",
            accountId: params.accountId,
            amount,
            currencyCode,
            providerReference: readiness.provider_reference,
            reason: `Payout destination changed within cooling period ending ${coolingWindowEndsAt}.`,
          });
          throw new SettlementDomainError(
            "Confirm it is you before requesting a payout, or wait until the payout destination cooling period ends.",
          );
        }
      }
      const riskSummary = await getAccountPayoutRiskSummary(deps.db, params.accountId);
      if (riskSummary.failed_payout_count > 0) {
        throw new SettlementDomainError("Recent payout failures must be reviewed before requesting another payout.");
      }
      if (riskSummary.stale_requested_payout_count > 0) {
        throw new SettlementDomainError(
          "A previous payout request needs reconciliation before requesting another payout.",
        );
      }

      const activeSupportHoldAmount = await getAccountActiveSupportHoldAmount(deps.db, params.accountId);
      const payoutAvailableBalanceAmount = subtractMoney(wallet.available_balance_amount, activeSupportHoldAmount);
      if (
        wallet.negative_balance_status !== "in-good-standing" ||
        compareMoney(wallet.available_balance_amount, "0.00") < 0
      ) {
        throw new SettlementDomainError("Negative balance must be recovered before requesting payout.");
      }
      if (compareMoney(activeSupportHoldAmount, "0.00") > 0) {
        throw new SettlementDomainError("Open support requests must be resolved before requesting this payout.");
      }
      if (compareMoney(payoutAvailableBalanceAmount, amount) < 0) {
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
      const requestedAt = new Date().toISOString();
      const result = await commandHandler({
        streamId: `settlement.payout-${payoutId}`,
        command: {
          type: "RequestPayout",
          payoutId,
          accountId: params.accountId,
          amount,
          currencyCode,
          destinationReference: params.destinationReference ?? null,
          note: params.note ?? null,
          notificationEmail: params.notificationEmail ?? null,
          requestedAt,
        },
        context,
      });
      let commandSnapshot = {
        payoutId,
        version: result.version,
        payout: requirePayoutSnapshot(result.state, result.version),
      };

      try {
        await deps.wallets.postEntry(
          {
            accountId: params.accountId,
            ledgerEntryId: payoutDebitLedgerEntryId(payoutId),
            kind: "payout",
            direction: "debit",
            amount,
            currencyCode,
            fundsStatus: "available",
            payoutId,
            description: params.note ?? `Payout ${deriveDisplayReferenceOrRaw(payoutId)}`,
            postedAt: requestedAt,
          },
          context,
        );
      } catch (error) {
        const failureMessage = providerErrorMessage(error, "Payout wallet debit failed.");
        const failedSnapshot = await failPayoutAndReverseWallet(
          {
            payoutId,
            accountId: params.accountId,
            failureReason: "Payout account details need review.",
            providerStatus: "failed",
            providerFailureMessage: failureMessage,
            amount,
            currencyCode,
          },
          context,
        );
        return {
          payoutId,
          version: failedSnapshot.version,
          payout: failedSnapshot.payout,
        };
      }

      const transferIdempotencyKey = `settlement:payout:${payoutId}:transfer`;
      const transferOperationKey = `payout:${payoutId}:transfer`;
      await recordSettlementProviderOperationPending(deps.db, {
        operationKey: transferOperationKey,
        providerName: deps.moneyMovementGateway.providerName,
        operationKind: "platform-transfer-create",
        accountId: params.accountId,
        payoutId,
        idempotencyKey: transferIdempotencyKey,
        request: {
          payoutId,
          accountId: params.accountId,
          providerReference: readiness.provider_reference,
          amount,
          currencyCode,
        },
        createdAt: requestedAt,
      });

      let providerTransferReference: string | null = null;
      try {
        const transfer = await deps.moneyMovementGateway.transferPlatformBalanceToConnectedAccount({
          payoutId,
          accountId: params.accountId,
          providerReference: readiness.provider_reference,
          amount,
          currencyCode,
          idempotencyKey: transferIdempotencyKey,
        });
        providerTransferReference = transfer.providerTransferReference;
        await recordSettlementProviderOperationSucceeded(deps.db, {
          operationKey: transferOperationKey,
          providerObjectReference: transfer.providerTransferReference,
        });
        await recordSettlementProviderIdempotencyKey(deps.db, {
          operationKey: transferOperationKey,
          providerName: deps.moneyMovementGateway.providerName,
          operationKind: "platform-transfer-create",
          accountId: params.accountId,
          payoutId,
          providerObjectReference: transfer.providerTransferReference,
          idempotencyKey: transferIdempotencyKey,
          createdAt: new Date().toISOString(),
        });
        commandSnapshot = await recordPayoutProviderReferences(
          {
            payoutId,
            providerTransferReference: transfer.providerTransferReference,
          },
          context,
        );
        await recordOperation({
          kind: "provider-transfer-submitted",
          accountId: params.accountId,
          payoutId,
          amount,
          currencyCode,
          providerTransferReference: transfer.providerTransferReference,
        });
      } catch (error) {
        const providerFailureMessage = providerErrorMessage(error, "Provider transfer submission failed.");
        await recordSettlementProviderOperationFailed(deps.db, {
          operationKey: transferOperationKey,
          errorMessage: providerFailureMessage,
        });
        if (!isTerminalProviderFailure(error)) {
          return commandSnapshot;
        }
        await recordOperation({
          kind: "payout-failed",
          accountId: params.accountId,
          payoutId,
          amount,
          currencyCode,
          reason: providerFailureMessage,
        });
        const failedSnapshot = await failPayoutAndReverseWallet(
          {
            payoutId,
            accountId: params.accountId,
            failureReason: "Payout account details need review.",
            providerStatus: "failed",
            providerFailureMessage,
            amount,
            currencyCode,
          },
          context,
        );
        return {
          payoutId,
          version: failedSnapshot.version,
          payout: failedSnapshot.payout,
        };
      }

      const payoutIdempotencyKey = `settlement:payout:${payoutId}:payout`;
      const payoutOperationKey = `payout:${payoutId}:payout`;
      await recordSettlementProviderOperationPending(deps.db, {
        operationKey: payoutOperationKey,
        providerName: deps.moneyMovementGateway.providerName,
        operationKind: "connected-account-payout-create",
        accountId: params.accountId,
        payoutId,
        idempotencyKey: payoutIdempotencyKey,
        request: {
          payoutId,
          accountId: params.accountId,
          providerReference: readiness.provider_reference,
          amount,
          currencyCode,
        },
      });

      try {
        const providerPayout = await deps.moneyMovementGateway.createConnectedAccountPayout({
          payoutId,
          accountId: params.accountId,
          providerReference: readiness.provider_reference,
          amount,
          currencyCode,
          idempotencyKey: payoutIdempotencyKey,
        });
        await recordSettlementProviderOperationSucceeded(deps.db, {
          operationKey: payoutOperationKey,
          providerObjectReference: providerPayout.providerPayoutReference,
        });
        await recordSettlementProviderIdempotencyKey(deps.db, {
          operationKey: payoutOperationKey,
          providerName: deps.moneyMovementGateway.providerName,
          operationKind: "connected-account-payout-create",
          accountId: params.accountId,
          payoutId,
          providerObjectReference: providerPayout.providerPayoutReference,
          idempotencyKey: payoutIdempotencyKey,
          createdAt: new Date().toISOString(),
        });
        commandSnapshot = await recordPayoutProviderReferences(
          {
            payoutId,
            providerTransferReference,
            providerPayoutReference: providerPayout.providerPayoutReference,
            providerStatus: providerPayout.providerStatus,
          },
          context,
        );
        await recordOperation({
          kind: "provider-payout-submitted",
          accountId: params.accountId,
          payoutId,
          amount,
          currencyCode,
          providerPayoutReference: providerPayout.providerPayoutReference,
        });

        const inTransit = await commandHandler({
          streamId: `settlement.payout-${payoutId}`,
          command: {
            type: "MarkPayoutInTransit",
            providerTransferReference,
            providerPayoutReference: providerPayout.providerPayoutReference,
            providerStatus: providerPayout.providerStatus,
            sentAt: new Date().toISOString(),
          },
          context,
        });
        commandSnapshot = {
          payoutId,
          version: inTransit.version,
          payout: requirePayoutSnapshot(inTransit.state, inTransit.version),
        };
      } catch (error) {
        const providerFailureMessage = providerErrorMessage(error, "Provider payout submission failed.");
        await recordSettlementProviderOperationFailed(deps.db, {
          operationKey: payoutOperationKey,
          errorMessage: providerFailureMessage,
        });
        await recordOperation({
          kind: "payout-failed",
          accountId: params.accountId,
          payoutId,
          amount,
          currencyCode,
          reason: providerFailureMessage,
        });
      }

      return commandSnapshot;
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
      const alreadyProcessed = await hasProcessedProviderWebhookEvent(event);
      if (alreadyProcessed) {
        await recordOperation({
          kind: "money-movement-webhook-ignored",
          providerEventId: event.providerEventId,
          providerPayoutReference: providerObjectReferenceFromEvent(event) ?? undefined,
          reason: "Provider webhook event was already processed.",
        });
        return { received: true, ignored: true };
      }
      const result = await handleMoneyMovementEvent(event, context);
      await recordProviderWebhookEvent(event);
      return result;
    },
    reconcileProviderPayout,
    reconcilePayoutsNeedingAttention,
    enqueuePayoutReconciliationJob: async (params, context) => {
      const limit = Math.max(1, Math.min(params.limit ?? 100, 500));
      const payouts = await listPayoutsNeedingReconciliation(deps.db, {
        accountId: context.audit.forAccountId,
        limit,
      });
      const job = await jobStore.enqueue({
        jobId: createId("job"),
        jobKind: "payout-reconciliation",
        payload: {
          accountId: context.audit.forAccountId,
          limit,
        },
        progress: payoutReconciliationJobProgress("queued", 0, payouts.length, "Payout reconciliation queued."),
        eventContext: context,
      });
      await workUnitStore.enqueue({
        jobId: job.jobId,
        units: payouts.map((payout) => ({
          unitId: payout.payout_id,
          unitKind: "payout-reconciliation",
          payload: {
            payoutId: payout.payout_id,
            providerPayoutReference: payout.provider_payout_reference,
          },
        })),
      });
      return job;
    },
    getPayoutReconciliationJob: (jobId) => jobStore.get(jobId),
    listPayoutReconciliationJobEvents: (jobId, afterSequence = 0) => jobStore.listEvents(jobId, afterSequence),
    waitForPayoutReconciliationJobEvents: (jobId, signal) => jobStore.waitForEvents({ jobId, signal }),
    prunePayoutReconciliationJobRetention: (input = {}) =>
      jobStore.pruneTerminalJobs({
        completedBefore: input.completedBefore ?? payoutReconciliationRetentionCutoff(7),
        limit: input.limit,
      }),
    processNextPayoutReconciliationJob: async (input) => {
      const processedUnit = await processNextPayoutReconciliationWorkUnit(input);
      if (processedUnit > 0) {
        return processedUnit;
      }

      const unitSummary = await workUnitStore.summarize();
      if (unitSummary.queued > 0 || unitSummary.running > 0) {
        return 0;
      }

      const claimed = await jobStore.claimNext({
        claimOwnerId: input.claimOwnerId,
        claimTtlMs: input.claimTtlMs,
        jobKinds: ["payout-reconciliation"],
      });
      if (!claimed) {
        return 0;
      }

      try {
        input.throwIfLeaseLost?.();
        if (input.signal?.aborted) {
          throw new SettlementDomainError("Payout reconciliation job was cancelled.");
        }
        if (!claimed.eventContext) {
          throw new SettlementDomainError("Payout reconciliation job is missing event context.");
        }

        await requirePayoutReconciliationJobClaim(
          jobStore.updateProgress({
            jobId: claimed.jobId,
            claimOwnerId: input.claimOwnerId,
            claimTtlMs: input.claimTtlMs,
            progress: payoutReconciliationJobProgress("processing", 0, claimed.payload.limit, "Reconciling payouts."),
          }),
        );
        const jobContext = createDurableJobExecutionContext(jobStore, {
          jobId: claimed.jobId,
          claimOwnerId: input.claimOwnerId,
          claimTtlMs: input.claimTtlMs,
          signal: input.signal,
          throwIfLeaseLost: input.throwIfLeaseLost,
          cancelledMessage: "Payout reconciliation job was cancelled.",
          claimLostMessage: "Payout reconciliation job claim was lost before the status update completed.",
        });
        const result = await reconcilePayoutsNeedingAttention(
          {
            accountId: claimed.payload.accountId,
            limit: claimed.payload.limit,
            claimOwnerId: input.claimOwnerId,
            claimTtlMs: input.claimTtlMs,
          },
          claimed.eventContext,
          jobContext,
        );
        await requirePayoutReconciliationJobClaim(
          jobStore.complete({
            jobId: claimed.jobId,
            claimOwnerId: input.claimOwnerId,
            progress: payoutReconciliationJobProgress(
              "completed",
              result.checked,
              result.checked,
              "Payout reconciliation completed.",
            ),
            result,
          }),
        );
        return 1;
      } catch (error) {
        if (isPayoutReconciliationJobHandoff(error, input)) {
          return 0;
        }
        await requirePayoutReconciliationJobClaim(
          jobStore.fail({
            jobId: claimed.jobId,
            claimOwnerId: input.claimOwnerId,
            progress: {
              ...claimed.progress,
              phase: "failed",
              message: error instanceof Error ? error.message : "Payout reconciliation failed.",
            },
            errorMessage: error instanceof Error ? error.message : "Payout reconciliation failed.",
          }),
        );
        return 1;
      }
    },
    getPayoutReconciliationWorkUnitSummary: (input = {}) => workUnitStore.summarize(input),
    projectors: [
      createProjectionHandlerSet({
        projectionName: "settlement-payout-projection",
        handlers: buildPayoutProjectionHandlers(deps.db),
      }),
      createProjectionHandlerSet({
        projectionName: SETTLEMENT_PAYOUT_TRANSACTIONAL_EMAIL_PROJECTION,
        handlers: buildSettlementPayoutTransactionalEmailProjectionHandlers(
          notificationOutbox,
          SETTLEMENT_PAYOUT_TRANSACTIONAL_EMAIL_PROJECTION,
        ),
      }),
    ],
  };

  async function processNextPayoutReconciliationWorkUnit(input: {
    claimOwnerId: string;
    claimTtlMs: number;
    workflowMaxActiveClaims?: number;
    jobMaxActiveClaims?: number;
    laneName?: string | null;
    signal?: AbortSignal;
    throwIfLeaseLost?: () => void;
  }): Promise<number> {
    const claimResult = await workUnitStore.claimNext({
      claimOwnerId: input.claimOwnerId,
      claimTtlMs: input.claimTtlMs,
      workflowMaxActiveClaims: input.workflowMaxActiveClaims ?? 1,
      jobMaxActiveClaims: input.jobMaxActiveClaims ?? 1,
      jobKinds: ["payout-reconciliation"],
      laneName: input.laneName ?? null,
    });
    const claim = claimResult.claim;
    if (!claim) {
      return 0;
    }

    try {
      input.throwIfLeaseLost?.();
      if (input.signal?.aborted) {
        throw new SettlementDomainError("Payout reconciliation job was cancelled.");
      }
      if (!claim.job.eventContext) {
        throw new SettlementDomainError("Payout reconciliation job is missing event context.");
      }
      const providerPayoutReference = claim.unit.payload.providerPayoutReference;
      const outcome: PayoutReconciliationWorkUnitResult = providerPayoutReference
        ? await reconcilePayoutWorkUnit(
            claim.unit.payload.payoutId,
            providerPayoutReference,
            claim.job.eventContext,
            input.signal,
          )
        : {
            payoutId: claim.unit.payload.payoutId,
            status: "skipped",
            message: "Payout has no provider payout reference.",
          };
      await requirePayoutReconciliationJobClaim(
        workUnitStore.recordTerminal({
          jobId: claim.job.jobId,
          unitId: claim.unit.unitId,
          claimOwnerId: claim.claimOwnerId,
          claimToken: claim.claimToken,
          state: outcome.status === "failed" ? "failed" : outcome.status === "skipped" ? "skipped" : "completed",
          unitResult: outcome,
          errorMessage: outcome.status === "failed" ? outcome.message : null,
          parentProgress: claim.job.progress,
          parentResult: claim.job.result,
          resolveParentUpdate: (queryable) => payoutReconciliationParentUpdateFromWorkUnits(queryable, claim.job),
        }),
      );
      return 1;
    } catch (error) {
      if (isPayoutReconciliationJobHandoff(error, input)) {
        await workUnitStore.releaseClaim({
          jobId: claim.job.jobId,
          unitId: claim.unit.unitId,
          claimOwnerId: claim.claimOwnerId,
          claimToken: claim.claimToken,
        });
        return 0;
      }
      const outcome: PayoutReconciliationWorkUnitResult = {
        payoutId: claim.unit.payload.payoutId,
        status: "failed",
        message: error instanceof Error ? error.message : "Payout reconciliation failed.",
      };
      await requirePayoutReconciliationJobClaim(
        workUnitStore.recordTerminal({
          jobId: claim.job.jobId,
          unitId: claim.unit.unitId,
          claimOwnerId: claim.claimOwnerId,
          claimToken: claim.claimToken,
          state: "failed",
          unitResult: outcome,
          errorMessage: outcome.message,
          parentProgress: claim.job.progress,
          parentResult: claim.job.result,
          resolveParentUpdate: (queryable) => payoutReconciliationParentUpdateFromWorkUnits(queryable, claim.job),
        }),
      );
      return 1;
    }
  }

  async function reconcilePayoutWorkUnit(
    payoutId: string,
    providerPayoutReference: string,
    context: EventStoreContext,
    signal?: AbortSignal,
  ): Promise<PayoutReconciliationWorkUnitResult> {
    const result = await reconcileProviderPayout({ providerPayoutReference }, context, { signal });
    return {
      payoutId,
      status: result.ignored ? "ignored" : "reconciled",
      message: null,
    };
  }

  async function payoutReconciliationParentUpdateFromWorkUnits(
    queryable: PgQueryable,
    job: PayoutReconciliationJob,
  ): Promise<
    Readonly<{
      parentProgress: PayoutReconciliationJobProgress;
      parentResult: PayoutReconciliationJobResult;
      completeJob: boolean;
    }>
  > {
    const units = await listPayoutReconciliationWorkUnitsForJob(queryable, job.jobId);
    const terminalUnits = units.filter(
      (unit) => unit.state === "completed" || unit.state === "failed" || unit.state === "skipped",
    );
    const outcomes = terminalUnits.flatMap((unit) => (unit.result ? [unit.result] : []));
    const total = Math.max(job.progress.total, units.length, outcomes.length);
    const completeJob = total > 0 && terminalUnits.length >= total;
    const result: PayoutReconciliationJobResult = {
      checked: outcomes.length,
      reconciled: outcomes.filter((outcome) => outcome.status === "reconciled").length,
      ignored: outcomes.filter((outcome) => outcome.status === "ignored").length,
      skipped: outcomes.filter((outcome) => outcome.status === "skipped").length,
      errors: outcomes
        .filter((outcome) => outcome.status === "failed")
        .map((outcome) => ({ payoutId: outcome.payoutId, message: outcome.message ?? "Reconciliation failed." })),
    };
    if (completeJob) {
      await recordSettlementReconciliationRun(queryable, {
        reconciliationRunId: `rec_${job.jobId}`,
        kind: "payouts",
        checked: result.checked,
        reconciled: result.reconciled,
        ignored: result.ignored,
        skipped: result.skipped,
        errorCount: result.errors.length,
        status: result.errors.length > 0 ? "completed-with-errors" : "completed",
        summary: result,
        startedAt: job.startedAt ?? new Date().toISOString(),
        completedAt: new Date().toISOString(),
      });
    }
    return {
      parentProgress: payoutReconciliationJobProgress(
        completeJob ? "completed" : "processing",
        terminalUnits.length,
        total,
        completeJob ? "Payout reconciliation completed." : "Reconciled payout.",
      ),
      parentResult: result,
      completeJob,
    };
  }
}

function payoutReconciliationJobProgress(
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

function compactPayoutReconciliationJobResult(
  input: Readonly<{ checked: number; reconciled: number; ignored: number; skipped: number }>,
): PayoutReconciliationJobResult {
  return {
    ...input,
    errors: [],
  };
}

async function requirePayoutReconciliationJobClaim(
  succeeded: Promise<boolean | DurableJobWorkUnitTerminalOutcome> | boolean | DurableJobWorkUnitTerminalOutcome,
) {
  const outcome = await succeeded;
  if (!isDurableJobWorkUnitTerminalAccepted(outcome)) {
    throw new SettlementDomainError("Payout reconciliation job claim was lost before the status update completed.");
  }
}

function payoutReconciliationRetentionCutoff(daysAgo: number): Date {
  return new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000);
}

function isPayoutReconciliationJobHandoff(error: unknown, input?: { signal?: AbortSignal }) {
  return isDurableJobHandoffError(error, input);
}

function createPayoutReconciliationProgressCheckpoint(
  jobContext: DurableJobExecutionContext<PayoutReconciliationJobProgress, PayoutReconciliationJobResult>,
) {
  return createDurableJobProgressCheckpoint(jobContext, {
    minIntervalMs: 1_000,
    minCompletedDelta: 10,
    minRenewIntervalMs: 5_000,
    completed: (progress) => progress.completed,
    isTerminal: (progress) => progress.phase === "completed" || progress.phase === "failed",
  });
}

async function listPayoutReconciliationWorkUnitsForJob(
  queryable: PgQueryable,
  jobId: string,
): Promise<
  readonly DurableJobWorkUnitRecord<PayoutReconciliationWorkUnitPayload, PayoutReconciliationWorkUnitResult>[]
> {
  const result = await queryable.query<{
    unit_id: string;
    unit_kind: string;
    state: "queued" | "running" | "completed" | "failed" | "skipped";
    payload: unknown;
    result: unknown;
    error_message: string | null;
    claim_owner_id: string | null;
    claim_token: string | null;
    claimed_until: Date | string | null;
    attempt_count: number | string;
    created_at: Date | string;
    updated_at: Date | string;
    completed_at: Date | string | null;
  }>(
    `SELECT unit_id,
            unit_kind,
            state,
            payload,
            result,
            error_message,
            claim_owner_id,
            claim_token,
            claimed_until,
            attempt_count,
            created_at,
            updated_at,
            completed_at
     FROM settlement_payout_reconciliation_work_units
     WHERE job_id = $1
     ORDER BY created_at ASC, unit_id ASC`,
    [jobId],
  );

  return result.rows.map((row) => ({
    jobId,
    unitId: row.unit_id,
    unitKind: row.unit_kind,
    state: row.state,
    payload: readJsonValue(row.payload),
    result: row.result == null ? null : readJsonValue(row.result),
    errorMessage: row.error_message,
    claimOwnerId: row.claim_owner_id,
    claimToken: row.claim_token,
    claimedUntil: row.claimed_until == null ? null : formatTimestamp(row.claimed_until),
    attemptCount: Number(row.attempt_count),
    createdAt: formatTimestamp(row.created_at),
    updatedAt: formatTimestamp(row.updated_at),
    completedAt: row.completed_at == null ? null : formatTimestamp(row.completed_at),
  }));
}

function readJsonValue<T>(value: unknown): T {
  return typeof value === "string" ? (JSON.parse(value) as T) : (value as T);
}

function formatTimestamp(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : String(value);
}
