import "./observability-prelude";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { createNoopNotificationAdapter, type NotificationChannelAdapter } from "@chase-sets/notifications";
import { createNoopTransactionalEmailGateway, type TransactionalEmailGateway } from "@chase-sets/communications-email";
import {
  createSesEmailNotificationAdapter,
  createSesSendRequest,
  createSesTransactionalEmailGateway,
} from "@chase-sets/ses-email";
import {
  createLocalEmailCaptureGateway,
  createLocalEmailCaptureNotificationAdapter,
} from "@chase-sets/local-email-capture";
import { createFakePaymentProcessorGateway } from "@chase-sets/payment-processing-testing";
import { createStripePaymentProcessorGateway } from "@chase-sets/stripe-payments";
import { createFakeMoneyMovementGateway } from "@chase-sets/money-movement-testing";
import { createStripeConnectMoneyMovementGateway } from "@chase-sets/stripe-connect";
import { createEasyPostPostageLabelProvider } from "@chase-sets/easypost-postage";
import { createSandboxPostageLabelProvider } from "@chase-sets/postage-labels-testing";
import { createFilesystemObjectStorage, createS3ObjectStorage, type ObjectStorage } from "@chase-sets/object-storage";
import type { GoogleShoppingSyncMode } from "@chase-sets/discovery/server";
import type { PaymentsServices } from "@chase-sets/payments/server";
import { settlementOperationLogFields, type SettlementServices } from "@chase-sets/settlement/server";
import { createCommercialTermsResolver } from "@chase-sets/commercial-terms/server";
import { createSettlementBalanceCreditResolver } from "@chase-sets/settlement/server";
import {
  collectWorkerRunners,
  createDurableJobLaneRunners,
  createWorkerHost,
  createWorkerRunnerLoop,
  type WorkerHostRuntime,
  type WorkerRuntimeObserver,
  type WorkerRunner,
  type WorkerRunnerLoop,
} from "@chase-sets/platform-runtime/worker";
import { assertRunnerCapacity, summarizeRunnerCapacity } from "@chase-sets/platform-runtime/worker-capacity";
import {
  createPostgresTransactionalEmailOutbox,
  createTransactionalEmailOutboxDispatcher,
} from "@chase-sets/transactional-email-outbox";
import { createNotificationOutboxDispatcher, createPostgresNotificationOutbox } from "@chase-sets/notification-outbox";
import { createPostgresWebNotificationAdapter } from "@chase-sets/web-notifications";
import { createTwilioMessagingAdapter } from "@chase-sets/twilio-messaging";
import {
  bootstrapPlatformControlPlane,
  createPostgresPlatformControlPlane,
  type PlatformControlPlane,
} from "@chase-sets/platform-runtime/control-plane";
import { createProcessDrainState, startGracefulHttpServer } from "@chase-sets/platform-runtime/process-lifecycle";
import { getObservabilityRuntime, recordSettlementOperationSignal } from "@chase-sets/observability";
import {
  loadConfig,
  type PlatformWorkerCatalogAssetStorageConfig,
  type PlatformWorkerGoogleMerchantConfig,
} from "./config";
import { closePlatformWorkerPools, createPlatformWorkerPools } from "./database-pools";
import { platformEmailTemplateRenderer } from "./email-template-renderer";
import { createGoogleMerchantServiceAccountAccessTokenProvider } from "./google-merchant-auth";
import { createGoogleMerchantApiClient } from "./google-merchant-client";
import { workerContextRegistry } from "./generated/worker-context-registry";

const observability = getObservabilityRuntime();
const logger = observability.logger;
const config = loadConfig();
const pools = createPlatformWorkerPools(config);
await bootstrapPlatformControlPlane(pools.control);
const controlPlane = createPostgresPlatformControlPlane(pools.control);

const paymentProcessorGateway =
  config.paymentProcessor.kind === "stripe"
    ? createStripePaymentProcessorGateway({
        secretKey: config.paymentProcessor.secretKey,
        publishableKey: config.paymentProcessor.publishableKey,
        webhookSecret: config.paymentProcessor.webhookSecret,
        apiBaseUrl: config.paymentProcessor.apiBaseUrl,
        checkoutUiMode: config.paymentProcessor.checkoutUiMode,
      })
    : createFakePaymentProcessorGateway();
const moneyMovementGateway =
  config.moneyMovement.kind === "stripe"
    ? createStripeConnectMoneyMovementGateway({
        secretKey: config.moneyMovement.secretKey,
        webhookSecret: config.moneyMovement.webhookSecret,
        apiBaseUrl: config.moneyMovement.apiBaseUrl,
        onboardingReturnUrl: config.moneyMovement.onboardingReturnUrl,
        onboardingRefreshUrl: config.moneyMovement.onboardingRefreshUrl,
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
const commercialTermsResolver = pools["commercial-terms"]
  ? createCommercialTermsResolver({ db: pools["commercial-terms"] })
  : undefined;
const balanceCreditResolver = pools.settlement ? createSettlementBalanceCreditResolver(pools.settlement) : undefined;
const transactionalEmailGateway = createPlatformTransactionalEmailGateway(config.notificationEmail);
const emailNotificationAdapter = createPlatformEmailNotificationAdapter(config.notificationEmail);

const runtime = createWorkerHost(workerContextRegistry, "platform-worker", {
  pools,
  hostPorts: {
    processorGateway: paymentProcessorGateway,
    moneyMovementGateway,
    operationsRecorder: settlementOperationsRecorder,
    postageLabelProvider,
    catalogAssetStorage,
    ...(commercialTermsResolver ? { commercialTermsResolver } : {}),
    ...(balanceCreditResolver ? { balanceCreditResolver } : {}),
  },
});

const projectionRunners = collectWorkerRunners(runtime, {
  controlPlane,
  projectionOperationClaimTtlMs: config.leaseTtlMs * 4,
  projectionOperationLeaseTtlMs: config.leaseTtlMs,
  projectionOperationLeaseRenewIntervalMs: config.leaseRenewIntervalMs,
  observer: createWorkerObserver("platform-worker"),
});
const bulkJobRunners = [
  ...createCatalogBulkJobRunners(runtime.services, config),
  ...createInventoryJobRunners(runtime.services, config),
  ...createGoogleShoppingJobRunners(runtime.services, config),
  ...createPricingJobRunners(runtime.services, config),
  ...createSettlementJobRunners(runtime.services, config),
];
const notificationDispatchRunners = createNotificationDispatchRunners(
  runtime,
  config.workerId,
  emailNotificationAdapter,
);
const transactionalEmailDispatchRunners = createTransactionalEmailDispatchRunners(
  runtime,
  config.workerId,
  transactionalEmailGateway,
);
const scheduledJobRunners = createScheduledJobRunners(runtime.services, config, controlPlane);
const runnerGroups = [
  createRunnerGroup("projections", projectionRunners, config.projectionMaxConcurrentRunners),
  createRunnerGroup("jobs", bulkJobRunners, config.jobMaxConcurrentRunners),
  createRunnerGroup(
    "dispatch",
    [...notificationDispatchRunners, ...transactionalEmailDispatchRunners],
    config.dispatchMaxConcurrentRunners,
  ),
  createRunnerGroup("scheduled", scheduledJobRunners, config.scheduledMaxConcurrentRunners),
].filter((group) => group.runners.length > 0);
const runnerLoops = runnerGroups.map((group) => ({
  ...group,
  loop: createWorkerRunnerLoop({
    workerId: config.workerId,
    controlPlane,
    runners: group.runners,
    maxConcurrentRunners: group.maxConcurrentRunners,
    leaseTtlMs: config.leaseTtlMs,
    leaseRenewIntervalMs: config.leaseRenewIntervalMs,
    pollIntervalMs: config.pollIntervalMs,
    observer: createWorkerObserver("platform-worker", group.name),
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
const runnerCount = runnerGroups.reduce((total, group) => total + group.runners.length, 0);
const runnerCapacity = summarizeRunnerCapacity(config.pool.max, runnerGroupCapacityInputs(runnerGroups));
assertRunnerCapacity(runnerCapacity, {
  workerName: "Platform worker",
  allowOverPoolCapacity: process.env.ALLOW_WORKER_OVER_POOL_CAPACITY === "true",
});

await controlPlane.heartbeatWorker({
  workerId: config.workerId,
  workerKind: "platform-worker",
  metadata: { runnerCount, runnerGroups: runnerGroupMetadata(runnerGroups), runnerCapacity },
});
const heartbeatTimer = setInterval(
  () => {
    void controlPlane
      .heartbeatWorker({
        workerId: config.workerId,
        workerKind: "platform-worker",
        metadata: { runnerCount, runnerGroups: runnerGroupMetadata(runnerGroups), runnerCapacity },
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
  const durableWorkflows = await collectDurableWorkflowStatuses(runtime.services);
  return c.json({
    status: "ok",
    loop: summarizeLoopStatuses(config.workerId, loopStatuses),
    capacity: runnerCapacity,
    loops: loopStatuses,
    durableWorkflows,
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
      runnerCount,
      runnerGroups: runnerGroupMetadata(runnerGroups),
      runnerCapacity,
    });
  },
  onDrainStart: [
    async () => {
      clearInterval(heartbeatTimer);
      await stopRunnerLoops(runnerLoops.map((runnerLoop) => runnerLoop.loop));
    },
  ],
  onShutdown: [async () => closePlatformWorkerPools(pools), async () => observability.shutdown()],
});

type RunnerGroup = Readonly<{
  name: string;
  runners: readonly WorkerRunner[];
  maxConcurrentRunners: number;
}>;

function createRunnerGroup(name: string, runners: readonly WorkerRunner[], maxConcurrentRunners: number): RunnerGroup {
  return {
    name,
    runners,
    maxConcurrentRunners,
  };
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
  await Promise.allSettled(loops.map((loop) => loop.stop()));
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

function createWorkerObserver(workerKind: string, runnerGroup?: string): WorkerRuntimeObserver {
  return {
    leaseMissed: (event) =>
      logger.info("Worker runner lease missed.", {
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
    runnerCompleted: (event) =>
      logger.info("Worker runner completed.", {
        type: "worker.runner.completed",
        workerKind,
        runnerGroup,
        ...event,
      }),
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
    | "sellerFundsReleaseIntervalMs"
    | "payoutReconciliationIntervalMs"
    | "googleMerchant"
    | "googleShoppingMaintenanceIntervalMs"
    | "googleShoppingMaintenanceBatchSize"
    | "googleShoppingRefreshWindowDays"
    | "googleShoppingDiagnosticsIntervalMs"
    | "googleShoppingDiagnosticsBatchSize"
  >,
  controlPlane: PlatformControlPlane,
): readonly WorkerRunner[] {
  const payments = services.payments as PaymentsServices | undefined;
  const settlement = services.settlement as SettlementServices | undefined;
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
          const result = await payments.payments.scanPaymentsNeedingReconciliation({
            limit: 100,
            claimOwnerId: config.workerId,
            claimTtlMs: config.leaseTtlMs * 4,
          });
          logger.info("Payment reconciliation scan completed.", {
            type: "payments.reconciliation-needed",
            count: result.attention,
          });
          return result.checked;
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
  input: Pick<ReturnType<typeof loadConfig>, "workerId" | "leaseTtlMs" | "googleMerchant">,
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

function createTransactionalEmailDispatchRunners(
  runtime: WorkerHostRuntime,
  workerId: string,
  gateway: TransactionalEmailGateway,
): readonly WorkerRunner[] {
  const emailOutboxContextNames = new Set<string>(
    workerContextRegistry
      .filter((entry) =>
        entry.manifest.hostPorts?.some((port: { portName: string }) => port.portName === "transactionalEmailOutbox"),
      )
      .map((entry) => entry.contextName),
  );

  return runtime.mountedContexts
    .filter((context) => emailOutboxContextNames.has(context.contextName))
    .map((context) => {
      const dispatcher = createTransactionalEmailOutboxDispatcher({
        outbox: createPostgresTransactionalEmailOutbox({ db: context.pool }),
        gateway,
        claimOwnerId: `${workerId}:${context.contextName}:transactional-email`,
      });

      return {
        name: `${context.contextName}.transactional-email-dispatcher`,
        kind: "job",
        runOnce: dispatcher.runOnce,
      };
    });
}

function createNotificationDispatchRunners(
  runtime: WorkerHostRuntime,
  workerId: string,
  emailAdapter: NotificationChannelAdapter,
): readonly WorkerRunner[] {
  const notificationCenterContext = runtime.mountedContexts.find((context) => context.contextName === "notifications");
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

function createPlatformTransactionalEmailGateway(
  input: ReturnType<typeof loadConfig>["notificationEmail"],
): TransactionalEmailGateway {
  if (input.provider === "local-capture") {
    return createLocalEmailCaptureGateway({
      captureFilePath: input.localCapture.filePath,
      templateRenderer: platformEmailTemplateRenderer,
    });
  }

  if (input.provider !== "amazon-ses") {
    return createNoopTransactionalEmailGateway();
  }

  const ses = requireCompleteSesConfig(input.ses);

  return createSesTransactionalEmailGateway({
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
      logger.info("Transactional email send attempted.", {
        type: "transactional-email.send.attempt",
        provider: "amazon-ses",
        messageType: event.messageType,
        attempt: event.attempt,
        correlationId: event.correlationId,
      });
    },
    onResult: (event) => {
      const payload = {
        type: "transactional-email.send.result",
        provider: "amazon-ses",
        messageType: event.messageType,
        success: event.success,
        ...(event.error ? { error: event.error } : {}),
      };
      if (event.success) {
        logger.info("Transactional email send accepted.", payload);
      } else {
        logger.warn("Transactional email send failed.", payload);
      }
    },
  });
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
