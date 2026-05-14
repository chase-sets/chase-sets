import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  PLATFORM_INTERNAL_AUTH_SECRET_ENV,
} from "@chase-sets/platform-runtime/http";
import {
  getContextDatabaseEnvName,
  loadBootstrapConfig,
  loadConfig,
} from "../src/config";
import { getApiHostContextNames } from "@chase-sets/platform-runtime/api";
import { apiContextRegistry } from "../src/generated/api-context-registry";

const envNames = [
  "DATABASE_URL",
  "PLATFORM_CONTROL_DATABASE_URL",
  ...platformApiContextNames().map((contextName) =>
    getContextDatabaseEnvName(contextName),
  ),
];

function platformApiContextNames() {
  return getApiHostContextNames(apiContextRegistry, "platform-api");
}

function resetConfigEnv() {
  for (const envName of envNames) {
    delete process.env[envName];
  }

  delete process.env.PORT;
  delete process.env.STRIPE_SECRET_KEY;
  delete process.env.STRIPE_PUBLISHABLE_KEY;
  delete process.env.STRIPE_WEBHOOK_SECRET;
  delete process.env.STRIPE_API_BASE_URL;
  delete process.env.STRIPE_CHECKOUT_UI_MODE;
  delete process.env.STRIPE_CONNECT_RETURN_URL;
  delete process.env.STRIPE_CONNECT_REFRESH_URL;
  delete process.env.EASYPOST_API_KEY;
  delete process.env.EASYPOST_API_BASE_URL;
  delete process.env.EASYPOST_MODE;
  delete process.env.GOOGLE_SOCIAL_LOGIN_CLIENT_ID;
  delete process.env.GOOGLE_SOCIAL_LOGIN_CLIENT_SECRET;
  delete process.env.FACEBOOK_SOCIAL_LOGIN_CLIENT_ID;
  delete process.env.FACEBOOK_SOCIAL_LOGIN_CLIENT_SECRET;
  delete process.env.PAYMENT_RECONCILIATION_INTERVAL_MS;
  delete process.env.PAYOUT_RECONCILIATION_INTERVAL_MS;
  delete process.env.SELLER_FUNDS_RELEASE_INTERVAL_MS;
  delete process.env.REALTIME_BATCH_SIZE;
  delete process.env.REALTIME_POLL_INTERVAL_MS;
  delete process.env.REALTIME_HEARTBEAT_INTERVAL_MS;
  delete process.env.REALTIME_RETENTION_PRUNE_INTERVAL_MS;
  delete process.env.REALTIME_BACKGROUND_MAINTENANCE_ENABLED;
  delete process.env.REALTIME_WAKE_SIGNAL_ENABLED;
  delete process.env.REALTIME_MAX_CONSECUTIVE_FULL_BATCHES;
  delete process.env.REALTIME_MAX_TOPICS_PER_STREAM;
  delete process.env.REALTIME_MAX_ACTIVE_STREAMS;
  delete process.env.REALTIME_MAX_ACTIVE_STREAMS_PER_CONNECTION_KEY;
  delete process.env.REALTIME_STREAM_LIMITER;
  delete process.env.REALTIME_REDIS_URL;
  delete process.env.REALTIME_REDIS_NAMESPACE;
  delete process.env.REALTIME_REDIS_LEASE_TTL_SECONDS;
  delete process.env.REALTIME_STREAM_LEASE_TTL_MS;
  delete process.env.REALTIME_STREAM_LEASE_RENEW_INTERVAL_MS;
  delete process.env.DATABASE_POOL_MAX;
  delete process.env.DATABASE_POOL_IDLE_TIMEOUT_MS;
  delete process.env.DATABASE_POOL_CONNECTION_TIMEOUT_MS;
  delete process.env.WRITE_CONSISTENCY_DRAIN_ENABLED;
  delete process.env.REALTIME_CURSOR_SIGNING_SECRET;
  delete process.env.REALTIME_PREVIOUS_CURSOR_SIGNING_SECRETS;
  delete process.env.NODE_ENV;
  delete process.env.DEPLOYMENT_ENVIRONMENT;
  delete process.env[PLATFORM_INTERNAL_AUTH_SECRET_ENV];
  delete process.env.PLATFORM_ADMIN_EMAIL;
  delete process.env.PLATFORM_ADMIN_PASSWORD;
  delete process.env.PLATFORM_ADMIN_DISPLAY_NAME;
  delete process.env.PLATFORM_ADMIN_ACCOUNT_NAME;
}

beforeEach(resetConfigEnv);
afterEach(resetConfigEnv);

describe("platform api config", () => {
  it("loads the shared database url", () => {
    process.env.DATABASE_URL = "postgresql://localhost/chase_sets";

    const config = loadBootstrapConfig();

    expect(config.sharedDatabaseUrl).toBe("postgresql://localhost/chase_sets");
    expect(config.controlDatabaseUrl).toBe("postgresql://localhost/chase_sets");
    expect(config.contextDatabaseUrls).toEqual({});
    expect(config.paymentReconciliationIntervalMs).toBe(300_000);
    expect(config.payoutReconciliationIntervalMs).toBe(300_000);
    expect(config.sellerFundsReleaseIntervalMs).toBe(300_000);
    expect(config.realtime).toMatchObject({
      batchSize: 100,
      pollIntervalMs: 1_000,
      heartbeatIntervalMs: 15_000,
      maxConsecutiveFullBatches: 3,
      maxTopicsPerStream: 16,
      maxActiveStreams: 1_000,
      maxActiveStreamsPerConnectionKey: 6,
    });
  });

  it("loads per-context database urls without a shared fallback", () => {
    delete process.env.DATABASE_URL;
    process.env.PLATFORM_CONTROL_DATABASE_URL = "postgresql://localhost/control";
    for (const contextName of platformApiContextNames()) {
      process.env[getContextDatabaseEnvName(contextName)] =
        `postgresql://localhost/${contextName.replaceAll("-", "_")}`;
    }

    const config = loadBootstrapConfig();

    expect(config.sharedDatabaseUrl).toBeNull();
    expect(config.controlDatabaseUrl).toBe("postgresql://localhost/control");
    expect(config.contextDatabaseUrls.auth).toBe("postgresql://localhost/auth");
    expect(config.contextDatabaseUrls.checkout).toBe("postgresql://localhost/checkout");
    expect(config.contextDatabaseUrls["commercial-terms"]).toBe(
      "postgresql://localhost/commercial_terms",
    );
    expect(config.contextDatabaseUrls.settlement).toBe("postgresql://localhost/settlement");
  });

  it("supports mixed shared and per-context database urls", () => {
    process.env.DATABASE_URL = "postgresql://localhost/shared";
    process.env.DATABASE_URL_PAYMENTS = "postgresql://localhost/payments";

    const config = loadBootstrapConfig();

    expect(config.sharedDatabaseUrl).toBe("postgresql://localhost/shared");
    expect(config.contextDatabaseUrls.payments).toBe("postgresql://localhost/payments");
  });

  it("loads platform admin bootstrap configuration", () => {
    process.env.DATABASE_URL = "postgresql://localhost/chase_sets";
    process.env.PLATFORM_ADMIN_EMAIL = "ops@chasesets.com";
    process.env.PLATFORM_ADMIN_PASSWORD = "rotate-me-before-go-live";
    process.env.PLATFORM_ADMIN_DISPLAY_NAME = "Ops Admin";
    process.env.PLATFORM_ADMIN_ACCOUNT_NAME = "Chase Sets Ops";

    expect(loadBootstrapConfig().platformAdmin).toEqual({
      email: "ops@chasesets.com",
      password: "rotate-me-before-go-live",
      displayName: "Ops Admin",
      accountName: "Chase Sets Ops",
    });
  });

  it("requires platform admin email and password together", () => {
    process.env.DATABASE_URL = "postgresql://localhost/chase_sets";
    process.env.PLATFORM_ADMIN_EMAIL = "ops@chasesets.com";

    expect(() => loadBootstrapConfig()).toThrow(
      "PLATFORM_ADMIN_EMAIL and PLATFORM_ADMIN_PASSWORD must be configured together.",
    );
  });

  it("falls back to the fake payment processor when stripe env vars are missing", () => {
    process.env.DATABASE_URL = "postgresql://localhost/chase_sets";

    expect(loadConfig().paymentProcessor).toEqual({ kind: "fake" });
    expect(loadConfig().moneyMovement).toEqual({ kind: "fake" });
  });

  it("loads Stripe Connect money movement config from Stripe env vars", () => {
    process.env.DATABASE_URL = "postgresql://localhost/chase_sets";
    process.env.STRIPE_SECRET_KEY = "sk_test";
    process.env.STRIPE_WEBHOOK_SECRET = "whsec_test";
    process.env.STRIPE_API_BASE_URL = "https://stripe.test";
    process.env.STRIPE_CONNECT_RETURN_URL = "https://example.test/return";
    process.env.STRIPE_CONNECT_REFRESH_URL = "https://example.test/refresh";

    expect(loadConfig().moneyMovement).toEqual({
      kind: "stripe",
      secretKey: "sk_test",
      webhookSecret: "whsec_test",
      apiBaseUrl: "https://stripe.test",
      onboardingReturnUrl: "https://example.test/return",
      onboardingRefreshUrl: "https://example.test/refresh",
    });
  });

  it("fails production config when Stripe payment or Connect secrets are missing", () => {
    process.env.DATABASE_URL = "postgresql://localhost/chase_sets";
    process.env.NODE_ENV = "production";
    process.env.PLATFORM_CONTROL_DATABASE_URL = "postgresql://localhost/control";

    expect(() => loadConfig()).toThrow(
      "STRIPE_SECRET_KEY, STRIPE_PUBLISHABLE_KEY, and STRIPE_WEBHOOK_SECRET are required for Stripe payment processing and Connect money movement in production.",
    );
  });

  it("fails production config when hosted payout setup URLs are missing", () => {
    process.env.DATABASE_URL = "postgresql://localhost/chase_sets";
    process.env.NODE_ENV = "production";
    process.env.PLATFORM_CONTROL_DATABASE_URL = "postgresql://localhost/control";
    process.env.STRIPE_SECRET_KEY = "sk_live_123";
    process.env.STRIPE_PUBLISHABLE_KEY = "pk_live_123";
    process.env.STRIPE_WEBHOOK_SECRET = "whsec_live";
    process.env.EASYPOST_API_KEY = "EZAK_live";

    expect(() => loadConfig()).toThrow(
      "STRIPE_CONNECT_RETURN_URL and STRIPE_CONNECT_REFRESH_URL are required for hosted payout setup in production.",
    );
  });

  it("reports Stripe go-live checks", () => {
    process.env.DATABASE_URL = "postgresql://localhost/chase_sets";
    process.env.STRIPE_SECRET_KEY = "sk_live_123";
    process.env.STRIPE_PUBLISHABLE_KEY = "pk_live_123";
    process.env.STRIPE_WEBHOOK_SECRET = "whsec_live";
    process.env.STRIPE_CONNECT_RETURN_URL = "https://example.test/return";
    process.env.STRIPE_CONNECT_REFRESH_URL = "https://example.test/refresh";

    expect(loadConfig().stripeGoLive).toMatchObject({
      apiVersion: "2026-02-25.clover",
      paymentsConfigured: true,
      connectConfigured: true,
      onboardingUrlsConfigured: true,
      fakeFallbackAllowed: true,
      liveSecretKeyLikely: true,
    });
    expect(loadConfig().stripeGoLive.requiredWebhookEvents).toContain(
      "checkout.session.completed",
    );
    expect(loadConfig().stripeGoLive.requiredWebhookEvents).toContain(
      "payment_intent.succeeded",
    );
    expect(loadConfig().stripeGoLive.requiredWebhookEvents).toContain(
      "v2.core.account[requirements].updated",
    );
    expect(loadConfig().stripeGoLive.requiredWebhookEvents).toContain("payout.failed");
  });

  it("forces Stripe adapters and disables fake fallback in production", () => {
    process.env.DATABASE_URL = "postgresql://localhost/chase_sets";
    process.env.NODE_ENV = "production";
    process.env.PLATFORM_CONTROL_DATABASE_URL = "postgresql://localhost/control";
    process.env.STRIPE_SECRET_KEY = "sk_live_123";
    process.env.STRIPE_PUBLISHABLE_KEY = "pk_live_123";
    process.env.STRIPE_WEBHOOK_SECRET = "whsec_live";
    process.env.STRIPE_CONNECT_RETURN_URL = "https://example.test/return";
    process.env.STRIPE_CONNECT_REFRESH_URL = "https://example.test/refresh";
    process.env.EASYPOST_API_KEY = "EZAK_live";
    process.env[PLATFORM_INTERNAL_AUTH_SECRET_ENV] = "internal-test-secret";

    const config = loadConfig();

    expect(config.paymentProcessor).toMatchObject({ kind: "stripe" });
    expect(config.moneyMovement).toMatchObject({ kind: "stripe" });
    expect(config.stripeGoLive).toMatchObject({
      paymentsConfigured: true,
      connectConfigured: true,
      onboardingUrlsConfigured: true,
      fakeFallbackAllowed: false,
      liveSecretKeyLikely: true,
    });
  });

  it("requires an internal auth secret in production", () => {
    process.env.DATABASE_URL = "postgresql://localhost/chase_sets";
    process.env.NODE_ENV = "production";
    process.env.PLATFORM_CONTROL_DATABASE_URL = "postgresql://localhost/control";
    process.env.STRIPE_SECRET_KEY = "sk_live_123";
    process.env.STRIPE_PUBLISHABLE_KEY = "pk_live_123";
    process.env.STRIPE_WEBHOOK_SECRET = "whsec_live";
    process.env.STRIPE_CONNECT_RETURN_URL = "https://example.test/return";
    process.env.STRIPE_CONNECT_REFRESH_URL = "https://example.test/refresh";
    process.env.EASYPOST_API_KEY = "EZAK_live";

    expect(() => loadConfig()).toThrow(
      `${PLATFORM_INTERNAL_AUTH_SECRET_ENV} is required for internal platform API capabilities in production.`,
    );
  });

  it("loads hosted Checkout fallback configuration", () => {
    process.env.DATABASE_URL = "postgresql://localhost/chase_sets";
    process.env.STRIPE_SECRET_KEY = "sk_test_123";
    process.env.STRIPE_PUBLISHABLE_KEY = "pk_test_123";
    process.env.STRIPE_WEBHOOK_SECRET = "whsec_test";
    process.env.STRIPE_CHECKOUT_UI_MODE = "hosted";

    expect(loadConfig().paymentProcessor).toMatchObject({
      kind: "stripe",
      checkoutUiMode: "hosted",
    });
  });

  it("loads social login provider credentials", () => {
    process.env.DATABASE_URL = "postgresql://localhost/chase_sets";
    process.env.GOOGLE_SOCIAL_LOGIN_CLIENT_ID = "google-client";
    process.env.GOOGLE_SOCIAL_LOGIN_CLIENT_SECRET = "google-secret";
    process.env.FACEBOOK_SOCIAL_LOGIN_CLIENT_ID = "facebook-client";
    process.env.FACEBOOK_SOCIAL_LOGIN_CLIENT_SECRET = "facebook-secret";

    expect(loadConfig().socialLogin).toEqual({
      google: {
        clientId: "google-client",
        clientSecret: "google-secret",
      },
      facebook: {
        clientId: "facebook-client",
        clientSecret: "facebook-secret",
      },
    });
  });

  it("can disable scheduled payout reconciliation", () => {
    process.env.DATABASE_URL = "postgresql://localhost/chase_sets";
    process.env.PAYOUT_RECONCILIATION_INTERVAL_MS = "0";

    expect(loadConfig().payoutReconciliationIntervalMs).toBeNull();
  });

  it("loads realtime tuning from environment variables", () => {
    process.env.DATABASE_URL = "postgresql://localhost/chase_sets";
    process.env.REALTIME_BATCH_SIZE = "25";
    process.env.REALTIME_POLL_INTERVAL_MS = "250";
    process.env.REALTIME_HEARTBEAT_INTERVAL_MS = "5000";
    process.env.REALTIME_RETENTION_PRUNE_INTERVAL_MS = "120000";
    process.env.REALTIME_BACKGROUND_MAINTENANCE_ENABLED = "false";
    process.env.REALTIME_WAKE_SIGNAL_ENABLED = "false";
    process.env.REALTIME_MAX_CONSECUTIVE_FULL_BATCHES = "2";
    process.env.REALTIME_MAX_TOPICS_PER_STREAM = "8";
    process.env.REALTIME_MAX_ACTIVE_STREAMS = "200";
    process.env.REALTIME_MAX_ACTIVE_STREAMS_PER_CONNECTION_KEY = "3";
    process.env.REALTIME_CURSOR_SIGNING_SECRET = "current-secret";
    process.env.REALTIME_PREVIOUS_CURSOR_SIGNING_SECRETS = "old-secret, older-secret ";
    process.env.REALTIME_STREAM_LEASE_TTL_MS = "30000";
    process.env.REALTIME_STREAM_LEASE_RENEW_INTERVAL_MS = "10000";

    expect(loadConfig().realtime).toEqual({
      batchSize: 25,
      pollIntervalMs: 250,
      heartbeatIntervalMs: 5_000,
      retentionPruneIntervalMs: 120_000,
      backgroundMaintenanceEnabled: false,
      wakeSignalEnabled: false,
      maxConsecutiveFullBatches: 2,
      maxTopicsPerStream: 8,
      maxActiveStreams: 200,
      maxActiveStreamsPerConnectionKey: 3,
      cursorSigningSecret: "current-secret",
      previousCursorSigningSecrets: ["old-secret", "older-secret"],
      streamLimiter: {
        kind: "postgres",
        leaseTtlMs: 30_000,
        renewIntervalMs: 10_000,
      },
    });
  });

  it("rejects the local stream limiter in production", () => {
    process.env.DATABASE_URL = "postgresql://localhost/chase_sets";
    process.env.PLATFORM_CONTROL_DATABASE_URL = "postgresql://localhost/control";
    process.env.NODE_ENV = "production";
    process.env.DEPLOYMENT_ENVIRONMENT = "production";
    process.env.REALTIME_STREAM_LIMITER = "local";

    expect(() => loadConfig()).toThrow(
      "REALTIME_STREAM_LIMITER=postgres, REALTIME_WAKE_SIGNAL_ENABLED=true, and PLATFORM_CONTROL_DATABASE_URL are required for horizontally scalable SSE in production.",
    );
  });

  it("allows single-connection staging to disable postgres realtime coordination and write drains", () => {
    process.env.DATABASE_URL = "postgresql://localhost/chase_sets";
    process.env.PLATFORM_CONTROL_DATABASE_URL = "postgresql://localhost/control";
    process.env.NODE_ENV = "production";
    process.env.DEPLOYMENT_ENVIRONMENT = "staging";
    process.env.REALTIME_STREAM_LIMITER = "local";
    process.env.REALTIME_WAKE_SIGNAL_ENABLED = "false";
    process.env.REALTIME_BACKGROUND_MAINTENANCE_ENABLED = "false";
    process.env.WRITE_CONSISTENCY_DRAIN_ENABLED = "false";

    const config = loadConfig();

    expect(config.realtime.streamLimiter).toEqual({ kind: "local" });
    expect(config.realtime.wakeSignalEnabled).toBe(false);
    expect(config.realtime.backgroundMaintenanceEnabled).toBe(false);
    expect(config.writeConsistencyDrainEnabled).toBe(false);
  });
});
