import { getWorkerHostContextNames, type WorkerHostContextName } from "@chase-sets/platform-runtime/worker";
import {
  getBooleanEnv,
  getContextDatabaseEnvName as getSharedContextDatabaseEnvName,
  getContextWaiterDatabaseEnvName as getSharedContextWaiterDatabaseEnvName,
  getOptionalEnv,
  getOptionalPositiveNumberEnv,
  getPositiveNumberEnv,
  loadDeploymentEnvironment,
  loadCatalogAssetStorageConfig,
  loadPlatformDatabaseConfig,
  loadPoolConfig,
  loadPostageConfig,
  loadStripeProviderConfig,
  loadTcgplayerAutomationConfig,
  resolveEnumEnv,
  resolveMobileMessagingProvider,
  type PlatformCatalogAssetStorageConfig,
  type PlatformMoneyMovementConfig,
  type PlatformPaymentProcessorConfig,
  type PlatformPoolConfig,
  type PlatformPostageConfig,
  type PlatformTcgplayerAutomationConfig,
} from "@chase-sets/platform-runtime/config-schema";
import {
  isPlatformWorkerRuntimeProfile,
  type PlatformWorkerRuntimeProfile,
} from "@chase-sets/platform-runtime/runtime-profiles";
import { workerContextRegistry } from "./generated/worker-context-registry";

export type PlatformWorkerContextName = WorkerHostContextName<typeof workerContextRegistry>;

export type PlatformWorkerPoolConfig = PlatformPoolConfig;

export type PlatformWorkerConfig = Readonly<{
  runtimeProfile: PlatformWorkerRuntimeProfile;
  sharedDatabaseUrl: string | null;
  controlDatabaseUrl: string;
  workSignalDatabaseUrl: string | null;
  contextDatabaseUrls: Readonly<Partial<Record<PlatformWorkerContextName, string>>>;
  contextWaiterDatabaseUrls?: Readonly<Partial<Record<PlatformWorkerContextName, string>>>;
  pool: PlatformWorkerPoolConfig;
  catalogAssetStorage: PlatformWorkerCatalogAssetStorageConfig;
  port: number;
  workerId: string;
  maxConcurrentRunners: number;
  projectionMaxConcurrentRunners: number;
  projectionPriorityRefreshIntervalMs: number;
  jobMaxConcurrentRunners: number;
  dispatchMaxConcurrentRunners: number;
  scheduledMaxConcurrentRunners: number;
  sourceObservationBulkJobLaneCount: number;
  sourceObservationBulkJobWorkflowMaxActiveClaims: number;
  sourceObservationBulkJobMaxActiveClaimsPerJob: number;
  catalogAuthoringBulkJobLaneCount: number;
  catalogAuthoringBulkJobWorkflowMaxActiveClaims: number;
  catalogAuthoringBulkJobMaxActiveClaimsPerJob: number;
  sourceObservationIntegrationJobLaneCount: number;
  sourceObservationIntegrationJobWorkflowMaxActiveClaims: number;
  sourceObservationIntegrationJobMaxActiveClaimsPerJob: number;
  inventoryImportBatchJobLaneCount: number;
  inventoryImportBatchJobMaxConcurrentRunners: number;
  inventoryImportBatchJobWorkflowMaxActiveClaims: number;
  inventoryImportBatchJobMaxActiveClaimsPerJob: number;
  pricingRecommendationJobLaneCount: number;
  pricingRecommendationJobWorkflowMaxActiveClaims: number;
  pricingRecommendationJobMaxActiveClaimsPerJob: number;
  settlementPayoutReconciliationJobLaneCount: number;
  settlementPayoutReconciliationJobWorkflowMaxActiveClaims: number;
  settlementPayoutReconciliationJobMaxActiveClaimsPerJob: number;
  pollIntervalMs: number;
  leaseTtlMs: number;
  leaseRenewIntervalMs: number;
  projectionOperations: PlatformWorkerProjectionOperationsConfig;
  projectionWakeScheduler: PlatformWorkerProjectionWakeSchedulerConfig;
  projectionWakeRelay: PlatformWorkerProjectionWakeRelayConfig;
  projectionWakeDisabledProjections: readonly string[];
  paymentReconciliationIntervalMs: number | null;
  paymentDeadlineSweepIntervalMs: number | null;
  supportRequestDeadlineSweepIntervalMs: number | null;
  reviewWindowSweepIntervalMs: number | null;
  sellerFundsReleaseIntervalMs: number | null;
  payoutReconciliationIntervalMs: number | null;
  googleShoppingMaintenanceIntervalMs: number | null;
  googleShoppingMaintenanceBatchSize: number;
  googleShoppingRefreshWindowDays: number;
  googleShoppingDiagnosticsIntervalMs: number | null;
  googleShoppingDiagnosticsBatchSize: number;
  googleShoppingDiagnosticsPreviousIssueChunkSize: number;
  discoverySearchEmbeddings: Readonly<{
    apiKey: string | null;
    model: string;
    batchSize: number;
    timeoutMs: number;
    maxAttempts: number;
    retryBackoffBaseMs: number;
    retryBackoffMaxMs: number;
    intervalMs: number;
    rolloutValue: string | null;
    rescueValue: string | null;
    hybridValue: string | null;
    queryCacheMaxEntries: number;
    queryCacheTtlMs: number;
  }>;
  paymentProcessor: PlatformWorkerPaymentProcessorConfig;
  moneyMovement: PlatformWorkerMoneyMovementConfig;
  mobileMessaging: PlatformWorkerMobileMessagingConfig;
  postage: PlatformWorkerPostageConfig;
  tcgplayerAutomation: PlatformWorkerTcgplayerAutomationConfig | null;
  googleMerchant: PlatformWorkerGoogleMerchantConfig;
  notificationEmail: PlatformWorkerNotificationEmailConfig;
}>;

export type PlatformWorkerProjectionOperationsConfig = Readonly<{
  runnerCount: number;
  operationTimeoutMs: number;
  rebuildOperationTimeoutMs: number;
  maxAttempts: number;
  retryBackoffBaseMs: number;
  retryBackoffMaxMs: number;
  leaseAcquireTimeoutMs: number;
}>;

export type PlatformWorkerProjectionWakeSchedulerConfig = Readonly<{
  enabled: boolean;
  pushDispatchEnabled: boolean;
  maxConcurrentRunners: number;
  pollIntervalMs: number;
  hotLaneRunnerCount: number;
  standardLaneRunnerCount: number;
  bulkLaneRunnerCount: number;
  maxClaimsPerRun: number;
  claimTtlMs: number;
  statementTimeoutMs: number;
  retryBackoffBaseMs: number;
  retryBackoffMaxMs: number;
  maxAttempts: number;
  cleanupIntervalMs: number;
}>;

export type PlatformWorkerProjectionWakeRelayConfig = Readonly<{
  enabled: boolean;
  listenerDatabaseUrls: Readonly<Partial<Record<PlatformWorkerContextName, string>>>;
  catchUpBatchSize: number;
  standbyRetryMs: number;
  noSourcesRetryMs: number;
  failureBackoffMs: number;
  failureBackoffMaxMs: number;
}>;

export type PlatformWorkerCatalogAssetStorageConfig = PlatformCatalogAssetStorageConfig;

export type PlatformWorkerPaymentProcessorConfig = PlatformPaymentProcessorConfig;

export type PlatformWorkerMoneyMovementConfig = PlatformMoneyMovementConfig;

export type PlatformWorkerPostageConfig = PlatformPostageConfig<false>;

export type PlatformWorkerTcgplayerAutomationConfig = PlatformTcgplayerAutomationConfig;

export type PlatformWorkerGoogleMerchantConfig =
  | Readonly<{
      syncEnabled: false;
      dryRun: boolean;
    }>
  | Readonly<{
      syncEnabled: true;
      dryRun: boolean;
      merchantAccountId: string;
      apiDataSourceId: string;
      targetCountry: string;
      contentLanguage: string;
      feedLabel: string;
      credentialSecretName: string;
    }>;

export type PlatformWorkerMobileMessagingConfig =
  | Readonly<{ kind: "noop" }>
  | Readonly<{
      kind: "twilio";
      accountSid: string;
      authToken: string;
      messagingServiceSid: string;
      apiBaseUrl?: string;
      statusCallbackBaseUrl?: string;
    }>;

export type PlatformWorkerNotificationEmailConfig = Readonly<{
  provider: "noop" | "amazon-ses" | "local-capture";
  ses: Readonly<{
    region?: string;
    accessKeyId?: string;
    secretAccessKey?: string;
    fromEmail?: string;
    configurationSetName?: string;
    sourceArn?: string;
  }>;
  localCapture: Readonly<{
    filePath: string;
  }>;
}>;

export function getPlatformWorkerContextsForRuntimeProfile(
  runtimeProfile: PlatformWorkerRuntimeProfile,
): readonly PlatformWorkerContextName[] {
  return getWorkerHostContextNames(workerContextRegistry, "platform-worker", runtimeProfile);
}

export function getContextDatabaseEnvName(contextName: PlatformWorkerContextName) {
  return getSharedContextDatabaseEnvName(contextName);
}

export function getContextWaiterDatabaseEnvName(contextName: PlatformWorkerContextName) {
  return getSharedContextWaiterDatabaseEnvName(contextName);
}

export function getContextListenerDatabaseEnvName(contextName: PlatformWorkerContextName) {
  return `WORKER_LISTENER_DATABASE_URL_${contextName.replaceAll("-", "_").toUpperCase()}`;
}

export function loadConfig(): PlatformWorkerConfig {
  const runtimeProfile = loadRuntimeProfile();
  const deploymentEnvironment = loadDeploymentEnvironment();
  const productionLike = deploymentEnvironment === "production";
  const workerContexts = getPlatformWorkerContextsForRuntimeProfile(runtimeProfile);
  const databaseConfig = loadPlatformDatabaseConfig({
    contextNames: workerContexts,
    missingControlDatabaseUrlError: "PLATFORM_CONTROL_DATABASE_URL or DATABASE_URL is required.",
  });

  const port = Number(process.env.PORT ?? 6183);
  const easyPostApiKey = getOptionalEnv("EASYPOST_API_KEY");
  const googleMerchantSyncEnabled = getBooleanEnv("GOOGLE_MERCHANT_SYNC_ENABLED", false);
  const googleMerchantDryRun = getBooleanEnv("GOOGLE_MERCHANT_DRY_RUN", true);
  const googleMerchantAccountId = getOptionalEnv("GOOGLE_MERCHANT_ACCOUNT_ID");
  const googleMerchantApiDataSourceId = getOptionalEnv("GOOGLE_MERCHANT_API_DATA_SOURCE_ID");
  const googleMerchantTargetCountry = getOptionalEnv("GOOGLE_MERCHANT_TARGET_COUNTRY") ?? "US";
  const googleMerchantContentLanguage = getOptionalEnv("GOOGLE_MERCHANT_CONTENT_LANGUAGE") ?? "en";
  const googleMerchantFeedLabel = getOptionalEnv("GOOGLE_MERCHANT_FEED_LABEL") ?? googleMerchantTargetCountry;
  const googleMerchantCredentialSecretName = getOptionalEnv("GOOGLE_MERCHANT_CREDENTIAL_SECRET_NAME");
  const voyageApiKey = getOptionalEnv("VOYAGE_API_KEY");
  const mobileMessagingProvider = resolveMobileMessagingProvider(getOptionalEnv("MOBILE_MESSAGING_PROVIDER"));
  const twilioAccountSid = getOptionalEnv("TWILIO_ACCOUNT_SID");
  const twilioAuthToken = getOptionalEnv("TWILIO_AUTH_TOKEN");
  const twilioMessagingServiceSid = getOptionalEnv("TWILIO_MESSAGING_SERVICE_SID");
  const twilioApiBaseUrl = getOptionalEnv("TWILIO_API_BASE_URL") ?? undefined;
  const twilioStatusCallbackBaseUrl = getOptionalEnv("TWILIO_STATUS_CALLBACK_BASE_URL") ?? undefined;
  const providerRequired = productionLike && runtimeProfile !== "landing";
  const stripeProvider = loadStripeProviderConfig({
    productionLike: providerRequired,
    deploymentEnvironment,
    productionMissingConfigError:
      "STRIPE_SECRET_KEY, STRIPE_PUBLISHABLE_KEY, STRIPE_WEBHOOK_SECRET, and STRIPE_CONNECT_WEBHOOK_SECRET are required for platform worker payment processing and money movement in production.",
  });
  const notificationEmailProvider = resolveNotificationEmailProvider(getOptionalEnv("NOTIFICATION_EMAIL_PROVIDER"));
  const sesAwsRegion = getOptionalEnv("SES_AWS_REGION") ?? undefined;
  const sesAwsAccessKeyId = getOptionalEnv("SES_AWS_ACCESS_KEY_ID") ?? undefined;
  const sesAwsSecretAccessKey = getOptionalEnv("SES_AWS_SECRET_ACCESS_KEY") ?? undefined;
  const sesFromEmail = getOptionalEnv("SES_FROM_EMAIL") ?? undefined;
  const sesConfigurationSetName = getOptionalEnv("SES_CONFIGURATION_SET_NAME") ?? undefined;
  const sesSourceArn = getOptionalEnv("SES_SOURCE_ARN") ?? undefined;
  const localEmailCaptureFile =
    getOptionalEnv("LOCAL_EMAIL_CAPTURE_FILE") ?? "artifacts/notifications/local-email-capture.jsonl";
  if (providerRequired && !easyPostApiKey) {
    throw new Error("EASYPOST_API_KEY is required for platform worker postage label work in production.");
  }
  if (productionLike && notificationEmailProvider === "local-capture") {
    throw new Error("NOTIFICATION_EMAIL_PROVIDER=local-capture is only allowed outside production.");
  }
  if (
    notificationEmailProvider === "amazon-ses" &&
    (!sesAwsRegion ||
      !sesAwsAccessKeyId ||
      !sesAwsSecretAccessKey ||
      !sesFromEmail ||
      !sesConfigurationSetName ||
      !sesSourceArn)
  ) {
    throw new Error(
      "SES_AWS_REGION, SES_AWS_ACCESS_KEY_ID, SES_AWS_SECRET_ACCESS_KEY, SES_FROM_EMAIL, SES_CONFIGURATION_SET_NAME, and SES_SOURCE_ARN are required when NOTIFICATION_EMAIL_PROVIDER=amazon-ses.",
    );
  }
  if (mobileMessagingProvider === "twilio" && (!twilioAccountSid || !twilioAuthToken || !twilioMessagingServiceSid)) {
    throw new Error(
      "TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, and TWILIO_MESSAGING_SERVICE_SID are required when MOBILE_MESSAGING_PROVIDER=twilio.",
    );
  }

  const maxConcurrentRunners = getPositiveNumberEnv("WORKER_MAX_CONCURRENT_RUNNERS", 4);

  return {
    runtimeProfile,
    ...databaseConfig,
    pool: loadPoolConfig(),
    catalogAssetStorage: loadCatalogAssetStorageConfig({
      port,
      productionLike,
      defaultPublicBaseUrl: `${(getOptionalEnv("PLATFORM_API_URL") ?? `http://localhost:${port}`).replace(
        /\/$/,
        "",
      )}/catalog-assets`,
    }),
    port,
    workerId: getOptionalEnv("WORKER_ID") ?? `platform-worker-${process.pid}-${Date.now().toString(36)}`,
    maxConcurrentRunners,
    projectionMaxConcurrentRunners: getPositiveNumberEnv(
      "WORKER_PROJECTION_MAX_CONCURRENT_RUNNERS",
      Math.min(2, maxConcurrentRunners),
    ),
    // Idle-runner backlog refresh cadence: surfaces orphaned backlog on
    // groups that fell behind without running so they re-enter the fair
    // rotation instead of starving behind the discovery cascade.
    projectionPriorityRefreshIntervalMs: getPositiveNumberEnv("WORKER_PROJECTION_PRIORITY_REFRESH_INTERVAL_MS", 5_000),
    jobMaxConcurrentRunners: getPositiveNumberEnv("WORKER_JOB_MAX_CONCURRENT_RUNNERS", 1),
    dispatchMaxConcurrentRunners: getPositiveNumberEnv("WORKER_DISPATCH_MAX_CONCURRENT_RUNNERS", 1),
    scheduledMaxConcurrentRunners: getPositiveNumberEnv("WORKER_SCHEDULED_MAX_CONCURRENT_RUNNERS", 1),
    sourceObservationBulkJobLaneCount: getPositiveNumberEnv("SOURCE_OBSERVATION_BULK_JOB_LANE_COUNT", 1),
    sourceObservationBulkJobWorkflowMaxActiveClaims: getPositiveNumberEnv(
      "SOURCE_OBSERVATION_BULK_JOB_WORKFLOW_MAX_ACTIVE_CLAIMS",
      1,
    ),
    sourceObservationBulkJobMaxActiveClaimsPerJob: getPositiveNumberEnv(
      "SOURCE_OBSERVATION_BULK_JOB_MAX_ACTIVE_CLAIMS_PER_JOB",
      1,
    ),
    catalogAuthoringBulkJobLaneCount: getPositiveNumberEnv("CATALOG_AUTHORING_BULK_JOB_LANE_COUNT", 1),
    catalogAuthoringBulkJobWorkflowMaxActiveClaims: getPositiveNumberEnv(
      "CATALOG_AUTHORING_BULK_JOB_WORKFLOW_MAX_ACTIVE_CLAIMS",
      1,
    ),
    catalogAuthoringBulkJobMaxActiveClaimsPerJob: getPositiveNumberEnv(
      "CATALOG_AUTHORING_BULK_JOB_MAX_ACTIVE_CLAIMS_PER_JOB",
      1,
    ),
    sourceObservationIntegrationJobLaneCount: getPositiveNumberEnv("SOURCE_OBSERVATION_INTEGRATION_JOB_LANE_COUNT", 1),
    sourceObservationIntegrationJobWorkflowMaxActiveClaims: getPositiveNumberEnv(
      "SOURCE_OBSERVATION_INTEGRATION_JOB_WORKFLOW_MAX_ACTIVE_CLAIMS",
      1,
    ),
    sourceObservationIntegrationJobMaxActiveClaimsPerJob: getPositiveNumberEnv(
      "SOURCE_OBSERVATION_INTEGRATION_JOB_MAX_ACTIVE_CLAIMS_PER_JOB",
      1,
    ),
    inventoryImportBatchJobLaneCount: getPositiveNumberEnv("INVENTORY_IMPORT_BATCH_JOB_LANE_COUNT", 1),
    inventoryImportBatchJobMaxConcurrentRunners: getPositiveNumberEnv(
      "INVENTORY_IMPORT_BATCH_JOB_MAX_CONCURRENT_RUNNERS",
      1,
    ),
    inventoryImportBatchJobWorkflowMaxActiveClaims: getPositiveNumberEnv(
      "INVENTORY_IMPORT_BATCH_JOB_WORKFLOW_MAX_ACTIVE_CLAIMS",
      1,
    ),
    inventoryImportBatchJobMaxActiveClaimsPerJob: getPositiveNumberEnv(
      "INVENTORY_IMPORT_BATCH_JOB_MAX_ACTIVE_CLAIMS_PER_JOB",
      1,
    ),
    pricingRecommendationJobLaneCount: getPositiveNumberEnv("PRICING_RECOMMENDATION_JOB_LANE_COUNT", 1),
    pricingRecommendationJobWorkflowMaxActiveClaims: getPositiveNumberEnv(
      "PRICING_RECOMMENDATION_JOB_WORKFLOW_MAX_ACTIVE_CLAIMS",
      1,
    ),
    pricingRecommendationJobMaxActiveClaimsPerJob: getPositiveNumberEnv(
      "PRICING_RECOMMENDATION_JOB_MAX_ACTIVE_CLAIMS_PER_JOB",
      1,
    ),
    settlementPayoutReconciliationJobLaneCount: getPositiveNumberEnv(
      "SETTLEMENT_PAYOUT_RECONCILIATION_JOB_LANE_COUNT",
      1,
    ),
    settlementPayoutReconciliationJobWorkflowMaxActiveClaims: getPositiveNumberEnv(
      "SETTLEMENT_PAYOUT_RECONCILIATION_JOB_WORKFLOW_MAX_ACTIVE_CLAIMS",
      1,
    ),
    settlementPayoutReconciliationJobMaxActiveClaimsPerJob: getPositiveNumberEnv(
      "SETTLEMENT_PAYOUT_RECONCILIATION_JOB_MAX_ACTIVE_CLAIMS_PER_JOB",
      1,
    ),
    pollIntervalMs: getPositiveNumberEnv("WORKER_POLL_INTERVAL_MS", 1_000),
    leaseTtlMs: getPositiveNumberEnv("WORKER_LEASE_TTL_MS", 30_000),
    leaseRenewIntervalMs: getPositiveNumberEnv("WORKER_LEASE_RENEW_INTERVAL_MS", 10_000),
    projectionOperations: {
      runnerCount: getPositiveNumberEnv("WORKER_PROJECTION_OPERATION_RUNNER_COUNT", 2),
      operationTimeoutMs: getPositiveNumberEnv("WORKER_PROJECTION_OPERATION_TIMEOUT_MS", 600_000),
      rebuildOperationTimeoutMs: getPositiveNumberEnv("WORKER_PROJECTION_OPERATION_REBUILD_TIMEOUT_MS", 7_200_000),
      maxAttempts: getPositiveNumberEnv("WORKER_PROJECTION_OPERATION_MAX_ATTEMPTS", 5),
      retryBackoffBaseMs: getPositiveNumberEnv("WORKER_PROJECTION_OPERATION_RETRY_BACKOFF_BASE_MS", 30_000),
      retryBackoffMaxMs: getPositiveNumberEnv("WORKER_PROJECTION_OPERATION_RETRY_BACKOFF_MAX_MS", 600_000),
      leaseAcquireTimeoutMs: getPositiveNumberEnv("WORKER_PROJECTION_OPERATION_LEASE_ACQUIRE_TIMEOUT_MS", 15_000),
    },
    projectionWakeScheduler: {
      enabled: getBooleanEnv("WORKER_PROJECTION_WAKE_SCHEDULER_ENABLED", true),
      pushDispatchEnabled: getBooleanEnv("WORKER_WAKE_PUSH_DISPATCH_ENABLED", true),
      maxConcurrentRunners: getPositiveNumberEnv("WORKER_WAKE_MAX_CONCURRENT_RUNNERS", 2),
      pollIntervalMs: getPositiveNumberEnv("WORKER_WAKE_POLL_INTERVAL_MS", 1_000),
      // Lane runner counts accept zero so an operator can kill one priority
      // lane on this worker without disabling the whole wake scheduler.
      hotLaneRunnerCount: getNonNegativeNumberEnv("WORKER_WAKE_HOT_LANE_RUNNER_COUNT", 1),
      standardLaneRunnerCount: getNonNegativeNumberEnv("WORKER_WAKE_STANDARD_LANE_RUNNER_COUNT", 1),
      bulkLaneRunnerCount: getNonNegativeNumberEnv("WORKER_WAKE_BULK_LANE_RUNNER_COUNT", 1),
      maxClaimsPerRun: getPositiveNumberEnv("WORKER_WAKE_MAX_CLAIMS_PER_RUN", 10),
      claimTtlMs: getPositiveNumberEnv("WORKER_WAKE_CLAIM_TTL_MS", 120_000),
      statementTimeoutMs: getPositiveNumberEnv("WORKER_WAKE_STATEMENT_TIMEOUT_MS", 30_000),
      retryBackoffBaseMs: getPositiveNumberEnv("WORKER_WAKE_RETRY_BACKOFF_BASE_MS", 1_000),
      retryBackoffMaxMs: getPositiveNumberEnv("WORKER_WAKE_RETRY_BACKOFF_MAX_MS", 60_000),
      maxAttempts: getPositiveNumberEnv("WORKER_WAKE_MAX_ATTEMPTS", 10),
      cleanupIntervalMs: getPositiveNumberEnv("WORK_SIGNAL_CLEANUP_INTERVAL_MS", 60_000),
    },
    projectionWakeRelay: {
      enabled: getBooleanEnv("WORKER_PROJECTION_WAKE_RELAY_ENABLED", true),
      listenerDatabaseUrls: Object.fromEntries(
        workerContexts.flatMap((contextName) => {
          const listenerDatabaseUrl = getOptionalEnv(getContextListenerDatabaseEnvName(contextName));
          return listenerDatabaseUrl ? [[contextName, listenerDatabaseUrl]] : [];
        }),
      ) as Readonly<Partial<Record<PlatformWorkerContextName, string>>>,
      catchUpBatchSize: getPositiveNumberEnv("WORKER_WAKE_RELAY_CATCH_UP_BATCH_SIZE", 100),
      standbyRetryMs: getPositiveNumberEnv("WORKER_WAKE_RELAY_STANDBY_RETRY_MS", 15_000),
      noSourcesRetryMs: getPositiveNumberEnv("WORKER_WAKE_RELAY_NO_SOURCES_RETRY_MS", 60_000),
      failureBackoffMs: getPositiveNumberEnv("WORKER_WAKE_RELAY_FAILURE_BACKOFF_MS", 5_000),
      failureBackoffMaxMs: getPositiveNumberEnv("WORKER_WAKE_RELAY_FAILURE_BACKOFF_MAX_MS", 60_000),
    },
    projectionWakeDisabledProjections: getProjectionKeyListEnv("WORKER_WAKE_DISABLED_PROJECTIONS"),
    paymentReconciliationIntervalMs: getOptionalPositiveNumberEnv("PAYMENT_RECONCILIATION_INTERVAL_MS", 300_000),
    paymentDeadlineSweepIntervalMs: getOptionalPositiveNumberEnv("PAYMENT_DEADLINE_SWEEP_INTERVAL_MS", 60_000),
    supportRequestDeadlineSweepIntervalMs: getOptionalPositiveNumberEnv(
      "SUPPORT_REQUEST_DEADLINE_SWEEP_INTERVAL_MS",
      300_000,
    ),
    // Double-blind reveal expiry sweep (m108): shares the support-request
    // sweep's 5-minute default cadence -- frequent enough that a missed
    // same-request counterpart-reveal race self-heals promptly, cheap enough
    // (bounded candidate queries) to run that often.
    reviewWindowSweepIntervalMs: getOptionalPositiveNumberEnv("REVIEW_WINDOW_SWEEP_INTERVAL_MS", 300_000),
    sellerFundsReleaseIntervalMs: getOptionalPositiveNumberEnv("SELLER_FUNDS_RELEASE_INTERVAL_MS", 300_000),
    payoutReconciliationIntervalMs: getOptionalPositiveNumberEnv("PAYOUT_RECONCILIATION_INTERVAL_MS", 300_000),
    googleShoppingMaintenanceIntervalMs: getOptionalPositiveNumberEnv(
      "GOOGLE_SHOPPING_MAINTENANCE_INTERVAL_MS",
      86_400_000,
    ),
    googleShoppingMaintenanceBatchSize: getPositiveNumberEnv("GOOGLE_SHOPPING_MAINTENANCE_BATCH_SIZE", 100),
    googleShoppingRefreshWindowDays: getPositiveNumberEnv("GOOGLE_SHOPPING_REFRESH_WINDOW_DAYS", 25),
    googleShoppingDiagnosticsIntervalMs: getOptionalPositiveNumberEnv(
      "GOOGLE_SHOPPING_DIAGNOSTICS_INTERVAL_MS",
      86_400_000,
    ),
    googleShoppingDiagnosticsBatchSize: getPositiveNumberEnv("GOOGLE_SHOPPING_DIAGNOSTICS_BATCH_SIZE", 100),
    googleShoppingDiagnosticsPreviousIssueChunkSize: getPositiveNumberEnv(
      "GOOGLE_SHOPPING_DIAGNOSTICS_PREVIOUS_ISSUE_CHUNK_SIZE",
      100,
    ),
    discoverySearchEmbeddings: {
      apiKey: voyageApiKey,
      model: getOptionalEnv("VOYAGE_EMBEDDING_MODEL") ?? "voyage-4-lite",
      batchSize: getPositiveNumberEnv("VOYAGE_EMBEDDING_BATCH_SIZE", 128),
      timeoutMs: getPositiveNumberEnv("VOYAGE_EMBEDDING_TIMEOUT_MS", 15_000),
      maxAttempts: getPositiveNumberEnv("VOYAGE_EMBEDDING_MAX_ATTEMPTS", 4),
      retryBackoffBaseMs: getPositiveNumberEnv("VOYAGE_EMBEDDING_RETRY_BACKOFF_BASE_MS", 500),
      retryBackoffMaxMs: getPositiveNumberEnv("VOYAGE_EMBEDDING_RETRY_BACKOFF_MAX_MS", 10_000),
      intervalMs: getPositiveNumberEnv("DISCOVERY_SEARCH_EMBEDDING_INTERVAL_MS", 1_000),
      rolloutValue: getOptionalEnv("DISCOVERY_SEARCH_EMBEDDINGS"),
      rescueValue: getOptionalEnv("DISCOVERY_SEARCH_RESCUE"),
      hybridValue: getOptionalEnv("DISCOVERY_SEARCH_HYBRID"),
      queryCacheMaxEntries: getPositiveNumberEnv("DISCOVERY_QUERY_EMBEDDING_CACHE_MAX_ENTRIES", 1_000),
      queryCacheTtlMs: getPositiveNumberEnv("DISCOVERY_QUERY_EMBEDDING_CACHE_TTL_MS", 900_000),
    },
    paymentProcessor: stripeProvider.paymentProcessor,
    moneyMovement: stripeProvider.moneyMovement,
    mobileMessaging:
      mobileMessagingProvider === "twilio"
        ? {
            kind: "twilio",
            accountSid: twilioAccountSid as string,
            authToken: twilioAuthToken as string,
            messagingServiceSid: twilioMessagingServiceSid as string,
            apiBaseUrl: twilioApiBaseUrl,
            statusCallbackBaseUrl: twilioStatusCallbackBaseUrl,
          }
        : { kind: "noop" },
    postage: loadPostageConfig({
      productionLike: providerRequired,
      productionMissingApiKeyError:
        "EASYPOST_API_KEY is required for platform worker postage label work in production.",
      includeWebhookSecret: false,
    }),
    tcgplayerAutomation: loadTcgplayerAutomationConfig(),
    googleMerchant: loadGoogleMerchantConfig({
      syncEnabled: googleMerchantSyncEnabled,
      dryRun: googleMerchantDryRun,
      merchantAccountId: googleMerchantAccountId,
      apiDataSourceId: googleMerchantApiDataSourceId,
      targetCountry: googleMerchantTargetCountry,
      contentLanguage: googleMerchantContentLanguage,
      feedLabel: googleMerchantFeedLabel,
      credentialSecretName: googleMerchantCredentialSecretName,
    }),
    notificationEmail: {
      provider: notificationEmailProvider,
      ses: {
        region: sesAwsRegion,
        accessKeyId: sesAwsAccessKeyId,
        secretAccessKey: sesAwsSecretAccessKey,
        fromEmail: sesFromEmail,
        configurationSetName: sesConfigurationSetName,
        sourceArn: sesSourceArn,
      },
      localCapture: {
        filePath: localEmailCaptureFile,
      },
    },
  };
}

function loadRuntimeProfile(): PlatformWorkerRuntimeProfile {
  const value = getOptionalEnv("CHASE_SETS_RUNTIME_PROFILE") ?? "public";
  if (!isPlatformWorkerRuntimeProfile(value)) {
    throw new Error("CHASE_SETS_RUNTIME_PROFILE must be landing, proof, or public.");
  }

  return value;
}

export function describeGoogleMerchantConfigForLogs(config: PlatformWorkerGoogleMerchantConfig) {
  if (!config.syncEnabled) {
    return {
      syncEnabled: false,
      dryRun: config.dryRun,
    };
  }

  return {
    syncEnabled: true,
    dryRun: config.dryRun,
    merchantAccountId: config.merchantAccountId,
    apiDataSourceId: config.apiDataSourceId,
    targetCountry: config.targetCountry,
    contentLanguage: config.contentLanguage,
    feedLabel: config.feedLabel,
    credentialSecretName: "[configured]",
  };
}

function loadGoogleMerchantConfig(input: {
  syncEnabled: boolean;
  dryRun: boolean;
  merchantAccountId: string | null;
  apiDataSourceId: string | null;
  targetCountry: string;
  contentLanguage: string;
  feedLabel: string;
  credentialSecretName: string | null;
}): PlatformWorkerGoogleMerchantConfig {
  if (!input.syncEnabled) {
    return {
      syncEnabled: false,
      dryRun: input.dryRun,
    };
  }

  const missing = [
    ["GOOGLE_MERCHANT_ACCOUNT_ID", input.merchantAccountId],
    ["GOOGLE_MERCHANT_API_DATA_SOURCE_ID", input.apiDataSourceId],
    ["GOOGLE_MERCHANT_TARGET_COUNTRY", input.targetCountry],
    ["GOOGLE_MERCHANT_CONTENT_LANGUAGE", input.contentLanguage],
    ["GOOGLE_MERCHANT_FEED_LABEL", input.feedLabel],
    ["GOOGLE_MERCHANT_CREDENTIAL_SECRET_NAME", input.credentialSecretName],
  ].flatMap(([name, value]) => (value ? [] : [name]));

  if (missing.length > 0) {
    throw new Error(`${missing.join(", ")} are required when GOOGLE_MERCHANT_SYNC_ENABLED=true.`);
  }
  if (!/^[A-Z]{2}$/.test(input.targetCountry)) {
    throw new Error("GOOGLE_MERCHANT_TARGET_COUNTRY must be an ISO 3166-1 alpha-2 country code such as US.");
  }
  if (!/^[a-z]{2}(-[A-Z]{2})?$/.test(input.contentLanguage)) {
    throw new Error("GOOGLE_MERCHANT_CONTENT_LANGUAGE must be a language code such as en or en-US.");
  }

  return {
    syncEnabled: true,
    dryRun: input.dryRun,
    merchantAccountId: input.merchantAccountId as string,
    apiDataSourceId: input.apiDataSourceId as string,
    targetCountry: input.targetCountry,
    contentLanguage: input.contentLanguage,
    feedLabel: input.feedLabel,
    credentialSecretName: input.credentialSecretName as string,
  };
}

function resolveNotificationEmailProvider(value: string | null): PlatformWorkerNotificationEmailConfig["provider"] {
  return resolveEnumEnv<PlatformWorkerNotificationEmailConfig["provider"]>(
    "NOTIFICATION_EMAIL_PROVIDER",
    value,
    ["noop", "amazon-ses", "local-capture"],
    "noop",
  );
}

function getNonNegativeNumberEnv(name: string, defaultValue: number) {
  // Empty/whitespace values fall back to the default so an unset Terraform
  // interpolation can never silently zero out a lane.
  const raw = getOptionalEnv(name);
  if (raw === null) {
    return defaultValue;
  }

  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : defaultValue;
}

/**
 * Comma-separated `<target-context>:<projection-name>` keys (matching the
 * registry's affectedProjectionNames format, e.g.
 * `checkout:checkout.cart-projection`). Malformed entries fail config load
 * instead of being ignored, because an operator silently failing to disable a
 * projection group is the dangerous direction for a kill switch.
 */
function getProjectionKeyListEnv(name: string): readonly string[] {
  const raw = getOptionalEnv(name);
  if (!raw) {
    return [];
  }

  const keys = raw
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  for (const key of keys) {
    const separatorIndex = key.indexOf(":");
    if (separatorIndex <= 0 || separatorIndex >= key.length - 1) {
      throw new Error(`${name} entries must use the form <target-context>:<projection-name>, got '${key}'.`);
    }
  }

  return [...new Set(keys)].sort((left, right) => left.localeCompare(right));
}
