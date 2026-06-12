import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { describeGoogleMerchantConfigForLogs, loadConfig } from "../src/config";

const envNames = [
  "DATABASE_URL",
  "PLATFORM_CONTROL_DATABASE_URL",
  "NODE_ENV",
  "PORT",
  "STRIPE_SECRET_KEY",
  "STRIPE_PUBLISHABLE_KEY",
  "STRIPE_WEBHOOK_SECRET",
  "STRIPE_CONNECT_WEBHOOK_SECRET",
  "STRIPE_API_BASE_URL",
  "STRIPE_CHECKOUT_UI_MODE",
  "STRIPE_CONNECT_RETURN_URL",
  "STRIPE_CONNECT_REFRESH_URL",
  "EASYPOST_API_KEY",
  "EASYPOST_API_BASE_URL",
  "EASYPOST_MODE",
  "GOOGLE_MERCHANT_SYNC_ENABLED",
  "GOOGLE_MERCHANT_DRY_RUN",
  "GOOGLE_MERCHANT_ACCOUNT_ID",
  "GOOGLE_MERCHANT_API_DATA_SOURCE_ID",
  "GOOGLE_MERCHANT_TARGET_COUNTRY",
  "GOOGLE_MERCHANT_CONTENT_LANGUAGE",
  "GOOGLE_MERCHANT_FEED_LABEL",
  "GOOGLE_MERCHANT_CREDENTIAL_SECRET_NAME",
  "GOOGLE_SHOPPING_MAINTENANCE_INTERVAL_MS",
  "GOOGLE_SHOPPING_MAINTENANCE_BATCH_SIZE",
  "GOOGLE_SHOPPING_REFRESH_WINDOW_DAYS",
  "GOOGLE_SHOPPING_DIAGNOSTICS_INTERVAL_MS",
  "GOOGLE_SHOPPING_DIAGNOSTICS_BATCH_SIZE",
  "GOOGLE_SHOPPING_DIAGNOSTICS_PREVIOUS_ISSUE_CHUNK_SIZE",
  "NOTIFICATION_EMAIL_PROVIDER",
  "SES_AWS_REGION",
  "SES_AWS_ACCESS_KEY_ID",
  "SES_AWS_SECRET_ACCESS_KEY",
  "SES_FROM_EMAIL",
  "SES_CONFIGURATION_SET_NAME",
  "SES_SOURCE_ARN",
  "LOCAL_EMAIL_CAPTURE_FILE",
  "MOBILE_MESSAGING_PROVIDER",
  "TWILIO_ACCOUNT_SID",
  "TWILIO_AUTH_TOKEN",
  "TWILIO_MESSAGING_SERVICE_SID",
  "TWILIO_API_BASE_URL",
  "TWILIO_STATUS_CALLBACK_BASE_URL",
  "WORKER_MAX_CONCURRENT_RUNNERS",
  "WORKER_PROJECTION_MAX_CONCURRENT_RUNNERS",
  "WORKER_JOB_MAX_CONCURRENT_RUNNERS",
  "WORKER_DISPATCH_MAX_CONCURRENT_RUNNERS",
  "WORKER_SCHEDULED_MAX_CONCURRENT_RUNNERS",
  "WORKER_PROJECTION_WAKE_SCHEDULER_ENABLED",
  "WORKER_PROJECTION_WAKE_RELAY_ENABLED",
  "WORKER_WAKE_HOT_LANE_RUNNER_COUNT",
  "WORKER_WAKE_STANDARD_LANE_RUNNER_COUNT",
  "WORKER_WAKE_BULK_LANE_RUNNER_COUNT",
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

    expect(config.paymentProcessor).toEqual({ kind: "fake" });
    expect(config.moneyMovement).toEqual({ kind: "fake" });
    expect(config.mobileMessaging).toEqual({ kind: "noop" });
    expect(config.postage).toEqual({ kind: "sandbox" });
    expect(config.googleMerchant).toEqual({ syncEnabled: false, dryRun: true });
    expect(config.catalogAssetStorage).toEqual({
      kind: "filesystem",
      rootDir: "artifacts/catalog-assets",
      publicBaseUrl: `http://localhost:${config.port}/catalog-assets`,
    });
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
    });
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
      hotLaneRunnerCount: 1,
      standardLaneRunnerCount: 1,
      bulkLaneRunnerCount: 1,
    });
    expect(config.projectionWakeRelay.enabled).toBe(true);
    expect(config.projectionWakeDisabledProjections).toEqual([]);
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

  it("fails production config when Stripe provider secrets are missing", () => {
    process.env.DATABASE_URL = "postgresql://localhost/chase_sets";
    process.env.PLATFORM_CONTROL_DATABASE_URL = "postgresql://localhost/control";
    process.env.NODE_ENV = "production";

    expect(() => loadConfig()).toThrow(
      "STRIPE_SECRET_KEY, STRIPE_PUBLISHABLE_KEY, STRIPE_WEBHOOK_SECRET, and STRIPE_CONNECT_WEBHOOK_SECRET are required for platform worker payment processing and money movement in production.",
    );
  });

  it("fails production config when EasyPost is missing", () => {
    process.env.DATABASE_URL = "postgresql://localhost/chase_sets";
    process.env.PLATFORM_CONTROL_DATABASE_URL = "postgresql://localhost/control";
    process.env.NODE_ENV = "production";
    process.env.STRIPE_SECRET_KEY = "sk_test_123";
    process.env.STRIPE_PUBLISHABLE_KEY = "pk_test_123";
    process.env.STRIPE_WEBHOOK_SECRET = "whsec_test";
    process.env.STRIPE_CONNECT_WEBHOOK_SECRET = "whsec_connect_test";

    expect(() => loadConfig()).toThrow(
      "EASYPOST_API_KEY is required for platform worker postage label work in production.",
    );
  });

  it("does not require hosted payout setup URLs in production config", () => {
    process.env.DATABASE_URL = "postgresql://localhost/chase_sets";
    process.env.PLATFORM_CONTROL_DATABASE_URL = "postgresql://localhost/control";
    process.env.NODE_ENV = "production";
    process.env.STRIPE_SECRET_KEY = "sk_test_123";
    process.env.STRIPE_PUBLISHABLE_KEY = "pk_test_123";
    process.env.STRIPE_WEBHOOK_SECRET = "whsec_test";
    process.env.STRIPE_CONNECT_WEBHOOK_SECRET = "whsec_connect_test";
    process.env.EASYPOST_API_KEY = "EZTK_test";
    process.env.CATALOG_ASSET_STORAGE_KIND = "s3";
    process.env.CATALOG_ASSET_S3_BUCKET = "catalog-assets-staging";
    process.env.CATALOG_ASSET_S3_REGION = "nyc3";
    process.env.CATALOG_ASSET_PUBLIC_BASE_URL = "https://assets.staging.chasesets.com";

    const config = loadConfig();

    expect(config.moneyMovement).toMatchObject({ kind: "stripe" });
    expect(config.moneyMovement).not.toHaveProperty("onboardingReturnUrl");
    expect(config.moneyMovement).not.toHaveProperty("onboardingRefreshUrl");
  });

  it("loads production provider adapters when staging-style provider config is complete", () => {
    process.env.DATABASE_URL = "postgresql://localhost/chase_sets";
    process.env.PLATFORM_CONTROL_DATABASE_URL = "postgresql://localhost/control";
    process.env.NODE_ENV = "production";
    process.env.STRIPE_SECRET_KEY = "sk_test_123";
    process.env.STRIPE_PUBLISHABLE_KEY = "pk_test_123";
    process.env.STRIPE_WEBHOOK_SECRET = "whsec_test";
    process.env.STRIPE_CONNECT_WEBHOOK_SECRET = "whsec_connect_test";
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
      webhookSecret: "whsec_connect_test",
    });
    expect(config.moneyMovement).not.toHaveProperty("onboardingReturnUrl");
    expect(config.moneyMovement).not.toHaveProperty("onboardingRefreshUrl");
    expect(config.postage).toEqual({
      kind: "easypost",
      apiKey: "EZTK_test",
      apiBaseUrl: undefined,
      mode: "test",
    });
  });

  it("passes through legacy hosted setup URLs when explicitly configured", () => {
    process.env.DATABASE_URL = "postgresql://localhost/chase_sets";
    process.env.STRIPE_SECRET_KEY = "sk_test_123";
    process.env.STRIPE_CONNECT_WEBHOOK_SECRET = "whsec_connect_test";
    process.env.STRIPE_CONNECT_RETURN_URL = "https://marketplace.staging.chasesets.com/account/payouts";
    process.env.STRIPE_CONNECT_REFRESH_URL = "https://marketplace.staging.chasesets.com/account/payouts/setup";

    expect(loadConfig().moneyMovement).toMatchObject({
      kind: "stripe",
      onboardingReturnUrl: "https://marketplace.staging.chasesets.com/account/payouts",
      onboardingRefreshUrl: "https://marketplace.staging.chasesets.com/account/payouts/setup",
    });
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
    process.env.STRIPE_SECRET_KEY = "sk_test_123";
    process.env.STRIPE_PUBLISHABLE_KEY = "pk_test_123";
    process.env.STRIPE_WEBHOOK_SECRET = "whsec_test";
    process.env.STRIPE_CONNECT_WEBHOOK_SECRET = "whsec_connect_test";
    process.env.EASYPOST_API_KEY = "EZTK_test";
    process.env.CATALOG_ASSET_STORAGE_KIND = "s3";
    process.env.CATALOG_ASSET_S3_BUCKET = "catalog-assets-staging";
    process.env.CATALOG_ASSET_S3_REGION = "nyc3";
    process.env.CATALOG_ASSET_PUBLIC_BASE_URL = "https://assets.staging.chasesets.com";
    process.env.NOTIFICATION_EMAIL_PROVIDER = "local-capture";

    expect(() => loadConfig()).toThrow("NOTIFICATION_EMAIL_PROVIDER=local-capture is only allowed outside production.");
  });
});
