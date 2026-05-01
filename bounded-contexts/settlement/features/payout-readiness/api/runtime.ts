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
  normalizeCurrencyCode,
  normalizePayoutReadinessStatus,
  SettlementDomainError,
  type PayoutReadinessStatus,
} from "../../../support/runtime-support/common";
import type {
  MoneyMovementGateway,
  ProviderPayoutReadiness,
} from "@chase-sets/money-movement";
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
import {
  buildPayoutSetupProgress,
  type PayoutSetupProgress,
} from "../domain/setup-progress";

type PayoutReadinessRuntimeDeps = Readonly<{
  eventStore: EventStore;
  checkpointStore: ProjectionCheckpointStore;
  db: PgQueryable;
  moneyMovementGateway: MoneyMovementGateway;
}>;

export type PayoutReadinessServices = Readonly<{
  commandHandler: CommandHandler<
    PayoutReadinessCommand,
    PayoutReadinessState,
    PayoutReadinessEvent
  >;
  getPayoutReadiness: (accountId: string) => Promise<SettlementPayoutReadinessRow>;
  getPayoutSetupProgress: (accountId: string) => Promise<PayoutSetupProgress>;
  createOnboardingSession: (
    params: Readonly<{
      accountId: AccountId;
      returnUrl?: string | null;
      refreshUrl?: string | null;
    }>,
    context: EventStoreContext,
  ) => Promise<{ url: string; providerReference: string; expiresAt: string | null }>;
  createAccountManagementSession: (
    params: Readonly<{
      accountId: AccountId;
      returnUrl?: string | null;
    }>,
    context: EventStoreContext,
  ) => Promise<{ url: string; providerReference: string; expiresAt: string | null }>;
  refreshProviderReadiness: (
    params: Readonly<{ accountId: AccountId }>,
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
      recordedAt?: string;
    }>,
    context: EventStoreContext,
  ) => Promise<{ accountId: AccountId; version: number }>;
  projectors: readonly Projector[];
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

  if (
    readiness.transferCapabilityStatus === "inactive" ||
    readiness.payoutCapabilityStatus === "inactive"
  ) {
    return "restricted";
  }

  return "pending";
}

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
    async createOnboardingSession(params, context) {
      const existing = await getPayoutReadiness(deps.db, params.accountId);
      const ensured = existing.provider_reference
        ? await deps.moneyMovementGateway.refreshPayoutReadiness({
            accountId: params.accountId,
            providerReference: existing.provider_reference,
          })
        : await deps.moneyMovementGateway.ensurePayoutAccount({
            accountId: params.accountId,
            currencyCode: normalizeCurrencyCode("usd"),
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
        },
        context,
      );

      const session = await deps.moneyMovementGateway.createOnboardingSession({
        accountId: params.accountId,
        providerReference: ensured.providerReference,
        returnUrl: params.returnUrl,
        refreshUrl: params.refreshUrl,
        idempotencyKey: `settlement:payout-account:${params.accountId}:onboarding`,
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
        },
        context,
      );

      return {
        url: session.url,
        providerReference: session.providerReference,
        expiresAt: session.expiresAt,
      };
    },
    async createAccountManagementSession(params, _context) {
      const existing = await getPayoutReadiness(deps.db, params.accountId);
      if (!existing.provider_reference) {
        throw new SettlementDomainError(
          "Payout setup must be started before managing payout account details.",
        );
      }

      const session =
        await deps.moneyMovementGateway.createAccountManagementSession({
          accountId: params.accountId,
          providerReference: existing.provider_reference,
          returnUrl: params.returnUrl,
          idempotencyKey: `settlement:payout-account:${params.accountId}:manage`,
        });

      return {
        url: session.url,
        providerReference: session.providerReference,
        expiresAt: session.expiresAt,
      };
    },
    async refreshProviderReadiness(params, context) {
      const existing = await getPayoutReadiness(deps.db, params.accountId);
      const readiness = existing.provider_reference
        ? await deps.moneyMovementGateway.refreshPayoutReadiness({
            accountId: params.accountId,
            providerReference: existing.provider_reference,
          })
        : await deps.moneyMovementGateway.ensurePayoutAccount({
            accountId: params.accountId,
            currencyCode: normalizeCurrencyCode("usd"),
            idempotencyKey: `settlement:payout-account:${params.accountId}`,
          });

      await recordProviderReadiness(
        {
          accountId: params.accountId,
          status: readinessStatus(readiness),
          missingRequirements: readiness.missingRequirements,
          providerReference: readiness.providerReference,
          onboardingStatus: readiness.onboardingStatus,
          transferCapabilityStatus: readiness.transferCapabilityStatus,
          payoutCapabilityStatus: readiness.payoutCapabilityStatus,
          payoutDestinationStatus: readiness.payoutDestinationStatus,
        },
        context,
      );

      return getPayoutReadiness(deps.db, params.accountId);
    },
    async recordProviderReadinessFromWebhook(params, context) {
      const existing = await getPayoutReadinessByProviderReference(
        deps.db,
        params.providerReference,
      );
      if (!existing) {
        return null;
      }

      return recordProviderReadiness(
        {
          accountId: existing.account_id as AccountId,
          status: readinessStatus(params.readiness),
          missingRequirements: params.readiness.missingRequirements,
          providerReference: params.readiness.providerReference,
          onboardingStatus: params.readiness.onboardingStatus,
          transferCapabilityStatus: params.readiness.transferCapabilityStatus,
          payoutCapabilityStatus: params.readiness.payoutCapabilityStatus,
          payoutDestinationStatus: params.readiness.payoutDestinationStatus,
          recordedAt: params.recordedAt,
        },
        context,
      );
    },
    recordProviderReadiness,
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
