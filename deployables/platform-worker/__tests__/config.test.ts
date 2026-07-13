import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  describeGoogleMerchantConfigForLogs,
  getPlatformWorkerContextsForRuntimeProfile,
  loadConfig,
} from "../src/config";
import { describeTcgplayerAutomationConfigForLogs } from "@chase-sets/platform-runtime/config-schema";

const envNames = [
  "DATABASE_URL",
  "DEPLOYMENT_ENVIRONMENT",
  "PLATFORM_CONTROL_DATABASE_URL",
  "PLATFORM_WORK_SIGNAL_DATABASE_URL",
  "CHASE_SETS_RUNTIME_PROFILE",
  "NODE_ENV",
  "PORT",
  "STRIPE_SECRET_KEY",
  "STRIPE_PUBLISHABLE_KEY",
  "STRIPE_WEBHOOK_SECRET",
  "STRIPE_WEBHOOK_SECRET_PREVIOUS",
  "STRIPE_CONNECT_WEBHOOK_SECRET",
  "STRIPE_CONNECT_WEBHOOK_SECRET_PREVIOUS",
  "STRIPE_CONNECT_ACCOUNTS_API",
  "STRIPE_API_BASE_URL",
  "EASYPOST_API_KEY",
  "EASYPOST_API_BASE_URL",
  "EASYPOST_MODE",
  "DISCOVERY_SEARCH_EMBEDDINGS",
  "DISCOVERY_SEARCH_RESCUE",
  "DISCOVERY_SEARCH_HYBRID",
  "DISCOVERY_QUERY_EMBEDDING_CACHE_MAX_ENTRIES",
  "DISCOVERY_QUERY_EMBEDDING_CACHE_TTL_MS",
  "DISCOVERY_SEARCH_EMBEDDING_INTERVAL_MS",
  "VOYAGE_API_KEY",
  "VOYAGE_EMBEDDING_MODEL",
  "VOYAGE_EMBEDDING_BATCH_SIZE",
  "VOYAGE_EMBEDDING_TIMEOUT_MS",
  "VOYAGE_EMBEDDING_MAX_ATTEMPTS",
  "VOYAGE_EMBEDDING_RETRY_BACKOFF_BASE_MS",
  "VOYAGE_EMBEDDING_RETRY_BACKOFF_MAX_MS",
  "GOOGLE_MERCHANT_SYNC_ENABLED",
  "GOOGLE_MERCHANT_DRY_RUN",
  "GOOGLE_MERCHANT_ACCOUNT_ID",
  "GOOGLE_MERCHANT_API_DATA_SOURCE_ID",
  "GOOGLE_MERCHANT_TARGET_COUNTRY",
  "GOOGLE_MERCHANT_CONTENT_LANGUAGE",
  "GOOGLE_MERCHANT_FEED_LABEL",
  "GOOGLE_MERCHANT_CREDENTIAL_SECRET_NAME",
  "GOOGLE_MERCHANT_PRODUCTION_SYNC_APPROVAL_REFERENCE",
  "GOOGLE_SHOPPING_MAINTENANCE_INTERVAL_MS",
  "GOOGLE_SHOPPING_MAINTENANCE_BATCH_SIZE",
  "GOOGLE_SHOPPING_REFRESH_WINDOW_DAYS",
  "GOOGLE_SHOPPING_DIAGNOSTICS_INTERVAL_MS",
  "GOOGLE_SHOPPING_DIAGNOSTICS_BATCH_SIZE",
  "GOOGLE_SHOPPING_DIAGNOSTICS_PREVIOUS_ISSUE_CHUNK_SIZE",
  "TCGPLAYER_AUTOMATION_TCG_AUTH_COOKIE",
  "TCGPLAYER_AUTOMATION_USER_AGENT",
  "TCGPLAYER_AUTOMATION_REQUEST_DELAY_MS",
  "TCGPLAYER_AUTOMATION_RATE_LIMIT_COOLDOWN_MS",
  "TCGPLAYER_AUTOMATION_MAX_CONCURRENT_REQUESTS",
  "TCGPLAYER_AUTOMATION_ADAPTIVE_ENABLED",
  "TCGPLAYER_AUTOMATION_MIN_REQUEST_DELAY_MS",
  "TCGPLAYER_AUTOMATION_MAX_REQUEST_DELAY_MS",
  "TCGPLAYER_AUTOMATION_LEARNED_MIN_DELAY_MS",
  "TCGPLAYER_AUTOMATION_DOMAIN_CONFIG_JSON",
  "TCGPLAYER_AUTOMATION_ADAPTIVE_INCREASE_MULTIPLIER",
  "TCGPLAYER_AUTOMATION_ADAPTIVE_FLOOR_STEP_MS",
  "TCGPLAYER_AUTOMATION_ADAPTIVE_DECREASE_AMOUNT_MS",
  "TCGPLAYER_AUTOMATION_ADAPTIVE_SUCCESS_THRESHOLD",
  "TCGPLAYER_AUTOMATION_MAX_RETRIES",
  "NOTIFICATION_EMAIL_PROVIDER",
  "SES_AWS_REGION",
  "SES_AWS_ACCESS_KEY_ID",
  "SES_AWS_SECRET_ACCESS_KEY",
  "SES_FROM_EMAIL",
  "SES_CONFIGURATION_SET_NAME",
  "SES_SOURCE_ARN",
  "LOCAL_EMAIL_CAPTURE_FILE",
  "DATABASE_POOL_MAX",
  "DATABASE_POOL_IDLE_TIMEOUT_MS",
  "DATABASE_POOL_CONNECTION_TIMEOUT_MS",
  "PAYMENT_RECONCILIATION_INTERVAL_MS",
  "PAYMENT_DEADLINE_SWEEP_INTERVAL_MS",
  "SELLER_AVAILABILITY_RESTORE_SWEEP_INTERVAL_MS",
  "SELLER_FUNDS_RELEASE_INTERVAL_MS",
  "PAYOUT_RECONCILIATION_INTERVAL_MS",
  "MARKET_ROLLUPS_CLOSER_INTERVAL_MS",
  "MOBILE_MESSAGING_PROVIDER",
  "TWILIO_ACCOUNT_SID",
  "TWILIO_AUTH_TOKEN",
  "TWILIO_MESSAGING_SERVICE_SID",
  "TWILIO_API_BASE_URL",
  "TWILIO_STATUS_CALLBACK_BASE_URL",
  "WORKER_MAX_CONCURRENT_RUNNERS",
  "WORKER_PROJECTION_MAX_CONCURRENT_RUNNERS",
  "WORKER_PROJECTION_PRIORITY_REFRESH_INTERVAL_MS",
  "WORKER_JOB_MAX_CONCURRENT_RUNNERS",
  "WORKER_DISPATCH_MAX_CONCURRENT_RUNNERS",
  "WORKER_SCHEDULED_MAX_CONCURRENT_RUNNERS",
  "WORKER_PROJECTION_WAKE_SCHEDULER_ENABLED",
  "WORKER_PROJECTION_WAKE_RELAY_ENABLED",
  "WORKER_WAKE_PUSH_DISPATCH_ENABLED",
  "WORKER_WAKE_HOT_LANE_RUNNER_COUNT",
  "WORKER_WAKE_STANDARD_LANE_RUNNER_COUNT",
  "WORKER_WAKE_BULK_LANE_RUNNER_COUNT",
  "WORKER_WAKE_STATEMENT_TIMEOUT_MS",
  "WORKER_WAKE_DISABLED_PROJECTIONS",
  "SOURCE_OBSERVATION_BULK_JOB_LANE_COUNT",
  "SOURCE_OBSERVATION_BULK_JOB_WORKFLOW_MAX_ACTIVE_CLAIMS",
  "SOURCE_OBSERVATION_BULK_JOB_MAX_ACTIVE_CLAIMS_PER_JOB",
  "CATALOG_AUTHORING_BULK_JOB_LANE_COUNT",
  "CATALOG_AUTHORING_BULK_JOB_WORKFLOW_MAX_ACTIVE_CLAIMS",
  "CATALOG_AUTHORING_BULK_JOB_MAX_ACTIVE_CLAIMS_PER_JOB",
  "SOURCE_OBSERVATION_INTEGRATION_JOB_LANE_COUNT",
  "SOURCE_OBSERVATION_INTEGRATION_JOB_WORKFLOW_MAX_ACTIVE_CLAIMS",
  "SOURCE_OBSERVATION_INTEGRATION_JOB_MAX_ACTIVE_CLAIMS_PER_JOB",
  "INVENTORY_IMPORT_BATCH_JOB_LANE_COUNT",
  "INVENTORY_IMPORT_BATCH_JOB_MAX_CONCURRENT_RUNNERS",
  "INVENTORY_IMPORT_BATCH_JOB_WORKFLOW_MAX_ACTIVE_CLAIMS",
  "INVENTORY_IMPORT_BATCH_JOB_MAX_ACTIVE_CLAIMS_PER_JOB",
  "PRICING_RECOMMENDATION_JOB_LANE_COUNT",
  "PRICING_RECOMMENDATION_JOB_WORKFLOW_MAX_ACTIVE_CLAIMS",
  "PRICING_RECOMMENDATION_JOB_MAX_ACTIVE_CLAIMS_PER_JOB",
  "SETTLEMENT_PAYOUT_RECONCILIATION_JOB_LANE_COUNT",
  "SETTLEMENT_PAYOUT_RECONCILIATION_JOB_WORKFLOW_MAX_ACTIVE_CLAIMS",
  "SETTLEMENT_PAYOUT_RECONCILIATION_JOB_MAX_ACTIVE_CLAIMS_PER_JOB",
  "CATALOG_ASSET_STORAGE_KIND",
  "CATALOG_ASSET_LOCAL_ROOT",
  "CATALOG_ASSET_PUBLIC_BASE_URL",
  "CATALOG_ASSET_S3_BUCKET",
  "CATALOG_ASSET_S3_REGION",
  "CATALOG_ASSET_S3_ENDPOINT",
  "CATALOG_ASSET_S3_ACCESS_KEY_ID",
  "CATALOG_ASSET_S3_SECRET_ACCESS_KEY",
  "CATALOG_ASSET_S3_FORCE_PATH_STYLE",
  "PLATFORM_API_URL",
  "DATABASE_URL_AUTH",
  "DATABASE_URL_CATALOG",
  "DATABASE_URL_CHECKOUT",
  "DATABASE_URL_COMMERCIAL_TERMS",
  "DATABASE_URL_DISCOVERY",
  "DATABASE_URL_FULFILLMENT",
  "DATABASE_URL_IDENTITY",
  "DATABASE_URL_INVENTORY",
  "DATABASE_URL_MARKETPLACE",
  "DATABASE_URL_NOTIFICATIONS",
  "DATABASE_URL_ORDERING",
  "DATABASE_URL_PAYMENTS",
  "DATABASE_URL_PLATFORM_OPERATIONS",
  "DATABASE_URL_PRICING",
  "DATABASE_URL_PUBLIC_PRESENCE",
  "DATABASE_URL_SETTLEMENT",
];

function clearConfigEnv() {
  for (const envName of envNames) {
    delete process.env[envName];
  }
}

beforeEach(() => {
  clearConfigEnv();
});

afterEach(() => {
  clearConfigEnv();
});

describe("platform worker config", () => {
  it("falls back to fake provider adapters outside production", () => {
    process.env.DATABASE_URL = "postgresql://localhost/chase_sets";

    const config = loadConfig();

    expect(config.runtimeProfile).toBe("public");
    expect(config.paymentProcessor).toEqual({ kind: "fake" });
    expect(config.moneyMovement).toEqual({ kind: "fake" });
    expect(config.mobileMessaging).toEqual({ kind: "noop" });
    expect(config.postage).toEqual({ kind: "sandbox" });
    expect(config.tcgplayerAutomation).toBeNull();
    expect(config.googleMerchant).toEqual({ syncEnabled: false, dryRun: true });
    expect(config.discoverySearchEmbeddings).toEqual({
      apiKey: null,
      model: "voyage-4-lite",
      batchSize: 128,
      timeoutMs: 15_000,
      maxAttempts: 4,
      retryBackoffBaseMs: 500,
      retryBackoffMaxMs: 10_000,
      intervalMs: 1_000,
      rolloutValue: null,
      hybridValue: null,
      rescueValue: null,
      queryCacheMaxEntries: 1_000,
      queryCacheTtlMs: 900_000,
    });
    expect(config.catalogAssetStorage).toEqual({
      kind: "filesystem",
      rootDir: "artifacts/catalog-assets",
      publicBaseUrl: `http://localhost:${config.port}/catalog-assets`,
    });
  });

  it("loads optional Voyage enrichment config without requiring a live key", () => {
    process.env.DATABASE_URL = "postgresql://localhost/chase_sets";
    process.env.VOYAGE_API_KEY = "voyage-test";
    process.env.VOYAGE_EMBEDDING_MODEL = "voyage-4";
    process.env.VOYAGE_EMBEDDING_BATCH_SIZE = "64";
    process.env.DISCOVERY_SEARCH_EMBEDDINGS = "off";

    expect(loadConfig().discoverySearchEmbeddings).toMatchObject({
      apiKey: "voyage-test",
      model: "voyage-4",
      batchSize: 64,
      rolloutValue: "off",
    });
  });

  it("maps the landing runtime profile to the landing worker context set", () => {
    expect(getPlatformWorkerContextsForRuntimeProfile("landing")).toEqual([
      "auth",
      "catalog",
      "fulfillment",
      "identity",
      "marketplace",
      "ordering",
      "platform-operations",
      "public-presence",
    ]);
  });

  it("loads the landing runtime profile without full-platform context URLs while keeping wake runners active", () => {
    process.env.CHASE_SETS_RUNTIME_PROFILE = "landing";
    process.env.DATABASE_URL = "postgresql://localhost/chase_sets";
    process.env.DATABASE_URL_CHECKOUT = "postgresql://localhost/checkout";

    const config = loadConfig();

    expect(config.runtimeProfile).toBe("landing");
    expect(config.contextDatabaseUrls.checkout).toBeUndefined();
    expect(config.projectionWakeScheduler.enabled).toBe(true);
    expect(config.projectionWakeRelay.enabled).toBe(true);
  });

  it("rejects unknown runtime profiles", () => {
    process.env.CHASE_SETS_RUNTIME_PROFILE = "support";
    process.env.DATABASE_URL = "postgresql://localhost/chase_sets";

    expect(() => loadConfig()).toThrow("CHASE_SETS_RUNTIME_PROFILE must be landing, proof, or public.");
  });

  it("loads an explicit direct work-signal database URL separately from runtime query URLs", () => {
    process.env.DATABASE_URL = "postgresql://localhost/chase_sets_pooled";
    process.env.PLATFORM_CONTROL_DATABASE_URL = "postgresql://localhost/control_pooled";
    process.env.PLATFORM_WORK_SIGNAL_DATABASE_URL = "postgresql://localhost/control_direct";
    process.env.DATABASE_URL_AUTH = "postgresql://localhost/auth_pooled";
    process.env.DATABASE_URL_CHECKOUT = "postgresql://localhost/checkout_pooled";

    const config = loadConfig();

    expect(config.sharedDatabaseUrl).toBe("postgresql://localhost/chase_sets_pooled");
    expect(config.controlDatabaseUrl).toBe("postgresql://localhost/control_pooled");
    expect(config.workSignalDatabaseUrl).toBe("postgresql://localhost/control_direct");
    expect(config.contextDatabaseUrls.auth).toBe("postgresql://localhost/auth_pooled");
    expect(config.contextDatabaseUrls.checkout).toBe("postgresql://localhost/checkout_pooled");
  });

  it("keeps Google Merchant sync disabled unless explicitly enabled", () => {
    process.env.DATABASE_URL = "postgresql://localhost/chase_sets";
    process.env.GOOGLE_MERCHANT_ACCOUNT_ID = "123456";
    process.env.GOOGLE_MERCHANT_API_DATA_SOURCE_ID = "7890";

    expect(loadConfig().googleMerchant).toEqual({ syncEnabled: false, dryRun: true });
  });

  it("requires complete Google Merchant config when sync is enabled", () => {
    process.env.DATABASE_URL = "postgresql://localhost/chase_sets";
    process.env.GOOGLE_MERCHANT_SYNC_ENABLED = "true";
    process.env.GOOGLE_MERCHANT_ACCOUNT_ID = "123456";

    expect(() => loadConfig()).toThrow(
      "GOOGLE_MERCHANT_API_DATA_SOURCE_ID, GOOGLE_MERCHANT_CREDENTIAL_SECRET_NAME are required when GOOGLE_MERCHANT_SYNC_ENABLED=true.",
    );
  });

  it("loads Google Merchant config for enabled dry-run sync", () => {
    process.env.DATABASE_URL = "postgresql://localhost/chase_sets";
    process.env.GOOGLE_MERCHANT_SYNC_ENABLED = "true";
    process.env.GOOGLE_MERCHANT_DRY_RUN = "true";
    process.env.GOOGLE_MERCHANT_ACCOUNT_ID = "123456";
    process.env.GOOGLE_MERCHANT_API_DATA_SOURCE_ID = "7890";
    process.env.GOOGLE_MERCHANT_TARGET_COUNTRY = "US";
    process.env.GOOGLE_MERCHANT_CONTENT_LANGUAGE = "en";
    process.env.GOOGLE_MERCHANT_FEED_LABEL = "US";
    process.env.GOOGLE_MERCHANT_CREDENTIAL_SECRET_NAME = "google-merchant-service-account";

    expect(loadConfig().googleMerchant).toEqual({
      syncEnabled: true,
      dryRun: true,
      merchantAccountId: "123456",
      apiDataSourceId: "7890",
      targetCountry: "US",
      contentLanguage: "en",
      feedLabel: "US",
      credentialSecretName: "google-merchant-service-account",
      productionSyncApprovalReference: null,
    });
  });

  it("requires a production sync approval reference before enabling live Google Merchant writes", () => {
    process.env.DATABASE_URL = "postgresql://localhost/chase_sets";
    process.env.GOOGLE_MERCHANT_SYNC_ENABLED = "true";
    process.env.GOOGLE_MERCHANT_DRY_RUN = "false";
    process.env.GOOGLE_MERCHANT_ACCOUNT_ID = "123456";
    process.env.GOOGLE_MERCHANT_API_DATA_SOURCE_ID = "7890";
    process.env.GOOGLE_MERCHANT_TARGET_COUNTRY = "US";
    process.env.GOOGLE_MERCHANT_CONTENT_LANGUAGE = "en";
    process.env.GOOGLE_MERCHANT_FEED_LABEL = "US";
    process.env.GOOGLE_MERCHANT_CREDENTIAL_SECRET_NAME = "google-merchant-service-account";

    expect(() => loadConfig()).toThrow(
      "GOOGLE_MERCHANT_PRODUCTION_SYNC_APPROVAL_REFERENCE is required when GOOGLE_MERCHANT_DRY_RUN=false.",
    );
  });

  it("rejects placeholder production sync approval references for live Google Merchant writes", () => {
    process.env.DATABASE_URL = "postgresql://localhost/chase_sets";
    process.env.GOOGLE_MERCHANT_SYNC_ENABLED = "true";
    process.env.GOOGLE_MERCHANT_DRY_RUN = "false";
    process.env.GOOGLE_MERCHANT_ACCOUNT_ID = "123456";
    process.env.GOOGLE_MERCHANT_API_DATA_SOURCE_ID = "7890";
    process.env.GOOGLE_MERCHANT_TARGET_COUNTRY = "US";
    process.env.GOOGLE_MERCHANT_CONTENT_LANGUAGE = "en";
    process.env.GOOGLE_MERCHANT_FEED_LABEL = "US";
    process.env.GOOGLE_MERCHANT_CREDENTIAL_SECRET_NAME = "google-merchant-service-account";
    process.env.GOOGLE_MERCHANT_PRODUCTION_SYNC_APPROVAL_REFERENCE = "TBD";

    expect(() => loadConfig()).toThrow(
      "GOOGLE_MERCHANT_PRODUCTION_SYNC_APPROVAL_REFERENCE must point to a real external evidence record, not a placeholder.",
    );
  });

  it("loads Google Merchant config for live sync with a recorded production sync approval reference", () => {
    process.env.DATABASE_URL = "postgresql://localhost/chase_sets";
    process.env.GOOGLE_MERCHANT_SYNC_ENABLED = "true";
    process.env.GOOGLE_MERCHANT_DRY_RUN = "false";
    process.env.GOOGLE_MERCHANT_ACCOUNT_ID = "123456";
    process.env.GOOGLE_MERCHANT_API_DATA_SOURCE_ID = "7890";
    process.env.GOOGLE_MERCHANT_TARGET_COUNTRY = "US";
    process.env.GOOGLE_MERCHANT_CONTENT_LANGUAGE = "en";
    process.env.GOOGLE_MERCHANT_FEED_LABEL = "US";
    process.env.GOOGLE_MERCHANT_CREDENTIAL_SECRET_NAME = "google-merchant-service-account";
    process.env.GOOGLE_MERCHANT_PRODUCTION_SYNC_APPROVAL_REFERENCE = "GOOGLE-SHOPPING-SYNC-APPROVAL-2026-06-04";

    expect(loadConfig().googleMerchant).toEqual({
      syncEnabled: true,
      dryRun: false,
      merchantAccountId: "123456",
      apiDataSourceId: "7890",
      targetCountry: "US",
      contentLanguage: "en",
      feedLabel: "US",
      credentialSecretName: "google-merchant-service-account",
      productionSyncApprovalReference: "GOOGLE-SHOPPING-SYNC-APPROVAL-2026-06-04",
    });
  });

  it("loads TCGplayer automation config from environment without requiring local-only secrets", () => {
    process.env.DATABASE_URL = "postgresql://localhost/chase_sets";
    process.env.TCGPLAYER_AUTOMATION_TCG_AUTH_COOKIE = "fixture-cookie-value";
    process.env.TCGPLAYER_AUTOMATION_USER_AGENT = "Chase Sets staging provider proof";
    process.env.TCGPLAYER_AUTOMATION_DOMAIN_CONFIG_JSON = JSON.stringify({
      mpSearchApi: { requestDelayMs: 500, maxConcurrentRequests: 1 },
    });

    const config = loadConfig().tcgplayerAutomation;

    expect(config).toMatchObject({
      auth: {
        tcgAuthCookie: "fixture-cookie-value",
        userAgent: "Chase Sets staging provider proof",
      },
      domainConfigs: {
        mpSearchApi: expect.objectContaining({
          requestDelayMs: 500,
          rateLimitCooldownMs: 30_000,
          maxConcurrentRequests: 1,
        }),
        mpApi: expect.objectContaining({
          requestDelayMs: 250,
          maxConcurrentRequests: 2,
        }),
      },
      maxRetries: 3,
    });
  });

  it("redacts TCGplayer automation credentials from log descriptions", () => {
    process.env.DATABASE_URL = "postgresql://localhost/chase_sets";
    process.env.TCGPLAYER_AUTOMATION_TCG_AUTH_COOKIE = "fixture-cookie-value";

    const description = describeTcgplayerAutomationConfigForLogs(loadConfig().tcgplayerAutomation);

    expect(description).toMatchObject({
      configured: true,
      auth: {
        tcgAuthCookie: "[configured]",
        userAgent: "[configured]",
      },
    });
    expect(JSON.stringify(description)).not.toMatch(/fixture-cookie-value|TCGAuthTicket|fixture-cookie-value/i);
  });

  it("rejects malformed TCGplayer domain config instead of silently weakening provider budgets", () => {
    process.env.DATABASE_URL = "postgresql://localhost/chase_sets";
    process.env.TCGPLAYER_AUTOMATION_TCG_AUTH_COOKIE = "fixture-cookie-value";
    process.env.TCGPLAYER_AUTOMATION_DOMAIN_CONFIG_JSON = JSON.stringify({
      unknownDomain: { requestDelayMs: 0 },
    });

    expect(() => loadConfig()).toThrow(
      "TCGPLAYER_AUTOMATION_DOMAIN_CONFIG_JSON contains unsupported domain 'unknownDomain'.",
    );
  });

  it("redacts Google Merchant credential references from log descriptions", () => {
    const description = describeGoogleMerchantConfigForLogs({
      syncEnabled: true,
      dryRun: false,
      merchantAccountId: "123456",
      apiDataSourceId: "7890",
      targetCountry: "US",
      contentLanguage: "en",
      feedLabel: "US",
      credentialSecretName: "google-merchant-service-account",
      productionSyncApprovalReference: "GOOGLE-SHOPPING-SYNC-APPROVAL-2026-06-04",
    });

    expect(description).toEqual({
      syncEnabled: true,
      dryRun: false,
      merchantAccountId: "123456",
      apiDataSourceId: "7890",
      targetCountry: "US",
      contentLanguage: "en",
      feedLabel: "US",
      credentialSecretName: "[configured]",
      productionSyncApprovalReference: "GOOGLE-SHOPPING-SYNC-APPROVAL-2026-06-04",
    });
  });

  it("loads S3 Catalog asset storage for worker-hosted promotion jobs", () => {
    process.env.DATABASE_URL = "postgresql://localhost/chase_sets";
    process.env.CATALOG_ASSET_STORAGE_KIND = "s3";
    process.env.CATALOG_ASSET_S3_BUCKET = "catalog-assets";
    process.env.CATALOG_ASSET_S3_REGION = "nyc3";
    process.env.CATALOG_ASSET_S3_ENDPOINT = "https://nyc3.digitaloceanspaces.com";
    process.env.CATALOG_ASSET_PUBLIC_BASE_URL = "https://assets.chasesets.test";
    process.env.CATALOG_ASSET_S3_ACCESS_KEY_ID = "spaces-key";
    process.env.CATALOG_ASSET_S3_SECRET_ACCESS_KEY = "spaces-secret";

    expect(loadConfig().catalogAssetStorage).toEqual({
      kind: "s3",
      bucket: "catalog-assets",
      region: "nyc3",
      endpoint: "https://nyc3.digitaloceanspaces.com",
      publicBaseUrl: "https://assets.chasesets.test",
      accessKeyId: "spaces-key",
      secretAccessKey: "spaces-secret",
      forcePathStyle: false,
    });
  });

  it("matches the pre-extraction shared config shape for a representative environment", () => {
    process.env.DATABASE_URL = "postgresql://localhost/chase_sets";
    process.env.DATABASE_POOL_MAX = "18";
    process.env.DATABASE_POOL_IDLE_TIMEOUT_MS = "45000";
    process.env.DATABASE_POOL_CONNECTION_TIMEOUT_MS = "7000";
    process.env.STRIPE_SECRET_KEY = "sk_test_shared";
    process.env.STRIPE_PUBLISHABLE_KEY = "pk_test_shared";
    process.env.STRIPE_WEBHOOK_SECRET = "whsec_shared";
    process.env.STRIPE_WEBHOOK_SECRET_PREVIOUS = "whsec_previous_shared";
    process.env.STRIPE_CONNECT_WEBHOOK_SECRET = "whsec_connect_shared";
    process.env.STRIPE_CONNECT_WEBHOOK_SECRET_PREVIOUS = "whsec_connect_previous_shared";
    process.env.STRIPE_API_BASE_URL = "https://stripe.shared.test";
    process.env.EASYPOST_API_KEY = "EZAK_shared";
    process.env.EASYPOST_API_BASE_URL = "https://api.easypost.shared.test/v2";
    process.env.EASYPOST_MODE = "production";
    process.env.PAYMENT_RECONCILIATION_INTERVAL_MS = "600000";
    process.env.PAYMENT_DEADLINE_SWEEP_INTERVAL_MS = "120000";
    process.env.SELLER_FUNDS_RELEASE_INTERVAL_MS = "900000";
    process.env.PAYOUT_RECONCILIATION_INTERVAL_MS = "1200000";
    process.env.CATALOG_ASSET_STORAGE_KIND = "s3";
    process.env.CATALOG_ASSET_S3_BUCKET = "catalog-assets";
    process.env.CATALOG_ASSET_S3_REGION = "nyc3";
    process.env.CATALOG_ASSET_S3_ENDPOINT = "https://nyc3.digitaloceanspaces.com";
    process.env.CATALOG_ASSET_PUBLIC_BASE_URL = "https://assets.chasesets.test";
    process.env.CATALOG_ASSET_S3_ACCESS_KEY_ID = "spaces-key";
    process.env.CATALOG_ASSET_S3_SECRET_ACCESS_KEY = "spaces-secret";
    process.env.CATALOG_ASSET_S3_FORCE_PATH_STYLE = "true";

    const config = loadConfig();

    expect({
      pool: config.pool,
      catalogAssetStorage: config.catalogAssetStorage,
      paymentProcessor: config.paymentProcessor,
      moneyMovement: config.moneyMovement,
      postage: config.postage,
      paymentReconciliationIntervalMs: config.paymentReconciliationIntervalMs,
      paymentDeadlineSweepIntervalMs: config.paymentDeadlineSweepIntervalMs,
      sellerFundsReleaseIntervalMs: config.sellerFundsReleaseIntervalMs,
      payoutReconciliationIntervalMs: config.payoutReconciliationIntervalMs,
    }).toEqual({
      pool: {
        max: 18,
        idleTimeoutMillis: 45_000,
        connectionTimeoutMillis: 7_000,
        idleInTransactionSessionTimeoutMillis: undefined,
      },
      catalogAssetStorage: {
        kind: "s3",
        bucket: "catalog-assets",
        region: "nyc3",
        publicBaseUrl: "https://assets.chasesets.test",
        endpoint: "https://nyc3.digitaloceanspaces.com",
        accessKeyId: "spaces-key",
        secretAccessKey: "spaces-secret",
        forcePathStyle: true,
      },
      paymentProcessor: {
        kind: "stripe",
        secretKey: "sk_test_shared",
        publishableKey: "pk_test_shared",
        webhookSecret: "whsec_shared",
        previousWebhookSecrets: ["whsec_previous_shared"],
        apiBaseUrl: "https://stripe.shared.test",
      },
      moneyMovement: {
        kind: "stripe",
        secretKey: "sk_test_shared",
        webhookSecret: "whsec_connect_shared",
        previousWebhookSecrets: ["whsec_connect_previous_shared"],
        connectAccountsApi: "v2",
        apiBaseUrl: "https://stripe.shared.test",
      },
      postage: {
        kind: "easypost",
        apiKey: "EZAK_shared",
        apiBaseUrl: "https://api.easypost.shared.test/v2",
        mode: "production",
      },
      paymentReconciliationIntervalMs: 600_000,
      paymentDeadlineSweepIntervalMs: 120_000,
      sellerFundsReleaseIntervalMs: 900_000,
      payoutReconciliationIntervalMs: 1_200_000,
    });
  });

  it("keeps default runner concurrency within shared-resource capacity", () => {
    process.env.DATABASE_URL = "postgresql://localhost/chase_sets";

    expect(loadConfig()).toMatchObject({
      maxConcurrentRunners: 4,
      projectionMaxConcurrentRunners: 2,
      jobMaxConcurrentRunners: 1,
      dispatchMaxConcurrentRunners: 1,
      scheduledMaxConcurrentRunners: 1,
      sourceObservationBulkJobLaneCount: 1,
      sourceObservationBulkJobWorkflowMaxActiveClaims: 1,
      sourceObservationBulkJobMaxActiveClaimsPerJob: 1,
      catalogAuthoringBulkJobLaneCount: 1,
      catalogAuthoringBulkJobWorkflowMaxActiveClaims: 1,
      catalogAuthoringBulkJobMaxActiveClaimsPerJob: 1,
      sourceObservationIntegrationJobLaneCount: 1,
      sourceObservationIntegrationJobWorkflowMaxActiveClaims: 1,
      sourceObservationIntegrationJobMaxActiveClaimsPerJob: 1,
      inventoryImportBatchJobLaneCount: 1,
      inventoryImportBatchJobMaxConcurrentRunners: 1,
      inventoryImportBatchJobWorkflowMaxActiveClaims: 1,
      inventoryImportBatchJobMaxActiveClaimsPerJob: 1,
      pricingRecommendationJobLaneCount: 1,
      pricingRecommendationJobWorkflowMaxActiveClaims: 1,
      pricingRecommendationJobMaxActiveClaimsPerJob: 1,
      settlementPayoutReconciliationJobLaneCount: 1,
      settlementPayoutReconciliationJobWorkflowMaxActiveClaims: 1,
      settlementPayoutReconciliationJobMaxActiveClaimsPerJob: 1,
      googleShoppingMaintenanceIntervalMs: 86_400_000,
      googleShoppingMaintenanceBatchSize: 100,
      googleShoppingRefreshWindowDays: 25,
      googleShoppingDiagnosticsIntervalMs: 86_400_000,
      googleShoppingDiagnosticsBatchSize: 100,
      googleShoppingDiagnosticsPreviousIssueChunkSize: 100,
    });
  });

  it("allows explicit runner concurrency overrides", () => {
    process.env.DATABASE_URL = "postgresql://localhost/chase_sets";
    process.env.WORKER_PROJECTION_MAX_CONCURRENT_RUNNERS = "6";
    process.env.WORKER_JOB_MAX_CONCURRENT_RUNNERS = "3";
    process.env.WORKER_DISPATCH_MAX_CONCURRENT_RUNNERS = "2";
    process.env.WORKER_SCHEDULED_MAX_CONCURRENT_RUNNERS = "2";
    process.env.SOURCE_OBSERVATION_BULK_JOB_LANE_COUNT = "4";
    process.env.SOURCE_OBSERVATION_BULK_JOB_WORKFLOW_MAX_ACTIVE_CLAIMS = "4";
    process.env.SOURCE_OBSERVATION_BULK_JOB_MAX_ACTIVE_CLAIMS_PER_JOB = "2";
    process.env.CATALOG_AUTHORING_BULK_JOB_LANE_COUNT = "3";
    process.env.CATALOG_AUTHORING_BULK_JOB_WORKFLOW_MAX_ACTIVE_CLAIMS = "3";
    process.env.CATALOG_AUTHORING_BULK_JOB_MAX_ACTIVE_CLAIMS_PER_JOB = "2";
    process.env.SOURCE_OBSERVATION_INTEGRATION_JOB_LANE_COUNT = "4";
    process.env.SOURCE_OBSERVATION_INTEGRATION_JOB_WORKFLOW_MAX_ACTIVE_CLAIMS = "4";
    process.env.SOURCE_OBSERVATION_INTEGRATION_JOB_MAX_ACTIVE_CLAIMS_PER_JOB = "2";
    process.env.INVENTORY_IMPORT_BATCH_JOB_LANE_COUNT = "4";
    process.env.INVENTORY_IMPORT_BATCH_JOB_MAX_CONCURRENT_RUNNERS = "2";
    process.env.INVENTORY_IMPORT_BATCH_JOB_WORKFLOW_MAX_ACTIVE_CLAIMS = "4";
    process.env.INVENTORY_IMPORT_BATCH_JOB_MAX_ACTIVE_CLAIMS_PER_JOB = "2";
    process.env.PRICING_RECOMMENDATION_JOB_LANE_COUNT = "3";
    process.env.PRICING_RECOMMENDATION_JOB_WORKFLOW_MAX_ACTIVE_CLAIMS = "3";
    process.env.PRICING_RECOMMENDATION_JOB_MAX_ACTIVE_CLAIMS_PER_JOB = "2";
    process.env.SETTLEMENT_PAYOUT_RECONCILIATION_JOB_LANE_COUNT = "2";
    process.env.SETTLEMENT_PAYOUT_RECONCILIATION_JOB_WORKFLOW_MAX_ACTIVE_CLAIMS = "2";
    process.env.SETTLEMENT_PAYOUT_RECONCILIATION_JOB_MAX_ACTIVE_CLAIMS_PER_JOB = "1";
    process.env.GOOGLE_SHOPPING_MAINTENANCE_INTERVAL_MS = "3600000";
    process.env.GOOGLE_SHOPPING_MAINTENANCE_BATCH_SIZE = "250";
    process.env.GOOGLE_SHOPPING_REFRESH_WINDOW_DAYS = "20";
    process.env.GOOGLE_SHOPPING_DIAGNOSTICS_INTERVAL_MS = "7200000";
    process.env.GOOGLE_SHOPPING_DIAGNOSTICS_BATCH_SIZE = "150";
    process.env.GOOGLE_SHOPPING_DIAGNOSTICS_PREVIOUS_ISSUE_CHUNK_SIZE = "75";

    expect(loadConfig()).toMatchObject({
      projectionMaxConcurrentRunners: 6,
      jobMaxConcurrentRunners: 3,
      dispatchMaxConcurrentRunners: 2,
      scheduledMaxConcurrentRunners: 2,
      sourceObservationBulkJobLaneCount: 4,
      sourceObservationBulkJobWorkflowMaxActiveClaims: 4,
      sourceObservationBulkJobMaxActiveClaimsPerJob: 2,
      catalogAuthoringBulkJobLaneCount: 3,
      catalogAuthoringBulkJobWorkflowMaxActiveClaims: 3,
      catalogAuthoringBulkJobMaxActiveClaimsPerJob: 2,
      sourceObservationIntegrationJobLaneCount: 4,
      sourceObservationIntegrationJobWorkflowMaxActiveClaims: 4,
      sourceObservationIntegrationJobMaxActiveClaimsPerJob: 2,
      inventoryImportBatchJobLaneCount: 4,
      inventoryImportBatchJobMaxConcurrentRunners: 2,
      inventoryImportBatchJobWorkflowMaxActiveClaims: 4,
      inventoryImportBatchJobMaxActiveClaimsPerJob: 2,
      pricingRecommendationJobLaneCount: 3,
      pricingRecommendationJobWorkflowMaxActiveClaims: 3,
      pricingRecommendationJobMaxActiveClaimsPerJob: 2,
      settlementPayoutReconciliationJobLaneCount: 2,
      settlementPayoutReconciliationJobWorkflowMaxActiveClaims: 2,
      settlementPayoutReconciliationJobMaxActiveClaimsPerJob: 1,
      googleShoppingMaintenanceIntervalMs: 3_600_000,
      googleShoppingMaintenanceBatchSize: 250,
      googleShoppingRefreshWindowDays: 20,
      googleShoppingDiagnosticsIntervalMs: 7_200_000,
      googleShoppingDiagnosticsBatchSize: 150,
      googleShoppingDiagnosticsPreviousIssueChunkSize: 75,
    });
  });

  it("defaults projection wake controls to fully enabled", () => {
    process.env.DATABASE_URL = "postgresql://localhost/chase_sets";

    const config = loadConfig();

    expect(config.projectionWakeScheduler).toMatchObject({
      enabled: true,
      pushDispatchEnabled: true,
      hotLaneRunnerCount: 1,
      standardLaneRunnerCount: 1,
      bulkLaneRunnerCount: 1,
      statementTimeoutMs: 30_000,
    });
    expect(config.projectionWakeRelay.enabled).toBe(true);
    expect(config.projectionWakeDisabledProjections).toEqual([]);
  });

  it("loads the wake push dispatch kill switch without disabling wake polling", () => {
    process.env.DATABASE_URL = "postgresql://localhost/chase_sets";
    process.env.WORKER_WAKE_PUSH_DISPATCH_ENABLED = "false";

    const config = loadConfig();

    expect(config.projectionWakeScheduler.enabled).toBe(true);
    expect(config.projectionWakeScheduler.pushDispatchEnabled).toBe(false);
    expect(config.projectionWakeScheduler.pollIntervalMs).toBe(1_000);
  });

  it("loads the wake scheduler statement timeout", () => {
    process.env.DATABASE_URL = "postgresql://localhost/chase_sets";
    process.env.WORKER_WAKE_STATEMENT_TIMEOUT_MS = "45000";

    expect(loadConfig().projectionWakeScheduler.statementTimeoutMs).toBe(45_000);
  });

  it("disables a single wake priority lane with a zero runner count", () => {
    process.env.DATABASE_URL = "postgresql://localhost/chase_sets";
    process.env.WORKER_WAKE_HOT_LANE_RUNNER_COUNT = "0";

    const config = loadConfig();

    expect(config.projectionWakeScheduler).toMatchObject({
      enabled: true,
      hotLaneRunnerCount: 0,
      standardLaneRunnerCount: 1,
      bulkLaneRunnerCount: 1,
    });
  });

  it("keeps lane runner counts at their defaults for empty or invalid values", () => {
    process.env.DATABASE_URL = "postgresql://localhost/chase_sets";
    process.env.WORKER_WAKE_HOT_LANE_RUNNER_COUNT = " ";
    process.env.WORKER_WAKE_STANDARD_LANE_RUNNER_COUNT = "zero";
    process.env.WORKER_WAKE_BULK_LANE_RUNNER_COUNT = "-2";

    expect(loadConfig().projectionWakeScheduler).toMatchObject({
      hotLaneRunnerCount: 1,
      standardLaneRunnerCount: 1,
      bulkLaneRunnerCount: 1,
    });
  });

  it("parses, trims, dedupes, and sorts disabled wake projection keys", () => {
    process.env.DATABASE_URL = "postgresql://localhost/chase_sets";
    process.env.WORKER_WAKE_DISABLED_PROJECTIONS =
      " marketplace:marketplace-offer-projection , checkout:checkout.cart-projection ,checkout:checkout.cart-projection,";

    expect(loadConfig().projectionWakeDisabledProjections).toEqual([
      "checkout:checkout.cart-projection",
      "marketplace:marketplace-offer-projection",
    ]);
  });

  it("rejects malformed disabled wake projection keys instead of ignoring them", () => {
    process.env.DATABASE_URL = "postgresql://localhost/chase_sets";
    process.env.WORKER_WAKE_DISABLED_PROJECTIONS = "checkout-cart-projection";

    expect(() => loadConfig()).toThrow(
      "WORKER_WAKE_DISABLED_PROJECTIONS entries must use the form <target-context>:<projection-name>, got 'checkout-cart-projection'.",
    );
  });

  it("loads Twilio mobile messaging configuration when enabled", () => {
    process.env.DATABASE_URL = "postgresql://localhost/chase_sets";
    process.env.MOBILE_MESSAGING_PROVIDER = "twilio";
    process.env.TWILIO_ACCOUNT_SID = "AC123";
    process.env.TWILIO_AUTH_TOKEN = "secret";
    process.env.TWILIO_MESSAGING_SERVICE_SID = "MG123";
    process.env.TWILIO_API_BASE_URL = "https://twilio.test";
    process.env.TWILIO_STATUS_CALLBACK_BASE_URL =
      "https://api.chasesets.test/api/notifications/provider/mobile-messaging/webhooks";

    expect(loadConfig().mobileMessaging).toEqual({
      kind: "twilio",
      accountSid: "AC123",
      authToken: "secret",
      messagingServiceSid: "MG123",
      apiBaseUrl: "https://twilio.test",
      statusCallbackBaseUrl: "https://api.chasesets.test/api/notifications/provider/mobile-messaging/webhooks",
    });
  });

  it("requires Twilio sender config when mobile messaging is enabled", () => {
    process.env.DATABASE_URL = "postgresql://localhost/chase_sets";
    process.env.MOBILE_MESSAGING_PROVIDER = "twilio";
    process.env.TWILIO_ACCOUNT_SID = "AC123";

    expect(() => loadConfig()).toThrow(
      "TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, and TWILIO_MESSAGING_SERVICE_SID are required when MOBILE_MESSAGING_PROVIDER=twilio.",
    );
  });

  it("fails closed for invalid mobile messaging provider and boolean values", () => {
    process.env.DATABASE_URL = "postgresql://localhost/chase_sets";
    process.env.MOBILE_MESSAGING_PROVIDER = "twillio";

    expect(() => loadConfig()).toThrow("MOBILE_MESSAGING_PROVIDER must be one of: noop, twilio.");

    process.env.MOBILE_MESSAGING_PROVIDER = "noop";
    process.env.GOOGLE_MERCHANT_SYNC_ENABLED = "enabled";

    expect(() => loadConfig()).toThrow(
      "GOOGLE_MERCHANT_SYNC_ENABLED must be a boolean value: 1, true, yes, on, 0, false, no, off.",
    );
  });

  it("fails production config when Stripe provider secrets are missing", () => {
    process.env.DATABASE_URL = "postgresql://localhost/chase_sets";
    process.env.PLATFORM_CONTROL_DATABASE_URL = "postgresql://localhost/control";
    process.env.NODE_ENV = "production";

    expect(() => loadConfig()).toThrow(
      "STRIPE_SECRET_KEY, STRIPE_PUBLISHABLE_KEY, STRIPE_WEBHOOK_SECRET, and STRIPE_CONNECT_WEBHOOK_SECRET are required for platform worker payment processing and money movement in production.",
    );
  });

  it("fails production config when DEPLOYMENT_ENVIRONMENT=production without NODE_ENV=production", () => {
    process.env.DATABASE_URL = "postgresql://localhost/chase_sets";
    process.env.PLATFORM_CONTROL_DATABASE_URL = "postgresql://localhost/control";
    process.env.DEPLOYMENT_ENVIRONMENT = "production";

    expect(() => loadConfig()).toThrow(
      "STRIPE_SECRET_KEY, STRIPE_PUBLISHABLE_KEY, STRIPE_WEBHOOK_SECRET, and STRIPE_CONNECT_WEBHOOK_SECRET are required for platform worker payment processing and money movement in production.",
    );
  });

  it("does not require marketplace provider secrets in production landing profile", () => {
    process.env.CHASE_SETS_RUNTIME_PROFILE = "landing";
    process.env.DATABASE_URL = "postgresql://localhost/chase_sets";
    process.env.PLATFORM_CONTROL_DATABASE_URL = "postgresql://localhost/control";
    process.env.NODE_ENV = "production";
    process.env.CATALOG_ASSET_STORAGE_KIND = "s3";
    process.env.CATALOG_ASSET_S3_BUCKET = "catalog-assets-staging";
    process.env.CATALOG_ASSET_S3_REGION = "nyc3";
    process.env.CATALOG_ASSET_PUBLIC_BASE_URL = "https://assets.staging.chasesets.com";

    const config = loadConfig();

    expect(config.paymentProcessor).toEqual({ kind: "fake" });
    expect(config.moneyMovement).toEqual({ kind: "fake" });
    expect(config.postage).toEqual({ kind: "sandbox" });
  });

  it("fails production config when EasyPost is missing", () => {
    process.env.DATABASE_URL = "postgresql://localhost/chase_sets";
    process.env.PLATFORM_CONTROL_DATABASE_URL = "postgresql://localhost/control";
    process.env.NODE_ENV = "production";
    process.env.STRIPE_SECRET_KEY = "sk_live_123";
    process.env.STRIPE_PUBLISHABLE_KEY = "pk_live_123";
    process.env.STRIPE_WEBHOOK_SECRET = "whsec_live";
    process.env.STRIPE_CONNECT_WEBHOOK_SECRET = "whsec_connect_live";

    expect(() => loadConfig()).toThrow(
      "EASYPOST_API_KEY is required for platform worker postage label work in production.",
    );
  });

  it("does not require hosted payout setup URLs in production config", () => {
    process.env.DATABASE_URL = "postgresql://localhost/chase_sets";
    process.env.PLATFORM_CONTROL_DATABASE_URL = "postgresql://localhost/control";
    process.env.NODE_ENV = "production";
    process.env.STRIPE_SECRET_KEY = "sk_live_123";
    process.env.STRIPE_PUBLISHABLE_KEY = "pk_live_123";
    process.env.STRIPE_WEBHOOK_SECRET = "whsec_live";
    process.env.STRIPE_CONNECT_WEBHOOK_SECRET = "whsec_connect_live";
    process.env.EASYPOST_API_KEY = "EZTK_test";
    process.env.CATALOG_ASSET_STORAGE_KIND = "s3";
    process.env.CATALOG_ASSET_S3_BUCKET = "catalog-assets-staging";
    process.env.CATALOG_ASSET_S3_REGION = "nyc3";
    process.env.CATALOG_ASSET_PUBLIC_BASE_URL = "https://assets.staging.chasesets.com";

    const config = loadConfig();

    expect(config.moneyMovement).toMatchObject({ kind: "stripe" });
  });

  it("loads production provider adapters when live provider config is complete", () => {
    process.env.DATABASE_URL = "postgresql://localhost/chase_sets";
    process.env.PLATFORM_CONTROL_DATABASE_URL = "postgresql://localhost/control";
    process.env.NODE_ENV = "production";
    process.env.STRIPE_SECRET_KEY = "sk_live_123";
    process.env.STRIPE_PUBLISHABLE_KEY = "pk_live_123";
    process.env.STRIPE_WEBHOOK_SECRET = "whsec_live";
    process.env.STRIPE_CONNECT_WEBHOOK_SECRET = "whsec_connect_live";
    process.env.EASYPOST_API_KEY = "EZTK_test";
    process.env.EASYPOST_MODE = "test";
    process.env.CATALOG_ASSET_STORAGE_KIND = "s3";
    process.env.CATALOG_ASSET_S3_BUCKET = "catalog-assets-staging";
    process.env.CATALOG_ASSET_S3_REGION = "nyc3";
    process.env.CATALOG_ASSET_PUBLIC_BASE_URL = "https://assets.staging.chasesets.com";

    const config = loadConfig();

    expect(config.paymentProcessor).toMatchObject({ kind: "stripe" });
    expect(config.moneyMovement).toMatchObject({
      kind: "stripe",
      webhookSecret: "whsec_connect_live",
      connectAccountsApi: "v2",
    });
    expect(config.postage).toEqual({
      kind: "easypost",
      apiKey: "EZTK_test",
      apiBaseUrl: undefined,
      mode: "test",
    });
  });

  it("loads explicit Stripe Connect Accounts API posture", () => {
    process.env.DATABASE_URL = "postgresql://localhost/chase_sets";
    process.env.STRIPE_SECRET_KEY = "sk_test_123";
    process.env.STRIPE_WEBHOOK_SECRET = "whsec_test";
    process.env.STRIPE_CONNECT_WEBHOOK_SECRET = "whsec_connect_test";
    process.env.STRIPE_CONNECT_ACCOUNTS_API = "v1";

    expect(loadConfig().moneyMovement).toEqual({
      kind: "stripe",
      secretKey: "sk_test_123",
      webhookSecret: "whsec_connect_test",
      previousWebhookSecrets: [],
      connectAccountsApi: "v1",
      apiBaseUrl: undefined,
    });
  });

  it("fails closed for invalid Stripe Connect Accounts API posture", () => {
    process.env.DATABASE_URL = "postgresql://localhost/chase_sets";
    process.env.STRIPE_SECRET_KEY = "sk_test_123";
    process.env.STRIPE_WEBHOOK_SECRET = "whsec_test";
    process.env.STRIPE_CONNECT_WEBHOOK_SECRET = "whsec_connect_test";
    process.env.STRIPE_CONNECT_ACCOUNTS_API = "express";

    expect(() => loadConfig()).toThrow("STRIPE_CONNECT_ACCOUNTS_API must be one of: v1, v2.");
  });

  it("fails closed for invalid EasyPost mode", () => {
    process.env.DATABASE_URL = "postgresql://localhost/chase_sets";
    process.env.EASYPOST_API_KEY = "EZTK_test";
    process.env.EASYPOST_MODE = "prod";

    expect(() => loadConfig()).toThrow("EASYPOST_MODE must be one of: test, production.");
  });

  it("fails closed for invalid notification email provider", () => {
    process.env.DATABASE_URL = "postgresql://localhost/chase_sets";
    process.env.NOTIFICATION_EMAIL_PROVIDER = "ses";

    expect(() => loadConfig()).toThrow("NOTIFICATION_EMAIL_PROVIDER must be one of: noop, amazon-ses, local-capture.");
  });

  it("fails when Amazon SES email is selected without complete SES config", () => {
    process.env.DATABASE_URL = "postgresql://localhost/chase_sets";
    process.env.NOTIFICATION_EMAIL_PROVIDER = "amazon-ses";
    process.env.SES_AWS_REGION = "us-east-2";
    process.env.SES_FROM_EMAIL = "notifications@preview.chasesets.com";

    expect(() => loadConfig()).toThrow(
      "SES_AWS_REGION, SES_AWS_ACCESS_KEY_ID, SES_AWS_SECRET_ACCESS_KEY, SES_FROM_EMAIL, SES_CONFIGURATION_SET_NAME, and SES_SOURCE_ARN are required when NOTIFICATION_EMAIL_PROVIDER=amazon-ses.",
    );
  });

  it("loads Amazon SES email provider config when complete", () => {
    process.env.DATABASE_URL = "postgresql://localhost/chase_sets";
    process.env.NOTIFICATION_EMAIL_PROVIDER = "amazon-ses";
    process.env.SES_AWS_REGION = "us-east-2";
    process.env.SES_AWS_ACCESS_KEY_ID = "AKIA_TEST";
    process.env.SES_AWS_SECRET_ACCESS_KEY = "secret-test";
    process.env.SES_FROM_EMAIL = "notifications@preview.chasesets.com";
    process.env.SES_CONFIGURATION_SET_NAME = "transactional-preview";
    process.env.SES_SOURCE_ARN = "arn:aws:ses:us-east-2:812517519777:identity/preview.chasesets.com";

    const config = loadConfig();

    expect(config.notificationEmail).toEqual({
      provider: "amazon-ses",
      ses: {
        region: "us-east-2",
        accessKeyId: "AKIA_TEST",
        secretAccessKey: "secret-test",
        fromEmail: "notifications@preview.chasesets.com",
        configurationSetName: "transactional-preview",
        sourceArn: "arn:aws:ses:us-east-2:812517519777:identity/preview.chasesets.com",
      },
      localCapture: {
        filePath: "artifacts/notifications/local-email-capture.jsonl",
      },
    });
  });

  it("loads local email capture provider config", () => {
    process.env.DATABASE_URL = "postgresql://localhost/chase_sets";
    process.env.NOTIFICATION_EMAIL_PROVIDER = "local-capture";
    process.env.LOCAL_EMAIL_CAPTURE_FILE = "artifacts/test-email.jsonl";

    const config = loadConfig();

    expect(config.notificationEmail).toEqual({
      provider: "local-capture",
      ses: {
        region: undefined,
        accessKeyId: undefined,
        secretAccessKey: undefined,
        fromEmail: undefined,
        configurationSetName: undefined,
        sourceArn: undefined,
      },
      localCapture: {
        filePath: "artifacts/test-email.jsonl",
      },
    });
  });

  it("rejects local email capture in production", () => {
    process.env.DATABASE_URL = "postgresql://localhost/chase_sets";
    process.env.PLATFORM_CONTROL_DATABASE_URL = "postgresql://localhost/control";
    process.env.NODE_ENV = "production";
    process.env.STRIPE_SECRET_KEY = "sk_live_123";
    process.env.STRIPE_PUBLISHABLE_KEY = "pk_live_123";
    process.env.STRIPE_WEBHOOK_SECRET = "whsec_live";
    process.env.STRIPE_CONNECT_WEBHOOK_SECRET = "whsec_connect_live";
    process.env.EASYPOST_API_KEY = "EZTK_test";
    process.env.CATALOG_ASSET_STORAGE_KIND = "s3";
    process.env.CATALOG_ASSET_S3_BUCKET = "catalog-assets-staging";
    process.env.CATALOG_ASSET_S3_REGION = "nyc3";
    process.env.CATALOG_ASSET_PUBLIC_BASE_URL = "https://assets.staging.chasesets.com";
    process.env.NOTIFICATION_EMAIL_PROVIDER = "local-capture";

    expect(() => loadConfig()).toThrow("NOTIFICATION_EMAIL_PROVIDER=local-capture is only allowed outside production.");
  });
});
