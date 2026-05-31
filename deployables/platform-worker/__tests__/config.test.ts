import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config";

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
  "SOURCE_OBSERVATION_BULK_JOB_LANE_COUNT",
  "SOURCE_OBSERVATION_BULK_JOB_WORKFLOW_MAX_ACTIVE_CLAIMS",
  "SOURCE_OBSERVATION_BULK_JOB_MAX_ACTIVE_CLAIMS_PER_JOB",
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
    expect(config.catalogAssetStorage).toEqual({
      kind: "filesystem",
      rootDir: "artifacts/catalog-assets",
      publicBaseUrl: `http://localhost:${config.port}/catalog-assets`,
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

    expect(loadConfig()).toMatchObject({
      projectionMaxConcurrentRunners: 6,
      jobMaxConcurrentRunners: 3,
      dispatchMaxConcurrentRunners: 2,
      scheduledMaxConcurrentRunners: 2,
      sourceObservationBulkJobLaneCount: 4,
      sourceObservationBulkJobWorkflowMaxActiveClaims: 4,
      sourceObservationBulkJobMaxActiveClaimsPerJob: 2,
    });
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

  it("fails production config when Stripe Connect URLs are missing", () => {
    process.env.DATABASE_URL = "postgresql://localhost/chase_sets";
    process.env.PLATFORM_CONTROL_DATABASE_URL = "postgresql://localhost/control";
    process.env.NODE_ENV = "production";
    process.env.STRIPE_SECRET_KEY = "sk_test_123";
    process.env.STRIPE_PUBLISHABLE_KEY = "pk_test_123";
    process.env.STRIPE_WEBHOOK_SECRET = "whsec_test";
    process.env.STRIPE_CONNECT_WEBHOOK_SECRET = "whsec_connect_test";
    process.env.EASYPOST_API_KEY = "EZTK_test";

    expect(() => loadConfig()).toThrow(
      "STRIPE_CONNECT_RETURN_URL and STRIPE_CONNECT_REFRESH_URL are required for platform worker hosted payout setup in production.",
    );
  });

  it("loads production provider adapters when staging-style provider config is complete", () => {
    process.env.DATABASE_URL = "postgresql://localhost/chase_sets";
    process.env.PLATFORM_CONTROL_DATABASE_URL = "postgresql://localhost/control";
    process.env.NODE_ENV = "production";
    process.env.STRIPE_SECRET_KEY = "sk_test_123";
    process.env.STRIPE_PUBLISHABLE_KEY = "pk_test_123";
    process.env.STRIPE_WEBHOOK_SECRET = "whsec_test";
    process.env.STRIPE_CONNECT_WEBHOOK_SECRET = "whsec_connect_test";
    process.env.STRIPE_CONNECT_RETURN_URL = "https://marketplace.staging.chasesets.com/account/payouts";
    process.env.STRIPE_CONNECT_REFRESH_URL = "https://marketplace.staging.chasesets.com/account/payouts/setup";
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
      onboardingReturnUrl: "https://marketplace.staging.chasesets.com/account/payouts",
      onboardingRefreshUrl: "https://marketplace.staging.chasesets.com/account/payouts/setup",
    });
    expect(config.postage).toEqual({
      kind: "easypost",
      apiKey: "EZTK_test",
      apiBaseUrl: undefined,
      mode: "test",
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
    process.env.STRIPE_CONNECT_RETURN_URL = "https://marketplace.staging.chasesets.com/account/payouts";
    process.env.STRIPE_CONNECT_REFRESH_URL = "https://marketplace.staging.chasesets.com/account/payouts/setup";
    process.env.EASYPOST_API_KEY = "EZTK_test";
    process.env.CATALOG_ASSET_STORAGE_KIND = "s3";
    process.env.CATALOG_ASSET_S3_BUCKET = "catalog-assets-staging";
    process.env.CATALOG_ASSET_S3_REGION = "nyc3";
    process.env.CATALOG_ASSET_PUBLIC_BASE_URL = "https://assets.staging.chasesets.com";
    process.env.NOTIFICATION_EMAIL_PROVIDER = "local-capture";

    expect(() => loadConfig()).toThrow("NOTIFICATION_EMAIL_PROVIDER=local-capture is only allowed outside production.");
  });
});
