import "./observability-prelude";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import {
  createNoopNotificationAdapter,
  type NotificationChannelAdapter,
  type NotificationPreferenceResolver,
} from "@chase-sets/outbound-messaging";
import {
  createPostgresTcgplayerAutomationHttpConfigStore,
  createTcgplayerAutomationCatalogClient,
  createTcgplayerAutomationHttpClients,
} from "@chase-sets/catalog/server";
import { createSesEmailNotificationAdapter, createSesSendRequest } from "@chase-sets/ses-email";
import { createLocalEmailCaptureNotificationAdapter } from "@chase-sets/local-email-capture";
import { createStripePaymentProcessorGateway } from "@chase-sets/stripe-payments";
import { createStripeConnectMoneyMovementGateway } from "@chase-sets/stripe-connect";
import { createEasyPostPostageLabelProvider } from "@chase-sets/easypost-postage";
import { createFilesystemObjectStorage, createS3ObjectStorage, type ObjectStorage } from "@chase-sets/object-storage";
import type { GoogleShoppingSyncMode } from "@chase-sets/discovery/server";
import type { InventoryDraftListingCreator } from "@chase-sets/inventory/server";
import type { PaymentsServices } from "@chase-sets/payments/server";
import { settlementOperationLogFields, type SettlementServices } from "@chase-sets/settlement/server";
import {
  createCheckoutProcessingFeePolicyResolver,
  createCommercialTermsResolver,
  type CommercialTermsAccountSource,
} from "@chase-sets/commercial-terms/server";
import { createSettlementBalanceCreditResolver } from "@chase-sets/settlement/server";
import {
  collectProjectionOperationRunners,
  collectWorkerRunners,
  createDurableJobLaneRunners,
  createWorkerHost,
  createWorkerRunnerLoop,
  type WorkerHostRuntime,
  type WorkerRuntimeObserver,
  type WorkerRunner,
  type WorkerRunnerLoop,
} from "@chase-sets/platform-runtime/worker";
import {
  createProjectionWakeSchedulerRunners,
  startPostgresProjectionWakePushDispatcher,
  createWorkSignalCleanupRunner,
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
import { collectRetentionSweepTargets, createRetentionSweepRunner } from "@chase-sets/platform-runtime/retention-sweep";
import { createPgPool, createPostgresEventStore, type PgTransactionalPool } from "@chase-sets/event-core-postgres";
import {
  assertRunnerCapacity,
  assertRunnerLaneIsolation,
  summarizeDatabasePoolPressure,
  summarizeRunnerCapacity,
} from "@chase-sets/platform-runtime/worker-capacity";
import { createNotificationOutboxDispatcher, createPostgresNotificationOutbox } from "@chase-sets/notification-outbox";
import { createPostgresWebNotificationAdapter } from "@chase-sets/web-notifications";
import { createTwilioMessagingAdapter } from "@chase-sets/twilio-messaging";
import {
  bootstrapPlatformControlPlane,
  createPostgresPlatformControlPlane,
  type PlatformControlPlane,
} from "@chase-sets/platform-runtime/control-plane";
import { createProcessDrainState, startGracefulHttpServer } from "@chase-sets/platform-runtime/process-lifecycle";
import {
  createRuntimeLifecycleRegistry,
  runWithRuntimeLifecycleTimeout,
} from "@chase-sets/platform-runtime/runtime-lifecycle";
import {
  getObservabilityRuntime,
  recordCatalogControlPlaneEvent,
  recordCatalogIntegrationJob,
  recordCatalogIntegrationOptionQuery,
  recordProjectionInterestIndexLookup,
  recordProjectionWakeIntentEnqueueOutcome,
  recordProjectionWakeIntentOutcome,
  recordProjectionWakeRelayCatchUp,
  recordProjectionWakeRelayFanOut,
  recordSettlementOperationSignal,
  type ProjectionWakeIntentOutcomeSignal,
} from "@chase-sets/observability";
import {
  loadConfig,
  type PlatformWorkerCatalogAssetStorageConfig,
  type PlatformWorkerGoogleMerchantConfig,
} from "./config";
import { createAgentWebhookDispatchRunners, createOrderingAgentWebhookOrderResolvers } from "./agent-webhook-runners";
import { closePlatformWorkerPools, createPlatformWorkerPools } from "./database-pools";
import { platformEmailTemplateRenderer } from "./email-template-renderer";
import { createGoogleMerchantServiceAccountAccessTokenProvider } from "./google-merchant-auth";
import { createGoogleMerchantApiClient } from "./google-merchant-client";
import { workerContextRegistry } from "./generated/worker-context-registry";
import { runStartupRetry } from "./startup-retry";
import {
  createFakeMoneyMovementGateway,
  createFakePaymentProcessorGateway,
  createSandboxPostageLabelProvider,
} from "./test-support/provider-gateways";

const observability = getObservabilityRuntime();
const logger = observability.logger;
const config = loadConfig();
const workerKind = "platform-worker";
const platformWorkerGroupsEnabled = config.runtimeProfile !== "landing";
const pools = createPlatformWorkerPools(config);
await runWorkerStartupDatabaseStep("bootstrap platform control plane", () =>
  bootstrapPlatformControlPlane(pools.control),
);
const runtimeLifecycle = createRuntimeLifecycleRegistry();
const controlPlane = createPostgresPlatformControlPlane(pools.control, { lifecycle: runtimeLifecycle });
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

const paymentProcessorGateway =
  config.paymentProcessor.kind === "stripe"
    ? createStripePaymentProcessorGateway({
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
const tcgplayerAutomationCatalogClient = config.tcgplayerAutomation
  ? createTcgplayerAutomationCatalogClient(
      createTcgplayerAutomationHttpClients(
        createPostgresTcgplayerAutomationHttpConfigStore(pools.catalog, config.tcgplayerAutomation),
      ),
    )
  : undefined;
const sourceObservationTelemetry = createSourceObservationTelemetry();
let runtime: WorkerHostRuntime | null = null;
const commercialTermsResolver = pools["commercial-terms"]
  ? createCommercialTermsResolver({
      db: pools["commercial-terms"],
      accountSource: createIdentityCommercialTermsAccountSource(
        () => runtime?.services.identity as WorkerIdentityServices | undefined,
      ),
    })
  : undefined;
const balanceCreditResolver = pools.settlement ? createSettlementBalanceCreditResolver(pools.settlement) : undefined;
const checkoutProcessingFeePolicyResolver = pools["commercial-terms"]
  ? createCheckoutProcessingFeePolicyResolver(pools["commercial-terms"])
  : undefined;
const emailNotificationAdapter = createPlatformEmailNotificationAdapter(config.notificationEmail);
const draftListingCreator: InventoryDraftListingCreator = async (params, context) => {
  const marketplaceServices = runtime?.services.marketplace as
    | {
        listings?: {
          createBatchDraftListingFromInventorySnapshot?: InventoryDraftListingCreator;
        };
      }
    | undefined;
  const createDraft = marketplaceServices?.listings?.createBatchDraftListingFromInventorySnapshot;
  if (!createDraft) {
    throw new Error("Marketplace draft listing service is unavailable.");
  }

  return createDraft(params, context);
};

runtime = createWorkerHost(workerContextRegistry, "platform-worker", {
  pools,
  runtimeProfile: config.runtimeProfile,
  runtimeLifecycle,
  hostPorts: {
    processorGateway: paymentProcessorGateway,
    moneyMovementGateway,
    operationsRecorder: settlementOperationsRecorder,
    postageLabelProvider,
    addressVerificationProvider: postageLabelProvider,
    catalogAssetStorage,
    ...(tcgplayerAutomationCatalogClient ? { tcgplayerAutomationCatalogClient } : {}),
    sourceObservationTelemetry,
    ...(commercialTermsResolver ? { commercialTermsResolver } : {}),
    ...(balanceCreditResolver ? { balanceCreditResolver } : {}),
    ...(checkoutProcessingFeePolicyResolver ? { checkoutProcessingFeePolicyResolver } : {}),
    agentWebhookOrderResolvers: createOrderingAgentWebhookOrderResolvers({
      ordering: pools.ordering,
      linkedAuthorizations: pools.identity,
      oauthClients: pools.auth,
    }),
    draftListingCreator,
    searchEmbeddingConfig: config.discoverySearchEmbeddings,
  },
});

type WorkerIdentityServices = Readonly<{
  accounts?: Readonly<{
    getAccountState?: (accountId: string) => Promise<Readonly<{
      id: string | null;
      accountType: "personal" | "business" | "enterprise" | null;
      status: string;
    }> | null>;
  }>;
}>;

function createIdentityCommercialTermsAccountSource(
  getIdentityServices: () => WorkerIdentityServices | undefined,
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
  observer: createWorkerObserver(workerKind),
});
const inventoryImportJobRunners = platformWorkerGroupsEnabled
  ? createInventoryJobRunners(runtime.services, config)
  : [];
const bulkJobRunners = [
  ...createCatalogBulkJobRunners(runtime.services, config),
  ...(platformWorkerGroupsEnabled
    ? [
        ...createGoogleShoppingJobRunners(runtime.services, config),
        ...createPricingJobRunners(runtime.services, config),
        ...createBulkRepriceIngestionJobRunners(runtime.services, config),
        ...createSettlementJobRunners(runtime.services, config),
      ]
    : []),
];
const notificationDispatchRunners = platformWorkerGroupsEnabled
  ? createNotificationDispatchRunners(runtime, config.workerId, emailNotificationAdapter)
  : [];
const agentWebhookDispatchRunners = platformWorkerGroupsEnabled
  ? createAgentWebhookDispatchRunners(runtime, { workerId: config.workerId })
  : [];
const scheduledJobRunners = platformWorkerGroupsEnabled
  ? [
      ...createScheduledJobRunners(runtime.services, config, controlPlane),
      createWorkSignalCleanupRunner({
        controlPlane,
        workSignalStore,
        intervalMs: config.projectionWakeScheduler.cleanupIntervalMs,
        observer: createProjectionWakeSchedulerLogObserver(),
      }),
      createRetentionSweepRunner({
        controlPlane,
        targets: collectRetentionSweepTargets(runtime, pools.control),
        observer: {
          sweepCompleted: (event) => {
            if (event.deleted > 0) {
              logger.info("Retention sweep completed.", {
                type: "retention.sweep.completed",
                ...event,
              });
            }
          },
          sweepFailed: (event) =>
            logger.error("Retention sweep failed; it will retry on its next interval.", {
              type: "retention.sweep.failed",
              contextName: event.contextName,
              sweepName: event.sweepName,
              tableName: event.tableName,
              error: event.error instanceof Error ? event.error.message : String(event.error),
            }),
        },
      }),
    ]
  : [];
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
  createRunnerGroup(
    "dispatch",
    [...notificationDispatchRunners, ...agentWebhookDispatchRunners],
    config.dispatchMaxConcurrentRunners,
  ),
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
    observer: createWorkerObserver(workerKind, group.name),
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
app.get("/internal/workers/status", async (c) => {
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
  return c.json({
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
  });
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
  const catalog = services.catalog as
    | {
        sourceObservations?: {
          getBulkReviewWorkUnitSummary?: () => Promise<unknown>;
          getIntegrationWorkUnitSummary?: () => Promise<unknown>;
        };
        authoringBulkJobs?: {
          getWorkUnitSummary?: () => Promise<unknown>;
        };
      }
    | undefined;
  const inventory = services.inventory as
    | {
        importBatches?: {
          getImportBatchWorkUnitSummary?: () => Promise<unknown>;
        };
      }
    | undefined;
  const pricing = services.pricing as
    | {
        recommendations?: {
          getRecommendationWorkUnitSummary?: () => Promise<unknown>;
        };
      }
    | undefined;
  const settlement = services.settlement as
    | {
        payouts?: {
          getPayoutReconciliationWorkUnitSummary?: () => Promise<unknown>;
        };
      }
    | undefined;
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

function createWorkerObserver(workerKind: string, runnerGroup?: string): WorkerRuntimeObserver {
  return {
    leaseMissed: (event) =>
      logger.debug("Worker runner lease missed.", {
        type: "worker.runner.lease_missed",
        workerKind,
        runnerGroup,
        ...event,
      }),
    leaseRenewFailed: (event) =>
      logger.warn("Worker runner lease renewal failed.", {
        type: "worker.runner.lease_renew_failed",
        workerKind,
        runnerGroup,
        ...event,
      }),
    runnerCompleted: (event) => {
      const log = event.processed > 0 || event.state === "degraded" ? logger.info : logger.debug;
      log("Worker runner completed.", {
        type: "worker.runner.completed",
        workerKind,
        runnerGroup,
        ...event,
      });
    },
    runnerFailed: (event) =>
      logger.error("Worker runner failed.", {
        type: "worker.runner.failed",
        workerKind,
        runnerGroup,
        ...event,
      }),
    projectionOperationStarted: (event) =>
      logger.info("Projection operation started.", {
        type: "projection.operation.started",
        workerKind,
        runnerGroup,
        ...event,
      }),
    projectionOperationCompleted: (event) =>
      logger.info("Projection operation completed.", {
        type: "projection.operation.completed",
        workerKind,
        runnerGroup,
        ...event,
      }),
    projectionOperationFailed: (event) =>
      logger.error("Projection operation failed.", {
        type: "projection.operation.failed",
        workerKind,
        runnerGroup,
        ...event,
      }),
  };
}

function createScheduledJobRunners(
  services: Readonly<Record<string, unknown>>,
  input: Pick<
    ReturnType<typeof loadConfig>,
    | "paymentReconciliationIntervalMs"
    | "paymentDeadlineSweepIntervalMs"
    | "supportRequestDeadlineSweepIntervalMs"
    | "reviewWindowSweepIntervalMs"
    | "reviewOpportunityReminderSweepIntervalMs"
    | "sellerFundsReleaseIntervalMs"
    | "payoutReconciliationIntervalMs"
    | "marketRollupsCloserIntervalMs"
    | "gmvReconciliationIntervalMs"
    | "googleMerchant"
    | "googleShoppingMaintenanceIntervalMs"
    | "googleShoppingMaintenanceBatchSize"
    | "googleShoppingRefreshWindowDays"
    | "googleShoppingDiagnosticsIntervalMs"
    | "googleShoppingDiagnosticsBatchSize"
    | "discoverySearchEmbeddings"
  >,
  controlPlane: PlatformControlPlane,
): readonly WorkerRunner[] {
  const payments = services.payments as PaymentsServices | undefined;
  const ordering = services.ordering as
    | {
        orders?: {
          sweepBreachedPaymentDeadlines?: (
            params: { now?: Date; limit?: number } | undefined,
            context: typeof SYSTEM_CONTEXT,
          ) => Promise<{ checked: number; cancelled: number; progressed: number; failed: number }>;
        };
      }
    | undefined;
  const platformOperations = services["platform-operations"] as
    | {
        supportRequests?: {
          sweepSupportRequestDeadlines?: (
            params: { now?: string; limit?: number },
            context: typeof SYSTEM_CONTEXT,
          ) => Promise<{
            autoResolved: number;
            fallbackEscalated: number;
            escalated: number;
            autoClosed: number;
            responseRemindersEmitted: number;
            reviewRemindersEmitted: number;
            returnRefundsReleased: number;
          }>;
        };
        opsDashboard?: {
          recordReconciliationRun?: (params: {
            yearMonth: string;
            tapeGmvAmount: string;
            ledgerSaleAmount: string;
            now?: string;
          }) => Promise<{ status: "ok" | "drift-alarm" }>;
        };
      }
    | undefined;
  const marketplaceReviews = (services.marketplace as { reviews?: unknown } | undefined)?.reviews as
    | {
        sweepReviewWindowExpirations?: (
          params: { now?: string; limit?: number },
          context: typeof SYSTEM_CONTEXT,
        ) => Promise<{ counterpartPairsRevealed: number; windowExpiredRevealed: number }>;
        sweepReviewOpportunityReminders?: (params: {
          now?: string;
          limit?: number;
        }) => Promise<{ remindersSent: number }>;
      }
    | undefined;
  const pricing = services.pricing as
    | {
        marketRollups?: {
          runDailyRollupCloser?: (params?: { now?: string; trailingWindowDays?: number; limit?: number }) => Promise<{
            rollupDaysRecomputed: number;
            marketStateSnapshotsRecomputed: number;
            productAggregatesRecomputed: number;
            platformDaysRecomputed: number;
          }>;
          getPlatformGmvForMonth?: (params: { yearMonth: string }) => Promise<string>;
        };
      }
    | undefined;
  const settlement = services.settlement as SettlementServices | undefined;
  const fulfillment = services.fulfillment as
    | {
        shipments?: {
          reconcileStalePostageLabelPurchases?: (params?: {
            staleAfterMs?: number;
            limit?: number;
          }) => Promise<{ checked: number; attached: number; voided: number; failed: number }>;
          reconcileStalePostageLabelVoids?: (params?: {
            staleAfterMs?: number;
            limit?: number;
          }) => Promise<{ checked: number; failed: number }>;
        };
      }
    | undefined;
  const discovery = services.discovery as
    | {
        googleShoppingSync?: {
          processScheduledMaintenanceSync?: (input: {
            mode: GoogleShoppingSyncMode;
            limit?: number;
            refreshWindowDays?: number;
          }) => Promise<number>;
          processScheduledDiagnosticsRefresh?: (input: {
            mode: GoogleShoppingSyncMode;
            batchSize?: number;
          }) => Promise<number>;
        };
        searchEmbeddings?: {
          processNextBatch: (input?: { limit?: number; signal?: AbortSignal }) => Promise<{
            processed: number;
            embedded: number;
            totalTokens: number;
          }>;
        };
      }
    | undefined;
  const durableJobRetention = createDurableJobRetentionTask(services);
  const runners: WorkerRunner[] = [];

  if (payments && input.paymentReconciliationIntervalMs) {
    runners.push(
      createScheduledJobRunner(
        "payments.reconciliation",
        input.paymentReconciliationIntervalMs,
        controlPlane,
        async () => {
          const result = await payments.payments.scanPaymentsNeedingReconciliation(
            {
              limit: 100,
              claimOwnerId: config.workerId,
              claimTtlMs: config.leaseTtlMs * 4,
            },
            SYSTEM_CONTEXT,
          );
          logger.info("Payment reconciliation scan completed.", {
            type: "payments.reconciliation",
            result,
          });
          return result.checked;
        },
      ),
    );
  }

  const sweepBreachedPaymentDeadlines = ordering?.orders?.sweepBreachedPaymentDeadlines;
  if (sweepBreachedPaymentDeadlines && input.paymentDeadlineSweepIntervalMs) {
    runners.push(
      createScheduledJobRunner(
        "ordering.payment-deadline-sweep",
        input.paymentDeadlineSweepIntervalMs,
        controlPlane,
        async () => {
          const result = await sweepBreachedPaymentDeadlines({ limit: 100 }, SYSTEM_CONTEXT);
          logger.info("Ordering payment deadline sweep completed.", {
            type: "ordering.payment-deadline-sweep",
            result,
          });
          if (result.failed > 0) {
            throw new Error(`Payment deadline sweep failed for ${result.failed} candidate(s).`);
          }
          return result.cancelled + result.progressed;
        },
      ),
    );
  }

  const sweepSupportRequestDeadlines = platformOperations?.supportRequests?.sweepSupportRequestDeadlines;
  if (sweepSupportRequestDeadlines && input.supportRequestDeadlineSweepIntervalMs) {
    runners.push(
      createScheduledJobRunner(
        "platform-operations.support-request-deadline-sweep",
        input.supportRequestDeadlineSweepIntervalMs,
        controlPlane,
        async () => {
          const result = await sweepSupportRequestDeadlines({ limit: 100 }, SYSTEM_CONTEXT);
          logger.info("Support request deadline sweep completed.", {
            type: "platform-operations.support-request-deadline-sweep",
            result,
          });
          return (
            result.autoResolved +
            result.fallbackEscalated +
            result.escalated +
            result.autoClosed +
            result.responseRemindersEmitted +
            result.reviewRemindersEmitted +
            result.returnRefundsReleased
          );
        },
      ),
    );
  }

  const sweepReviewWindowExpirations = marketplaceReviews?.sweepReviewWindowExpirations;
  if (sweepReviewWindowExpirations && input.reviewWindowSweepIntervalMs) {
    runners.push(
      createScheduledJobRunner(
        "marketplace.review-window-sweep",
        input.reviewWindowSweepIntervalMs,
        controlPlane,
        async () => {
          const result = await sweepReviewWindowExpirations({ limit: 100 }, SYSTEM_CONTEXT);
          logger.info("Marketplace review-window reveal sweep completed.", {
            type: "marketplace.review-window-sweep",
            result,
          });
          return result.counterpartPairsRevealed + result.windowExpiredRevealed;
        },
      ),
    );
  }

  const sweepReviewOpportunityReminders = marketplaceReviews?.sweepReviewOpportunityReminders;
  if (sweepReviewOpportunityReminders && input.reviewOpportunityReminderSweepIntervalMs) {
    runners.push(
      createScheduledJobRunner(
        "marketplace.review-opportunity-reminder-sweep",
        input.reviewOpportunityReminderSweepIntervalMs,
        controlPlane,
        async () => {
          const result = await sweepReviewOpportunityReminders({ limit: 100 });
          logger.info("Marketplace review-opportunity reminder sweep completed.", {
            type: "marketplace.review-opportunity-reminder-sweep",
            result,
          });
          return result.remindersSent;
        },
      ),
    );
  }

  const runDailyRollupCloser = pricing?.marketRollups?.runDailyRollupCloser;
  if (runDailyRollupCloser && input.marketRollupsCloserIntervalMs) {
    runners.push(
      createScheduledJobRunner(
        "pricing.market-rollups-closer",
        input.marketRollupsCloserIntervalMs,
        controlPlane,
        async () => {
          const result = await runDailyRollupCloser({ limit: 500 });
          logger.info("Pricing market-rollups closer completed.", {
            type: "pricing.market-rollups-closer",
            result,
          });
          return (
            result.rollupDaysRecomputed + result.marketStateSnapshotsRecomputed + result.productAggregatesRecomputed
          );
        },
      ),
    );
  }

  const getPlatformGmvForMonth = pricing?.marketRollups?.getPlatformGmvForMonth;
  const getLedgerSaleCreditTotalForMonth = settlement?.wallets?.getLedgerSaleCreditTotalForMonth;
  const recordReconciliationRun = platformOperations?.opsDashboard?.recordReconciliationRun;
  if (
    getPlatformGmvForMonth &&
    getLedgerSaleCreditTotalForMonth &&
    recordReconciliationRun &&
    input.gmvReconciliationIntervalMs
  ) {
    runners.push(
      createScheduledJobRunner(
        "platform-operations.gmv-reconciliation",
        input.gmvReconciliationIntervalMs,
        controlPlane,
        async () => {
          // Reconciles the most recently completed calendar month: on any
          // given day, the current month is still accumulating trades and
          // settlements, so comparing it would show expected, not
          // anomalous, "drift". A trailing re-check of the last completed
          // month (rather than a strict once-per-month run) mirrors the
          // rollup closer's own trailing-window re-derivation, catching a
          // late refund or settlement correction that lands after the
          // month first closes.
          const lastMonthDate = new Date();
          lastMonthDate.setUTCDate(0);
          const yearMonth = lastMonthDate.toISOString().slice(0, 7);
          const [tapeGmvAmount, ledgerSaleAmount] = await Promise.all([
            getPlatformGmvForMonth({ yearMonth }),
            getLedgerSaleCreditTotalForMonth({ yearMonth }),
          ]);
          const run = await recordReconciliationRun({ yearMonth, tapeGmvAmount, ledgerSaleAmount });
          const log = run.status === "drift-alarm" ? logger.warn : logger.info;
          log("Platform-operations GMV reconciliation completed.", {
            type: "platform-operations.gmv-reconciliation",
            yearMonth,
            tapeGmvAmount,
            ledgerSaleAmount,
            status: run.status,
          });
          return 1;
        },
      ),
    );
  }

  if (settlement && input.sellerFundsReleaseIntervalMs) {
    runners.push(
      createScheduledJobRunner(
        "settlement.seller-funds-release",
        input.sellerFundsReleaseIntervalMs,
        controlPlane,
        async () => {
          const result = await settlement.wallets.releaseMaturePendingSaleCredits(
            {
              limit: 500,
              claimOwnerId: config.workerId,
              claimTtlMs: config.leaseTtlMs * 4,
            },
            SYSTEM_CONTEXT,
          );
          logger.info("Seller funds release completed.", {
            type: "settlement.funds-release",
            result,
          });
          return typeof result === "object" && result && "released" in result
            ? Number((result as { released: unknown }).released)
            : 0;
        },
      ),
    );
  }

  if (settlement && input.payoutReconciliationIntervalMs) {
    runners.push(
      createScheduledJobRunner(
        "settlement.payout-reconciliation",
        input.payoutReconciliationIntervalMs,
        controlPlane,
        async () => {
          const result = await settlement.payouts.reconcilePayoutsNeedingAttention(
            {
              limit: 100,
              claimOwnerId: config.workerId,
              claimTtlMs: config.leaseTtlMs * 4,
            },
            SYSTEM_CONTEXT,
          );
          logger.info("Payout reconciliation completed.", {
            type: "settlement.reconciliation",
            result,
          });
          return typeof result === "object" && result && "checked" in result
            ? Number((result as { checked: unknown }).checked)
            : 0;
        },
      ),
    );
  }

  if (fulfillment?.shipments?.reconcileStalePostageLabelPurchases) {
    runners.push(
      createScheduledJobRunner(
        "fulfillment.postage-label-purchase-reconciliation",
        5 * 60 * 1000,
        controlPlane,
        async () => {
          const result = await fulfillment.shipments!.reconcileStalePostageLabelPurchases!({
            staleAfterMs: 5 * 60 * 1000,
            limit: 100,
          });
          logger.info("Fulfillment postage label purchase reconciliation completed.", {
            type: "fulfillment.postage-label-purchase-reconciliation",
            result,
          });
          return result.checked;
        },
      ),
    );
  }

  if (fulfillment?.shipments?.reconcileStalePostageLabelVoids) {
    runners.push(
      createScheduledJobRunner(
        "fulfillment.postage-label-void-reconciliation",
        5 * 60 * 1000,
        controlPlane,
        async () => {
          const result = await fulfillment.shipments!.reconcileStalePostageLabelVoids!({
            staleAfterMs: 24 * 60 * 60 * 1000,
            limit: 100,
          });
          logger.info("Fulfillment postage label void reconciliation completed.", {
            type: "fulfillment.postage-label-void-reconciliation",
            result,
          });
          return result.checked;
        },
      ),
    );
  }

  if (
    discovery?.googleShoppingSync?.processScheduledMaintenanceSync &&
    input.googleMerchant.syncEnabled &&
    input.googleShoppingMaintenanceIntervalMs
  ) {
    runners.push(
      createScheduledJobRunner(
        "discovery.google-shopping-maintenance",
        input.googleShoppingMaintenanceIntervalMs,
        controlPlane,
        async () => {
          const processed = await discovery.googleShoppingSync!.processScheduledMaintenanceSync!({
            mode: input.googleMerchant.dryRun ? "dry-run" : "live",
            limit: input.googleShoppingMaintenanceBatchSize,
            refreshWindowDays: input.googleShoppingRefreshWindowDays,
          });
          logger.info("Google Shopping maintenance scan completed.", {
            type: "google-shopping.maintenance",
            processed,
            mode: input.googleMerchant.dryRun ? "dry-run" : "live",
          });
          return processed;
        },
      ),
    );
  }

  if (
    discovery?.googleShoppingSync?.processScheduledDiagnosticsRefresh &&
    input.googleMerchant.syncEnabled &&
    input.googleShoppingDiagnosticsIntervalMs
  ) {
    runners.push(
      createScheduledJobRunner(
        "discovery.google-shopping-diagnostics",
        input.googleShoppingDiagnosticsIntervalMs,
        controlPlane,
        async () => {
          const processed = await discovery.googleShoppingSync!.processScheduledDiagnosticsRefresh!({
            mode: input.googleMerchant.dryRun ? "dry-run" : "live",
            batchSize: input.googleShoppingDiagnosticsBatchSize,
          });
          logger.info("Google Shopping diagnostics refresh scan completed.", {
            type: "google-shopping.diagnostics",
            processed,
            mode: input.googleMerchant.dryRun ? "dry-run" : "live",
          });
          return processed;
        },
      ),
    );
  }

  if (discovery?.searchEmbeddings) {
    runners.push(
      createScheduledJobRunner(
        "discovery.search-embedding-enrichment",
        input.discoverySearchEmbeddings.intervalMs,
        controlPlane,
        async () => {
          const result = await discovery.searchEmbeddings!.processNextBatch({
            limit: input.discoverySearchEmbeddings.batchSize,
          });
          if (result.processed > 0) {
            logger.info("Discovery search embedding enrichment batch completed.", {
              type: "discovery.search-embedding-enrichment",
              processed: result.processed,
              embedded: result.embedded,
              totalTokens: result.totalTokens,
              model: input.discoverySearchEmbeddings.model,
            });
          }
          return result.embedded;
        },
      ),
    );
  }

  if (durableJobRetention) {
    runners.push(createScheduledJobRunner("durable-jobs.retention", 60 * 60 * 1000, controlPlane, durableJobRetention));
  }

  return runners;
}

function createDurableJobRetentionTask(services: Readonly<Record<string, unknown>>): (() => Promise<number>) | null {
  const tasks: Array<() => Promise<number>> = [];
  const catalog = services.catalog as
    | {
        authoringBulkJobs?: {
          pruneRetention?: (input?: { completedBefore?: Date; limit?: number }) => Promise<number>;
        };
        sourceObservations?: {
          pruneSourceObservationJobRetention?: (input?: {
            completedBefore?: Date;
            limit?: number;
          }) => Promise<{ bulkReviewJobs: number; integrationJobs: number }>;
        };
      }
    | undefined;
  const inventory = services.inventory as
    | {
        importBatches?: {
          pruneImportBatchJobRetention?: (input?: {
            completedBefore?: Date;
            stagedInputCreatedBefore?: Date;
            limit?: number;
          }) => Promise<{ jobs: number; stagedInputs: number }>;
        };
      }
    | undefined;
  const pricing = services.pricing as
    | {
        recommendations?: {
          pruneRecommendationJobRetention?: (input?: { completedBefore?: Date; limit?: number }) => Promise<number>;
        };
      }
    | undefined;
  const settlement = services.settlement as
    | {
        payouts?: {
          prunePayoutReconciliationJobRetention?: (input?: {
            completedBefore?: Date;
            limit?: number;
          }) => Promise<number>;
        };
      }
    | undefined;
  const discovery = services.discovery as
    | {
        googleShoppingSync?: {
          pruneFullSyncJobRetention?: (input?: { completedBefore?: Date; limit?: number }) => Promise<number>;
        };
      }
    | undefined;

  const completedBefore = () => new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const stagedInputCreatedBefore = () => new Date(Date.now() - 24 * 60 * 60 * 1000);

  if (catalog?.authoringBulkJobs?.pruneRetention) {
    tasks.push(() => catalog.authoringBulkJobs!.pruneRetention!({ completedBefore: completedBefore(), limit: 500 }));
  }
  if (catalog?.sourceObservations?.pruneSourceObservationJobRetention) {
    tasks.push(async () => {
      const result = await catalog.sourceObservations!.pruneSourceObservationJobRetention!({
        completedBefore: completedBefore(),
        limit: 500,
      });
      return result.bulkReviewJobs + result.integrationJobs;
    });
  }
  if (inventory?.importBatches?.pruneImportBatchJobRetention) {
    tasks.push(async () => {
      const result = await inventory.importBatches!.pruneImportBatchJobRetention!({
        completedBefore: completedBefore(),
        stagedInputCreatedBefore: stagedInputCreatedBefore(),
        limit: 500,
      });
      return result.jobs + result.stagedInputs;
    });
  }
  if (pricing?.recommendations?.pruneRecommendationJobRetention) {
    tasks.push(() =>
      pricing.recommendations!.pruneRecommendationJobRetention!({ completedBefore: completedBefore(), limit: 500 }),
    );
  }
  if (settlement?.payouts?.prunePayoutReconciliationJobRetention) {
    tasks.push(() =>
      settlement.payouts!.prunePayoutReconciliationJobRetention!({
        completedBefore: completedBefore(),
        limit: 500,
      }),
    );
  }
  if (discovery?.googleShoppingSync?.pruneFullSyncJobRetention) {
    tasks.push(() =>
      discovery.googleShoppingSync!.pruneFullSyncJobRetention!({ completedBefore: completedBefore(), limit: 500 }),
    );
  }

  if (tasks.length === 0) {
    return null;
  }

  return async () => {
    const counts = await Promise.all(tasks.map((task) => task()));
    const deleted = counts.reduce((sum, count) => sum + count, 0);
    logger.info("Durable job retention completed.", {
      type: "durable-jobs.retention",
      deleted,
    });
    return deleted;
  };
}

function createCatalogBulkJobRunners(
  services: Readonly<Record<string, unknown>>,
  input: Pick<
    ReturnType<typeof loadConfig>,
    | "workerId"
    | "leaseTtlMs"
    | "sourceObservationBulkJobLaneCount"
    | "sourceObservationBulkJobWorkflowMaxActiveClaims"
    | "sourceObservationBulkJobMaxActiveClaimsPerJob"
    | "catalogAuthoringBulkJobLaneCount"
    | "catalogAuthoringBulkJobWorkflowMaxActiveClaims"
    | "catalogAuthoringBulkJobMaxActiveClaimsPerJob"
    | "sourceObservationIntegrationJobLaneCount"
    | "sourceObservationIntegrationJobWorkflowMaxActiveClaims"
    | "sourceObservationIntegrationJobMaxActiveClaimsPerJob"
  >,
): readonly WorkerRunner[] {
  type CatalogSourceObservationJobProcessor = Readonly<{
    processNextBulkReviewJob?: (input: {
      claimOwnerId: string;
      claimTtlMs: number;
      workflowMaxActiveClaims?: number;
      jobMaxActiveClaims?: number;
      laneName?: string | null;
      signal?: AbortSignal;
      throwIfLeaseLost?: () => void;
    }) => Promise<number>;
    processNextIntegrationJob?: (input: {
      claimOwnerId: string;
      claimTtlMs: number;
      workflowMaxActiveClaims?: number;
      jobMaxActiveClaims?: number;
      laneName?: string | null;
      signal?: AbortSignal;
      throwIfLeaseLost?: () => void;
    }) => Promise<number>;
  }>;

  const catalog = services.catalog as
    | {
        sourceObservations?: CatalogSourceObservationJobProcessor;
        authoringBulkJobs?: {
          processNext?: (input: {
            claimOwnerId: string;
            claimTtlMs: number;
            services: never;
            workflowMaxActiveClaims?: number;
            jobMaxActiveClaims?: number;
            laneName?: string | null;
            signal?: AbortSignal;
            throwIfLeaseLost?: () => void;
          }) => Promise<boolean>;
        };
      }
    | undefined;
  const processNextBulkReviewJob = catalog?.sourceObservations?.processNextBulkReviewJob;
  const processNextIntegrationJob = catalog?.sourceObservations?.processNextIntegrationJob;
  const processNextAuthoringBulkJob = catalog?.authoringBulkJobs?.processNext;

  if (!processNextBulkReviewJob && !processNextIntegrationJob && !processNextAuthoringBulkJob) {
    return [];
  }

  const runners: WorkerRunner[] = [];

  if (processNextBulkReviewJob) {
    runners.push(
      ...createDurableJobLaneRunners({
        workflowName: "catalog.source-observation-bulk-jobs",
        laneCount: input.sourceObservationBulkJobLaneCount,
        runLane: async (lane) => ({
          processed: await processNextBulkReviewJob({
            claimOwnerId: `${input.workerId}:${lane.laneName}`,
            claimTtlMs: input.leaseTtlMs * 4,
            workflowMaxActiveClaims: input.sourceObservationBulkJobWorkflowMaxActiveClaims,
            jobMaxActiveClaims: input.sourceObservationBulkJobMaxActiveClaimsPerJob,
            laneName: lane.laneName,
            signal: lane.runnerContext?.signal,
            throwIfLeaseLost: lane.runnerContext?.throwIfLeaseLost,
          }),
          lastGlobalPosition: "0" as never,
        }),
      }),
    );
  }

  if (processNextIntegrationJob) {
    runners.push(
      ...createDurableJobLaneRunners({
        workflowName: "catalog.source-observation-integration-jobs",
        laneCount: input.sourceObservationIntegrationJobLaneCount,
        runLane: async (lane) => ({
          processed: await processNextIntegrationJob({
            claimOwnerId: `${input.workerId}:${lane.laneName}`,
            claimTtlMs: input.leaseTtlMs * 4,
            workflowMaxActiveClaims: input.sourceObservationIntegrationJobWorkflowMaxActiveClaims,
            jobMaxActiveClaims: input.sourceObservationIntegrationJobMaxActiveClaimsPerJob,
            laneName: lane.laneName,
            signal: lane.runnerContext?.signal,
            throwIfLeaseLost: lane.runnerContext?.throwIfLeaseLost,
          }),
          lastGlobalPosition: "0" as never,
        }),
      }),
    );
  }

  if (processNextAuthoringBulkJob && catalog) {
    runners.push(
      ...createDurableJobLaneRunners({
        workflowName: "catalog.authoring-bulk-jobs",
        laneCount: input.catalogAuthoringBulkJobLaneCount,
        runLane: async (lane) => ({
          processed: (await processNextAuthoringBulkJob({
            claimOwnerId: `${input.workerId}:${lane.laneName}`,
            claimTtlMs: input.leaseTtlMs * 4,
            services: catalog as never,
            workflowMaxActiveClaims: input.catalogAuthoringBulkJobWorkflowMaxActiveClaims,
            jobMaxActiveClaims: input.catalogAuthoringBulkJobMaxActiveClaimsPerJob,
            laneName: lane.laneName,
            signal: lane.runnerContext?.signal,
            throwIfLeaseLost: lane.runnerContext?.throwIfLeaseLost,
          }))
            ? 1
            : 0,
          lastGlobalPosition: "0" as never,
        }),
      }),
    );
  }

  return runners;
}

function createInventoryJobRunners(
  services: Readonly<Record<string, unknown>>,
  input: Pick<
    ReturnType<typeof loadConfig>,
    | "workerId"
    | "leaseTtlMs"
    | "inventoryImportBatchJobLaneCount"
    | "inventoryImportBatchJobWorkflowMaxActiveClaims"
    | "inventoryImportBatchJobMaxActiveClaimsPerJob"
  >,
): readonly WorkerRunner[] {
  const inventory = services.inventory as
    | {
        importBatches?: {
          processNextImportBatchJob?: (input: {
            claimOwnerId: string;
            claimTtlMs: number;
            workflowMaxActiveClaims?: number;
            jobMaxActiveClaims?: number;
            laneName?: string | null;
            signal?: AbortSignal;
            throwIfLeaseLost?: () => void;
          }) => Promise<number>;
        };
      }
    | undefined;
  const processNextImportBatchJob = inventory?.importBatches?.processNextImportBatchJob;

  if (!processNextImportBatchJob) {
    return [];
  }

  return createDurableJobLaneRunners({
    workflowName: "inventory.import-batch-jobs",
    laneCount: input.inventoryImportBatchJobLaneCount,
    runLane: async (lane) => ({
      processed: await processNextImportBatchJob({
        claimOwnerId: `${input.workerId}:${lane.laneName}`,
        claimTtlMs: input.leaseTtlMs * 4,
        workflowMaxActiveClaims: input.inventoryImportBatchJobWorkflowMaxActiveClaims,
        jobMaxActiveClaims: input.inventoryImportBatchJobMaxActiveClaimsPerJob,
        laneName: lane.laneName,
        signal: lane.runnerContext?.signal,
        throwIfLeaseLost: lane.runnerContext?.throwIfLeaseLost,
      }),
      lastGlobalPosition: "0" as never,
    }),
  });
}

function createGoogleShoppingJobRunners(
  services: Readonly<Record<string, unknown>>,
  input: Pick<
    ReturnType<typeof loadConfig>,
    "workerId" | "leaseTtlMs" | "googleMerchant" | "googleShoppingDiagnosticsPreviousIssueChunkSize"
  >,
): readonly WorkerRunner[] {
  const discovery = services.discovery as
    | {
        googleShoppingSync?: {
          processNextFullSyncJob?: (input: {
            claimOwnerId: string;
            claimTtlMs: number;
            merchantClientForMode: (mode: GoogleShoppingSyncMode) => ReturnType<typeof createGoogleMerchantApiClient>;
            signal?: AbortSignal;
            throwIfLeaseLost?: () => void;
          }) => Promise<number>;
          processNextIncrementalSyncJob?: (input: {
            claimOwnerId: string;
            claimTtlMs: number;
            mode: GoogleShoppingSyncMode;
            merchantClientForMode: (mode: GoogleShoppingSyncMode) => ReturnType<typeof createGoogleMerchantApiClient>;
            signal?: AbortSignal;
            throwIfLeaseLost?: () => void;
          }) => Promise<number>;
          processNextDiagnosticsRefreshJob?: (input: {
            claimOwnerId: string;
            claimTtlMs: number;
            previousIssueChunkSize?: number;
            merchantClientForMode: (mode: GoogleShoppingSyncMode) => ReturnType<typeof createGoogleMerchantApiClient>;
            signal?: AbortSignal;
            throwIfLeaseLost?: () => void;
          }) => Promise<number>;
        };
      }
    | undefined;
  const processNextFullSyncJob = discovery?.googleShoppingSync?.processNextFullSyncJob;
  const processNextIncrementalSyncJob = discovery?.googleShoppingSync?.processNextIncrementalSyncJob;
  const processNextDiagnosticsRefreshJob = discovery?.googleShoppingSync?.processNextDiagnosticsRefreshJob;

  if (!processNextFullSyncJob && !processNextIncrementalSyncJob && !processNextDiagnosticsRefreshJob) {
    return [];
  }

  return [
    ...(processNextFullSyncJob
      ? createDurableJobLaneRunners({
          workflowName: "discovery.google-shopping-full-sync-jobs",
          laneCount: 1,
          runLane: async (lane) => ({
            processed: await processNextFullSyncJob({
              claimOwnerId: `${input.workerId}:${lane.laneName}`,
              claimTtlMs: input.leaseTtlMs * 4,
              merchantClientForMode: (mode) => createGoogleShoppingMerchantClient(input.googleMerchant, mode),
              signal: lane.runnerContext?.signal,
              throwIfLeaseLost: lane.runnerContext?.throwIfLeaseLost,
            }),
            lastGlobalPosition: "0" as never,
          }),
        })
      : []),
    ...(processNextIncrementalSyncJob
      ? createDurableJobLaneRunners({
          workflowName: "discovery.google-shopping-incremental-sync-jobs",
          laneCount: 1,
          runLane: async (lane) => ({
            processed: await processNextIncrementalSyncJob({
              claimOwnerId: `${input.workerId}:${lane.laneName}`,
              claimTtlMs: input.leaseTtlMs * 4,
              mode: input.googleMerchant.syncEnabled && !input.googleMerchant.dryRun ? "live" : "dry-run",
              merchantClientForMode: (mode) => createGoogleShoppingMerchantClient(input.googleMerchant, mode),
              signal: lane.runnerContext?.signal,
              throwIfLeaseLost: lane.runnerContext?.throwIfLeaseLost,
            }),
            lastGlobalPosition: "0" as never,
          }),
        })
      : []),
    ...(processNextDiagnosticsRefreshJob
      ? createDurableJobLaneRunners({
          workflowName: "discovery.google-shopping-diagnostics-jobs",
          laneCount: 1,
          runLane: async (lane) => ({
            processed: await processNextDiagnosticsRefreshJob({
              claimOwnerId: `${input.workerId}:${lane.laneName}`,
              claimTtlMs: input.leaseTtlMs * 4,
              previousIssueChunkSize: input.googleShoppingDiagnosticsPreviousIssueChunkSize,
              merchantClientForMode: (mode) => createGoogleShoppingMerchantClient(input.googleMerchant, mode),
              signal: lane.runnerContext?.signal,
              throwIfLeaseLost: lane.runnerContext?.throwIfLeaseLost,
            }),
            lastGlobalPosition: "0" as never,
          }),
        })
      : []),
  ];
}

function createPricingJobRunners(
  services: Readonly<Record<string, unknown>>,
  input: Pick<
    ReturnType<typeof loadConfig>,
    | "workerId"
    | "leaseTtlMs"
    | "pricingRecommendationJobLaneCount"
    | "pricingRecommendationJobWorkflowMaxActiveClaims"
    | "pricingRecommendationJobMaxActiveClaimsPerJob"
  >,
): readonly WorkerRunner[] {
  const pricing = services.pricing as
    | {
        recommendations?: {
          processNextRecommendationJob?: (input: {
            claimOwnerId: string;
            claimTtlMs: number;
            marketplaceListingGatewayForAccount: (accountId: string) => {
              previewListingTerms: (body: { priceAmount: string }) => Promise<{ fee_quote_fingerprint: string }>;
              updateListingPrice: (
                listingId: string,
                body: { priceAmount: string; feeQuoteFingerprint?: string | null },
              ) => Promise<unknown>;
              createListing: (body: {
                inventoryItemId: string;
                priceAmount: string;
                quantityCap: number;
                listingIdOverride?: string;
              }) => Promise<{ id?: string; listing_id?: string }>;
              staleFeeQuoteFingerprint?: (error: unknown) => string | null;
            };
            workflowMaxActiveClaims?: number;
            jobMaxActiveClaims?: number;
            laneName?: string | null;
            signal?: AbortSignal;
            throwIfLeaseLost?: () => void;
          }) => Promise<number>;
        };
      }
    | undefined;
  const marketplace = services.marketplace as
    | {
        listings?: {
          previewListingTerms?: (params: {
            accountId: string;
            priceAmount: string;
          }) => Promise<{ fee_quote_fingerprint: string }>;
          updateListingPrice?: (
            params: { accountId: string; listingId: string; priceAmount: string; feeQuoteFingerprint?: string | null },
            context: typeof SYSTEM_CONTEXT,
          ) => Promise<unknown>;
          createListing?: (
            params: {
              accountId: string;
              inventoryItemId: string;
              priceAmount: string;
              quantityCap: number;
              listingIdOverride?: string;
            },
            context: typeof SYSTEM_CONTEXT,
          ) => Promise<{ listingId?: string; id?: string; listing_id?: string }>;
        };
      }
    | undefined;
  const processNextRecommendationJob = pricing?.recommendations?.processNextRecommendationJob;

  if (!processNextRecommendationJob || !marketplace?.listings) {
    return [];
  }

  return createDurableJobLaneRunners({
    workflowName: "pricing.recommendation-jobs",
    laneCount: input.pricingRecommendationJobLaneCount,
    runLane: async (lane) => ({
      processed: await processNextRecommendationJob({
        claimOwnerId: `${input.workerId}:${lane.laneName}`,
        claimTtlMs: input.leaseTtlMs * 4,
        workflowMaxActiveClaims: input.pricingRecommendationJobWorkflowMaxActiveClaims,
        jobMaxActiveClaims: input.pricingRecommendationJobMaxActiveClaimsPerJob,
        laneName: lane.laneName,
        marketplaceListingGatewayForAccount: (accountId) => ({
          previewListingTerms: (body) => marketplace.listings!.previewListingTerms!({ accountId, ...body }),
          updateListingPrice: (listingId, body) =>
            marketplace.listings!.updateListingPrice!({ accountId, listingId, ...body }, SYSTEM_CONTEXT),
          createListing: async (body) => {
            const result = await marketplace.listings!.createListing!({ accountId, ...body }, SYSTEM_CONTEXT);
            return {
              id: result.id ?? result.listingId,
              listing_id: result.listing_id ?? result.listingId,
            };
          },
        }),
        signal: lane.runnerContext?.signal,
        throwIfLeaseLost: lane.runnerContext?.throwIfLeaseLost,
      }),
      lastGlobalPosition: "0" as never,
    }),
  });
}

function createBulkRepriceIngestionJobRunners(
  services: Readonly<Record<string, unknown>>,
  input: Pick<
    ReturnType<typeof loadConfig>,
    | "workerId"
    | "leaseTtlMs"
    | "pricingBulkRepriceJobLaneCount"
    | "pricingBulkRepriceJobWorkflowMaxActiveClaims"
    | "pricingBulkRepriceJobMaxActiveClaimsPerJob"
  >,
): readonly WorkerRunner[] {
  const pricing = services.pricing as
    | {
        bulkRepriceIngestion?: {
          processNextBulkRepriceJob?: (input: {
            claimOwnerId: string;
            claimTtlMs: number;
            workflowMaxActiveClaims?: number;
            jobMaxActiveClaims?: number;
            laneName?: string | null;
            marketplaceListingGatewayForAccount: (accountId: string) => {
              applyBulkListingPriceUpdates: (body: {
                updates: readonly { listingId: string; priceAmount: string }[];
              }) => Promise<{ items: readonly { listingId: string; outcome: string; message?: string }[] }>;
            };
            inventorySkuGatewayForAccount: (accountId: string) => {
              resolveSellerSkusToInventoryItems: (sellerSkus: readonly string[]) => Promise<
                readonly Readonly<{
                  sellerSku: string;
                  status: "missing" | "ambiguous" | "unmapped-item" | "mapped";
                  inventoryItemId?: string;
                  productId?: string;
                  catalogItemId?: string;
                }>[]
              >;
            };
            signal?: AbortSignal;
            throwIfLeaseLost?: () => void;
          }) => Promise<number>;
        };
      }
    | undefined;
  const marketplace = services.marketplace as
    | {
        listings?: {
          applyBulkListingPriceUpdates?: (
            params: { accountId: string; updates: readonly { listingId: string; priceAmount: string }[] },
            context: typeof SYSTEM_CONTEXT,
          ) => Promise<readonly { listingId: string; outcome: string; version: number; message?: string }[]>;
        };
      }
    | undefined;
  const inventory = services.inventory as
    | {
        importBatches?: {
          resolveAccountSkuMappingsToInventoryItems?: (params: {
            accountId: string;
            sellerSkus: readonly string[];
          }) => Promise<
            readonly Readonly<{
              sellerSku: string;
              status: "missing" | "ambiguous" | "unmapped-item" | "mapped";
              inventoryItemId?: string;
              productId?: string;
              catalogItemId?: string;
            }>[]
          >;
        };
      }
    | undefined;
  const processNextBulkRepriceJob = pricing?.bulkRepriceIngestion?.processNextBulkRepriceJob;

  if (!processNextBulkRepriceJob || !marketplace?.listings || !inventory?.importBatches) {
    return [];
  }

  return createDurableJobLaneRunners({
    workflowName: "pricing.bulk-reprice-jobs",
    laneCount: input.pricingBulkRepriceJobLaneCount,
    runLane: async (lane) => ({
      processed: await processNextBulkRepriceJob({
        claimOwnerId: `${input.workerId}:${lane.laneName}`,
        claimTtlMs: input.leaseTtlMs * 4,
        workflowMaxActiveClaims: input.pricingBulkRepriceJobWorkflowMaxActiveClaims,
        jobMaxActiveClaims: input.pricingBulkRepriceJobMaxActiveClaimsPerJob,
        laneName: lane.laneName,
        marketplaceListingGatewayForAccount: (accountId) => ({
          applyBulkListingPriceUpdates: async (body) => ({
            items: await marketplace.listings!.applyBulkListingPriceUpdates!({ accountId, ...body }, SYSTEM_CONTEXT),
          }),
        }),
        inventorySkuGatewayForAccount: (accountId) => ({
          resolveSellerSkusToInventoryItems: (sellerSkus) =>
            inventory.importBatches!.resolveAccountSkuMappingsToInventoryItems!({ accountId, sellerSkus }),
        }),
        signal: lane.runnerContext?.signal,
        throwIfLeaseLost: lane.runnerContext?.throwIfLeaseLost,
      }),
      lastGlobalPosition: "0" as never,
    }),
  });
}

function createSettlementJobRunners(
  services: Readonly<Record<string, unknown>>,
  input: Pick<
    ReturnType<typeof loadConfig>,
    | "workerId"
    | "leaseTtlMs"
    | "settlementPayoutReconciliationJobLaneCount"
    | "settlementPayoutReconciliationJobWorkflowMaxActiveClaims"
    | "settlementPayoutReconciliationJobMaxActiveClaimsPerJob"
  >,
): readonly WorkerRunner[] {
  const settlement = services.settlement as
    | {
        payouts?: {
          processNextPayoutReconciliationJob?: (input: {
            claimOwnerId: string;
            claimTtlMs: number;
            workflowMaxActiveClaims?: number;
            jobMaxActiveClaims?: number;
            laneName?: string | null;
            signal?: AbortSignal;
            throwIfLeaseLost?: () => void;
          }) => Promise<number>;
        };
      }
    | undefined;
  const processNextPayoutReconciliationJob = settlement?.payouts?.processNextPayoutReconciliationJob;

  if (!processNextPayoutReconciliationJob) {
    return [];
  }

  return createDurableJobLaneRunners({
    workflowName: "settlement.payout-reconciliation-jobs",
    laneCount: input.settlementPayoutReconciliationJobLaneCount,
    runLane: async (lane) => ({
      processed: await processNextPayoutReconciliationJob({
        claimOwnerId: `${input.workerId}:${lane.laneName}`,
        claimTtlMs: input.leaseTtlMs * 4,
        workflowMaxActiveClaims: input.settlementPayoutReconciliationJobWorkflowMaxActiveClaims,
        jobMaxActiveClaims: input.settlementPayoutReconciliationJobMaxActiveClaimsPerJob,
        laneName: lane.laneName,
        signal: lane.runnerContext?.signal,
        throwIfLeaseLost: lane.runnerContext?.throwIfLeaseLost,
      }),
      lastGlobalPosition: "0" as never,
    }),
  });
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

function createGoogleShoppingMerchantClient(config: PlatformWorkerGoogleMerchantConfig, mode: GoogleShoppingSyncMode) {
  if (mode === "live" && config.syncEnabled && config.dryRun) {
    throw new Error("Google Shopping live sync requested while GOOGLE_MERCHANT_DRY_RUN=true.");
  }

  const clientConfig = config.syncEnabled && mode === "dry-run" ? { ...config, dryRun: true } : config;
  const accessTokenProvider =
    clientConfig.syncEnabled && !clientConfig.dryRun
      ? createGoogleMerchantServiceAccountAccessTokenProvider({
          credentialSecretName: clientConfig.credentialSecretName,
        })
      : async () => {
          throw new Error("Google Merchant credentials are not required in dry-run mode.");
        };

  return createGoogleMerchantApiClient({
    config: clientConfig,
    accessTokenProvider,
    logger,
  });
}

function createNotificationDispatchRunners(
  runtime: WorkerHostRuntime,
  workerId: string,
  emailAdapter: NotificationChannelAdapter,
): readonly WorkerRunner[] {
  const notificationCenterContext = runtime.mountedContexts.find((context) => context.contextName === "notifications");
  const preferenceResolver = (
    notificationCenterContext?.services as
      | { notificationPreferenceResolver?: NotificationPreferenceResolver }
      | undefined
  )?.notificationPreferenceResolver;
  if (!preferenceResolver) {
    throw new Error("Notifications preference resolver is unavailable for notification dispatch.");
  }
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
  const notificationOutboxContextNames = new Set<string>(
    workerContextRegistry
      .filter((entry) =>
        entry.manifest.hostPorts?.some((port: { portName: string }) => port.portName === "notificationOutbox"),
      )
      .map((entry) => entry.contextName),
  );

  return runtime.mountedContexts
    .filter((context) => notificationOutboxContextNames.has(context.contextName))
    .map((context) => {
      const webNotificationDb = notificationCenterContext?.pool ?? context.pool;
      const dispatcher = createNotificationOutboxDispatcher({
        outbox: createPostgresNotificationOutbox({ db: context.pool }),
        preferenceResolver,
        adapters: [
          emailAdapter,
          ...mobileMessageAdapters,
          createPostgresWebNotificationAdapter({ db: webNotificationDb }),
        ],
        claimOwnerId: `${workerId}:${context.contextName}:notifications`,
      });

      return {
        name: `${context.contextName}.notification-dispatcher`,
        kind: "job",
        runOnce: dispatcher.runOnce,
      };
    });
}

function createScheduledJobRunner(
  name: string,
  intervalMs: number,
  controlPlane: PlatformControlPlane,
  job: () => Promise<number>,
): WorkerRunner {
  return {
    name,
    kind: "job",
    runOnce: async () => {
      const claimed = await controlPlane.claimScheduledRunner({ runnerName: name, intervalMs });
      if (!claimed) {
        return { processed: 0, lastGlobalPosition: "0" as never };
      }

      const processed = await job();
      await controlPlane.recordScheduledRunnerCompleted({ runnerName: name });
      return { processed, lastGlobalPosition: "0" as never };
    },
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

const SYSTEM_CONTEXT = {
  tenantId: "tnt_identity" as never,
  audit: {
    performedByUserId: "usr_identity_system" as never,
    forAccountId: "acc_identity_system" as never,
  },
};
