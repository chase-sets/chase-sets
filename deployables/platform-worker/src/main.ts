import type { CatalogServices } from "@chase-sets/catalog/server";
import type { InventoryServices } from "@chase-sets/inventory/server";
import type { SettlementServices } from "@chase-sets/settlement/server";

import "./observability-prelude";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { createNoopNotificationAdapter, type NotificationChannelAdapter } from "@chase-sets/outbound-messaging";
import { isChannelsServices, type ChannelsServices } from "@chase-sets/channels/server";
import {
  createBuyerOfferPricing,
  type ChannelConnectionIdentityReader,
  type PricingHostPorts,
} from "@chase-sets/pricing/server";
import { createSesEmailNotificationAdapter, createSesSendRequest } from "@chase-sets/ses-email";
import { createLocalEmailCaptureNotificationAdapter } from "@chase-sets/local-email-capture";
import { createStripePaymentProcessorGateway } from "@chase-sets/stripe-payments";
import { createStripeConnectMoneyMovementGateway } from "@chase-sets/stripe-connect";
import { createEasyPostPostageLabelProvider } from "@chase-sets/easypost-postage";
import { bootstrapContextDatabase } from "@chase-sets/bounded-context-runtime";
import { module as settlementModule } from "@chase-sets/settlement";
import { createFilesystemObjectStorage, createS3ObjectStorage, type ObjectStorage } from "@chase-sets/object-storage";

import { createStorageLocationAuthority } from "@chase-sets/inventory/server";
import { type MarketplaceServices } from "@chase-sets/marketplace/server";
import { createPlatformWorkerInventoryDraftListingConsumer } from "./inventory-draft-listing-consumer";
import type { PricingServices } from "@chase-sets/pricing/server";
import { createIdentityTermsAcceptanceResolver, type IdentityServices } from "@chase-sets/identity/server";
import {
  activateMarketplaceLabelPostage,
  settlementOperationLogFields,
  type MarketplaceLabelPostageActivation,
} from "@chase-sets/settlement/server";
import {
  createCheckoutProcessingFeePolicyResolver,
  createCommercialTermsResolver,
  type CommercialTermsAccountSource,
  type CommercialTermsResolver,
} from "@chase-sets/commercial-terms/server";
import {
  createSettlementBalanceCreditResolver,
  createSettlementWalletSpendHoldPort,
} from "@chase-sets/settlement/server";
import {
  collectProjectionOperationRunners,
  collectWorkerRunners,
  createWorkerHost,
  createWorkerRunnerLoop,
  type WorkerHostRuntime,
  type WorkerRunner,
  type WorkerRunnerLoop,
} from "@chase-sets/platform-runtime/worker";
import { createWorkerObserver } from "@chase-sets/platform-runtime/worker-observer";
import {
  createProjectionWakeSchedulerRunners,
  startPostgresProjectionWakePushDispatcher,
  type ProjectionWakeIntentLifecycleEvent,
  type ProjectionWakeSchedulerObserver,
} from "@chase-sets/platform-runtime/projection-wake-scheduler";
import {
  runProjectionWakeRelayActiveSession,
  startProjectionWakeRelaySupervisor,
  type ProjectionWakeRelayRuntimeObserver,
  type ProjectionWakeRelaySourceRuntime,
} from "@chase-sets/platform-runtime/projection-wake-relay";
import {
  buildProjectionInterestIndex,
  summarizeProjectionInterestIndex,
} from "@chase-sets/platform-runtime/projection-interest-index";
import { listProjectionInterestOverridesForPushMigration } from "@chase-sets/platform-runtime/projection-push-migration";
import { listSourceContextWakeRelayConfigs } from "@chase-sets/platform-runtime/source-context-wake-registry";
import { createPostgresWorkSignalStore } from "@chase-sets/platform-runtime/work-signal-store";
import {
  collectRetentionSweepTargets,
  createRetentionSweepLogObserver,
} from "@chase-sets/platform-runtime/retention-sweep";
import { createPgPool, createPostgresEventStore, type PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { closeContextPools } from "@chase-sets/platform-runtime/context-pools";
import {
  assertRunnerCapacity,
  assertRunnerLaneIsolation,
  summarizeDatabasePoolPressure,
  summarizeRunnerCapacity,
} from "@chase-sets/platform-runtime/worker-capacity";
import { attributeProjectionHotLag } from "@chase-sets/platform-runtime/projection-hot-lag-evidence";

import { createTwilioMessagingAdapter } from "@chase-sets/twilio-messaging";
import {
  bootstrapPlatformControlPlane,
  createEvidenceWindowCorrelation,
  createNullEvidenceWindowCorrelation,
  createPostgresEvidenceWindowRegistration,
  createPostgresEvidenceWindowProviderWrite,
  createPostgresPlatformControlPlane,
} from "@chase-sets/platform-runtime/control-plane";
import { createProcessDrainState, startGracefulHttpServer } from "@chase-sets/platform-runtime/process-lifecycle";
import {
  listConsumedEventTypes,
  PLATFORM_WORKER_KIND,
  WORKER_CONSUMED_EVENT_TYPES_METADATA_KEY,
} from "@chase-sets/platform-runtime/worker-event-capability";
import {
  createRuntimeLifecycleRegistry,
  runWithRuntimeLifecycleTimeout,
} from "@chase-sets/platform-runtime/runtime-lifecycle";
import {
  getObservabilityRuntime,
  recordCatalogControlPlaneEvent,
  recordCatalogIntegrationJob,
  recordCatalogIntegrationOptionQuery,
  recordDiscoverySearchQuerySignal,
  recordDiscoveryQueryEmbeddingLoad,
  recordDiscoverySearchRetrievalFailure,
  recordProjectionInterestIndexLookup,
  recordProjectionStatus,
  recordProjectionWakeIntentEnqueueOutcome,
  recordProjectionWakeIntentOutcome,
  recordProjectionWakeRelayCatchUp,
  recordProjectionWakeRelayFanOut,
  recordSettlementOperationSignal,
  type ProjectionWakeIntentOutcomeSignal,
} from "@chase-sets/observability";
import { loadConfig, type PlatformWorkerCatalogAssetStorageConfig } from "./config";
import {
  createAgentGrantRevocationWorkerPorts,
  createOrderingAgentWebhookOrderResolvers,
} from "./agent-webhook-runners";

import { createPlatformWorkerMarketplaceChannelInboundClampBinding } from "./channels-outbound-runners";
import { createPlatformChannelSaleRecorder } from "./channels-reconciliation-runners";
import { closePlatformWorkerPools, createPlatformWorkerPools, createSettlementBootstrapPool } from "./database-pools";
import { platformEmailTemplateRenderer } from "./email-template-renderer";
import { workerContextRegistry } from "./context-registry";
import { createPlatformWorkerJobComposition } from "./worker-job-composition";
import { createSupportEvidenceCleanupHostPort } from "./scheduled-runners";

import { runStartupRetry } from "./startup-retry";

import {
  createFakeMoneyMovementGateway,
  createFakePaymentProcessorGateway,
  createSandboxPostageLabelProvider,
} from "./test-support/provider-gateways";

const observability = getObservabilityRuntime();
const logger = observability.logger;
const config = loadConfig();
const workerKind = PLATFORM_WORKER_KIND;
const platformWorkerGroupsEnabled = config.runtimeProfile !== "landing";
const pools = createPlatformWorkerPools(config);
await runWorkerStartupDatabaseStep("bootstrap platform control plane", () =>
  bootstrapPlatformControlPlane(pools.control),
);
const runtimeLifecycle = createRuntimeLifecycleRegistry();
const controlPlane = createPostgresPlatformControlPlane(pools.control, { lifecycle: runtimeLifecycle });
const evidenceWindowCorrelation =
  config.evidenceWindowAdmissionSecret && config.stripeEffectiveMode === "test"
    ? createEvidenceWindowCorrelation(createPostgresEvidenceWindowRegistration(pools.control))
    : createNullEvidenceWindowCorrelation();
let projectionWakeRunnerLoop: WorkerRunnerLoop | null = null;
const workSignalStore = createPostgresWorkSignalStore(pools.workSignal, {
  observer: {
    projectionWakeIntentEnqueued: (event) => {
      recordProjectionWakeIntentEnqueueOutcome({
        outcome: event.outcome,
        sourceContextName: event.sourceContextName,
        targetContextName: event.targetContextName,
        projectionName: event.projectionName,
        priorityLane: event.priorityLane,
        origin: event.origin,
        routingMode: event.routingMode,
      });
      if (config.projectionWakeScheduler.pushDispatchEnabled) {
        projectionWakeRunnerLoop?.nudge();
      }
    },
  },
});

const evidenceWindowProviderWrite = createPostgresEvidenceWindowProviderWrite(pools.control);
const paymentProcessorGateway =
  config.paymentProcessor.kind === "stripe"
    ? createStripePaymentProcessorGateway({
        evidenceWindowCorrelation,
        evidenceWindowProviderWrite,
        secretKey: config.paymentProcessor.secretKey,
        publishableKey: config.paymentProcessor.publishableKey,
        webhookSecret: config.paymentProcessor.webhookSecret,
        previousWebhookSecrets: config.paymentProcessor.previousWebhookSecrets,
        apiBaseUrl: config.paymentProcessor.apiBaseUrl,
      })
    : createFakePaymentProcessorGateway();
const moneyMovementGateway =
  config.moneyMovement.kind === "stripe"
    ? createStripeConnectMoneyMovementGateway({
        evidenceWindowCorrelation,
        evidenceWindowProviderWrite,
        secretKey: config.moneyMovement.secretKey,
        webhookSecret: config.moneyMovement.webhookSecret,
        previousWebhookSecrets: config.moneyMovement.previousWebhookSecrets,
        accountsApi: config.moneyMovement.connectAccountsApi,
        apiBaseUrl: config.moneyMovement.apiBaseUrl,
      })
    : createFakeMoneyMovementGateway();
const settlementOperationsRecorder = {
  record(event: Record<string, unknown>) {
    recordSettlementOperationSignal({
      kind: String(event.kind ?? "unknown"),
      providerName: typeof event.providerName === "string" ? event.providerName : null,
      setupSurface: typeof event.setupSurface === "string" ? event.setupSurface : null,
      safeCategory: typeof event.safeCategory === "string" ? event.safeCategory : null,
      readinessStatus: typeof event.readinessStatus === "string" ? event.readinessStatus : null,
    });
    logger.info("Settlement operation recorded.", {
      type: "settlement.operation",
      ...settlementOperationLogFields(event),
    });
  },
};
const postageLabelProvider =
  config.postage.kind === "easypost"
    ? createEasyPostPostageLabelProvider({
        apiKey: config.postage.apiKey,
        apiBaseUrl: config.postage.apiBaseUrl,
        mode: config.postage.mode,
      })
    : createSandboxPostageLabelProvider();
const catalogAssetStorage = createCatalogAssetStorage(config.catalogAssetStorage);
const sourceObservationTelemetry = createSourceObservationTelemetry();
let runtime: WorkerHostRuntime | null = null;
const marketplaceChannelInboundClamp = createPlatformWorkerMarketplaceChannelInboundClampBinding(
  Boolean(pools.marketplace),
  () => runtime?.services.marketplace as MarketplaceServices | undefined,
);
const commercialTermsResolver = pools["commercial-terms"]
  ? createCommercialTermsResolver({
      db: pools["commercial-terms"],
      accountSource: createIdentityCommercialTermsAccountSource(
        () => runtime?.services.identity as IdentityServices | undefined,
      ),
    })
  : undefined;
if (pools.checkout && !commercialTermsResolver) {
  throw new Error("Checkout requires a Commercial Terms resolver backed by the Commercial Terms database.");
}
const pricingHostPorts: PricingHostPorts | undefined = pools.pricing
  ? {
      commercialTermsResolver: requirePricingCommercialTermsResolver(commercialTermsResolver),
      channelConnectionIdentityReader: createChannelConnectionIdentityReader(() => {
        const services = runtime?.services.channels;
        return isChannelsServices(services) ? services : undefined;
      }),
    }
  : undefined;
const termsAcceptanceResolver = pools.identity ? createIdentityTermsAcceptanceResolver(pools.identity) : undefined;
const balanceCreditResolver = pools.settlement
  ? createSettlementBalanceCreditResolver(pools.settlement, {
      termsAcceptanceResolver,
      // Wallet write port so checkout reserves applied balance authoritatively
      // and concurrent checkouts cannot double-spend wallet credit.
      walletSpendHolds: createSettlementWalletSpendHoldPort(pools.settlement),
    })
  : undefined;
const checkoutProcessingFeePolicyResolver = pools["commercial-terms"]
  ? createCheckoutProcessingFeePolicyResolver(pools["commercial-terms"])
  : undefined;
const emailNotificationAdapter = createPlatformEmailNotificationAdapter(config.notificationEmail);
const inventoryDraftListingConsumer = createPlatformWorkerInventoryDraftListingConsumer(
  () => runtime?.services.marketplace as MarketplaceServices | undefined,
);

const identityHostPorts = {
  capabilityAdministrationAuthority: { kind: "deny-all", diagnostic: "authority_absent" },
} satisfies Pick<import("@chase-sets/identity/server").IdentityHostPorts, "capabilityAdministrationAuthority">;
const supportEvidenceCleanupHostPort = createSupportEvidenceCleanupHostPort(config, logger);
const constructWorkerRuntime = (marketplaceLabelPostageActivation?: MarketplaceLabelPostageActivation) =>
  createWorkerHost(workerContextRegistry, "platform-worker", {
    pools,
    runtimeProfile: config.runtimeProfile,
    runtimeLifecycle,
    hostPorts: {
      inventoryDraftListingConsumer,
      draftListingDelivery: inventoryDraftListingConsumer,
      ...identityHostPorts,
      ...supportEvidenceCleanupHostPort,
      ...(pools.pricing ? { managedOfferPricing: createBuyerOfferPricing(pools.pricing) } : {}),
      processorGateway: paymentProcessorGateway,
      moneyMovementGateway,
      operationsRecorder: settlementOperationsRecorder,
      postageLabelProvider,
      addressVerificationProvider: postageLabelProvider,
      catalogAssetStorage,
      ...(pricingHostPorts ?? {}),
      sourceObservationTelemetry,
      evidenceWindowCorrelation,
      evidenceWindowProviderWrite,
      ...(commercialTermsResolver ? { commercialTermsResolver } : {}),
      ...(balanceCreditResolver ? { balanceCreditResolver } : {}),
      ...(checkoutProcessingFeePolicyResolver ? { checkoutProcessingFeePolicyResolver } : {}),
      agentWebhookOrderResolvers: createOrderingAgentWebhookOrderResolvers({
        ordering: pools.ordering,
        linkedAuthorizations: pools.identity,
        oauthClients: pools.auth,
      }),
      // Ordering's cleanup authority is an API-only read surface: the
      // worker runs projectors, subscriptions, and scheduled runners and never
      // serves N8. The variant is stated explicitly rather than omitted, so an
      // unsupplied nonoptional port can never masquerade as "mounted".
      inventoryCleanupAuthority: { kind: "not-mounted" },
      marketplaceChannelInboundClamp,
      channelCredentialKeyring: config.channelCredentialKeyring,
      ebayOAuthConfiguration: config.ebayOAuthConfiguration,
      ...(pools.inventory ? { channelSaleRecorder: createPlatformChannelSaleRecorder(pools.inventory) } : {}),
      storageLocationAuthority: {
        resolve: pools.inventory
          ? createStorageLocationAuthority(pools.inventory).resolveStorageLocationAuthority
          : async () => null,
      },
      searchEmbeddingConfig: config.discoverySearchEmbeddings,
      searchTelemetry: {
        recordSearchQuery: recordDiscoverySearchQuerySignal,
        recordQueryEmbeddingLoad: recordDiscoveryQueryEmbeddingLoad,
        recordSearchRetrievalFailure: recordDiscoverySearchRetrievalFailure,
      },
      ...(marketplaceLabelPostageActivation ? { marketplaceLabelPostageActivation } : {}),
    },
  });

if (config.runtimeProfile === "landing") {
  runtime = constructWorkerRuntime();
} else {
  const settlementBootstrapPool = createSettlementBootstrapPool(config);
  try {
    await runWorkerStartupDatabaseStep("bootstrap Settlement database", () =>
      bootstrapContextDatabase(settlementModule, settlementBootstrapPool),
    );
  } finally {
    await closeContextPools({ settlementBootstrapPool });
  }
  const marketplaceLabelPostageActivation = await runWorkerStartupDatabaseStep(
    "activate marketplace label postage",
    () => activateMarketplaceLabelPostage(pools.settlement),
  ).catch((error) => {
    logger.error("Marketplace label postage runner activation refused.", {
      type: "settlement.marketplace_label_postage.activation_refused",
      error,
    });
    throw error;
  });
  runtime = constructWorkerRuntime(marketplaceLabelPostageActivation);
}

function createChannelConnectionIdentityReader(
  getServices: () => ChannelsServices | undefined,
): ChannelConnectionIdentityReader {
  return {
    resolve: async (input) => {
      const connection = await getServices()?.connections.getConnection(input);
      return connection
        ? {
            connectionId: connection.connectionId,
            providerKey: connection.providerKey,
            environment: connection.environment,
          }
        : null;
    },
  };
}

function requirePricingCommercialTermsResolver(resolver: CommercialTermsResolver | undefined): CommercialTermsResolver {
  if (!resolver) {
    throw new Error("Pricing cannot be mounted without the Commercial Terms resolver host port.");
  }
  return resolver;
}

function createIdentityCommercialTermsAccountSource(
  getIdentityServices: () => IdentityServices | undefined,
): CommercialTermsAccountSource {
  return {
    getAccount: async (accountId) => {
      const account = await getIdentityServices()?.accounts?.getAccountState?.(accountId);
      if (!account?.id || !account.accountType) {
        return null;
      }

      return {
        account_id: account.id,
        account_type: account.accountType,
        status: account.status,
        founders_window_started_at: account.foundersWindow?.startedAt ?? null,
        founders_window_ends_at: account.foundersWindow?.endsAt ?? null,
      };
    },
  };
}

const projectionRunners = collectWorkerRunners(runtime, {
  workSignalStore,
});
// Projection operations get their own runner group (and loop) so queued
// recovery operations are never starved by projection-group backlog priority,
// and a hung operation cannot pin projection replay capacity.
const projectionOperationRunners = collectProjectionOperationRunners(runtime, {
  controlPlane,
  runnerCount: config.projectionOperations.runnerCount,
  claimTtlMs: config.leaseTtlMs * 4,
  leaseTtlMs: config.leaseTtlMs,
  leaseRenewIntervalMs: config.leaseRenewIntervalMs,
  operationTimeoutMs: config.projectionOperations.operationTimeoutMs,
  rebuildOperationTimeoutMs: config.projectionOperations.rebuildOperationTimeoutMs,
  maxAttempts: config.projectionOperations.maxAttempts,
  retryBackoffBaseMs: config.projectionOperations.retryBackoffBaseMs,
  retryBackoffMaxMs: config.projectionOperations.retryBackoffMaxMs,
  leaseAcquireTimeoutMs: config.projectionOperations.leaseAcquireTimeoutMs,
  workSignalStore,
  observer: createWorkerObserver(logger, workerKind, undefined, recordProjectionStatus),
});
const notificationOutboxContextNames = new Set<string>(
  workerContextRegistry
    .filter((entry) => entry.manifest.hostPorts?.some((port) => port.portName === "notificationOutbox"))
    .map((entry) => entry.contextName),
);
const jobComposition = createPlatformWorkerJobComposition(
  {
    services: runtime.services,
    runtime,
    ports: createAgentGrantRevocationWorkerPorts(runtime),
    config,
    controlPlane,
    logger,
    notification: platformWorkerGroupsEnabled
      ? {
          emailAdapter: emailNotificationAdapter,
          mobileMessageAdapters: () => createMobileMessageAdapters(config),
          outboxContextNames: notificationOutboxContextNames,
        }
      : undefined,
  },
  {
    workSignalCleanup: () => ({
      workSignalStore,
      intervalMs: config.projectionWakeScheduler.cleanupIntervalMs,
      observer: createProjectionWakeSchedulerLogObserver(),
    }),
    retentionSweep: () => ({
      targets: collectRetentionSweepTargets(runtime, pools.control),
      observer: createRetentionSweepLogObserver(logger),
    }),
  },
);
const inventoryImportJobRunners = jobComposition["inventory-jobs"];
const bulkJobRunners = jobComposition.jobs;
const dispatchRunners = jobComposition.dispatch;
const scheduledJobRunners = jobComposition.scheduled;
// Projection-group-level wake kill switch (WORKER_WAKE_DISABLED_PROJECTIONS):
// disabled `<target-context>:<projection-name>` keys are removed from the wake
// scheduler's hosted groups and marked disabled in the relay interest index,
// so the relay fans out no new wake intents for them and this worker never
// wake-runs them. Fallback polling (`projections` runner group) is untouched.
const projectionWakeDisabledProjectionKeys = new Set(config.projectionWakeDisabledProjections);
const projectionWakeSchedulerProjectionGroups = runtime.projectionGroups.filter(
  (group) => !projectionWakeDisabledProjectionKeys.has(`${group.targetContextName}:${group.projectionName}`),
);
if (projectionWakeDisabledProjectionKeys.size > 0) {
  const hostedProjectionKeys = new Set(
    runtime.projectionGroups.map((group) => `${group.targetContextName}:${group.projectionName}`),
  );
  logger.warn("Projection wake handling disabled for configured projection groups.", {
    type: "projection-wake.controls.projections_disabled",
    disabledProjectionKeys: config.projectionWakeDisabledProjections,
    unknownDisabledProjectionKeys: config.projectionWakeDisabledProjections.filter(
      (projectionKey) => !hostedProjectionKeys.has(projectionKey),
    ),
  });
}
const projectionWakeRunners = config.projectionWakeScheduler.enabled
  ? createProjectionWakeSchedulerRunners({
      workerId: config.workerId,
      controlPlane,
      workSignalStore,
      projectionGroups: projectionWakeSchedulerProjectionGroups,
      lanes: [
        { lane: "hot", runnerCount: config.projectionWakeScheduler.hotLaneRunnerCount },
        { lane: "standard", runnerCount: config.projectionWakeScheduler.standardLaneRunnerCount },
        { lane: "bulk", runnerCount: config.projectionWakeScheduler.bulkLaneRunnerCount },
      ],
      maxClaimsPerRun: config.projectionWakeScheduler.maxClaimsPerRun,
      claimTtlMs: config.projectionWakeScheduler.claimTtlMs,
      leaseTtlMs: config.leaseTtlMs,
      leaseRenewIntervalMs: config.leaseRenewIntervalMs,
      statementTimeoutMs: config.projectionWakeScheduler.statementTimeoutMs,
      retryBackoffBaseMs: config.projectionWakeScheduler.retryBackoffBaseMs,
      retryBackoffMaxMs: config.projectionWakeScheduler.retryBackoffMaxMs,
      maxAttempts: config.projectionWakeScheduler.maxAttempts,
      observer: createProjectionWakeSchedulerLogObserver(),
    })
  : [];
const runnerGroups = [
  createRunnerGroup("projections", projectionRunners, config.projectionMaxConcurrentRunners),
  createRunnerGroup("operations", projectionOperationRunners, config.projectionOperations.runnerCount),
  createRunnerGroup("jobs", bulkJobRunners, config.jobMaxConcurrentRunners),
  createRunnerGroup("inventory-jobs", inventoryImportJobRunners, config.inventoryImportBatchJobMaxConcurrentRunners),
  createRunnerGroup("dispatch", dispatchRunners, config.dispatchMaxConcurrentRunners),
  createRunnerGroup("scheduled", scheduledJobRunners, config.scheduledMaxConcurrentRunners),
  createRunnerGroup(
    "wakes",
    projectionWakeRunners,
    config.projectionWakeScheduler.maxConcurrentRunners,
    config.projectionWakeScheduler.pollIntervalMs,
    // Reserve wake-loop capacity for the hot lane so critical read-after-write
    // wakes are never starved by in-flight standard/bulk passes. The loop
    // clamps the reservation so standard/bulk always keep at least one slot.
    config.projectionWakeScheduler.hotLaneRunnerCount,
  ),
].filter((group) => group.runners.length > 0);

const runnerLoops = runnerGroups.map((group) => ({
  ...group,
  loop: createWorkerRunnerLoop({
    workerId: config.workerId,
    controlPlane,
    runners: group.runners,
    maxConcurrentRunners: group.maxConcurrentRunners,
    reservedRunnerSlots: group.reservedRunnerSlots,
    priorityRefreshIntervalMs: config.projectionPriorityRefreshIntervalMs,
    leaseTtlMs: config.leaseTtlMs,
    leaseRenewIntervalMs: config.leaseRenewIntervalMs,
    pollIntervalMs: group.pollIntervalMs ?? config.pollIntervalMs,
    observer: createWorkerObserver(logger, workerKind, group.name, recordProjectionStatus),
    onError: (error, runner) => {
      logger.error("Platform worker runner failed.", {
        type: "platform-worker.runner.failed",
        runnerGroup: group.name,
        runner: runner.name,
        runnerKind: runner.kind,
        error,
      });
    },
  }),
}));
projectionWakeRunnerLoop = runnerLoops.find((runnerLoop) => runnerLoop.name === "wakes")?.loop ?? null;
const projectionWakePushDispatcher =
  config.projectionWakeScheduler.pushDispatchEnabled && projectionWakeRunnerLoop
    ? startPostgresProjectionWakePushDispatcher({
        listenerPool: pools.workSignal,
        listenRetryCooldownMs: config.projectionWakeScheduler.pollIntervalMs,
        listenerObserver: {
          listenerUnavailable: ({ error }) => {
            logger.warn("Projection wake push dispatcher listener unavailable; relying on wake polling.", {
              type: "projection-wake-push.listener_unavailable",
              error,
            });
          },
        },
        nudge: () => projectionWakeRunnerLoop?.nudge(),
        waitTimeoutMs: config.projectionWakeScheduler.pollIntervalMs,
        targetContextNames: [
          ...new Set(projectionWakeSchedulerProjectionGroups.map((group) => group.targetContextName)),
        ],
      })
    : null;
void projectionWakePushDispatcher?.done.catch((error: unknown) => {
  logger.error("Projection wake push dispatcher exited unexpectedly.", {
    type: "projection-wake-push.dispatcher.failed",
    error,
  });
});
const projectionWakeRelayConfigs = listSourceContextWakeRelayConfigs();
const projectionWakeRelayListenerPools = new Map<string, PgTransactionalPool>();
const projectionWakeRelaySources: ProjectionWakeRelaySourceRuntime[] = config.projectionWakeRelay.enabled
  ? projectionWakeRelayConfigs.flatMap((relayConfig) => {
      const sourcePool = (pools as Readonly<Record<string, PgTransactionalPool | undefined>>)[
        relayConfig.sourceContextName
      ];
      if (!sourcePool) {
        logger.warn("Projection wake relay source context has no worker database pool.", {
          type: "projection-wake-relay.source.missing_pool",
          sourceContextName: relayConfig.sourceContextName,
        });
        return [];
      }

      const listenerDatabaseUrl =
        config.projectionWakeRelay.listenerDatabaseUrls[
          relayConfig.sourceContextName as keyof typeof config.projectionWakeRelay.listenerDatabaseUrls
        ];
      if (listenerDatabaseUrl) {
        projectionWakeRelayListenerPools.set(
          relayConfig.sourceContextName,
          createPgPool(listenerDatabaseUrl, {
            ...config.pool,
            max: 1,
            onIdleClientError: ({ error }) => {
              logger.warn("Projection wake relay listener pool idle client error.", {
                type: "projection-wake-relay.listener_pool.idle_client_error",
                sourceContextName: relayConfig.sourceContextName,
                error,
              });
            },
          }),
        );
      } else {
        logger.warn("Projection wake relay source has no listener database URL; relying on catch-up passes only.", {
          type: "projection-wake-relay.source.missing_listener_url",
          sourceContextName: relayConfig.sourceContextName,
        });
      }

      return [
        {
          sourceContextName: relayConfig.sourceContextName,
          eventStore: createPostgresEventStore({ pool: sourcePool }),
          listenerPool: projectionWakeRelayListenerPools.get(relayConfig.sourceContextName),
        },
      ];
    })
  : [];
const projectionWakeRelayInterestIndex = buildProjectionInterestIndex({
  projectionGroups: runtime.projectionGroups,
  projectionOverrides: [
    // Deployment-level disables win over registry-derived data, so they come
    // first (override resolution takes the first match per scope).
    ...config.projectionWakeDisabledProjections.map((projectionKey) => {
      const separatorIndex = projectionKey.indexOf(":");
      return {
        targetContextName: projectionKey.slice(0, separatorIndex),
        projectionName: projectionKey.slice(separatorIndex + 1),
        disabled: true,
        optOutReason: "Disabled by WORKER_WAKE_DISABLED_PROJECTIONS.",
      };
    }),
    // Rollout/owner/opt-out data from the source-context wake registry and
    // the push-first migration inventory: owners on every
    // entry, plus disables for registry-disabled/opted-out sources and
    // owner-approved projection opt-outs.
    ...listProjectionInterestOverridesForPushMigration(),
  ],
});
const projectionWakeRelayAbortController = new AbortController();
let projectionWakeRelayIdleLogged = false;
const projectionWakeRelayRuntimeObserver = createProjectionWakeRelayLogObserver();
const projectionWakeRelaySupervisor = config.projectionWakeRelay.enabled
  ? startProjectionWakeRelaySupervisor({
      runSession: (signal) =>
        runProjectionWakeRelayActiveSession({
          workerId: config.workerId,
          controlPlane,
          projectionInterestIndex: projectionWakeRelayInterestIndex,
          workSignalStore,
          sources: projectionWakeRelaySources,
          relayConfigs: projectionWakeRelayConfigs,
          leaseTtlMs: config.leaseTtlMs,
          leaseRenewIntervalMs: config.leaseRenewIntervalMs,
          catchUpBatchSize: config.projectionWakeRelay.catchUpBatchSize,
          signal,
          observer: projectionWakeRelayRuntimeObserver,
        }),
      signal: projectionWakeRelayAbortController.signal,
      standbyRetryMs: config.projectionWakeRelay.standbyRetryMs,
      noSourcesRetryMs: config.projectionWakeRelay.noSourcesRetryMs,
      failureBackoffMs: config.projectionWakeRelay.failureBackoffMs,
      failureBackoffMaxMs: config.projectionWakeRelay.failureBackoffMaxMs,
      observer: {
        sessionEnded: (event) => {
          // Idle no-source sessions recur on a fixed interval; log the state
          // change once instead of repeating it forever.
          if (event.status === "no-enabled-sources") {
            if (projectionWakeRelayIdleLogged) {
              return;
            }
            projectionWakeRelayIdleLogged = true;
          } else {
            projectionWakeRelayIdleLogged = false;
          }
          logger.info("Projection wake relay session ended.", {
            type: "projection-wake-relay.session.ended",
            status: event.status,
            sessionCount: event.sessionCount,
            retryDelayMs: event.retryDelayMs,
            ...(event.error === undefined ? {} : { error: event.error }),
          });
        },
      },
    })
  : null;
void projectionWakeRelaySupervisor?.done.catch((error: unknown) => {
  logger.error("Projection wake relay supervisor exited unexpectedly.", {
    type: "projection-wake-relay.supervisor.failed",
    error,
  });
});
const runnerCount = runnerGroups.reduce((total, group) => total + group.runners.length, 0);
// Producers of event types newly added to existing subscriptions admit writes only once every live worker reads them.
const consumedEventTypes = listConsumedEventTypes(runtime.subscriptionRunners);
const runnerCapacity = summarizeRunnerCapacity(config.pool.max, runnerGroupCapacityInputs(runnerGroups));
const getDatabasePoolPressure = () => summarizeDatabasePoolPressure(config.pool.max, pools);
assertRunnerCapacity(runnerCapacity, {
  workerName: "Platform worker",
  allowOverPoolCapacity: process.env.ALLOW_WORKER_OVER_POOL_CAPACITY === "true",
});
assertRunnerLaneIsolation(runnerCapacity, { workerName: "Platform worker" });

await runWorkerStartupDatabaseStep("record initial worker heartbeat", () =>
  controlPlane.heartbeatWorker({
    workerId: config.workerId,
    workerKind,
    metadata: {
      runtimeProfile: config.runtimeProfile,
      runnerCount,
      [WORKER_CONSUMED_EVENT_TYPES_METADATA_KEY]: consumedEventTypes,
      runnerGroups: runnerGroupMetadata(runnerGroups),
      runnerCapacity,
      databasePoolPressure: getDatabasePoolPressure(),
    },
  }),
);
const heartbeatTimer = setInterval(
  () => {
    void controlPlane
      .heartbeatWorker({
        workerId: config.workerId,
        workerKind,
        metadata: {
          runtimeProfile: config.runtimeProfile,
          runnerCount,
          [WORKER_CONSUMED_EVENT_TYPES_METADATA_KEY]: consumedEventTypes,
          runnerGroups: runnerGroupMetadata(runnerGroups),
          runnerCapacity,
          databasePoolPressure: getDatabasePoolPressure(),
        },
      })
      .catch((error) => {
        logger.error("Platform worker heartbeat failed.", {
          type: "platform-worker.heartbeat.failed",
          error,
        });
      });
  },
  Math.max(5_000, Math.floor(config.leaseTtlMs / 3)),
);
heartbeatTimer.unref?.();
for (const runnerLoop of runnerLoops) {
  runnerLoop.loop.start();
}

const drainState = createProcessDrainState();
const app = new Hono();
app.get("/health/live", (c) => c.json({ status: "ok" }));
app.get("/health/ready", async (c) => {
  if (drainState.isDraining()) {
    return c.json(
      {
        status: "degraded",
        checks: [
          {
            name: "process.draining",
            status: "degraded",
            message: "Process is draining for shutdown.",
          },
        ],
      },
      503,
    );
  }

  await pools.control.query("SELECT 1");
  return c.json({ status: "ok" });
});
const buildWorkerStatusPayload = async (): Promise<Record<string, unknown>> => {
  const loopStatuses = runnerLoops.map((runnerLoop) => ({
    name: runnerLoop.name,
    maxConcurrentRunners: runnerLoop.maxConcurrentRunners,
    runnerCount: runnerLoop.runners.length,
    ...runnerLoop.loop.status(),
  }));
  const [durableWorkflows, projectionWakeIntents, projectionWakeIntentBreakdown] = await Promise.all([
    collectDurableWorkflowStatuses(runtime.services),
    workSignalStore.summarizeProjectionWakeIntents(),
    workSignalStore.summarizeProjectionWakeIntentBreakdown(),
  ]);
  return {
    status: "ok",
    runtimeProfile: config.runtimeProfile,
    workerKind,
    loop: summarizeLoopStatuses(config.workerId, loopStatuses),
    capacity: runnerCapacity,
    databasePoolPressure: getDatabasePoolPressure(),
    loops: loopStatuses,
    durableWorkflows,
    projectionWakeControls: {
      schedulerEnabled: config.projectionWakeScheduler.enabled,
      pushDispatchEnabled: config.projectionWakeScheduler.pushDispatchEnabled,
      relayEnabled: config.projectionWakeRelay.enabled,
      laneRunnerCounts: {
        hot: config.projectionWakeScheduler.hotLaneRunnerCount,
        standard: config.projectionWakeScheduler.standardLaneRunnerCount,
        bulk: config.projectionWakeScheduler.bulkLaneRunnerCount,
      },
      // Effective (clamped) reservation reported by the wakes runner loop, so
      // operators see the slots actually protected for the hot lane.
      hotLaneReservedRunnerSlots: loopStatuses.find((status) => status.name === "wakes")?.reservedRunnerSlots ?? 0,
      disabledProjectionKeys: config.projectionWakeDisabledProjections,
    },
    projectionWakeIntents,
    projectionWakeIntentBreakdown,
    projectionWakeRelay: projectionWakeRelaySupervisor
      ? {
          enabled: true,
          ...projectionWakeRelaySupervisor.state(),
          configuredSourceContextNames: projectionWakeRelaySources.map((source) => source.sourceContextName),
          listenerSourceContextNames: [...projectionWakeRelayListenerPools.keys()],
          interestIndexVersion: projectionWakeRelayInterestIndex.indexVersion,
          // Operator surface: loaded index version, staleness and
          // generation time, enabled source contexts, disabled/opt-out entry
          // counts, and route-dependency coverage.
          interestIndex: summarizeProjectionInterestIndex(projectionWakeRelayInterestIndex),
        }
      : { enabled: false },
    workers: await controlPlane.listWorkerHeartbeats(),
    runners: await controlPlane.listRunnerStatuses(),
    leases: await controlPlane.listLeases(),
  };
};

app.get("/internal/workers/status", async (c) => {
  return c.json(await buildWorkerStatusPayload());
});
// Live hot/background lane attribution for Platform Operations, computed
// in-process from the same data as /internal/workers/status plus current
// projection-group status snapshots. Mirrors the offline
// scripts/projection-hot-lag-evidence.mjs classification so support can get
// a same-cause answer without the manual capture-artifacts-then-run-CLI
// workflow. Not part of /internal/workers/status itself so its (small)
// extra projection-status read never adds cost to the frequently polled
// heartbeat/status endpoint.
app.get("/internal/workers/hot-lag-evidence", async (c) => {
  const [workerStatus, projectionStatus] = await Promise.all([
    buildWorkerStatusPayload(),
    controlPlane.listProjectionStatusSnapshots(),
  ]);

  return c.json(attributeProjectionHotLag({ workerStatus, projectionStatus }));
});

startGracefulHttpServer({
  name: "platform-worker",
  port: config.port,
  serve,
  fetch: app.fetch,
  drainState,
  logger,
  onListening: (info) => {
    logger.info("Platform worker listening.", {
      type: "platform-worker.started",
      port: info.port,
      workerId: config.workerId,
      runtimeProfile: config.runtimeProfile,
      workerKind,
      runnerCount,
      runnerGroups: runnerGroupMetadata(runnerGroups),
      runnerCapacity,
    });
  },
  onDrainStart: [
    async () => {
      projectionWakeRelayAbortController.abort();
      if (projectionWakeRelaySupervisor) {
        // Bound the drain wait so a wedged relay session (for example a hung
        // lease release against an unhealthy control database) cannot stall
        // the whole worker drain.
        await Promise.race([
          projectionWakeRelaySupervisor.done,
          new Promise((resolve) => {
            const timer = setTimeout(resolve, 30_000);
            timer.unref?.();
          }),
        ]);
      }
    },
    async () => {
      if (projectionWakePushDispatcher) {
        await runWithRuntimeLifecycleTimeout(
          "platform-worker.projection-wake-push-dispatcher-stop",
          () => projectionWakePushDispatcher.stop(),
          { logger },
        );
      }
    },
    async () => {
      clearInterval(heartbeatTimer);
      await stopRunnerLoops(runnerLoops.map((runnerLoop) => runnerLoop.loop));
    },
  ],
  onShutdown: [
    async () => {
      await runtimeLifecycle.stopAll({ logger });
    },
    async () => {
      await runWithRuntimeLifecycleTimeout(
        "platform-worker.close-projection-wake-relay-listener-pools",
        () => closeProjectionWakeRelayListenerPools(projectionWakeRelayListenerPools),
        { logger },
      );
    },
    async () => {
      await runWithRuntimeLifecycleTimeout("platform-worker.close-pools", () => closePlatformWorkerPools(pools), {
        logger,
      });
    },
    async () => observability.shutdown(),
  ],
});

type RunnerGroup = Readonly<{
  name: string;
  runners: readonly WorkerRunner[];
  maxConcurrentRunners: number;
  pollIntervalMs?: number;
  reservedRunnerSlots?: number;
}>;

function createRunnerGroup(
  name: string,
  runners: readonly WorkerRunner[],
  maxConcurrentRunners: number,
  pollIntervalMs?: number,
  reservedRunnerSlots?: number,
): RunnerGroup {
  return {
    name,
    runners,
    maxConcurrentRunners,
    pollIntervalMs,
    reservedRunnerSlots,
  };
}

function runWorkerStartupDatabaseStep<T>(operationName: string, run: () => Promise<T>): Promise<T> {
  return runStartupRetry({
    operationName,
    run,
    logger,
    retryBudgetMs: startupRetryBudgetMs("WORKER_STARTUP_DATABASE_RETRY_BUDGET_MS", 60_000),
    retryDelayMs: startupRetryBudgetMs("WORKER_STARTUP_DATABASE_RETRY_DELAY_MS", 1_000),
  });
}

function startupRetryBudgetMs(envName: string, fallback: number): number {
  const value = Number(process.env[envName] ?? fallback);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function runnerGroupMetadata(groups: readonly RunnerGroup[]) {
  return Object.fromEntries(
    groups.map((group) => [
      group.name,
      {
        runnerCount: group.runners.length,
        maxConcurrentRunners: group.maxConcurrentRunners,
      },
    ]),
  );
}

function runnerGroupCapacityInputs(groups: readonly RunnerGroup[]) {
  return groups.map((group) => ({
    name: group.name,
    runnerCount: group.runners.length,
    maxConcurrentRunners: group.maxConcurrentRunners,
    reservedRunnerSlots: group.reservedRunnerSlots ?? 0,
    reservedRunnerCount: group.runners.filter((runner) => runner.reservedCapacity === true).length,
    sharedRunnerCount: group.runners.filter((runner) => runner.reservedCapacity !== true).length,
  }));
}

function summarizeLoopStatuses(workerId: string, loopStatuses: readonly ReturnType<WorkerRunnerLoop["status"]>[]) {
  return {
    workerId,
    activeRunnerCount: loopStatuses.reduce((total, status) => total + status.activeRunnerCount, 0),
    stopped: loopStatuses.every((status) => status.stopped),
  };
}

async function stopRunnerLoops(loops: readonly WorkerRunnerLoop[]) {
  await runWithRuntimeLifecycleTimeout(
    "platform-worker.runner-loop-stop",
    () => Promise.allSettled(loops.map((loop) => loop.stop())).then(() => undefined),
    { logger },
  );
}

async function collectDurableWorkflowStatuses(services: Readonly<Record<string, unknown>>) {
  const catalog = services.catalog as CatalogServices | undefined;
  const inventory = services.inventory as InventoryServices | undefined;
  const pricing = services.pricing as PricingServices | undefined;
  const settlement = services.settlement as SettlementServices | undefined;
  const summaries = await Promise.all([
    catalog?.sourceObservations?.getBulkReviewWorkUnitSummary?.().then((summary) => ({
      workflowName: "catalog.source-observation-bulk-review",
      summary,
    })),
    catalog?.sourceObservations?.getIntegrationWorkUnitSummary?.().then((summary) => ({
      workflowName: "catalog.source-observation-integration",
      summary,
    })),
    catalog?.authoringBulkJobs?.getWorkUnitSummary?.().then((summary) => ({
      workflowName: "catalog.authoring-bulk",
      summary,
    })),
    inventory?.importBatches?.getImportBatchWorkUnitSummary?.().then((summary) => ({
      workflowName: "inventory.import-batch",
      summary,
    })),
    pricing?.recommendations?.getRecommendationWorkUnitSummary?.().then((summary) => ({
      workflowName: "pricing.recommendations",
      summary,
    })),
    settlement?.payouts?.getPayoutReconciliationWorkUnitSummary?.().then((summary) => ({
      workflowName: "settlement.payout-reconciliation",
      summary,
    })),
  ]);
  return summaries.filter(Boolean);
}

async function closeProjectionWakeRelayListenerPools(listenerPools: ReadonlyMap<string, PgTransactionalPool>) {
  await Promise.allSettled(
    [...listenerPools.values()].map((pool) => (pool as unknown as { end: () => Promise<void> }).end()),
  );
}

function createProjectionWakeRelayLogObserver(): ProjectionWakeRelayRuntimeObserver {
  let idleSessionSkipLogged = false;

  return {
    sessionSkipped: (event) => {
      // Recurs on every idle no-source session; log the state once.
      if (idleSessionSkipLogged) {
        return;
      }
      idleSessionSkipLogged = true;
      logger.info("Projection wake relay session skipped.", {
        type: "projection-wake-relay.session.skipped",
        ...event,
      });
    },
    leaseAcquired: (event) => {
      idleSessionSkipLogged = false;
      logger.info("Projection wake relay lease acquired.", {
        type: "projection-wake-relay.lease.acquired",
        ...event,
      });
    },
    leaseMissed: (event) =>
      logger.info("Projection wake relay lease missed; standing by.", {
        type: "projection-wake-relay.lease.missed",
        ...event,
      }),
    leaseLost: (event) =>
      logger.warn("Projection wake relay lease lost.", {
        type: "projection-wake-relay.lease.lost",
        ...event,
      }),
    sourceCatchUpStarted: (event) =>
      logger.info("Projection wake relay source catch-up started.", {
        type: "projection-wake-relay.catch_up.started",
        ...event,
      }),
    sourceCatchUpCompleted: (event) => {
      recordProjectionWakeRelayCatchUp({
        sourceContextName: event.sourceContextName,
        reason: event.reason,
        eventCount: event.eventCount,
        cursorAdvanceCount: event.cursorAdvanceCount,
        durationMs: event.durationMs,
      });
      logger.info("Projection wake relay source catch-up completed.", {
        type: "projection-wake-relay.catch_up.completed",
        ...event,
      });
    },
    sourceCatchUpFailed: (event) =>
      logger.error("Projection wake relay source catch-up failed.", {
        type: "projection-wake-relay.catch_up.failed",
        ...event,
      }),
    cursorAdvanced: (event) =>
      logger.info("Projection wake relay cursor advanced.", {
        type: "projection-wake-relay.cursor.advanced",
        ...event,
      }),
    listenerConnected: (event) =>
      logger.info("Projection wake relay listener connected.", {
        type: "projection-wake-relay.listener.connected",
        ...event,
      }),
    listenerUnavailable: (event) =>
      logger.warn("Projection wake relay listener unavailable.", {
        type: "projection-wake-relay.listener.unavailable",
        ...event,
      }),
    listenerDisconnected: (event) =>
      logger.warn("Projection wake relay listener disconnected.", {
        type: "projection-wake-relay.listener.disconnected",
        ...event,
      }),
    notificationReceived: (event) =>
      logger.info("Projection wake relay notification received.", {
        type: "projection-wake-relay.notification.received",
        ...event,
      }),
    notificationRejected: (event) =>
      logger.warn("Projection wake relay notification rejected.", {
        type: "projection-wake-relay.notification.rejected",
        ...event,
      }),
    sourceSkipped: (event) => {
      recordProjectionWakeRelayFanOut({
        sourceContextName: event.sourceContextName,
        status: "skipped",
        reason: event.reason,
        routingMode: event.routingMode,
        intentCount: 0,
        enqueuedCount: 0,
      });
      logger.info("Projection wake relay source skipped.", {
        type: "projection-wake-relay.fan_out.source_skipped",
        ...event,
      });
    },
    interestIndexLookupCompleted: (event) => {
      recordProjectionInterestIndexLookup({
        sourceContextName: event.sourceContextName,
        targetContextName: event.targetContextName,
        projectionName: event.projectionName,
        priorityLane: event.priorityLane,
        outcome: event.outcome,
        intentCount: event.intentCount,
        durationMs: event.durationMs,
      });
      logger.info("Projection interest index lookup completed.", {
        type: "projection-wake-relay.interest_index.lookup_completed",
        ...event,
      });
    },
    fanOutSkipped: (event) => {
      recordProjectionWakeRelayFanOut({
        sourceContextName: event.sourceContextName,
        status: "skipped",
        reason: event.reason,
        routingMode: event.routingMode,
        intentCount: 0,
        enqueuedCount: 0,
      });
      logger.info("Projection wake relay fan-out found no interests.", {
        type: "projection-wake-relay.fan_out.no_interests",
        ...event,
      });
    },
    fanOutSucceeded: (event) => {
      recordProjectionWakeRelayFanOut({
        sourceContextName: event.sourceContextName,
        status: "enqueued",
        priorityLane: event.priorityLane,
        routingMode: event.routingMode,
        intentCount: event.intentCount,
        enqueuedCount: event.enqueuedCount,
        notificationAgeMs: event.notificationAgeMs,
      });
      logger.info("Projection wake relay fan-out enqueued wake intents.", {
        type: "projection-wake-relay.fan_out.succeeded",
        ...event,
      });
    },
    fanOutFailed: (event) => {
      recordProjectionWakeRelayFanOut({
        sourceContextName: event.sourceContextName,
        status: "failed",
        reason: event.reason,
        routingMode: event.routingMode,
        intentCount: event.intentCount,
        enqueuedCount: event.enqueuedCount,
      });
      logger.error("Projection wake relay fan-out failed.", {
        type: "projection-wake-relay.fan_out.failed",
        ...event,
      });
    },
  };
}

function createProjectionWakeSchedulerLogObserver(): ProjectionWakeSchedulerObserver {
  const recordIntentOutcome = (
    event: ProjectionWakeIntentLifecycleEvent,
    outcome: ProjectionWakeIntentOutcomeSignal["outcome"],
    extras: Readonly<{ processingDurationMs?: number | null; requeued?: boolean }> = {},
  ) =>
    recordProjectionWakeIntentOutcome({
      outcome,
      priorityLane: event.priorityLane,
      origin: event.origin,
      sourceContextName: event.sourceContextName,
      targetContextName: event.targetContextName,
      projectionName: event.projectionName,
      queueAgeMs: event.queueAgeMs,
      attemptCount: event.attemptCount,
      ...extras,
    });

  return {
    wakeIntentClaimed: (event) =>
      logger.info("Projection wake intent claimed.", {
        type: "projection-wake.intent.claimed",
        ...event,
      }),
    wakeIntentCompleted: (event) => {
      recordIntentOutcome(event, event.outcome === "ran" ? "completed" : "already-satisfied", {
        processingDurationMs: event.processingDurationMs,
        requeued: event.requeued,
      });
      logger.info("Projection wake intent completed.", {
        type: "projection-wake.intent.completed",
        ...event,
      });
    },
    wakeIntentNotReady: (event) => {
      recordIntentOutcome(event, "not-ready");
      logger.warn("Projection wake intent retried before checkpoint readiness.", {
        type: "projection-wake.intent.not_ready",
        ...event,
      });
    },
    wakeIntentDeferred: (event) => {
      recordIntentOutcome(event, "deferred");
      logger.info("Projection wake intent deferred while the projection group lease was busy.", {
        type: "projection-wake.intent.deferred",
        ...event,
      });
    },
    wakeIntentUnknownTarget: (event) => {
      recordIntentOutcome(event, "unknown-target");
      logger.warn("Projection wake intent targeted an unknown projection group or checkpoint.", {
        type: "projection-wake.intent.unknown_target",
        ...event,
      });
    },
    wakeIntentRunFailed: (event) => {
      recordIntentOutcome(event, "run-failed");
      logger.error("Projection wake intent run failed.", {
        type: "projection-wake.intent.run_failed",
        ...event,
      });
    },
    wakeIntentAttemptsExhausted: (event) => {
      recordIntentOutcome(event, "attempts-exhausted");
      logger.error("Projection wake intent exhausted its scheduler attempts.", {
        type: "projection-wake.intent.attempts_exhausted",
        ...event,
      });
    },
    wakeIntentClaimLost: (event) => {
      recordIntentOutcome(event, "claim-lost");
      logger.warn("Projection wake intent claim was lost before completion.", {
        type: "projection-wake.intent.claim_lost",
        ...event,
      });
    },
    checkpointReadinessRecordFailed: (event) =>
      logger.warn("Projection checkpoint readiness record failed after a wake completion.", {
        type: "projection-wake.readiness.record_failed",
        ...event,
      }),
    workSignalCleanupCompleted: (event) =>
      logger.info("Work signal cleanup completed.", {
        type: "work-signals.cleanup.completed",
        ...event.result,
      }),
  };
}

function createCatalogAssetStorage(storageConfig: PlatformWorkerCatalogAssetStorageConfig): ObjectStorage {
  return storageConfig.kind === "s3"
    ? createS3ObjectStorage(storageConfig)
    : createFilesystemObjectStorage(storageConfig);
}

function createSourceObservationTelemetry() {
  return {
    recordProviderOptionQuery: recordCatalogIntegrationOptionQuery,
    recordIntegrationJob: (event: { jobKind: string; result: string }) =>
      recordCatalogIntegrationJob({ ...event, operation: "integration-job" }),
    recordBulkReviewWorkUnit: (event: { jobKind: string; result: string }) =>
      recordCatalogIntegrationJob({ ...event, operation: "bulk-review-work-unit" }),
    recordControlPlaneEvent: recordCatalogControlPlaneEvent,
  };
}

function createPlatformEmailNotificationAdapter(
  input: ReturnType<typeof loadConfig>["notificationEmail"],
): NotificationChannelAdapter {
  if (input.provider === "local-capture") {
    return createLocalEmailCaptureNotificationAdapter({
      captureFilePath: input.localCapture.filePath,
      templateRenderer: platformEmailTemplateRenderer,
    });
  }

  if (input.provider !== "amazon-ses") {
    return createNoopNotificationAdapter("email");
  }

  const ses = requireCompleteSesConfig(input.ses);

  return createSesEmailNotificationAdapter({
    fromEmail: ses.fromEmail,
    configurationSetName: ses.configurationSetName,
    sourceArn: ses.sourceArn,
    templateRenderer: platformEmailTemplateRenderer,
    sendRequest: createSesSendRequest({
      region: ses.region,
      clientConfig: {
        credentials: {
          accessKeyId: ses.accessKeyId,
          secretAccessKey: ses.secretAccessKey,
        },
      },
    }),
    onAttempt: (event) => {
      logger.info("Email notification send attempted.", {
        type: "notification.email.send.attempt",
        provider: "amazon-ses",
        messageType: event.messageType,
        attempt: event.attempt,
        correlationId: event.correlationId,
      });
    },
    onResult: (event) => {
      const payload = {
        type: "notification.email.send.result",
        provider: "amazon-ses",
        messageType: event.messageType,
        success: event.success,
        ...(event.error ? { error: event.error } : {}),
      };
      if (event.success) {
        logger.info("Email notification send accepted.", payload);
      } else {
        logger.warn("Email notification send failed.", payload);
      }
    },
  });
}

function requireCompleteSesConfig(ses: ReturnType<typeof loadConfig>["notificationEmail"]["ses"]) {
  const { region, accessKeyId, secretAccessKey, fromEmail, configurationSetName, sourceArn } = ses;
  if (!region || !accessKeyId || !secretAccessKey || !fromEmail || !configurationSetName || !sourceArn) {
    throw new Error("Complete SES configuration is required when Amazon SES email is enabled.");
  }

  return {
    region,
    accessKeyId,
    secretAccessKey,
    fromEmail,
    configurationSetName,
    sourceArn,
  };
}

function createMobileMessageAdapters(
  config: Pick<ReturnType<typeof loadConfig>, "mobileMessaging">,
): readonly NotificationChannelAdapter[] {
  const mobileMessageAdapters: readonly NotificationChannelAdapter[] =
    config.mobileMessaging.kind === "twilio"
      ? [
          createTwilioMessagingAdapter({
            accountSid: config.mobileMessaging.accountSid,
            authToken: config.mobileMessaging.authToken,
            messagingServiceSid: config.mobileMessaging.messagingServiceSid,
            channel: "sms",
            apiBaseUrl: config.mobileMessaging.apiBaseUrl,
            statusCallbackBaseUrl: config.mobileMessaging.statusCallbackBaseUrl,
          }),
          createTwilioMessagingAdapter({
            accountSid: config.mobileMessaging.accountSid,
            authToken: config.mobileMessaging.authToken,
            messagingServiceSid: config.mobileMessaging.messagingServiceSid,
            channel: "rcs",
            apiBaseUrl: config.mobileMessaging.apiBaseUrl,
            statusCallbackBaseUrl: config.mobileMessaging.statusCallbackBaseUrl,
          }),
        ]
      : [createNoopNotificationAdapter("sms"), createNoopNotificationAdapter("rcs")];

  return mobileMessageAdapters;
}
