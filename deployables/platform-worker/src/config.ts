import { getWorkerHostContextNames, type WorkerHostContextName } from "@chase-sets/platform-runtime/worker";
import { workerContextRegistry } from "./generated/worker-context-registry";

export type PlatformWorkerContextName = WorkerHostContextName<typeof workerContextRegistry>;

export type PlatformWorkerPoolConfig = Readonly<{
  max: number;
  idleTimeoutMillis: number;
  connectionTimeoutMillis: number;
}>;

export type PlatformWorkerConfig = Readonly<{
  sharedDatabaseUrl: string | null;
  controlDatabaseUrl: string;
  contextDatabaseUrls: Readonly<Partial<Record<PlatformWorkerContextName, string>>>;
  pool: PlatformWorkerPoolConfig;
  catalogAssetStorage: PlatformWorkerCatalogAssetStorageConfig;
  port: number;
  workerId: string;
  maxConcurrentRunners: number;
  projectionMaxConcurrentRunners: number;
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
  paymentReconciliationIntervalMs: number | null;
  sellerFundsReleaseIntervalMs: number | null;
  payoutReconciliationIntervalMs: number | null;
  googleShoppingMaintenanceIntervalMs: number | null;
  googleShoppingMaintenanceBatchSize: number;
  googleShoppingRefreshWindowDays: number;
  paymentProcessor: PlatformWorkerPaymentProcessorConfig;
  moneyMovement: PlatformWorkerMoneyMovementConfig;
  mobileMessaging: PlatformWorkerMobileMessagingConfig;
  postage: PlatformWorkerPostageConfig;
  googleMerchant: PlatformWorkerGoogleMerchantConfig;
  notificationEmail: PlatformWorkerNotificationEmailConfig;
}>;

export type PlatformWorkerCatalogAssetStorageConfig =
  | Readonly<{
      kind: "filesystem";
      rootDir: string;
      publicBaseUrl: string;
    }>
  | Readonly<{
      kind: "s3";
      bucket: string;
      region: string;
      publicBaseUrl: string;
      endpoint?: string;
      accessKeyId?: string;
      secretAccessKey?: string;
      forcePathStyle?: boolean;
    }>;

export type PlatformWorkerPaymentProcessorConfig =
  | Readonly<{ kind: "fake" }>
  | Readonly<{
      kind: "stripe";
      secretKey: string;
      publishableKey: string;
      webhookSecret: string;
      apiBaseUrl?: string;
      checkoutUiMode?: "elements" | "hosted";
    }>;

export type PlatformWorkerMoneyMovementConfig =
  | Readonly<{ kind: "fake" }>
  | Readonly<{
      kind: "stripe";
      secretKey: string;
      webhookSecret: string;
      apiBaseUrl?: string;
      onboardingReturnUrl?: string;
      onboardingRefreshUrl?: string;
    }>;

export type PlatformWorkerPostageConfig =
  | Readonly<{ kind: "sandbox" }>
  | Readonly<{
      kind: "easypost";
      apiKey: string;
      apiBaseUrl?: string;
      mode: "test" | "production";
    }>;

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

const workerContexts = getWorkerHostContextNames(workerContextRegistry, "platform-worker");

export function getContextDatabaseEnvName(contextName: PlatformWorkerContextName) {
  return `DATABASE_URL_${contextName.replaceAll("-", "_").toUpperCase()}`;
}

export function loadConfig(): PlatformWorkerConfig {
  const sharedDatabaseUrl = getOptionalEnv("DATABASE_URL");
  const controlDatabaseUrl = getOptionalEnv("PLATFORM_CONTROL_DATABASE_URL") ?? sharedDatabaseUrl;
  if (!controlDatabaseUrl) {
    throw new Error("PLATFORM_CONTROL_DATABASE_URL or DATABASE_URL is required.");
  }

  const contextDatabaseUrls = Object.fromEntries(
    workerContexts.flatMap((contextName) => {
      const databaseUrl = getOptionalEnv(getContextDatabaseEnvName(contextName));
      return databaseUrl ? [[contextName, databaseUrl]] : [];
    }),
  ) as Readonly<Partial<Record<PlatformWorkerContextName, string>>>;
  const missingContextNames = workerContexts.filter(
    (contextName) => !sharedDatabaseUrl && !contextDatabaseUrls[contextName],
  );
  if (missingContextNames.length > 0) {
    throw new Error(
      `DATABASE_URL or per-context database URLs are required. Missing: ${missingContextNames
        .map((contextName) => getContextDatabaseEnvName(contextName))
        .join(", ")}.`,
    );
  }

  const port = Number(process.env.PORT ?? 6183);
  const stripeSecretKey = getOptionalEnv("STRIPE_SECRET_KEY");
  const stripePublishableKey = getOptionalEnv("STRIPE_PUBLISHABLE_KEY");
  const stripeWebhookSecret = getOptionalEnv("STRIPE_WEBHOOK_SECRET");
  const stripeConnectWebhookSecret = getOptionalEnv("STRIPE_CONNECT_WEBHOOK_SECRET");
  const stripeApiBaseUrl = getOptionalEnv("STRIPE_API_BASE_URL") ?? undefined;
  const stripeCheckoutUiMode = getOptionalEnv("STRIPE_CHECKOUT_UI_MODE");
  const stripeConnectReturnUrl = getOptionalEnv("STRIPE_CONNECT_RETURN_URL") ?? undefined;
  const stripeConnectRefreshUrl = getOptionalEnv("STRIPE_CONNECT_REFRESH_URL") ?? undefined;
  const easyPostApiKey = getOptionalEnv("EASYPOST_API_KEY");
  const easyPostApiBaseUrl = getOptionalEnv("EASYPOST_API_BASE_URL") ?? undefined;
  const easyPostMode = getOptionalEnv("EASYPOST_MODE") === "production" ? "production" : "test";
  const googleMerchantSyncEnabled = getBooleanEnv("GOOGLE_MERCHANT_SYNC_ENABLED", false);
  const googleMerchantDryRun = getBooleanEnv("GOOGLE_MERCHANT_DRY_RUN", true);
  const googleMerchantAccountId = getOptionalEnv("GOOGLE_MERCHANT_ACCOUNT_ID");
  const googleMerchantApiDataSourceId = getOptionalEnv("GOOGLE_MERCHANT_API_DATA_SOURCE_ID");
  const googleMerchantTargetCountry = getOptionalEnv("GOOGLE_MERCHANT_TARGET_COUNTRY") ?? "US";
  const googleMerchantContentLanguage = getOptionalEnv("GOOGLE_MERCHANT_CONTENT_LANGUAGE") ?? "en";
  const googleMerchantFeedLabel = getOptionalEnv("GOOGLE_MERCHANT_FEED_LABEL") ?? googleMerchantTargetCountry;
  const googleMerchantCredentialSecretName = getOptionalEnv("GOOGLE_MERCHANT_CREDENTIAL_SECRET_NAME");
  const mobileMessagingProvider = getOptionalEnv("MOBILE_MESSAGING_PROVIDER");
  const twilioAccountSid = getOptionalEnv("TWILIO_ACCOUNT_SID");
  const twilioAuthToken = getOptionalEnv("TWILIO_AUTH_TOKEN");
  const twilioMessagingServiceSid = getOptionalEnv("TWILIO_MESSAGING_SERVICE_SID");
  const twilioApiBaseUrl = getOptionalEnv("TWILIO_API_BASE_URL") ?? undefined;
  const twilioStatusCallbackBaseUrl = getOptionalEnv("TWILIO_STATUS_CALLBACK_BASE_URL") ?? undefined;
  const productionLike = process.env.NODE_ENV === "production";
  const resolvedStripeConnectWebhookSecret =
    stripeConnectWebhookSecret ?? (!productionLike ? stripeWebhookSecret : undefined);
  const notificationEmailProvider = resolveNotificationEmailProvider(getOptionalEnv("NOTIFICATION_EMAIL_PROVIDER"));
  const sesAwsRegion = getOptionalEnv("SES_AWS_REGION") ?? undefined;
  const sesAwsAccessKeyId = getOptionalEnv("SES_AWS_ACCESS_KEY_ID") ?? undefined;
  const sesAwsSecretAccessKey = getOptionalEnv("SES_AWS_SECRET_ACCESS_KEY") ?? undefined;
  const sesFromEmail = getOptionalEnv("SES_FROM_EMAIL") ?? undefined;
  const sesConfigurationSetName = getOptionalEnv("SES_CONFIGURATION_SET_NAME") ?? undefined;
  const sesSourceArn = getOptionalEnv("SES_SOURCE_ARN") ?? undefined;
  const localEmailCaptureFile =
    getOptionalEnv("LOCAL_EMAIL_CAPTURE_FILE") ?? "artifacts/notifications/local-email-capture.jsonl";

  if (
    productionLike &&
    (!stripeSecretKey || !stripePublishableKey || !stripeWebhookSecret || !stripeConnectWebhookSecret)
  ) {
    throw new Error(
      "STRIPE_SECRET_KEY, STRIPE_PUBLISHABLE_KEY, STRIPE_WEBHOOK_SECRET, and STRIPE_CONNECT_WEBHOOK_SECRET are required for platform worker payment processing and money movement in production.",
    );
  }
  if (productionLike && !easyPostApiKey) {
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
    sharedDatabaseUrl,
    controlDatabaseUrl,
    contextDatabaseUrls,
    pool: {
      max: getPositiveNumberEnv("DATABASE_POOL_MAX", 10),
      idleTimeoutMillis: getPositiveNumberEnv("DATABASE_POOL_IDLE_TIMEOUT_MS", 30_000),
      connectionTimeoutMillis: getPositiveNumberEnv("DATABASE_POOL_CONNECTION_TIMEOUT_MS", 5_000),
    },
    catalogAssetStorage: loadCatalogAssetStorageConfig(port, productionLike),
    port,
    workerId: getOptionalEnv("WORKER_ID") ?? `platform-worker-${process.pid}-${Date.now().toString(36)}`,
    maxConcurrentRunners,
    projectionMaxConcurrentRunners: getPositiveNumberEnv(
      "WORKER_PROJECTION_MAX_CONCURRENT_RUNNERS",
      Math.min(2, maxConcurrentRunners),
    ),
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
    paymentReconciliationIntervalMs: getOptionalPositiveNumberEnv("PAYMENT_RECONCILIATION_INTERVAL_MS", 300_000),
    sellerFundsReleaseIntervalMs: getOptionalPositiveNumberEnv("SELLER_FUNDS_RELEASE_INTERVAL_MS", 300_000),
    payoutReconciliationIntervalMs: getOptionalPositiveNumberEnv("PAYOUT_RECONCILIATION_INTERVAL_MS", 300_000),
    googleShoppingMaintenanceIntervalMs: getOptionalPositiveNumberEnv(
      "GOOGLE_SHOPPING_MAINTENANCE_INTERVAL_MS",
      86_400_000,
    ),
    googleShoppingMaintenanceBatchSize: getPositiveNumberEnv("GOOGLE_SHOPPING_MAINTENANCE_BATCH_SIZE", 100),
    googleShoppingRefreshWindowDays: getPositiveNumberEnv("GOOGLE_SHOPPING_REFRESH_WINDOW_DAYS", 25),
    paymentProcessor:
      stripeSecretKey && stripePublishableKey && stripeWebhookSecret
        ? {
            kind: "stripe",
            secretKey: stripeSecretKey,
            publishableKey: stripePublishableKey,
            webhookSecret: stripeWebhookSecret,
            apiBaseUrl: stripeApiBaseUrl,
            checkoutUiMode: stripeCheckoutUiMode === "hosted" ? "hosted" : "elements",
          }
        : { kind: "fake" },
    moneyMovement:
      stripeSecretKey && resolvedStripeConnectWebhookSecret
        ? {
            kind: "stripe",
            secretKey: stripeSecretKey,
            webhookSecret: resolvedStripeConnectWebhookSecret,
            apiBaseUrl: stripeApiBaseUrl,
            ...(stripeConnectReturnUrl ? { onboardingReturnUrl: stripeConnectReturnUrl } : {}),
            ...(stripeConnectRefreshUrl ? { onboardingRefreshUrl: stripeConnectRefreshUrl } : {}),
          }
        : { kind: "fake" },
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
    postage: easyPostApiKey
      ? {
          kind: "easypost",
          apiKey: easyPostApiKey,
          apiBaseUrl: easyPostApiBaseUrl,
          mode: easyPostMode,
        }
      : { kind: "sandbox" },
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
  if (value === "amazon-ses" || value === "local-capture") {
    return value;
  }

  return "noop";
}

function loadCatalogAssetStorageConfig(port: number, productionLike: boolean): PlatformWorkerCatalogAssetStorageConfig {
  const kind = getOptionalEnv("CATALOG_ASSET_STORAGE_KIND") ?? (productionLike ? "s3" : "filesystem");

  if (kind === "filesystem") {
    if (productionLike) {
      throw new Error("CATALOG_ASSET_STORAGE_KIND=s3 is required for Catalog asset storage in production.");
    }

    return {
      kind: "filesystem",
      rootDir: getOptionalEnv("CATALOG_ASSET_LOCAL_ROOT") ?? "artifacts/catalog-assets",
      publicBaseUrl:
        getOptionalEnv("CATALOG_ASSET_PUBLIC_BASE_URL") ??
        `${(getOptionalEnv("PLATFORM_API_URL") ?? `http://localhost:${port}`).replace(/\/$/, "")}/catalog-assets`,
    };
  }

  if (kind !== "s3") {
    throw new Error("CATALOG_ASSET_STORAGE_KIND must be filesystem or s3.");
  }

  const bucket = getOptionalEnv("CATALOG_ASSET_S3_BUCKET");
  const region = getOptionalEnv("CATALOG_ASSET_S3_REGION");
  const publicBaseUrl = getOptionalEnv("CATALOG_ASSET_PUBLIC_BASE_URL");
  const accessKeyId = getOptionalEnv("CATALOG_ASSET_S3_ACCESS_KEY_ID");
  const secretAccessKey = getOptionalEnv("CATALOG_ASSET_S3_SECRET_ACCESS_KEY");

  if (!bucket || !region || !publicBaseUrl) {
    throw new Error(
      "CATALOG_ASSET_S3_BUCKET, CATALOG_ASSET_S3_REGION, and CATALOG_ASSET_PUBLIC_BASE_URL are required when CATALOG_ASSET_STORAGE_KIND=s3.",
    );
  }
  if (Boolean(accessKeyId) !== Boolean(secretAccessKey)) {
    throw new Error(
      "CATALOG_ASSET_S3_ACCESS_KEY_ID and CATALOG_ASSET_S3_SECRET_ACCESS_KEY must be configured together.",
    );
  }

  return {
    kind: "s3",
    bucket,
    region,
    publicBaseUrl,
    endpoint: getOptionalEnv("CATALOG_ASSET_S3_ENDPOINT") ?? undefined,
    accessKeyId: accessKeyId ?? undefined,
    secretAccessKey: secretAccessKey ?? undefined,
    forcePathStyle: getBooleanEnv("CATALOG_ASSET_S3_FORCE_PATH_STYLE", false),
  };
}

function getOptionalEnv(name: string) {
  const value = process.env[name];
  return value?.trim() ? value.trim() : null;
}

function getBooleanEnv(name: string, defaultValue: boolean) {
  const value = getOptionalEnv(name);
  if (!value) {
    return defaultValue;
  }

  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function getOptionalPositiveNumberEnv(name: string, defaultValue: number) {
  const parsed = Number(process.env[name] ?? defaultValue);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function getPositiveNumberEnv(name: string, defaultValue: number) {
  return getOptionalPositiveNumberEnv(name, defaultValue) ?? defaultValue;
}
