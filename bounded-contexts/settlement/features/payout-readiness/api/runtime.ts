import { createAggregateCommandHandler } from "@chase-sets/event-core/aggregate-command-handler";
import { createPassthroughDomainEventCodec } from "@chase-sets/event-core/codec";
import type { CommandHandler } from "@chase-sets/event-core/command-handler";
import type { EventStore } from "@chase-sets/event-core/event-store";
import { createProjectionHandlerSet, type ProjectionHandlerSet } from "@chase-sets/event-core/projector";
import type { ProjectionCheckpointStore } from "@chase-sets/event-core/projector";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
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

type PayoutReadinessRuntimeDeps = Readonly<{
  eventStore: EventStore;
  checkpointStore: ProjectionCheckpointStore;
  db: PgQueryable;
  moneyMovementGateway: MoneyMovementGateway;
  operationsRecorder?: SettlementOperationsRecorder;
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
  }>;
  createPayoutAccountManagementSession: (
    params: Readonly<{
      accountId: AccountId;
    }>,
    context: EventStoreContext,
  ) => Promise<{
    clientSecret: string;
    providerReference: string;
    expiresAt: string | null;
    components: readonly ["payout-account-management"];
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
      onboardingStatus?: string;
      transferCapabilityStatus?: string;
      payoutCapabilityStatus?: string;
      payoutDestinationStatus?: string;
      payoutAccountDashboard?: string;
      lossesCollector?: string;
      feesCollector?: string;
      requirementsCollector?: string;
      recordedAt?: string;
    }>,
    context: EventStoreContext,
  ) => Promise<{ accountId: AccountId; version: number }>;
  projectors: readonly ProjectionHandlerSet[];
}>;

function readinessStatus(readiness: ProviderPayoutReadiness): PayoutReadinessStatus {
  if (
    readiness.onboardingStatus === "complete" &&
    readiness.transferCapabilityStatus === "active" &&
    readiness.payoutCapabilityStatus === "active" &&
    readiness.payoutDestinationStatus === "ready" &&
    readiness.missingRequirements.length === 0
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
): SettlementPayoutReadinessRow {
  return {
    account_id: accountId,
    status: readinessStatus(readiness),
    missing_requirements: readiness.missingRequirements,
    provider_reference: readiness.providerReference,
    onboarding_status: readiness.onboardingStatus,
    transfer_capability_status: readiness.transferCapabilityStatus,
    payout_capability_status: readiness.payoutCapabilityStatus,
    payout_destination_status: readiness.payoutDestinationStatus,
    payout_account_dashboard: readiness.payoutAccountDashboard,
    losses_collector: readiness.lossesCollector,
    fees_collector: readiness.feesCollector,
    requirements_collector: readiness.requirementsCollector,
    updated_at: updatedAt,
  };
}

export function createPayoutReadinessRuntime(deps: PayoutReadinessRuntimeDeps): PayoutReadinessServices {
  const operationsRecorder = deps.operationsRecorder ?? createNoopSettlementOperationsRecorder();
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

  function readinessOperationFields(readiness: ProviderPayoutReadiness) {
    return {
      providerReference: readiness.providerReference,
      readinessStatus: readinessStatus(readiness),
      onboardingStatus: readiness.onboardingStatus,
      transferCapabilityStatus: readiness.transferCapabilityStatus,
      payoutCapabilityStatus: readiness.payoutCapabilityStatus,
      payoutDestinationStatus: readiness.payoutDestinationStatus,
      payoutAccountDashboard: readiness.payoutAccountDashboard,
      missingRequirementCount: readiness.missingRequirements.length,
    };
  }

  async function recordProviderReadiness(
    params: Readonly<{
      accountId: AccountId;
      status: PayoutReadinessStatus | string;
      missingRequirements?: readonly string[];
      providerReference?: string | null;
      onboardingStatus?: string;
      transferCapabilityStatus?: string;
      payoutCapabilityStatus?: string;
      payoutDestinationStatus?: string;
      payoutAccountDashboard?: string;
      lossesCollector?: string;
      feesCollector?: string;
      requirementsCollector?: string;
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
        providerReference: params.providerReference ?? null,
        onboardingStatus: params.onboardingStatus ?? "not-started",
        transferCapabilityStatus: params.transferCapabilityStatus ?? "inactive",
        payoutCapabilityStatus: params.payoutCapabilityStatus ?? "inactive",
        payoutDestinationStatus: params.payoutDestinationStatus ?? "missing",
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

        await recordProviderReadiness(
          {
            accountId: params.accountId,
            status: readinessStatus(ensured),
            missingRequirements: ensured.missingRequirements,
            providerReference: ensured.providerReference,
            onboardingStatus: ensured.onboardingStatus,
            transferCapabilityStatus: ensured.transferCapabilityStatus,
            payoutCapabilityStatus: ensured.payoutCapabilityStatus,
            payoutDestinationStatus: ensured.payoutDestinationStatus,
            payoutAccountDashboard: ensured.payoutAccountDashboard,
            lossesCollector: ensured.lossesCollector,
            feesCollector: ensured.feesCollector,
            requirementsCollector: ensured.requirementsCollector,
          },
          context,
        );

        const session = await deps.moneyMovementGateway.createPayoutSetupSession({
          accountId: params.accountId,
          providerReference: ensured.providerReference,
          idempotencyKey: `settlement:payout-account:${params.accountId}:embedded-setup:${createId("setup")}`,
        });

        await recordProviderReadiness(
          {
            accountId: params.accountId,
            status: readinessStatus(session.readiness),
            missingRequirements: session.readiness.missingRequirements,
            providerReference: session.providerReference,
            onboardingStatus: session.readiness.onboardingStatus,
            transferCapabilityStatus: session.readiness.transferCapabilityStatus,
            payoutCapabilityStatus: session.readiness.payoutCapabilityStatus,
            payoutDestinationStatus: session.readiness.payoutDestinationStatus,
            payoutAccountDashboard: session.readiness.payoutAccountDashboard,
            lossesCollector: session.readiness.lossesCollector,
            feesCollector: session.readiness.feesCollector,
            requirementsCollector: session.readiness.requirementsCollector,
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
    async createPayoutAccountManagementSession(params, _context) {
      try {
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
          idempotencyKey: `settlement:payout-account:${params.accountId}:embedded-manage`,
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

        await recordProviderReadiness(
          {
            accountId: params.accountId,
            status: readinessStatus(canonicalReadiness),
            missingRequirements: canonicalReadiness.missingRequirements,
            providerReference: canonicalReadiness.providerReference,
            onboardingStatus: canonicalReadiness.onboardingStatus,
            transferCapabilityStatus: canonicalReadiness.transferCapabilityStatus,
            payoutCapabilityStatus: canonicalReadiness.payoutCapabilityStatus,
            payoutDestinationStatus: canonicalReadiness.payoutDestinationStatus,
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

        return payoutReadinessRowFromProviderReadiness(params.accountId, canonicalReadiness, recordedAt);
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
      const existing = await getPayoutReadinessByProviderReference(deps.db, params.providerReference);
      if (!existing) {
        await recordOperation({
          kind: "payout-readiness-webhook-ignored",
          providerReference: params.providerReference,
          safeCategory: "missing_provider_account",
        });
        return null;
      }

      const result = await recordProviderReadiness(
        {
          accountId: existing.account_id as AccountId,
          status: readinessStatus(params.readiness),
          missingRequirements: params.readiness.missingRequirements,
          providerReference: params.readiness.providerReference,
          onboardingStatus: params.readiness.onboardingStatus,
          transferCapabilityStatus: params.readiness.transferCapabilityStatus,
          payoutCapabilityStatus: params.readiness.payoutCapabilityStatus,
          payoutDestinationStatus: params.readiness.payoutDestinationStatus,
          payoutAccountDashboard: params.readiness.payoutAccountDashboard,
          lossesCollector: params.readiness.lossesCollector,
          feesCollector: params.readiness.feesCollector,
          requirementsCollector: params.readiness.requirementsCollector,
          recordedAt: params.recordedAt,
        },
        context,
      );

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
