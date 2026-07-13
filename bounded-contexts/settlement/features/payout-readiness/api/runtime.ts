import { createAggregateCommandHandler } from "@chase-sets/event-core/aggregate-command-handler";
import { createPassthroughDomainEventCodec } from "@chase-sets/event-core/codec";
import type { CommandHandler } from "@chase-sets/event-core/command-handler";
import type { EventStore } from "@chase-sets/event-core/event-store";
import { createProjectionHandlerSet, type ProjectionHandlerSet } from "@chase-sets/event-core/projector";
import type { ProjectionCheckpointStore } from "@chase-sets/event-core/projector";
import type { EventStoreContext, GlobalPosition } from "@chase-sets/event-core/storage";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { createId, type AccountId } from "@chase-sets/primitives/typed-ids";
import {
  normalizeCurrencyCode,
  normalizeOptionalText,
  normalizePayoutReadinessStatus,
  SettlementDomainError,
  type PayoutReadinessStatus,
} from "../../../support/runtime-support/common";
import {
  classifySettlementProviderError,
  createNoopSettlementOperationsRecorder,
  type SettlementOperationsRecorder,
} from "../../../support/runtime-support/operations";
import type { MoneyMovementGateway, ProviderPayoutReadiness } from "@chase-sets/money-movement";
import {
  createNoopNotificationOutbox,
  type EmailNotificationChannel,
  type NotificationChannel,
  type NotificationOutbox,
} from "@chase-sets/outbound-messaging";
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
  getPayoutReadinessByProviderReference,
  type SettlementPayoutReadinessRow,
} from "../read-model/queries";
import { buildPayoutSetupProgress, type PayoutSetupProgress } from "../domain/setup-progress";
import type { PayoutDestinationFrictionPolicy, SensitiveActionVerifier } from "../../payouts/api/runtime";

type PayoutReadinessRuntimeDeps = Readonly<{
  eventStore: EventStore;
  checkpointStore: ProjectionCheckpointStore;
  db: PgQueryable;
  moneyMovementGateway: MoneyMovementGateway;
  operationsRecorder?: SettlementOperationsRecorder;
  notificationOutbox?: NotificationOutbox;
  payoutDestinationFrictionPolicy?: Partial<PayoutDestinationFrictionPolicy>;
  sensitiveActionVerifier?: SensitiveActionVerifier;
}>;

export type PayoutReadinessServices = Readonly<{
  commandHandler: CommandHandler<PayoutReadinessCommand, PayoutReadinessState, PayoutReadinessEvent>;
  getPayoutReadiness: (accountId: string) => Promise<SettlementPayoutReadinessRow>;
  getPayoutSetupProgress: (accountId: string) => Promise<PayoutSetupProgress>;
  createPayoutSetupSession: (
    params: Readonly<{
      accountId: AccountId;
      contactEmail?: string | null;
    }>,
    context: EventStoreContext,
  ) => Promise<{
    clientSecret: string;
    providerReference: string;
    expiresAt: string | null;
    components: readonly ["payout-setup"];
    readiness: SettlementPayoutReadinessRow;
  }>;
  createHostedPayoutSetupLink: (
    params: Readonly<{
      accountId: AccountId;
      contactEmail?: string | null;
      returnUrl: string;
      refreshUrl: string;
      idempotencyKey: string;
    }>,
    context: EventStoreContext,
  ) => Promise<{
    accountId: string;
    providerReference: string;
    url: string;
    expiresAt: string | null;
    readiness: SettlementPayoutReadinessRow;
  }>;
  createPayoutAccountManagementSession: (
    params: Readonly<{
      accountId: AccountId;
      actorUserId?: string | null;
      sensitiveActionToken?: string | null;
    }>,
    context: EventStoreContext,
  ) => Promise<{
    clientSecret: string;
    providerReference: string;
    expiresAt: string | null;
    components: readonly ["payout-account-management"];
  }>;
  createPayoutNotificationBannerSession: (params: Readonly<{ accountId: AccountId }>) => Promise<{
    clientSecret: string;
    providerReference: string;
    expiresAt: string | null;
    components: readonly ["notification-banner"];
  }>;
  refreshProviderReadiness: (
    params: Readonly<{ accountId: AccountId; contactEmail?: string | null; providerReference?: string | null }>,
    context: EventStoreContext,
  ) => Promise<SettlementPayoutReadinessRow>;
  recordProviderReadinessFromWebhook: (
    params: Readonly<{
      providerReference: string;
      readiness: ProviderPayoutReadiness;
      recordedAt?: string;
    }>,
    context: EventStoreContext,
  ) => Promise<{ accountId: AccountId; version: number } | null>;
  recordProviderReadiness: (
    params: Readonly<{
      accountId: AccountId;
      status: PayoutReadinessStatus | string;
      missingRequirements?: readonly string[];
      providerReference?: string | null;
      contactEmail?: string | null;
      onboardingStatus?: string;
      transferCapabilityStatus?: string;
      payoutCapabilityStatus?: string;
      payoutDestinationStatus?: string;
      payoutDestinationFingerprint?: string | null;
      payoutDestinationChangedAt?: string | null;
      payoutAccountDashboard?: string;
      lossesCollector?: string;
      feesCollector?: string;
      requirementsCollector?: string;
      advisoryRequirements?: readonly string[];
      disabledReason?: string | null;
      requirementsDeadline?: string | null;
      recordedAt?: string;
    }>,
    context: EventStoreContext,
  ) => Promise<{ accountId: AccountId; version: number }>;
  projectors: readonly ProjectionHandlerSet[];
}>;

function readinessStatus(readiness: ProviderPayoutReadiness): PayoutReadinessStatus {
  const blockingRequirements = Array.isArray(readiness.blockingRequirements) ? readiness.blockingRequirements : null;
  if (
    readiness.onboardingStatus === "complete" &&
    readiness.transferCapabilityStatus === "active" &&
    readiness.payoutCapabilityStatus === "active" &&
    readiness.payoutDestinationStatus === "ready" &&
    blockingRequirements?.length === 0 &&
    !normalizeOptionalText(readiness.disabledReason)
  ) {
    return "ready";
  }

  if (readiness.transferCapabilityStatus === "inactive" || readiness.payoutCapabilityStatus === "inactive") {
    return "restricted";
  }

  return "pending";
}

function providerReferenceRefreshError(message: string) {
  const error = new SettlementDomainError(message) as SettlementDomainError & {
    code: string;
    statusCode: number;
  };
  error.code = "provider_reference_mismatch";
  error.statusCode = 409;
  return error;
}

function canonicalProviderReference(
  readiness: ProviderPayoutReadiness,
  expectedProviderReference?: string | null,
): string {
  const providerReference = normalizeOptionalText(readiness.providerReference);
  if (!providerReference) {
    throw providerReferenceRefreshError("Payout setup provider account could not be refreshed. Please retry setup.");
  }

  const expected = normalizeOptionalText(expectedProviderReference);
  if (expected && providerReference !== expected) {
    throw providerReferenceRefreshError("Payout setup changed while refreshing. Please restart payout setup.");
  }

  return providerReference;
}

function readinessWithProviderReference(
  readiness: ProviderPayoutReadiness,
  providerReference: string,
): ProviderPayoutReadiness {
  return {
    ...readiness,
    providerReference,
  };
}

function payoutReadinessRowFromProviderReadiness(
  accountId: AccountId,
  readiness: ProviderPayoutReadiness,
  updatedAt: string,
  payoutDestinationChangedAt: string | null = null,
): SettlementPayoutReadinessRow {
  return {
    account_id: accountId,
    status: readinessStatus(readiness),
    missing_requirements: readiness.blockingRequirements,
    advisory_requirements: readiness.advisoryRequirements,
    disabled_reason: readiness.disabledReason,
    requirements_deadline: readiness.requirementsDeadline,
    provider_reference: readiness.providerReference,
    contact_email: readiness.contactEmail ?? null,
    onboarding_status: readiness.onboardingStatus,
    transfer_capability_status: readiness.transferCapabilityStatus,
    payout_capability_status: readiness.payoutCapabilityStatus,
    payout_destination_status: readiness.payoutDestinationStatus,
    payout_destination_fingerprint: readiness.payoutDestinationFingerprint ?? null,
    payout_destination_changed_at: payoutDestinationChangedAt,
    payout_account_dashboard: readiness.payoutAccountDashboard,
    losses_collector: readiness.lossesCollector,
    fees_collector: readiness.feesCollector,
    requirements_collector: readiness.requirementsCollector,
    updated_at: updatedAt,
  };
}

export function createPayoutReadinessRuntime(deps: PayoutReadinessRuntimeDeps): PayoutReadinessServices {
  const operationsRecorder = deps.operationsRecorder ?? createNoopSettlementOperationsRecorder();
  const notificationOutbox = deps.notificationOutbox ?? createNoopNotificationOutbox();
  const frictionPolicy = {
    enabled: true,
    coolingPeriodMs: 24 * 60 * 60 * 1000,
    requireStepUpForAccountManagement: true,
    ...deps.payoutDestinationFrictionPolicy,
  };
  const sensitiveActionVerifier = deps.sensitiveActionVerifier ?? (async () => false);
  const { commandHandler } = createAggregateCommandHandler({
    eventStore: deps.eventStore,
    codec: createPassthroughDomainEventCodec<PayoutReadinessEvent>(),
    initialState: () => initialPayoutReadinessState,
    evolve: evolvePayoutReadiness,
    decide: decidePayoutReadiness,
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

  async function findCommittedPayoutReadinessByProviderReference(providerReference: string) {
    const latestByStream = new Map<
      string,
      {
        accountId: AccountId;
        providerReference: string | null;
        contactEmail: string | null;
        payoutDestinationFingerprint: string | null;
        payoutDestinationChangedAt: string | null;
      }
    >();
    let afterGlobalPosition: GlobalPosition | undefined;

    for (;;) {
      const events = await deps.eventStore.readAll({
        ...(afterGlobalPosition === undefined ? {} : { afterGlobalPosition }),
        eventTypes: ["settlement.payout-readiness.recorded"],
        streamPrefixes: ["settlement.payout-readiness-"],
        limit: 500,
      });
      for (const event of events) {
        const payload = event.payload as PayoutReadinessEvent["data"];
        latestByStream.set(event.streamId, {
          accountId: payload.accountId,
          providerReference: payload.providerReference,
          contactEmail: payload.contactEmail,
          payoutDestinationFingerprint: payload.payoutDestinationFingerprint,
          payoutDestinationChangedAt: payload.payoutDestinationChangedAt,
        });
      }
      if (events.length < 500) {
        break;
      }
      afterGlobalPosition = events[events.length - 1]?.globalPosition;
    }

    return [...latestByStream.values()].find((entry) => entry.providerReference === providerReference) ?? null;
  }

  function readinessOperationFields(readiness: ProviderPayoutReadiness) {
    return {
      providerReference: readiness.providerReference,
      readinessStatus: readinessStatus(readiness),
      onboardingStatus: readiness.onboardingStatus,
      transferCapabilityStatus: readiness.transferCapabilityStatus,
      payoutCapabilityStatus: readiness.payoutCapabilityStatus,
      payoutDestinationStatus: readiness.payoutDestinationStatus,
      payoutAccountDashboard: readiness.payoutAccountDashboard,
      missingRequirementCount: Array.isArray(readiness.blockingRequirements)
        ? readiness.blockingRequirements.length
        : undefined,
      advisoryRequirementCount: Array.isArray(readiness.advisoryRequirements)
        ? readiness.advisoryRequirements.length
        : undefined,
      disabledReason: readiness.disabledReason,
      requirementsDeadline: readiness.requirementsDeadline,
    };
  }

  async function verifySensitiveAction(
    params: Readonly<{ accountId: AccountId; userId?: string | null; token?: string | null }>,
  ) {
    const token = params.token?.trim();
    if (!token) {
      return false;
    }
    return sensitiveActionVerifier({
      accountId: params.accountId,
      userId: params.userId ?? null,
      token,
      purpose: "payout-account-management",
    });
  }

  function payoutDestinationChange(
    existing: Pick<SettlementPayoutReadinessRow, "payout_destination_fingerprint" | "payout_destination_changed_at">,
    readiness: ProviderPayoutReadiness,
    recordedAt: string,
  ) {
    const previous = normalizeOptionalText(existing.payout_destination_fingerprint);
    const next = normalizeOptionalText(readiness.payoutDestinationFingerprint);
    const changed = Boolean(previous && next && previous !== next);
    return {
      changed,
      fingerprint: next ?? previous,
      changedAt: changed ? recordedAt : existing.payout_destination_changed_at,
    };
  }

  async function notifyPayoutDestinationChanged(
    params: Readonly<{
      accountId: AccountId;
      contactEmail?: string | null;
      changedAt: string;
      providerReference?: string | null;
    }>,
  ) {
    if (!frictionPolicy.enabled) {
      return;
    }
    const title = "Payout destination changed";
    const body =
      "The payout destination for your Chase Sets account changed. If this was not you, contact support before requesting a payout.";
    const emailChannel: EmailNotificationChannel | null = params.contactEmail
      ? {
          channel: "email",
          to: [{ email: params.contactEmail }],
          subject: title,
          templateId: "settlement_payout_destination_changed",
          templateVersion: 1,
          templateData: { changedAt: params.changedAt },
        }
      : null;
    const channels: readonly NotificationChannel[] = [
      ...(emailChannel ? [emailChannel] : []),
      {
        channel: "web",
        recipient: { accountId: params.accountId },
        title,
        body,
        actionHref: "/account/payouts/setup",
      },
    ];
    const [firstChannel, ...otherChannels] = channels;
    if (!firstChannel) {
      return;
    }
    await notificationOutbox.enqueueNotification({
      message: {
        messageType: "settlement.payout-destination-changed",
        criticality: "security",
        title,
        body,
        actionHref: "/account/payouts/setup",
        templateId: "settlement_payout_destination_changed",
        templateVersion: 1,
        locale: "en",
        templateData: { changedAt: params.changedAt },
        channels: [firstChannel, ...otherChannels],
        idempotencyKey: `settlement:payout-destination-changed:${params.accountId}:${params.changedAt}`,
        correlationId: `settlement:payout-destination:${params.accountId}`,
        actor: { userId: null, accountId: params.accountId },
      },
      source: {
        sourceEventId: `settlement:payout-destination-changed:${params.accountId}:${params.changedAt}`,
        sourceGlobalPosition: "0",
        projectionName: "settlement-payout-destination-friction",
        occurredAt: params.changedAt,
      },
    });
    await recordOperation({
      kind: "payout-destination-changed",
      accountId: params.accountId,
      providerReference: params.providerReference ?? null,
      occurredAt: params.changedAt,
    });
  }

  async function recordProviderReadiness(
    params: Readonly<{
      accountId: AccountId;
      status: PayoutReadinessStatus | string;
      missingRequirements?: readonly string[];
      providerReference?: string | null;
      contactEmail?: string | null;
      onboardingStatus?: string;
      transferCapabilityStatus?: string;
      payoutCapabilityStatus?: string;
      payoutDestinationStatus?: string;
      payoutDestinationFingerprint?: string | null;
      payoutDestinationChangedAt?: string | null;
      payoutAccountDashboard?: string;
      lossesCollector?: string;
      feesCollector?: string;
      requirementsCollector?: string;
      advisoryRequirements?: readonly string[];
      disabledReason?: string | null;
      requirementsDeadline?: string | null;
      recordedAt?: string;
    }>,
    context: EventStoreContext,
  ) {
    if (!params.accountId) {
      throw new SettlementDomainError("Account is required.");
    }
    const result = await commandHandler({
      streamId: `settlement.payout-readiness-${params.accountId}`,
      command: {
        type: "RecordPayoutReadiness",
        accountId: params.accountId,
        status: normalizePayoutReadinessStatus(params.status),
        missingRequirements: params.missingRequirements ?? [],
        advisoryRequirements: params.advisoryRequirements ?? [],
        disabledReason: params.disabledReason ?? null,
        requirementsDeadline: params.requirementsDeadline ?? null,
        providerReference: params.providerReference ?? null,
        contactEmail: params.contactEmail ?? null,
        onboardingStatus: params.onboardingStatus ?? "not-started",
        transferCapabilityStatus: params.transferCapabilityStatus ?? "inactive",
        payoutCapabilityStatus: params.payoutCapabilityStatus ?? "inactive",
        payoutDestinationStatus: params.payoutDestinationStatus ?? "missing",
        payoutDestinationFingerprint: params.payoutDestinationFingerprint ?? null,
        payoutDestinationChangedAt: params.payoutDestinationChangedAt ?? null,
        payoutAccountDashboard: params.payoutAccountDashboard ?? "unknown",
        lossesCollector: params.lossesCollector ?? "unknown",
        feesCollector: params.feesCollector ?? "unknown",
        requirementsCollector: params.requirementsCollector ?? "unknown",
        recordedAt: params.recordedAt ?? new Date().toISOString(),
      },
      context,
    });

    return {
      accountId: params.accountId,
      version: result.version,
    };
  }

  return {
    commandHandler,
    getPayoutReadiness: (accountId) => getPayoutReadiness(deps.db, accountId),
    async getPayoutSetupProgress(accountId) {
      return buildPayoutSetupProgress(await getPayoutReadiness(deps.db, accountId));
    },
    async createPayoutSetupSession(params, context) {
      try {
        const existing = await getPayoutReadiness(deps.db, params.accountId);
        const ensured = existing.provider_reference
          ? await deps.moneyMovementGateway.refreshPayoutReadiness({
              accountId: params.accountId,
              providerReference: existing.provider_reference,
            })
          : await deps.moneyMovementGateway.ensurePayoutAccount({
              accountId: params.accountId,
              currencyCode: normalizeCurrencyCode("usd"),
              contactEmail: params.contactEmail,
              countryCode: "US",
              idempotencyKey: `settlement:payout-account:${params.accountId}`,
            });

        const ensuredRecordedAt = new Date().toISOString();
        const ensuredDestination = payoutDestinationChange(existing, ensured, ensuredRecordedAt);
        await recordProviderReadiness(
          {
            accountId: params.accountId,
            status: readinessStatus(ensured),
            missingRequirements: ensured.blockingRequirements,
            advisoryRequirements: ensured.advisoryRequirements,
            disabledReason: ensured.disabledReason,
            requirementsDeadline: ensured.requirementsDeadline,
            providerReference: ensured.providerReference,
            contactEmail: ensured.contactEmail ?? params.contactEmail ?? existing.contact_email,
            onboardingStatus: ensured.onboardingStatus,
            transferCapabilityStatus: ensured.transferCapabilityStatus,
            payoutCapabilityStatus: ensured.payoutCapabilityStatus,
            payoutDestinationStatus: ensured.payoutDestinationStatus,
            payoutDestinationFingerprint: ensuredDestination.fingerprint,
            payoutDestinationChangedAt: ensuredDestination.changedAt,
            payoutAccountDashboard: ensured.payoutAccountDashboard,
            lossesCollector: ensured.lossesCollector,
            feesCollector: ensured.feesCollector,
            requirementsCollector: ensured.requirementsCollector,
            recordedAt: ensuredRecordedAt,
          },
          context,
        );

        const session = await deps.moneyMovementGateway.createPayoutSetupSession({
          accountId: params.accountId,
          providerReference: ensured.providerReference,
          contactEmail: params.contactEmail,
          idempotencyKey: `settlement:payout-account:${params.accountId}:embedded-setup:${createId("setup")}`,
        });

        const sessionReadinessRecordedAt = new Date().toISOString();
        const sessionDestination = payoutDestinationChange(existing, session.readiness, sessionReadinessRecordedAt);
        await recordProviderReadiness(
          {
            accountId: params.accountId,
            status: readinessStatus(session.readiness),
            missingRequirements: session.readiness.blockingRequirements,
            advisoryRequirements: session.readiness.advisoryRequirements,
            disabledReason: session.readiness.disabledReason,
            requirementsDeadline: session.readiness.requirementsDeadline,
            providerReference: session.providerReference,
            contactEmail: session.readiness.contactEmail ?? params.contactEmail ?? existing.contact_email,
            onboardingStatus: session.readiness.onboardingStatus,
            transferCapabilityStatus: session.readiness.transferCapabilityStatus,
            payoutCapabilityStatus: session.readiness.payoutCapabilityStatus,
            payoutDestinationStatus: session.readiness.payoutDestinationStatus,
            payoutDestinationFingerprint: sessionDestination.fingerprint,
            payoutDestinationChangedAt: sessionDestination.changedAt,
            payoutAccountDashboard: session.readiness.payoutAccountDashboard,
            lossesCollector: session.readiness.lossesCollector,
            feesCollector: session.readiness.feesCollector,
            requirementsCollector: session.readiness.requirementsCollector,
            recordedAt: sessionReadinessRecordedAt,
          },
          context,
        );

        await recordOperation({
          kind: "payout-setup-session-created",
          accountId: params.accountId,
          setupSurface: "embedded-payout-setup",
          ...readinessOperationFields(session.readiness),
        });

        return {
          clientSecret: session.clientSecret,
          providerReference: session.providerReference,
          expiresAt: session.expiresAt,
          components: session.components,
          readiness: payoutReadinessRowFromProviderReadiness(
            params.accountId,
            session.readiness,
            sessionReadinessRecordedAt,
            sessionDestination.changedAt,
          ),
        };
      } catch (error) {
        await recordOperation({
          kind: "payout-setup-session-failed",
          accountId: params.accountId,
          setupSurface: "embedded-payout-setup",
          safeCategory: classifySettlementProviderError(error),
        });
        throw error;
      }
    },
    async createHostedPayoutSetupLink(params, context) {
      try {
        const existing = await getPayoutReadiness(deps.db, params.accountId);
        const ensured = existing.provider_reference
          ? await deps.moneyMovementGateway.refreshPayoutReadiness({
              accountId: params.accountId,
              providerReference: existing.provider_reference,
            })
          : await deps.moneyMovementGateway.ensurePayoutAccount({
              accountId: params.accountId,
              currencyCode: normalizeCurrencyCode("usd"),
              contactEmail: params.contactEmail,
              countryCode: "US",
              idempotencyKey: `settlement:payout-account:${params.accountId}`,
            });

        const ensuredRecordedAt = new Date().toISOString();
        const ensuredDestination = payoutDestinationChange(existing, ensured, ensuredRecordedAt);
        await recordProviderReadiness(
          {
            accountId: params.accountId,
            status: readinessStatus(ensured),
            missingRequirements: ensured.blockingRequirements,
            advisoryRequirements: ensured.advisoryRequirements,
            disabledReason: ensured.disabledReason,
            requirementsDeadline: ensured.requirementsDeadline,
            providerReference: ensured.providerReference,
            contactEmail: ensured.contactEmail ?? params.contactEmail ?? existing.contact_email,
            onboardingStatus: ensured.onboardingStatus,
            transferCapabilityStatus: ensured.transferCapabilityStatus,
            payoutCapabilityStatus: ensured.payoutCapabilityStatus,
            payoutDestinationStatus: ensured.payoutDestinationStatus,
            payoutDestinationFingerprint: ensuredDestination.fingerprint,
            payoutDestinationChangedAt: ensuredDestination.changedAt,
            payoutAccountDashboard: ensured.payoutAccountDashboard,
            lossesCollector: ensured.lossesCollector,
            feesCollector: ensured.feesCollector,
            requirementsCollector: ensured.requirementsCollector,
            recordedAt: ensuredRecordedAt,
          },
          context,
        );

        const link = await deps.moneyMovementGateway.createPayoutSetupLink({
          accountId: params.accountId,
          providerReference: ensured.providerReference,
          contactEmail: params.contactEmail,
          returnUrl: params.returnUrl,
          refreshUrl: params.refreshUrl,
          idempotencyKey: params.idempotencyKey,
        });

        const linkReadinessRecordedAt = new Date().toISOString();
        const linkDestination = payoutDestinationChange(existing, link.readiness, linkReadinessRecordedAt);
        await recordProviderReadiness(
          {
            accountId: params.accountId,
            status: readinessStatus(link.readiness),
            missingRequirements: link.readiness.blockingRequirements,
            advisoryRequirements: link.readiness.advisoryRequirements,
            disabledReason: link.readiness.disabledReason,
            requirementsDeadline: link.readiness.requirementsDeadline,
            providerReference: link.providerReference,
            contactEmail: link.readiness.contactEmail ?? params.contactEmail ?? existing.contact_email,
            onboardingStatus: link.readiness.onboardingStatus,
            transferCapabilityStatus: link.readiness.transferCapabilityStatus,
            payoutCapabilityStatus: link.readiness.payoutCapabilityStatus,
            payoutDestinationStatus: link.readiness.payoutDestinationStatus,
            payoutDestinationFingerprint: linkDestination.fingerprint,
            payoutDestinationChangedAt: linkDestination.changedAt,
            payoutAccountDashboard: link.readiness.payoutAccountDashboard,
            lossesCollector: link.readiness.lossesCollector,
            feesCollector: link.readiness.feesCollector,
            requirementsCollector: link.readiness.requirementsCollector,
            recordedAt: linkReadinessRecordedAt,
          },
          context,
        );

        await recordOperation({
          kind: "payout-setup-session-created",
          accountId: params.accountId,
          setupSurface: "hosted-onboarding",
          ...readinessOperationFields(link.readiness),
        });

        return {
          accountId: params.accountId,
          providerReference: link.providerReference,
          url: link.url,
          expiresAt: link.expiresAt,
          readiness: payoutReadinessRowFromProviderReadiness(
            params.accountId,
            link.readiness,
            linkReadinessRecordedAt,
            linkDestination.changedAt,
          ),
        };
      } catch (error) {
        await recordOperation({
          kind: "payout-setup-session-failed",
          accountId: params.accountId,
          setupSurface: "hosted-onboarding",
          safeCategory: classifySettlementProviderError(error),
        });
        throw error;
      }
    },
    async createPayoutAccountManagementSession(params, _context) {
      try {
        if (frictionPolicy.enabled && frictionPolicy.requireStepUpForAccountManagement) {
          const verified = await verifySensitiveAction({
            accountId: params.accountId,
            userId: params.actorUserId ?? null,
            token: params.sensitiveActionToken ?? null,
          });
          if (!verified) {
            await recordOperation({
              kind: "payout-account-management-session-failed",
              accountId: params.accountId,
              setupSurface: "embedded-account-management",
              safeCategory: "step_up_required",
            });
            throw new SettlementDomainError("Confirm it is you before managing payout account details.");
          }
        }
        const existing = await getPayoutReadiness(deps.db, params.accountId);
        if (!existing.provider_reference) {
          await recordOperation({
            kind: "payout-account-management-session-failed",
            accountId: params.accountId,
            setupSurface: "embedded-account-management",
            safeCategory: "missing_provider_account",
          });
          throw new SettlementDomainError("Payout setup must be started before managing payout account details.");
        }

        const session = await deps.moneyMovementGateway.createPayoutAccountManagementSession({
          accountId: params.accountId,
          providerReference: existing.provider_reference,
          idempotencyKey: `settlement:payout-account:${params.accountId}:embedded-manage:${createId("manage")}`,
        });

        await recordOperation({
          kind: "payout-account-management-session-created",
          accountId: params.accountId,
          setupSurface: "embedded-account-management",
          providerReference: session.providerReference,
        });

        return {
          clientSecret: session.clientSecret,
          providerReference: session.providerReference,
          expiresAt: session.expiresAt,
          components: session.components,
        };
      } catch (error) {
        if (!(error instanceof SettlementDomainError)) {
          await recordOperation({
            kind: "payout-account-management-session-failed",
            accountId: params.accountId,
            setupSurface: "embedded-account-management",
            safeCategory: classifySettlementProviderError(error),
          });
        }
        throw error;
      }
    },
    async createPayoutNotificationBannerSession(params) {
      const existing = await getPayoutReadiness(deps.db, params.accountId);
      if (!existing.provider_reference) {
        throw new SettlementDomainError("Payout setup must be started before showing payout notifications.");
      }

      const session = await deps.moneyMovementGateway.createPayoutNotificationBannerSession({
        accountId: params.accountId,
        providerReference: existing.provider_reference,
        idempotencyKey: `settlement:payout-account:${params.accountId}:embedded-notification-banner:${createId("banner")}`,
      });

      return {
        clientSecret: session.clientSecret,
        providerReference: session.providerReference,
        expiresAt: session.expiresAt,
        components: session.components,
      };
    },
    async refreshProviderReadiness(params, context) {
      let expectedProviderReference: string | null = null;
      try {
        const requestedProviderReference = normalizeOptionalText(params.providerReference);
        const existing = await getPayoutReadiness(deps.db, params.accountId);
        const existingProviderReference = normalizeOptionalText(existing.provider_reference);
        expectedProviderReference = existingProviderReference ?? requestedProviderReference;
        if (
          existingProviderReference &&
          requestedProviderReference &&
          existingProviderReference !== requestedProviderReference
        ) {
          throw providerReferenceRefreshError("Payout setup changed while refreshing. Please restart payout setup.");
        }

        const readiness = expectedProviderReference
          ? await deps.moneyMovementGateway.refreshPayoutReadiness({
              accountId: params.accountId,
              providerReference: expectedProviderReference,
            })
          : await deps.moneyMovementGateway.ensurePayoutAccount({
              accountId: params.accountId,
              currencyCode: normalizeCurrencyCode("usd"),
              contactEmail: params.contactEmail,
              countryCode: "US",
              idempotencyKey: `settlement:payout-account:${params.accountId}`,
            });
        const providerReference = canonicalProviderReference(readiness, expectedProviderReference);
        const recordedAt = new Date().toISOString();
        const canonicalReadiness = readinessWithProviderReference(readiness, providerReference);
        const destination = payoutDestinationChange(existing, canonicalReadiness, recordedAt);

        await recordProviderReadiness(
          {
            accountId: params.accountId,
            status: readinessStatus(canonicalReadiness),
            missingRequirements: canonicalReadiness.blockingRequirements,
            advisoryRequirements: canonicalReadiness.advisoryRequirements,
            disabledReason: canonicalReadiness.disabledReason,
            requirementsDeadline: canonicalReadiness.requirementsDeadline,
            providerReference: canonicalReadiness.providerReference,
            contactEmail: canonicalReadiness.contactEmail ?? params.contactEmail ?? existing.contact_email,
            onboardingStatus: canonicalReadiness.onboardingStatus,
            transferCapabilityStatus: canonicalReadiness.transferCapabilityStatus,
            payoutCapabilityStatus: canonicalReadiness.payoutCapabilityStatus,
            payoutDestinationStatus: canonicalReadiness.payoutDestinationStatus,
            payoutDestinationFingerprint: destination.fingerprint,
            payoutDestinationChangedAt: destination.changedAt,
            payoutAccountDashboard: canonicalReadiness.payoutAccountDashboard,
            lossesCollector: canonicalReadiness.lossesCollector,
            feesCollector: canonicalReadiness.feesCollector,
            requirementsCollector: canonicalReadiness.requirementsCollector,
            recordedAt,
          },
          context,
        );

        await recordOperation({
          kind: "payout-readiness-refresh-succeeded",
          accountId: params.accountId,
          ...readinessOperationFields(canonicalReadiness),
        });

        return payoutReadinessRowFromProviderReadiness(
          params.accountId,
          canonicalReadiness,
          recordedAt,
          destination.changedAt,
        );
      } catch (error) {
        await recordOperation({
          kind: "payout-readiness-refresh-failed",
          accountId: params.accountId,
          providerReference: expectedProviderReference,
          safeCategory: classifySettlementProviderError(error),
        });
        throw error;
      }
    },
    async recordProviderReadinessFromWebhook(params, context) {
      const projected = await getPayoutReadinessByProviderReference(deps.db, params.providerReference);
      const committed = projected
        ? null
        : await findCommittedPayoutReadinessByProviderReference(params.providerReference);
      const existing =
        projected ??
        (committed
          ? {
              account_id: committed.accountId,
              contact_email: committed.contactEmail,
              payout_destination_fingerprint: committed.payoutDestinationFingerprint,
              payout_destination_changed_at: committed.payoutDestinationChangedAt,
            }
          : null);
      if (!existing) {
        await recordOperation({
          kind: "payout-readiness-webhook-ignored",
          providerReference: params.providerReference,
          safeCategory: "missing_provider_account",
        });
        return null;
      }

      const recordedAt = params.recordedAt ?? new Date().toISOString();
      const destination = payoutDestinationChange(existing, params.readiness, recordedAt);
      const result = await recordProviderReadiness(
        {
          accountId: existing.account_id as AccountId,
          status: readinessStatus(params.readiness),
          missingRequirements: params.readiness.blockingRequirements,
          advisoryRequirements: params.readiness.advisoryRequirements,
          disabledReason: params.readiness.disabledReason,
          requirementsDeadline: params.readiness.requirementsDeadline,
          providerReference: params.readiness.providerReference,
          contactEmail: params.readiness.contactEmail ?? existing.contact_email,
          onboardingStatus: params.readiness.onboardingStatus,
          transferCapabilityStatus: params.readiness.transferCapabilityStatus,
          payoutCapabilityStatus: params.readiness.payoutCapabilityStatus,
          payoutDestinationStatus: params.readiness.payoutDestinationStatus,
          payoutDestinationFingerprint: destination.fingerprint,
          payoutDestinationChangedAt: destination.changedAt,
          payoutAccountDashboard: params.readiness.payoutAccountDashboard,
          lossesCollector: params.readiness.lossesCollector,
          feesCollector: params.readiness.feesCollector,
          requirementsCollector: params.readiness.requirementsCollector,
          recordedAt,
        },
        context,
      );

      if (destination.changed && destination.changedAt) {
        await notifyPayoutDestinationChanged({
          accountId: existing.account_id as AccountId,
          contactEmail: params.readiness.contactEmail ?? existing.contact_email,
          changedAt: destination.changedAt,
          providerReference: params.providerReference,
        });
      }

      await recordOperation({
        kind: "payout-readiness-webhook-recorded",
        accountId: existing.account_id,
        ...readinessOperationFields(params.readiness),
      });

      return result;
    },
    recordProviderReadiness,
    projectors: [
      createProjectionHandlerSet({
        projectionName: "settlement-payout-readiness-projection",
        handlers: buildPayoutReadinessProjectionHandlers(deps.db),
      }),
    ],
  };
}
