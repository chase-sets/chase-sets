import { createAggregateCommandHandler } from "@chase-sets/event-core/aggregate-command-handler";
import { createPassthroughDomainEventCodec } from "@chase-sets/event-core/codec";
import type { CommandHandler } from "@chase-sets/event-core/command-handler";
import type { EventStore } from "@chase-sets/event-core/event-store";
import { createProjectionHandlerSet, type ProjectionHandlerSet } from "@chase-sets/event-core/projector";
import type { ProjectionCheckpointStore } from "@chase-sets/event-core/projector";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import {
  type DurableJobEvent,
  type DurableJobExecutionContext,
  type DurableJobPublicSnapshot,
  type DurableJobRecord,
  toDurableJobPublicSnapshot,
} from "@chase-sets/platform-runtime/durable-job-store";
import type { DurableJobWorkUnitSummary } from "@chase-sets/platform-runtime/durable-job-work-units";
import { createNoopNotificationOutbox, type NotificationOutbox } from "@chase-sets/outbound-messaging";
import type { AccountId, PayoutId } from "@chase-sets/primitives/typed-ids";
import type { PolicyRuntime } from "@chase-sets/platform-policy/runtime";
import type { PayoutStatus } from "../../../support/runtime-support/common";
import type { MoneyMovementGateway } from "@chase-sets/money-movement";
import type { ProviderWebhookTelemetry } from "@chase-sets/http/provider-errors";
import { createNoopSettlementOperationsRecorder, type SettlementOperationsRecorder } from "./operations";
import { buildPayoutProjectionHandlers } from "../read-model/projection";
import {
  SETTLEMENT_PAYOUT_TRANSACTIONAL_EMAIL_PROJECTION,
  buildSettlementPayoutTransactionalEmailProjectionHandlers,
} from "../integrations/transactional-email/transactional-email-projector";
import type {
  SettlementReconciliationRunRow,
  SettlementProviderIdempotencyKeyRow,
  SettlementPayoutRow,
} from "../read-model/queries";
import type { SettlementPayoutSummary } from "../read-model/payout-summary";
import type { WalletServices } from "../../wallets/api/runtime";
import type { SettlementWalletRow } from "../../wallets/read-model/queries";
import type { PayoutReadinessServices } from "../../payout-readiness/api/runtime";
import {
  decidePayout,
  evolvePayoutMonth,
  evolvePayout,
  initialPayoutMonthState,
  initialPayoutState,
  type PayoutCommand,
  type PayoutEvent,
  type PayoutMonthEvent,
  type PayoutState,
} from "../domain/domain";
import { createPayoutPrimitives } from "./payout-primitives";
import { createPayoutProviderEvents } from "./payout-provider-events";
import { createPayoutReconciliation } from "./payout-reconciliation";
import { createPayoutReconciliationJobs } from "./payout-reconciliation-jobs";
import { createPayoutRequestLifecycle } from "./payout-request-lifecycle";

export type PayoutRuntimeDeps = Readonly<{
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
  webhookTelemetry?: ProviderWebhookTelemetry;
  /** The Settlement-owned resolver dependency for payout policies; standalone usage retains compiled fallbacks. */
  policies?: Pick<PolicyRuntime, "resolvePolicy">;
  /** Synthetic domain-control hook used only to prove recovery from a post-net/pre-fee interruption. */
  payoutPostingFault?: (stage: "after-net-debit") => Promise<void> | void;
}>;

export type PayoutDestinationFrictionPolicy = Readonly<{
  enabled: boolean;
  coolingPeriodMs: number;
  requireStepUpForAccountManagement: boolean;
  /**
   * The recent-authentication ("step-up") window, in minutes, the embedded
   * payout account-management session requires of the acting session.
   * Settlement owns the window because Settlement owns the action it gates;
   * the fact measured against it is Auth's own session-authentication moment
   * (`ResolvedActor.authenticatedAt`, read through
   * `resolveRecentAuthenticationStatus`), never a Settlement-minted token.
   * The default matches ADR 0020's ratified money-surface step-up window.
   */
  accountManagementRecentAuthMaxAgeMinutes: number;
}>;

/**
 * Verifies an out-of-band sensitive-action token for a payout **request** made
 * inside the payout-destination cooling window. This is the only surviving
 * consumer: the embedded account-management session no longer accepts a token
 * at all and instead evaluates Auth's recent-authentication fact (see
 * `createPayoutAccountManagementSession` in `../../payout-readiness/api/runtime`),
 * so no action carries two competing step-up contracts. With no verifier wired,
 * the cooling window is an unconditional block -- the shipped behavior this
 * friction was designed to produce.
 */
export type SensitiveActionVerifier = (
  input: Readonly<{
    accountId: AccountId;
    userId?: string | null;
    token: string;
    purpose: "payout-request";
  }>,
) => Promise<boolean>;

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
  requested_amount: string;
  fee_amount: string;
  net_amount: string;
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
  getPayoutSummary: (
    params: Readonly<{ accountId: string; canRequestPayouts: boolean; evaluatedAt?: string }>,
  ) => Promise<SettlementPayoutSummary>;
  getPayout: (payoutId: string, accountId: string) => Promise<SettlementPayoutRow | null>;
  getPayoutQuickAmounts: (params: Readonly<{ accountId: AccountId }>) => Promise<
    Readonly<{
      currency_code: string;
      minimum_amount: string;
      maximum_amount: string;
      full_available_amount: string;
    }>
  >;
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
        requested_amount?: string | null;
        fee_amount?: string | null;
        net_amount?: string | null;
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
    params: Readonly<{
      accountId: AccountId;
      amount: string;
      amountSelection?: "minimum" | "available" | null | "";
    }>,
    context: EventStoreContext,
  ) => Promise<
    Readonly<{
      account_id: string;
      requested_amount: string;
      fee_amount: string;
      net_amount: string;
      monthly_active_fee_amount: string;
      is_first_payout_of_month: boolean;
      fee_policy_version: string;
      fee_lines: readonly Readonly<{ code: "payout-fee" | "monthly-active-fee"; label: string; amount: string }>[];
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
      idempotencyKey?: string | null;
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
      netAmount?: string;
      feeAmount?: string;
      currencyCode?: string;
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

/**
 * Composes PayoutServices from the request lifecycle, provider-event
 * processing, reconciliation and reconciliation-job behaviors over one shared
 * set of payout aggregates and primitives.
 */
export function createPayoutRuntime(deps: PayoutRuntimeDeps): PayoutServices {
  const payoutCodec = createPassthroughDomainEventCodec<PayoutEvent>();
  const payoutMonthCodec = createPassthroughDomainEventCodec<PayoutMonthEvent>();
  const { commandHandler, repository } = createAggregateCommandHandler({
    eventStore: deps.eventStore,
    codec: payoutCodec,
    initialState: () => initialPayoutState,
    evolve: evolvePayout,
    decide: decidePayout,
  });
  const { repository: payoutMonthRepository } = createAggregateCommandHandler({
    eventStore: deps.eventStore,
    codec: payoutMonthCodec,
    initialState: () => initialPayoutMonthState,
    evolve: evolvePayoutMonth,
    decide: (_state, event: PayoutMonthEvent) => [event],
  });
  const primitives = createPayoutPrimitives(
    deps,
    { commandHandler, repository, payoutMonthRepository, payoutCodec, payoutMonthCodec },
    deps.operationsRecorder ?? createNoopSettlementOperationsRecorder(),
  );
  const reconciliation = createPayoutReconciliation(deps, primitives);
  const notificationOutbox = deps.notificationOutbox ?? createNoopNotificationOutbox();

  return {
    commandHandler,
    ...createPayoutRequestLifecycle(deps, primitives),
    ...createPayoutProviderEvents(deps, primitives),
    ...reconciliation,
    ...createPayoutReconciliationJobs(deps, reconciliation),
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
}
