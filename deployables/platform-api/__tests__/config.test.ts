import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import ts from "@chase-sets/typescript-compiler-api";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadDeploymentEnvironment, loadStripeProviderConfig } from "@chase-sets/platform-runtime/config-schema";
import { PLATFORM_INTERNAL_AUTH_SECRET_ENV } from "@chase-sets/platform-runtime/http";
import { DEFAULT_UCP_SIGNATURE_CREATED_FRESHNESS_WINDOW_MS } from "@chase-sets/platform-runtime/ucp";
import { STRIPE_API_VERSION } from "@chase-sets/stripe-config";
import {
  getContextDatabaseEnvName,
  getContextWaiterDatabaseEnvName,
  getPlatformApiContextsForRuntimeProfile,
  loadBootstrapConfig,
  loadConfig,
  RepresentativeCatalogProfileEnvironmentError,
} from "../src/config";
import { getApiHostContextNames } from "@chase-sets/platform-runtime/api";
import { apiContextRegistry } from "../src/generated/api-context-registry";

const loadStripeProviderConfigCallCount = vi.hoisted(() => ({ value: 0 }));

// Module-level call counter for the single shared Stripe provider load. It delegates to the real
// classifier, so every existing case keeps its exact behaviour while the call count stays observable.
vi.mock("@chase-sets/platform-runtime/config-schema", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@chase-sets/platform-runtime/config-schema")>();
  return {
    ...actual,
    loadStripeProviderConfig: (input: Parameters<typeof actual.loadStripeProviderConfig>[0]) => {
      loadStripeProviderConfigCallCount.value += 1;
      return actual.loadStripeProviderConfig(input);
    },
  };
});

const defaultCriticalReadConsistencyRouteTuning = [
  {
    mountPath: "/api/marketplace",
    routePath: "/account/cart",
    timeoutMs: 900,
    pollIntervalMs: 50,
    exactDependencyMode: "enabled",
  },
  {
    mountPath: "/api/marketplace",
    routePath: "/guest/cart",
    timeoutMs: 900,
    pollIntervalMs: 50,
    exactDependencyMode: "enabled",
  },
  {
    mountPath: "/api/marketplace",
    routePath: "/account/sell-list",
    timeoutMs: 900,
    pollIntervalMs: 50,
    exactDependencyMode: "enabled",
  },
  {
    mountPath: "/api/marketplace",
    routePath: "/account/sell-list/confirmations/:confirmationId",
    timeoutMs: 900,
    pollIntervalMs: 50,
    exactDependencyMode: "enabled",
  },
  {
    mountPath: "/api/marketplace",
    routePath: "/guest/sell-list",
    timeoutMs: 900,
    pollIntervalMs: 50,
    exactDependencyMode: "enabled",
  },
  {
    mountPath: "/api/marketplace",
    routePath: "/account/checkout-sessions/:sessionId",
    timeoutMs: 900,
    pollIntervalMs: 50,
    exactDependencyMode: "enabled",
  },
  {
    mountPath: "/api/settlement",
    routePath: "/payouts/:id",
    timeoutMs: 900,
    pollIntervalMs: 50,
    exactDependencyMode: "enabled",
  },
  {
    mountPath: "/api/settlement",
    routePath: "/payout-readiness",
    timeoutMs: 900,
    pollIntervalMs: 50,
    exactDependencyMode: "enabled",
  },
  {
    mountPath: "/api/marketplace",
    routePath: "/account/payments/:id",
    timeoutMs: 900,
    pollIntervalMs: 50,
    exactDependencyMode: "enabled",
  },
  {
    mountPath: "/api/marketplace",
    routePath: "/account/listings/:id",
    timeoutMs: 900,
    pollIntervalMs: 50,
    exactDependencyMode: "enabled",
  },
  {
    mountPath: "/api/public-presence/admin",
    routePath: "/waitlist",
    timeoutMs: 900,
    pollIntervalMs: 50,
    exactDependencyMode: "enabled",
  },
] as const;

const envNames = [
  "DATABASE_URL",
  "PLATFORM_CONTROL_DATABASE_URL",
  "PLATFORM_WORK_SIGNAL_DATABASE_URL",
  ...platformApiContextNames().map((contextName) => getContextDatabaseEnvName(contextName)),
  ...platformApiContextNames().map((contextName) => getContextWaiterDatabaseEnvName(contextName)),
];

function platformApiContextNames() {
  return getApiHostContextNames(apiContextRegistry, "platform-api");
}

function resetConfigEnv() {
  for (const envName of envNames) {
    delete process.env[envName];
  }

  delete process.env.PORT;
  delete process.env.CHASE_SETS_RUNTIME_PROFILE;
  delete process.env.STRIPE_SECRET_KEY;
  delete process.env.STRIPE_PUBLISHABLE_KEY;
  delete process.env.STRIPE_WEBHOOK_SECRET;
  delete process.env.STRIPE_WEBHOOK_SECRET_PREVIOUS;
  delete process.env.STRIPE_CONNECT_WEBHOOK_SECRET;
  delete process.env.STRIPE_CONNECT_WEBHOOK_SECRET_PREVIOUS;
  delete process.env.STRIPE_CONNECT_ACCOUNTS_API;
  delete process.env.STRIPE_API_BASE_URL;
  delete process.env.EASYPOST_API_KEY;
  delete process.env.EASYPOST_WEBHOOK_SECRET;
  delete process.env.EASYPOST_API_BASE_URL;
  delete process.env.EASYPOST_MODE;
  delete process.env.DISCOVERY_SEARCH_EMBEDDINGS;
  delete process.env.DISCOVERY_SEARCH_RESCUE;
  delete process.env.DISCOVERY_SEARCH_HYBRID;
  delete process.env.DISCOVERY_QUERY_EMBEDDING_CACHE_MAX_ENTRIES;
  delete process.env.DISCOVERY_QUERY_EMBEDDING_CACHE_TTL_MS;
  delete process.env.VOYAGE_API_KEY;
  delete process.env.VOYAGE_EMBEDDING_MODEL;
  delete process.env.VOYAGE_EMBEDDING_BATCH_SIZE;
  delete process.env.VOYAGE_EMBEDDING_TIMEOUT_MS;
  delete process.env.VOYAGE_EMBEDDING_MAX_ATTEMPTS;
  delete process.env.VOYAGE_EMBEDDING_RETRY_BACKOFF_BASE_MS;
  delete process.env.VOYAGE_EMBEDDING_RETRY_BACKOFF_MAX_MS;
  delete process.env.GOOGLE_SOCIAL_LOGIN_CLIENT_ID;
  delete process.env.GOOGLE_SOCIAL_LOGIN_CLIENT_SECRET;
  delete process.env.ADMIN_GOOGLE_WORKSPACE_HOSTED_DOMAINS;
  delete process.env.FACEBOOK_SOCIAL_LOGIN_CLIENT_ID;
  delete process.env.FACEBOOK_SOCIAL_LOGIN_CLIENT_SECRET;
  delete process.env.MOBILE_MESSAGING_PROVIDER;
  delete process.env.TWILIO_AUTH_TOKEN;
  delete process.env.TWILIO_WEBHOOK_SIGNATURE_REQUIRED;
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
  delete process.env.REALTIME_CURSOR_SIGNING_SECRET;
  delete process.env.REALTIME_PREVIOUS_CURSOR_SIGNING_SECRETS;
  delete process.env.READ_CONSISTENCY_TIMEOUT_MS;
  delete process.env.READ_CONSISTENCY_POLL_INTERVAL_MS;
  delete process.env.READ_CONSISTENCY_EXACT_DEPENDENCY_MODE;
  delete process.env.READ_CONSISTENCY_ROUTE_TUNING_JSON;
  delete process.env.READ_CONSISTENCY_WAKE_BEFORE_WAIT_ENABLED;
  delete process.env.READ_CONSISTENCY_READINESS_NOTIFICATIONS_ENABLED;
  delete process.env.NODE_ENV;
  delete process.env.DEPLOYMENT_ENVIRONMENT;
  delete process.env.PLATFORM_DATA_PROFILES;
  delete process.env.PLATFORM_PREVIEW_POSTGRES_ADMIN_URL;
  delete process.env.TAX_PROVIDER_BACKED_QUOTES_REQUIRED;
  delete process.env[PLATFORM_INTERNAL_AUTH_SECRET_ENV];
  delete process.env.PLATFORM_ADMIN_EMAIL;
  delete process.env.PLATFORM_ADMIN_PASSWORD;
  delete process.env.PLATFORM_ADMIN_DISPLAY_NAME;
  delete process.env.PLATFORM_ADMIN_ACCOUNT_NAME;
  delete process.env.ADMIN_REGISTRATION_ENABLED;
  delete process.env.REGISTRATION_ADMISSION_MODE;
  delete process.env.REGISTRATION_DISPOSABLE_EMAIL_MODE;
  delete process.env.REGISTRATION_DISPOSABLE_EMAIL_DOMAINS;
  delete process.env.CATALOG_ASSET_STORAGE_KIND;
  delete process.env.CATALOG_ASSET_LOCAL_ROOT;
  delete process.env.CATALOG_ASSET_PUBLIC_BASE_URL;
  delete process.env.CATALOG_ASSET_S3_BUCKET;
  delete process.env.CATALOG_ASSET_S3_REGION;
  delete process.env.CATALOG_ASSET_S3_ENDPOINT;
  delete process.env.CATALOG_ASSET_S3_ACCESS_KEY_ID;
  delete process.env.CATALOG_ASSET_S3_SECRET_ACCESS_KEY;
  delete process.env.CATALOG_ASSET_S3_FORCE_PATH_STYLE;
  delete process.env.MARKETPLACE_LISTING_PHOTO_STORAGE_KIND;
  delete process.env.MARKETPLACE_LISTING_PHOTO_LOCAL_ROOT;
  delete process.env.MARKETPLACE_LISTING_PHOTO_PUBLIC_BASE_URL;
  delete process.env.MARKETPLACE_LISTING_PHOTO_S3_BUCKET;
  delete process.env.MARKETPLACE_LISTING_PHOTO_S3_REGION;
  delete process.env.MARKETPLACE_LISTING_PHOTO_S3_ENDPOINT;
  delete process.env.MARKETPLACE_LISTING_PHOTO_S3_ACCESS_KEY_ID;
  delete process.env.MARKETPLACE_LISTING_PHOTO_S3_SECRET_ACCESS_KEY;
  delete process.env.MARKETPLACE_LISTING_PHOTO_S3_FORCE_PATH_STYLE;
  delete process.env.UCP_BUSINESS_SIGNING_PRIVATE_JWK;
  delete process.env.UCP_BUSINESS_SIGNING_KEY_ID;
  delete process.env.UCP_BUSINESS_SIGNING_ALG;
  delete process.env.UCP_BUSINESS_SIGNING_PREVIOUS_PUBLIC_JWKS;
  delete process.env.UCP_SIGNATURE_CREATED_FRESHNESS_WINDOW_MS;
  delete process.env.UCP_AP2_VERIFIER_URL;
  delete process.env.UCP_AP2_VERIFIER_AUTH_TOKEN;
  delete process.env.UCP_AP2_VERIFIER_TIMEOUT_MS;
  delete process.env.CHASE_SETS_RATE_LIMITS_DISABLED;
  delete process.env.CHASE_SETS_RATE_LIMIT_AUTH_REGISTER_IP_MAX;
  delete process.env.CHASE_SETS_RATE_LIMIT_AUTH_REGISTER_IP_WINDOW_MS;
  delete process.env.CHASE_SETS_RATE_LIMIT_AUTH_REGISTER_IP_DISABLED;
  delete process.env.CHASE_SETS_RATE_LIMIT_PAYMENTS_PAYMENT_CREATE_ACCOUNT_MAX;
  delete process.env.CHASE_SETS_RATE_LIMIT_PAYMENTS_PAYMENT_CREATE_ACCOUNT_WINDOW_MS;
  delete process.env.CHASE_SETS_RATE_LIMIT_PAYMENTS_PAYMENT_CREATE_ACCOUNT_DISABLED;
  delete process.env.PROJECTION_INLINE_APPLY_ENABLED;
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
    expect(config.runtimeProfile).toBe("public");
    expect(config.deploymentEnvironment).toBe("dev");
    expect(config.dataProfiles).toEqual(["critical-bootstrap", "catalog-integration-bootstrap", "scenario-seed"]);
    expect(config.realtime).toMatchObject({
      batchSize: 100,
      pollIntervalMs: 1_000,
      heartbeatIntervalMs: 15_000,
      maxConsecutiveFullBatches: 3,
      maxTopicsPerStream: 16,
      maxActiveStreams: 1_000,
      maxActiveStreamsPerConnectionKey: 6,
    });
    expect(config.readConsistency).toEqual({
      timeoutMs: 2_500,
      pollIntervalMs: 75,
      exactDependencyMode: "enabled",
      routeTuning: defaultCriticalReadConsistencyRouteTuning,
      wakeBeforeWaitEnabled: false,
      readinessNotificationsEnabled: false,
    });
    expect(config.projectionInlineApplyEnabled).toBe(false);
    expect(loadConfig().ucpSignatureCreatedFreshnessWindowMs).toBe(DEFAULT_UCP_SIGNATURE_CREATED_FRESHNESS_WINDOW_MS);
  });

  it("loads bootstrap config when rate-limit env overrides are absent", () => {
    process.env.DATABASE_URL = "postgresql://localhost/chase_sets";

    const config = loadBootstrapConfig();

    expect(config.sharedDatabaseUrl).toBe("postgresql://localhost/chase_sets");
    expect(config.runtimeProfile).toBe("public");
  });

  it("loads per-context database urls without a shared fallback", () => {
    delete process.env.DATABASE_URL;
    process.env.PLATFORM_CONTROL_DATABASE_URL = "postgresql://localhost/control";
    process.env.PLATFORM_WORK_SIGNAL_DATABASE_URL = "postgresql://localhost/control-direct";
    process.env.DATABASE_URL_CATALOG_WAITER = "postgresql://localhost/catalog-direct";
    for (const contextName of platformApiContextNames()) {
      process.env[getContextDatabaseEnvName(contextName)] =
        `postgresql://localhost/${contextName.replaceAll("-", "_")}`;
    }

    const config = loadBootstrapConfig();

    expect(config.sharedDatabaseUrl).toBeNull();
    expect(config.controlDatabaseUrl).toBe("postgresql://localhost/control");
    expect(config.workSignalDatabaseUrl).toBe("postgresql://localhost/control-direct");
    expect(config.contextWaiterDatabaseUrls?.catalog).toBe("postgresql://localhost/catalog-direct");
    expect(config.contextDatabaseUrls.auth).toBe("postgresql://localhost/auth");
    expect(config.contextDatabaseUrls.checkout).toBe("postgresql://localhost/checkout");
    expect(config.contextDatabaseUrls["commercial-terms"]).toBe("postgresql://localhost/commercial_terms");
    expect(config.contextDatabaseUrls.settlement).toBe("postgresql://localhost/settlement");
  });

  it("loads the landing runtime profile with only support-context database urls", () => {
    delete process.env.DATABASE_URL;
    process.env.CHASE_SETS_RUNTIME_PROFILE = "landing";
    process.env.PLATFORM_CONTROL_DATABASE_URL = "postgresql://localhost/control";
    for (const contextName of getPlatformApiContextsForRuntimeProfile("landing")) {
      process.env[getContextDatabaseEnvName(contextName)] =
        `postgresql://localhost/${contextName.replaceAll("-", "_")}`;
    }

    const config = loadBootstrapConfig();

    expect(config.runtimeProfile).toBe("landing");
    expect(config.contextDatabaseUrls.checkout).toBeUndefined();
    expect(config.contextDatabaseUrls.payments).toBeUndefined();
    expect(config.contextDatabaseUrls["commercial-terms"]).toBe("postgresql://localhost/commercial_terms");
    expect(config.contextDatabaseUrls.settlement).toBe("postgresql://localhost/settlement");
    expect(config.contextDatabaseUrls["public-presence"]).toBe("postgresql://localhost/public_presence");
  });

  it("loads production landing bootstrap with only landing context database urls", () => {
    delete process.env.DATABASE_URL;
    process.env.NODE_ENV = "production";
    process.env.DEPLOYMENT_ENVIRONMENT = "production";
    process.env.CHASE_SETS_RUNTIME_PROFILE = "landing";
    process.env.PLATFORM_CONTROL_DATABASE_URL = "postgresql://localhost/control";
    process.env[PLATFORM_INTERNAL_AUTH_SECRET_ENV] = "internal-test-secret";
    process.env.CATALOG_ASSET_STORAGE_KIND = "s3";
    process.env.CATALOG_ASSET_S3_BUCKET = "catalog-assets";
    process.env.CATALOG_ASSET_S3_REGION = "nyc3";
    process.env.CATALOG_ASSET_PUBLIC_BASE_URL = "https://assets.chasesets.com";

    for (const contextName of getPlatformApiContextsForRuntimeProfile("landing")) {
      process.env[getContextDatabaseEnvName(contextName)] =
        `postgresql://localhost/${contextName.replaceAll("-", "_")}`;
    }

    const config = loadBootstrapConfig();

    expect(config.deploymentEnvironment).toBe("production");
    expect(config.runtimeProfile).toBe("landing");
    expect(config.contextDatabaseUrls.auth).toBe("postgresql://localhost/auth");
    expect(config.contextDatabaseUrls.catalog).toBe("postgresql://localhost/catalog");
    expect(config.contextDatabaseUrls.ordering).toBe("postgresql://localhost/ordering");
    expect(config.contextDatabaseUrls["commercial-terms"]).toBe("postgresql://localhost/commercial_terms");
    expect(config.contextDatabaseUrls.settlement).toBe("postgresql://localhost/settlement");
    expect(config.contextDatabaseUrls.checkout).toBeUndefined();
    expect(config.contextDatabaseUrls.payments).toBeUndefined();
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

  it("loads long-lived environment data profiles for staging and production", () => {
    process.env.DATABASE_URL = "postgresql://localhost/chase_sets";
    process.env.DEPLOYMENT_ENVIRONMENT = "staging";
    process.env.CATALOG_ASSET_S3_BUCKET = "assets";
    process.env.CATALOG_ASSET_S3_REGION = "nyc3";
    process.env.CATALOG_ASSET_PUBLIC_BASE_URL = "https://assets.chasesets.test";

    expect(loadBootstrapConfig().dataProfiles).toEqual(["critical-bootstrap", "catalog-integration-bootstrap"]);

    process.env.DEPLOYMENT_ENVIRONMENT = "production";
    process.env.PLATFORM_CONTROL_DATABASE_URL = "postgresql://localhost/control";
    process.env[PLATFORM_INTERNAL_AUTH_SECRET_ENV] = "internal-test-secret";

    expect(loadBootstrapConfig().dataProfiles).toEqual(["critical-bootstrap", "catalog-integration-bootstrap"]);
  });

  it("fails closed on unknown deployment environments and normalizes allowed values", () => {
    process.env.DATABASE_URL = "postgresql://localhost/chase_sets";
    process.env.DEPLOYMENT_ENVIRONMENT = "Production";
    process.env.PLATFORM_CONTROL_DATABASE_URL = "postgresql://localhost/control";
    process.env[PLATFORM_INTERNAL_AUTH_SECRET_ENV] = "internal-test-secret";
    process.env.CATALOG_ASSET_STORAGE_KIND = "s3";
    process.env.CATALOG_ASSET_S3_BUCKET = "assets";
    process.env.CATALOG_ASSET_S3_REGION = "nyc3";
    process.env.CATALOG_ASSET_PUBLIC_BASE_URL = "https://assets.chasesets.test";

    expect(loadBootstrapConfig().deploymentEnvironment).toBe("production");

    process.env.DEPLOYMENT_ENVIRONMENT = "Preview";
    expect(loadBootstrapConfig().deploymentEnvironment).toBe("preview");

    process.env.DEPLOYMENT_ENVIRONMENT = "prod";
    expect(() => loadBootstrapConfig()).toThrow(
      "DEPLOYMENT_ENVIRONMENT must be one of: production, staging, preview, test, dev, local, remote-dev.",
    );
  });

  it("loads the preview Postgres admin URL only for preview bootstrap", () => {
    process.env.DATABASE_URL = "postgresql://localhost/chase_sets";
    process.env.DEPLOYMENT_ENVIRONMENT = "preview";
    process.env.PLATFORM_PREVIEW_POSTGRES_ADMIN_URL = "postgresql://postgres:secret@preview-postgres:5432/postgres";
    process.env.CATALOG_ASSET_S3_BUCKET = "assets";
    process.env.CATALOG_ASSET_S3_REGION = "nyc3";
    process.env.CATALOG_ASSET_PUBLIC_BASE_URL = "https://assets.chasesets.test";

    expect(loadBootstrapConfig().previewPostgresAdminUrl).toBe(
      "postgresql://postgres:secret@preview-postgres:5432/postgres",
    );

    process.env.DEPLOYMENT_ENVIRONMENT = "staging";
    expect(() => loadBootstrapConfig()).toThrow(
      "PLATFORM_PREVIEW_POSTGRES_ADMIN_URL may only be configured for preview deployments.",
    );
  });

  it("allows explicit data profile overrides", () => {
    process.env.DATABASE_URL = "postgresql://localhost/chase_sets";
    process.env.PLATFORM_DATA_PROFILES = "critical-bootstrap";

    expect(loadBootstrapConfig().dataProfiles).toEqual(["critical-bootstrap"]);

    process.env.PLATFORM_DATA_PROFILES = "scenario-seed,unknown";

    expect(() => loadBootstrapConfig()).toThrow("PLATFORM_DATA_PROFILES contains unsupported data profile 'unknown'.");
  });

  it("allows representative catalog only as an explicit request outside long-lived environments", () => {
    process.env.DATABASE_URL = "postgresql://localhost/chase_sets";
    process.env.PLATFORM_DATA_PROFILES = "representative-catalog";

    for (const environmentName of ["dev", "local", "remote-dev", "test", "preview"] as const) {
      process.env.DEPLOYMENT_ENVIRONMENT = environmentName;
      expect(loadBootstrapConfig().dataProfiles).toEqual(["representative-catalog"]);
    }

    for (const environmentName of ["staging", "production"] as const) {
      process.env.DEPLOYMENT_ENVIRONMENT = environmentName;
      if (environmentName === "production") {
        process.env.PLATFORM_CONTROL_DATABASE_URL = "postgresql://localhost/control";
        process.env[PLATFORM_INTERNAL_AUTH_SECRET_ENV] = "internal-test-secret";
      }
      expect(() => loadBootstrapConfig()).toThrow(RepresentativeCatalogProfileEnvironmentError);
      expect(() => loadBootstrapConfig()).toThrow(
        `representative-catalog is not allowed when DEPLOYMENT_ENVIRONMENT=${environmentName}.`,
      );
    }
  });

  it("allows representative commerce state only outside production", () => {
    process.env.DATABASE_URL = "postgresql://localhost/chase_sets";
    process.env.DEPLOYMENT_ENVIRONMENT = "staging";
    process.env.CATALOG_ASSET_STORAGE_KIND = "s3";
    process.env.CATALOG_ASSET_S3_BUCKET = "assets";
    process.env.CATALOG_ASSET_S3_REGION = "nyc3";
    process.env.CATALOG_ASSET_PUBLIC_BASE_URL = "https://assets.staging.chasesets.test";
    process.env.PLATFORM_DATA_PROFILES =
      "critical-bootstrap,catalog-integration-bootstrap,representative-commerce-state";

    expect(loadBootstrapConfig().dataProfiles).toEqual([
      "critical-bootstrap",
      "catalog-integration-bootstrap",
      "representative-commerce-state",
    ]);

    process.env.DEPLOYMENT_ENVIRONMENT = "production";
    process.env.PLATFORM_CONTROL_DATABASE_URL = "postgresql://localhost/control";
    process.env[PLATFORM_INTERNAL_AUTH_SECRET_ENV] = "internal-test-secret";

    expect(() => loadBootstrapConfig()).toThrow(
      "representative-commerce-state is not allowed when DEPLOYMENT_ENVIRONMENT=production.",
    );
  });

  it("allows admin-qa actor fixtures only outside production", () => {
    process.env.DATABASE_URL = "postgresql://localhost/chase_sets";
    process.env.DEPLOYMENT_ENVIRONMENT = "staging";
    process.env.CATALOG_ASSET_STORAGE_KIND = "s3";
    process.env.CATALOG_ASSET_S3_BUCKET = "assets";
    process.env.CATALOG_ASSET_S3_REGION = "nyc3";
    process.env.CATALOG_ASSET_PUBLIC_BASE_URL = "https://assets.staging.chasesets.test";
    process.env.PLATFORM_DATA_PROFILES = "critical-bootstrap,catalog-integration-bootstrap,admin-qa-actor-fixtures";

    expect(loadBootstrapConfig().dataProfiles).toEqual([
      "critical-bootstrap",
      "catalog-integration-bootstrap",
      "admin-qa-actor-fixtures",
    ]);

    process.env.DEPLOYMENT_ENVIRONMENT = "production";
    process.env.PLATFORM_CONTROL_DATABASE_URL = "postgresql://localhost/control";
    process.env[PLATFORM_INTERNAL_AUTH_SECRET_ENV] = "internal-test-secret";

    expect(() => loadBootstrapConfig()).toThrow(
      "admin-qa-actor-fixtures is not allowed when DEPLOYMENT_ENVIRONMENT=production.",
    );
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
    expect(loadConfig().mobileMessaging).toEqual({ kind: "noop" });
    expect(loadConfig().catalogAssetStorage).toEqual({
      kind: "filesystem",
      rootDir: "artifacts/catalog-assets",
      publicBaseUrl: "http://localhost:6182/catalog-assets",
    });
    expect(loadConfig().listingPhotoStorage).toEqual({
      kind: "filesystem",
      rootDir: "artifacts/marketplace-listing-photos",
      publicBaseUrl: "http://localhost:6182/marketplace-listing-photos",
    });
    expect(loadConfig().taxProviderBackedQuotesRequired).toBe(false);
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
    process.env.EASYPOST_WEBHOOK_SECRET = "whsec_easypost_shared";
    process.env.EASYPOST_API_BASE_URL = "https://api.easypost.shared.test/v2";
    process.env.EASYPOST_MODE = "production";
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
        webhookSecret: "whsec_easypost_shared",
        apiBaseUrl: "https://api.easypost.shared.test/v2",
        mode: "production",
      },
    });
  });

  it("loads the tax provider-backed quote gate from environment variables", () => {
    process.env.DATABASE_URL = "postgresql://localhost/chase_sets";
    process.env.TAX_PROVIDER_BACKED_QUOTES_REQUIRED = "true";

    expect(loadConfig().taxProviderBackedQuotesRequired).toBe(true);
  });

  it("loads S3-compatible asset storage from environment variables", () => {
    process.env.DATABASE_URL = "postgresql://localhost/chase_sets";
    process.env.CATALOG_ASSET_STORAGE_KIND = "s3";
    process.env.CATALOG_ASSET_S3_BUCKET = "catalog-assets";
    process.env.CATALOG_ASSET_S3_REGION = "nyc3";
    process.env.CATALOG_ASSET_S3_ENDPOINT = "https://nyc3.digitaloceanspaces.com";
    process.env.CATALOG_ASSET_PUBLIC_BASE_URL = "https://assets.chasesets.com";
    process.env.CATALOG_ASSET_S3_ACCESS_KEY_ID = "spaces-key";
    process.env.CATALOG_ASSET_S3_SECRET_ACCESS_KEY = "spaces-secret";
    process.env.MARKETPLACE_LISTING_PHOTO_STORAGE_KIND = "s3";
    process.env.MARKETPLACE_LISTING_PHOTO_S3_BUCKET = "listing-photos";
    process.env.MARKETPLACE_LISTING_PHOTO_S3_REGION = "nyc3";
    process.env.MARKETPLACE_LISTING_PHOTO_S3_ENDPOINT = "https://nyc3.digitaloceanspaces.com";
    process.env.MARKETPLACE_LISTING_PHOTO_PUBLIC_BASE_URL = "https://listing-photos.chasesets.com";
    process.env.MARKETPLACE_LISTING_PHOTO_S3_ACCESS_KEY_ID = "spaces-key";
    process.env.MARKETPLACE_LISTING_PHOTO_S3_SECRET_ACCESS_KEY = "spaces-secret";

    expect(loadConfig().catalogAssetStorage).toEqual({
      kind: "s3",
      bucket: "catalog-assets",
      region: "nyc3",
      endpoint: "https://nyc3.digitaloceanspaces.com",
      publicBaseUrl: "https://assets.chasesets.com",
      accessKeyId: "spaces-key",
      secretAccessKey: "spaces-secret",
      forcePathStyle: false,
    });
    expect(loadConfig().listingPhotoStorage).toEqual({
      kind: "s3",
      bucket: "listing-photos",
      region: "nyc3",
      endpoint: "https://nyc3.digitaloceanspaces.com",
      publicBaseUrl: "https://listing-photos.chasesets.com",
      accessKeyId: "spaces-key",
      secretAccessKey: "spaces-secret",
      forcePathStyle: false,
    });
  });

  it("loads Twilio SMS/RCS webhook configuration when enabled", () => {
    process.env.DATABASE_URL = "postgresql://localhost/chase_sets";
    process.env.MOBILE_MESSAGING_PROVIDER = "twilio";
    process.env.TWILIO_AUTH_TOKEN = "secret";
    process.env.TWILIO_WEBHOOK_SIGNATURE_REQUIRED = "false";

    expect(loadConfig().mobileMessaging).toEqual({
      kind: "twilio",
      authToken: "secret",
      requireWebhookSignature: false,
    });
  });

  it("requires Twilio auth token when mobile messaging webhooks are enabled", () => {
    process.env.DATABASE_URL = "postgresql://localhost/chase_sets";
    process.env.MOBILE_MESSAGING_PROVIDER = "twilio";

    expect(() => loadConfig()).toThrow("TWILIO_AUTH_TOKEN is required when MOBILE_MESSAGING_PROVIDER=twilio.");
  });

  it("fails closed for invalid mobile messaging provider and boolean values", () => {
    process.env.DATABASE_URL = "postgresql://localhost/chase_sets";
    process.env.MOBILE_MESSAGING_PROVIDER = "twillio";

    expect(() => loadConfig()).toThrow("MOBILE_MESSAGING_PROVIDER must be one of: noop, twilio.");

    process.env.MOBILE_MESSAGING_PROVIDER = "twilio";
    process.env.TWILIO_AUTH_TOKEN = "secret";
    process.env.TWILIO_WEBHOOK_SIGNATURE_REQUIRED = "required";

    expect(() => loadConfig()).toThrow(
      "TWILIO_WEBHOOK_SIGNATURE_REQUIRED must be a boolean value: 1, true, yes, on, 0, false, no, off.",
    );
  });

  it("loads Stripe Connect money movement config from Stripe env vars", () => {
    process.env.DATABASE_URL = "postgresql://localhost/chase_sets";
    process.env.STRIPE_SECRET_KEY = "sk_test_123";
    process.env.STRIPE_WEBHOOK_SECRET = "whsec_test";
    process.env.STRIPE_CONNECT_WEBHOOK_SECRET = "whsec_connect_test";
    process.env.STRIPE_API_BASE_URL = "https://stripe.test";

    expect(loadConfig().moneyMovement).toEqual({
      kind: "stripe",
      secretKey: "sk_test_123",
      webhookSecret: "whsec_connect_test",
      previousWebhookSecrets: [],
      connectAccountsApi: "v2",
      apiBaseUrl: "https://stripe.test",
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
    expect(loadConfig().stripeGoLive.requiredWebhookEvents).toContain("account.updated");
    expect(loadConfig().stripeGoLive.requiredWebhookEvents).not.toContain("v2.core.account.updated");
  });

  it("fails closed for invalid Stripe Connect Accounts API posture", () => {
    process.env.DATABASE_URL = "postgresql://localhost/chase_sets";
    process.env.STRIPE_SECRET_KEY = "sk_test_123";
    process.env.STRIPE_WEBHOOK_SECRET = "whsec_test";
    process.env.STRIPE_CONNECT_WEBHOOK_SECRET = "whsec_connect_test";
    process.env.STRIPE_CONNECT_ACCOUNTS_API = "express";

    expect(() => loadConfig()).toThrow("STRIPE_CONNECT_ACCOUNTS_API must be one of: v1, v2.");
  });

  it("fails production config when Stripe payment or Connect secrets are missing", () => {
    process.env.DATABASE_URL = "postgresql://localhost/chase_sets";
    process.env.NODE_ENV = "production";
    process.env.PLATFORM_CONTROL_DATABASE_URL = "postgresql://localhost/control";
    process.env[PLATFORM_INTERNAL_AUTH_SECRET_ENV] = "internal-test-secret";

    expect(() => loadConfig()).toThrow(
      "STRIPE_SECRET_KEY, STRIPE_PUBLISHABLE_KEY, STRIPE_WEBHOOK_SECRET, and STRIPE_CONNECT_WEBHOOK_SECRET are required for Stripe payment processing and Connect money movement in production.",
    );
  });

  it("allows production landing profile without marketplace provider secrets", () => {
    process.env.DATABASE_URL = "postgresql://localhost/chase_sets";
    process.env.NODE_ENV = "production";
    process.env.DEPLOYMENT_ENVIRONMENT = "production";
    process.env.CHASE_SETS_RUNTIME_PROFILE = "landing";
    process.env.PLATFORM_CONTROL_DATABASE_URL = "postgresql://localhost/control";
    process.env[PLATFORM_INTERNAL_AUTH_SECRET_ENV] = "internal-test-secret";
    process.env.CATALOG_ASSET_STORAGE_KIND = "s3";
    process.env.CATALOG_ASSET_S3_BUCKET = "catalog-assets";
    process.env.CATALOG_ASSET_S3_REGION = "nyc3";
    process.env.CATALOG_ASSET_PUBLIC_BASE_URL = "https://assets.chasesets.com";

    const config = loadConfig();

    expect(config.runtimeProfile).toBe("landing");
    expect(config.paymentProcessor).toEqual({ kind: "fake" });
    expect(config.moneyMovement).toEqual({ kind: "fake" });
    expect(config.postage).toEqual({ kind: "sandbox" });
    expect(config.listingPhotoStorage).toEqual({
      kind: "filesystem",
      rootDir: "artifacts/marketplace-listing-photos",
      publicBaseUrl: "http://localhost:6182/marketplace-listing-photos",
    });
    expect(config.stripeGoLive).toMatchObject({
      paymentsConfigured: false,
      connectConfigured: false,
      fakeFallbackAllowed: false,
    });
  });

  it("does not require hosted payout setup URLs in production config", () => {
    process.env.DATABASE_URL = "postgresql://localhost/chase_sets";
    process.env.NODE_ENV = "production";
    process.env.PLATFORM_CONTROL_DATABASE_URL = "postgresql://localhost/control";
    process.env.STRIPE_SECRET_KEY = "sk_live_123";
    process.env.STRIPE_PUBLISHABLE_KEY = "pk_live_123";
    process.env.STRIPE_WEBHOOK_SECRET = "whsec_live";
    process.env.STRIPE_CONNECT_WEBHOOK_SECRET = "whsec_connect_live";
    process.env.EASYPOST_API_KEY = "EZAK_live";
    process.env.EASYPOST_WEBHOOK_SECRET = "whsec_live_easypost";
    process.env[PLATFORM_INTERNAL_AUTH_SECRET_ENV] = "internal-test-secret";
    process.env.CATALOG_ASSET_STORAGE_KIND = "s3";
    process.env.CATALOG_ASSET_S3_BUCKET = "catalog-assets";
    process.env.CATALOG_ASSET_S3_REGION = "nyc3";
    process.env.CATALOG_ASSET_PUBLIC_BASE_URL = "https://assets.chasesets.com";
    process.env.MARKETPLACE_LISTING_PHOTO_STORAGE_KIND = "s3";
    process.env.MARKETPLACE_LISTING_PHOTO_S3_BUCKET = "listing-photos";
    process.env.MARKETPLACE_LISTING_PHOTO_S3_REGION = "nyc3";
    process.env.MARKETPLACE_LISTING_PHOTO_PUBLIC_BASE_URL = "https://listing-photos.chasesets.com";

    const config = loadConfig();

    expect(config.moneyMovement).toMatchObject({ kind: "stripe" });
  });

  it("reports Stripe go-live checks", () => {
    process.env.DATABASE_URL = "postgresql://localhost/chase_sets";
    process.env.STRIPE_SECRET_KEY = "sk_test_123";
    process.env.STRIPE_PUBLISHABLE_KEY = "pk_test_123";
    process.env.STRIPE_WEBHOOK_SECRET = "whsec_test";
    process.env.STRIPE_CONNECT_WEBHOOK_SECRET = "whsec_connect_test";

    expect(loadConfig().stripeGoLive).toMatchObject({
      apiVersion: STRIPE_API_VERSION,
      paymentsConfigured: true,
      connectConfigured: true,
      fakeFallbackAllowed: true,
      liveSecretKeyLikely: false,
    });
    expect(loadConfig().stripeGoLive.requiredWebhookEvents).toContain("checkout.session.completed");
    expect(loadConfig().stripeGoLive.requiredWebhookEvents).toContain("payment_intent.succeeded");
    expect(loadConfig().stripeGoLive.requiredWebhookEvents).not.toContain("shared_payment.granted_token.used");
    expect(loadConfig().stripeGoLive.requiredWebhookEvents).not.toContain("shared_payment.granted_token.deactivated");
    expect(loadConfig().stripeGoLive.requiredWebhookEvents).toContain("v2.core.account[requirements].updated");
    expect(loadConfig().stripeGoLive.requiredWebhookEvents).toContain("payout.failed");
  });

  it("rejects live Stripe keys outside production", () => {
    process.env.DATABASE_URL = "postgresql://localhost/chase_sets";
    process.env.DEPLOYMENT_ENVIRONMENT = "staging";
    process.env.STRIPE_SECRET_KEY = "sk_live_123";
    process.env.STRIPE_PUBLISHABLE_KEY = "pk_live_123";
    process.env.STRIPE_WEBHOOK_SECRET = "whsec_live";
    process.env.STRIPE_CONNECT_WEBHOOK_SECRET = "whsec_connect_live";

    expect(() => loadConfig()).toThrow(
      "STRIPE_SECRET_KEY was refused by Stripe key classification (reason=stripe-live-key-outside-production, serverKeyMode=live, serverKeyClass=standard, publishableKeyMode=live, deploymentEnvironment=staging).",
    );
  });

  it("loads EasyPost webhook configuration from environment variables", () => {
    process.env.DATABASE_URL = "postgresql://localhost/chase_sets";
    process.env.EASYPOST_API_KEY = "EZAK_test";
    process.env.EASYPOST_WEBHOOK_SECRET = "whsec_easypost";
    process.env.EASYPOST_API_BASE_URL = "https://api.easypost.test/v2";
    process.env.EASYPOST_MODE = "production";

    expect(loadConfig().postage).toEqual({
      kind: "easypost",
      apiKey: "EZAK_test",
      webhookSecret: "whsec_easypost",
      apiBaseUrl: "https://api.easypost.test/v2",
      mode: "production",
    });
  });

  it("fails closed for invalid EasyPost mode", () => {
    process.env.DATABASE_URL = "postgresql://localhost/chase_sets";
    process.env.EASYPOST_API_KEY = "EZAK_test";
    process.env.EASYPOST_MODE = "prod";

    expect(() => loadConfig()).toThrow("EASYPOST_MODE must be one of: test, production.");
  });

  it("forces Stripe adapters and disables fake fallback in production", () => {
    process.env.DATABASE_URL = "postgresql://localhost/chase_sets";
    process.env.NODE_ENV = "production";
    process.env.PLATFORM_CONTROL_DATABASE_URL = "postgresql://localhost/control";
    process.env.STRIPE_SECRET_KEY = "sk_live_123";
    process.env.STRIPE_PUBLISHABLE_KEY = "pk_live_123";
    process.env.STRIPE_WEBHOOK_SECRET = "whsec_live";
    process.env.STRIPE_CONNECT_WEBHOOK_SECRET = "whsec_connect_live";
    process.env.EASYPOST_API_KEY = "EZAK_live";
    process.env.EASYPOST_WEBHOOK_SECRET = "whsec_live_easypost";
    process.env[PLATFORM_INTERNAL_AUTH_SECRET_ENV] = "internal-test-secret";
    process.env.CATALOG_ASSET_STORAGE_KIND = "s3";
    process.env.CATALOG_ASSET_S3_BUCKET = "catalog-assets";
    process.env.CATALOG_ASSET_S3_REGION = "nyc3";
    process.env.CATALOG_ASSET_PUBLIC_BASE_URL = "https://assets.chasesets.com";
    process.env.MARKETPLACE_LISTING_PHOTO_STORAGE_KIND = "s3";
    process.env.MARKETPLACE_LISTING_PHOTO_S3_BUCKET = "listing-photos";
    process.env.MARKETPLACE_LISTING_PHOTO_S3_REGION = "nyc3";
    process.env.MARKETPLACE_LISTING_PHOTO_PUBLIC_BASE_URL = "https://listing-photos.chasesets.com";

    const config = loadConfig();

    expect(config.paymentProcessor).toMatchObject({ kind: "stripe" });
    expect(config.moneyMovement).toMatchObject({ kind: "stripe" });
    expect(config.stripeGoLive).toMatchObject({
      paymentsConfigured: true,
      connectConfigured: true,
      fakeFallbackAllowed: false,
      liveSecretKeyLikely: true,
    });
    expect(config.catalogAssetStorage).toMatchObject({
      kind: "s3",
      bucket: "catalog-assets",
      region: "nyc3",
    });
    expect(config.listingPhotoStorage).toMatchObject({
      kind: "s3",
      bucket: "listing-photos",
      region: "nyc3",
    });
  });

  it("requires EasyPost webhook verification in production", () => {
    process.env.DATABASE_URL = "postgresql://localhost/chase_sets";
    process.env.NODE_ENV = "production";
    process.env.PLATFORM_CONTROL_DATABASE_URL = "postgresql://localhost/control";
    process.env.STRIPE_SECRET_KEY = "sk_live_123";
    process.env.STRIPE_PUBLISHABLE_KEY = "pk_live_123";
    process.env.STRIPE_WEBHOOK_SECRET = "whsec_live";
    process.env.STRIPE_CONNECT_WEBHOOK_SECRET = "whsec_connect_live";
    process.env.EASYPOST_API_KEY = "EZAK_live";
    process.env[PLATFORM_INTERNAL_AUTH_SECRET_ENV] = "internal-test-secret";
    process.env.CATALOG_ASSET_STORAGE_KIND = "s3";
    process.env.CATALOG_ASSET_S3_BUCKET = "catalog-assets";
    process.env.CATALOG_ASSET_S3_REGION = "nyc3";
    process.env.CATALOG_ASSET_PUBLIC_BASE_URL = "https://assets.chasesets.com";
    process.env.MARKETPLACE_LISTING_PHOTO_STORAGE_KIND = "s3";
    process.env.MARKETPLACE_LISTING_PHOTO_S3_BUCKET = "listing-photos";
    process.env.MARKETPLACE_LISTING_PHOTO_S3_REGION = "nyc3";
    process.env.MARKETPLACE_LISTING_PHOTO_PUBLIC_BASE_URL = "https://listing-photos.chasesets.com";

    expect(() => loadConfig()).toThrow(
      "EASYPOST_WEBHOOK_SECRET is required for EasyPost webhook verification in production.",
    );
  });

  it("requires an internal auth secret in production", () => {
    process.env.DATABASE_URL = "postgresql://localhost/chase_sets";
    process.env.NODE_ENV = "production";
    process.env.PLATFORM_CONTROL_DATABASE_URL = "postgresql://localhost/control";
    process.env.STRIPE_SECRET_KEY = "sk_live_123";
    process.env.STRIPE_PUBLISHABLE_KEY = "pk_live_123";
    process.env.STRIPE_WEBHOOK_SECRET = "whsec_live";
    process.env.STRIPE_CONNECT_WEBHOOK_SECRET = "whsec_connect_live";
    process.env.EASYPOST_API_KEY = "EZAK_live";

    expect(() => loadConfig()).toThrow(
      `${PLATFORM_INTERNAL_AUTH_SECRET_ENV} is required for internal platform API capabilities in production.`,
    );
  });

  it("requires an internal auth secret for production deployment posture without NODE_ENV=production", () => {
    process.env.DATABASE_URL = "postgresql://localhost/chase_sets";
    process.env.DEPLOYMENT_ENVIRONMENT = "production";
    process.env.PLATFORM_CONTROL_DATABASE_URL = "postgresql://localhost/control";

    expect(() => loadConfig()).toThrow(
      `${PLATFORM_INTERNAL_AUTH_SECRET_ENV} is required for internal platform API capabilities in production.`,
    );
  });

  it("loads UCP business signing keys from environment variables", () => {
    process.env.DATABASE_URL = "postgresql://localhost/chase_sets";
    process.env.UCP_BUSINESS_SIGNING_KEY_ID = "merchant-2026";
    process.env.UCP_BUSINESS_SIGNING_ALG = "ES256";
    process.env.UCP_BUSINESS_SIGNING_PRIVATE_JWK = JSON.stringify({
      kty: "EC",
      crv: "P-256",
      x: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      y: "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
      d: "CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC",
    });
    process.env.UCP_BUSINESS_SIGNING_PREVIOUS_PUBLIC_JWKS = JSON.stringify([
      { kty: "EC", kid: "merchant-2025", crv: "P-256", x: "x", y: "y" },
    ]);

    expect(loadConfig().ucpBusinessSigningKeys).toMatchObject({
      current: {
        kid: "merchant-2026",
        alg: "ES256",
      },
      previousPublicJwks: [{ kid: "merchant-2025" }],
    });
  });

  it("loads the UCP signature freshness window", () => {
    process.env.DATABASE_URL = "postgresql://localhost/chase_sets";
    process.env.UCP_SIGNATURE_CREATED_FRESHNESS_WINDOW_MS = "120000";

    expect(loadConfig().ucpSignatureCreatedFreshnessWindowMs).toBe(120_000);
  });

  it("loads a complete AP2 verifier configuration", () => {
    process.env.DATABASE_URL = "postgresql://localhost/chase_sets";
    process.env.UCP_AP2_VERIFIER_URL = "https://verifier.example/verify";
    process.env.UCP_AP2_VERIFIER_AUTH_TOKEN = "verifier-secret";
    process.env.UCP_AP2_VERIFIER_TIMEOUT_MS = "2400";

    expect(loadConfig().ucpAp2Verifier).toEqual({
      endpoint: "https://verifier.example/verify",
      authorizationToken: "verifier-secret",
      timeoutMs: 2_400,
    });
  });

  it("rejects partial AP2 verifier configuration", () => {
    process.env.DATABASE_URL = "postgresql://localhost/chase_sets";
    process.env.UCP_AP2_VERIFIER_URL = "https://verifier.example/verify";

    expect(() => loadConfig()).toThrow(
      "UCP_AP2_VERIFIER_URL and UCP_AP2_VERIFIER_AUTH_TOKEN must be configured together.",
    );
  });

  it("requires HTTPS for a staging AP2 verifier", () => {
    process.env.DATABASE_URL = "postgresql://localhost/chase_sets";
    process.env.DEPLOYMENT_ENVIRONMENT = "staging";
    process.env.UCP_AP2_VERIFIER_URL = "http://verifier.example/verify";
    process.env.UCP_AP2_VERIFIER_AUTH_TOKEN = "verifier-secret";

    expect(() => loadConfig()).toThrow("UCP_AP2_VERIFIER_URL must use HTTPS in staging and production.");
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

  it("loads admin Google Workspace SSO domains when Google credentials are configured", () => {
    process.env.DATABASE_URL = "postgresql://localhost/chase_sets";
    process.env.GOOGLE_SOCIAL_LOGIN_CLIENT_ID = "google-client";
    process.env.GOOGLE_SOCIAL_LOGIN_CLIENT_SECRET = "google-secret";
    process.env.ADMIN_GOOGLE_WORKSPACE_HOSTED_DOMAINS = "ChaseSets.com, internal.chasesets.com ";

    expect(loadConfig().adminGoogleWorkspaceSso).toEqual({
      allowedHostedDomains: ["chasesets.com", "internal.chasesets.com"],
    });
  });

  it("requires Google credentials when admin Google Workspace SSO domains are configured", () => {
    process.env.DATABASE_URL = "postgresql://localhost/chase_sets";
    process.env.ADMIN_GOOGLE_WORKSPACE_HOSTED_DOMAINS = "chasesets.com";

    expect(() => loadConfig()).toThrow(
      "ADMIN_GOOGLE_WORKSPACE_HOSTED_DOMAINS requires GOOGLE_SOCIAL_LOGIN_CLIENT_ID and GOOGLE_SOCIAL_LOGIN_CLIENT_SECRET.",
    );
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

  it("loads read consistency rollout controls from environment variables", () => {
    process.env.DATABASE_URL = "postgresql://localhost/chase_sets";
    process.env.READ_CONSISTENCY_TIMEOUT_MS = "1500";
    process.env.READ_CONSISTENCY_POLL_INTERVAL_MS = "25";
    process.env.READ_CONSISTENCY_EXACT_DEPENDENCY_MODE = "target-context";
    process.env.READ_CONSISTENCY_ROUTE_TUNING_JSON = JSON.stringify([
      {
        mountPath: "/api/marketplace",
        routePath: "/account/checkout-sessions/:sessionId",
        targetContextName: "checkout",
        timeoutMs: 900,
        pollIntervalMs: 15,
        exactDependencyMode: "enabled",
      },
    ]);

    expect(loadConfig().readConsistency).toEqual({
      timeoutMs: 1_500,
      pollIntervalMs: 25,
      exactDependencyMode: "target-context",
      routeTuning: [
        ...defaultCriticalReadConsistencyRouteTuning,
        {
          mountPath: "/api/marketplace",
          routePath: "/account/checkout-sessions/:sessionId",
          targetContextName: "checkout",
          timeoutMs: 900,
          pollIntervalMs: 15,
          exactDependencyMode: "enabled",
        },
      ],
      wakeBeforeWaitEnabled: false,
      readinessNotificationsEnabled: false,
    });
  });

  it("enables read consistency wake-before-wait from its environment flag", () => {
    process.env.DATABASE_URL = "postgresql://localhost/chase_sets";
    process.env.READ_CONSISTENCY_WAKE_BEFORE_WAIT_ENABLED = "true";

    expect(loadConfig().readConsistency?.wakeBeforeWaitEnabled).toBe(true);
  });

  it("enables projection inline apply from its environment kill switch", () => {
    process.env.DATABASE_URL = "postgresql://localhost/chase_sets";
    process.env.PROJECTION_INLINE_APPLY_ENABLED = "true";

    expect(loadConfig().projectionInlineApplyEnabled).toBe(true);
  });

  it("enables read consistency readiness notifications from their environment flag", () => {
    process.env.DATABASE_URL = "postgresql://localhost/chase_sets";
    process.env.READ_CONSISTENCY_READINESS_NOTIFICATIONS_ENABLED = "true";

    expect(loadConfig().readConsistency?.readinessNotificationsEnabled).toBe(true);
  });

  it("keeps environment read consistency route tuning after critical defaults so operators can override", () => {
    process.env.DATABASE_URL = "postgresql://localhost/chase_sets";
    process.env.READ_CONSISTENCY_ROUTE_TUNING_JSON = JSON.stringify([
      {
        mountPath: "/api/marketplace",
        routePath: "/account/checkout-sessions/:sessionId",
        timeoutMs: 1200,
        pollIntervalMs: 60,
      },
    ]);

    expect(loadConfig().readConsistency?.routeTuning).toEqual([
      ...defaultCriticalReadConsistencyRouteTuning,
      {
        mountPath: "/api/marketplace",
        routePath: "/account/checkout-sessions/:sessionId",
        timeoutMs: 1200,
        pollIntervalMs: 60,
      },
    ]);
  });

  it("rejects invalid read consistency exact dependency modes", () => {
    process.env.DATABASE_URL = "postgresql://localhost/chase_sets";
    process.env.READ_CONSISTENCY_EXACT_DEPENDENCY_MODE = "off";

    expect(() => loadConfig()).toThrow("READ_CONSISTENCY_EXACT_DEPENDENCY_MODE must be enabled or target-context.");
  });

  it("rejects invalid read consistency numeric controls", () => {
    process.env.DATABASE_URL = "postgresql://localhost/chase_sets";
    process.env.READ_CONSISTENCY_TIMEOUT_MS = "0";

    expect(() => loadConfig()).toThrow("READ_CONSISTENCY_TIMEOUT_MS must be a positive number.");
  });

  it("rejects invalid read consistency route tuning", () => {
    process.env.DATABASE_URL = "postgresql://localhost/chase_sets";
    process.env.READ_CONSISTENCY_ROUTE_TUNING_JSON = JSON.stringify([
      {
        mountPath: "/api/marketplace",
        routePath: "account/checkout-sessions/:sessionId",
      },
    ]);

    expect(() => loadConfig()).toThrow(
      "READ_CONSISTENCY_ROUTE_TUNING_JSON[0].routePath must be an absolute path string.",
    );
  });

  it("rejects the local stream limiter in production", () => {
    process.env.DATABASE_URL = "postgresql://localhost/chase_sets";
    process.env.PLATFORM_CONTROL_DATABASE_URL = "postgresql://localhost/control";
    process.env.NODE_ENV = "production";
    process.env.DEPLOYMENT_ENVIRONMENT = "production";
    process.env.REALTIME_STREAM_LIMITER = "local";
    process.env[PLATFORM_INTERNAL_AUTH_SECRET_ENV] = "internal-test-secret";

    expect(() => loadConfig()).toThrow(
      "REALTIME_STREAM_LIMITER=postgres, REALTIME_WAKE_SIGNAL_ENABLED=true, and PLATFORM_CONTROL_DATABASE_URL are required for horizontally scalable SSE in production.",
    );
  });

  it("allows single-connection staging to disable postgres realtime coordination", () => {
    process.env.DATABASE_URL = "postgresql://localhost/chase_sets";
    process.env.PLATFORM_CONTROL_DATABASE_URL = "postgresql://localhost/control";
    process.env.NODE_ENV = "production";
    process.env.DEPLOYMENT_ENVIRONMENT = "staging";
    process.env.STRIPE_CONNECT_WEBHOOK_SECRET = "whsec_staging_connect_test";
    process.env.REALTIME_STREAM_LIMITER = "local";
    process.env.REALTIME_WAKE_SIGNAL_ENABLED = "false";
    process.env.REALTIME_BACKGROUND_MAINTENANCE_ENABLED = "false";

    const config = loadConfig();

    expect(config.realtime.streamLimiter).toEqual({ kind: "local" });
    expect(config.realtime.wakeSignalEnabled).toBe(false);
    expect(config.realtime.backgroundMaintenanceEnabled).toBe(false);
  });
});

// -------------------------------------------------------------------------------------------------
// Stripe key classification provenance — #6826 AC-C2, AC-C3, AC-F1 and AC-F2.
//
// These are positive, structural AST assertions with refusing default arms, not token blacklists.
// Their scope is bounded by ownership to exactly two modules read by path; their detection is by code
// shape. The repo-wide classifier inventory, the semantic detector, and every file under scripts/ and
// .github/workflows/ remain the scope of issue #6741 and are deliberately not asserted here.
//
// Every synthetic key literal below is a non-functional value and is never transmitted.
// -------------------------------------------------------------------------------------------------

const stripeProvenanceTestDirectory = dirname(fileURLToPath(import.meta.url));
const CONFIG_SCHEMA_PATH = join(
  stripeProvenanceTestDirectory,
  "../../../infrastructure/platform-runtime/config-schema.ts",
);
const PLATFORM_API_CONFIG_PATH = join(stripeProvenanceTestDirectory, "../src/config.ts");

const CONFIG_SCHEMA_SOURCE = readFileSync(CONFIG_SCHEMA_PATH, "utf8");
const PLATFORM_API_CONFIG_SOURCE = readFileSync(PLATFORM_API_CONFIG_PATH, "utf8");

const CLASSIFIER_NAME = "classifyStripeKeys";
const REFUSAL_CONSTRUCTOR_NAME = "stripeKeyRefusal";
const LOADER_NAME = "loadStripeProviderConfig";
const CLASSIFICATION_BINDING_NAME = "keyClassification";
const DEPLOYMENT_ENVIRONMENT_BINDING_NAME = "deploymentEnvironment";

const DECLARED_PREFIXES = ["sk_test_", "sk_live_", "rk_test_", "rk_live_", "pk_test_", "pk_live_"] as const;
const DECLARED_ENUM_VALUES = ["absent", "test", "live", "unknown", "standard", "restricted"] as const;
const DECLARED_REFUSAL_VARIABLES = ["STRIPE_SECRET_KEY", "STRIPE_PUBLISHABLE_KEY"] as const;
const DECLARED_DEPLOYMENT_ENVIRONMENTS = [
  "production",
  "staging",
  "preview",
  "test",
  "dev",
  "local",
  "remote-dev",
] as const;
const DECLARED_REFUSAL_REASONS = [
  "stripe-secret-key-unrecognized",
  "stripe-publishable-key-unrecognized",
  "stripe-key-mode-mismatch",
  "stripe-live-key-outside-production",
  "stripe-non-live-key-in-production",
  "stripe-restricted-key-in-production",
] as const;

/** K1 through K7 in normative order. K5 and K6 deliberately share one reason identifier. */
const EXPECTED_BRANCH_REASONS = [
  "stripe-secret-key-unrecognized",
  "stripe-publishable-key-unrecognized",
  "stripe-key-mode-mismatch",
  "stripe-live-key-outside-production",
  "stripe-non-live-key-in-production",
  "stripe-non-live-key-in-production",
  "stripe-restricted-key-in-production",
] as const;

const CLASSIFICATION_PROPERTY_NAMES = ["serverKeyMode", "serverKeyClass", "publishableKeyMode"] as const;

/** AC-F2 termination: exact named properties that intentionally retain key material. */
const RETAINING_SINK_PROPERTIES = new Set(["secretKey", "publishableKey", "paymentProcessor", "moneyMovement"]);

/** AC-F2 termination: the exact local gateway bindings a retaining object literal may terminate at. */
const DECLARED_GATEWAY_BINDINGS = new Set(["paymentProcessor", "moneyMovement"]);

/** The one declared discriminant projection off a retaining gateway binding. */
const GATEWAY_DISCRIMINANT_PROPERTY = "kind";

const STRIPE_KEY_ENVIRONMENT_NAMES = ["STRIPE_SECRET_KEY", "STRIPE_PUBLISHABLE_KEY"] as const;

function parseModule(fileName: string, sourceText: string): ts.SourceFile {
  return ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

function collectNodes<TNode extends ts.Node>(
  root: ts.Node,
  predicate: (node: ts.Node) => node is TNode,
): readonly TNode[] {
  const found: TNode[] = [];
  const visit = (node: ts.Node) => {
    if (predicate(node)) {
      found.push(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(root);
  return found;
}

type ClassifierLike = ts.FunctionDeclaration | ts.ArrowFunction | ts.FunctionExpression;

/** Resolves either the function-declaration or the arrow-const form, so style cannot change a result. */
function findFunctionLike(source: ts.SourceFile, name: string): ClassifierLike | undefined {
  const declaration = collectNodes(source, ts.isFunctionDeclaration).find((node) => node.name?.text === name);
  if (declaration) {
    return declaration;
  }

  const variable = collectNodes(source, ts.isVariableDeclaration).find(
    (node) =>
      ts.isIdentifier(node.name) &&
      node.name.text === name &&
      node.initializer !== undefined &&
      (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer)),
  );

  const initializer = variable?.initializer;
  if (initializer && (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer))) {
    return initializer;
  }

  return undefined;
}

function isInTypePosition(node: ts.Node): boolean {
  let current: ts.Node | undefined = node.parent;
  while (current) {
    if (ts.isTypeNode(current) || ts.isTypeAliasDeclaration(current) || ts.isInterfaceDeclaration(current)) {
      return true;
    }
    current = current.parent;
  }

  return false;
}

/** True only for identifiers that are value references, never declaration or member names. */
function isValueReference(node: ts.Identifier): boolean {
  const parent: ts.Node | undefined = node.parent;
  if (!parent || isInTypePosition(node)) {
    return false;
  }
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) {
    return false;
  }
  if (ts.isPropertyAssignment(parent) && parent.name === node) {
    return false;
  }
  if (ts.isParameter(parent) && parent.name === node) {
    return false;
  }
  if (ts.isVariableDeclaration(parent) && parent.name === node) {
    return false;
  }
  if (ts.isFunctionDeclaration(parent) && parent.name === node) {
    return false;
  }
  if (ts.isBindingElement(parent) && (parent.name === node || parent.propertyName === node)) {
    return false;
  }
  if (ts.isQualifiedName(parent) && parent.right === node) {
    return false;
  }
  if (ts.isImportSpecifier(parent) || ts.isExportSpecifier(parent)) {
    return false;
  }

  return true;
}

function collectBoundNames(name: ts.BindingName, into: Set<string>) {
  if (ts.isIdentifier(name)) {
    into.add(name.text);
    return;
  }

  for (const element of name.elements) {
    if (ts.isBindingElement(element)) {
      collectBoundNames(element.name, into);
    }
  }
}

/** Every identifier a function body declares, including nested and binding-pattern introductions. */
function collectDeclaredBindings(functionLike: ClassifierLike): Set<string> {
  const declared = new Set<string>();
  const body = functionLike.body;
  if (!body) {
    return declared;
  }

  for (const declaration of collectNodes(body, ts.isVariableDeclaration)) {
    collectBoundNames(declaration.name, declared);
  }
  for (const declaration of collectNodes(body, ts.isFunctionDeclaration)) {
    if (declaration.name) {
      declared.add(declaration.name.text);
    }
  }
  for (const parameter of collectNodes(body, ts.isParameter)) {
    collectBoundNames(parameter.name, declared);
  }

  return declared;
}

function parameterNames(functionLike: ClassifierLike): readonly string[] {
  const names: string[] = [];
  for (const parameter of functionLike.parameters) {
    const collected = new Set<string>();
    collectBoundNames(parameter.name, collected);
    names.push(...collected);
  }

  return names;
}

function stringLiteralsIn(root: ts.Node): readonly string[] {
  return collectNodes(root, ts.isStringLiteral).map((literal) => literal.text);
}

function isWideningAssertion(node: ts.Node): boolean {
  return ts.isAsExpression(node) || ts.isSatisfiesExpression(node) || ts.isNonNullExpression(node);
}

type StripeProvenanceRuleId =
  | "classifier-calls"
  | "classifier-positions"
  | "classifier-return"
  | "refusal-constructor"
  | "refusal-branches"
  | "return-closure"
  | "kind-totality"
  | "protected-names"
  | "identifier-resolution"
  | "callee-roles"
  | "nested-constructs"
  | "ambient-ownership"
  | "selection-determinacy"
  | "literal-source"
  | "parameter-pin"
  | "missing-config-vocabulary"
  | "provenance"
  | "single-classifier";

type StripeProvenanceReport = Readonly<Record<StripeProvenanceRuleId, readonly string[]>>;

const DECLARED_PREFIX_SET = new Set<string>(DECLARED_PREFIXES);
const DECLARED_ENUM_VALUE_SET = new Set<string>(DECLARED_ENUM_VALUES);
const CLASSIFICATION_PROPERTY_SET = new Set<string>(CLASSIFICATION_PROPERTY_NAMES);
const BRANCH_LITERAL_SET = new Set<string>([
  ...DECLARED_REFUSAL_REASONS,
  ...DECLARED_REFUSAL_VARIABLES,
  ...DECLARED_ENUM_VALUES,
  ...DECLARED_DEPLOYMENT_ENVIRONMENTS,
]);

/** Carried control (b) rule 1: every call inside the classifier is an exact declared prefix test. */
function classifierCallRule(source: ts.SourceFile): readonly string[] {
  const violations: string[] = [];
  const classifier = findFunctionLike(source, CLASSIFIER_NAME);
  if (!classifier?.body) {
    return [`${CLASSIFIER_NAME} was not found in either the declaration or the arrow-const form`];
  }

  const body = classifier.body;
  const parameters = new Set(parameterNames(classifier));
  const declared = collectDeclaredBindings(classifier);

  for (const call of collectNodes(body, ts.isCallExpression)) {
    const callee = call.expression;
    if (!ts.isPropertyAccessExpression(callee) || callee.name.text !== "startsWith") {
      violations.push(`call inside the classifier is not a startsWith test: ${call.getText(source)}`);
      continue;
    }
    if (!ts.isIdentifier(callee.expression) || !parameters.has(callee.expression.text)) {
      violations.push(`startsWith receiver is not a raw parameter: ${call.getText(source)}`);
    }
    if (call.arguments.length !== 1) {
      violations.push(`startsWith call does not take exactly one argument: ${call.getText(source)}`);
      continue;
    }
    const [argument] = call.arguments;
    if (!argument || !ts.isStringLiteral(argument) || !DECLARED_PREFIX_SET.has(argument.text)) {
      violations.push(`startsWith argument is not one of the six declared prefixes: ${call.getText(source)}`);
    }
  }

  for (const node of collectNodes(body, ts.isNewExpression)) {
    violations.push(`new expression inside the classifier: ${node.getText(source)}`);
  }
  for (const node of collectNodes(body, ts.isAwaitExpression)) {
    violations.push(`await inside the classifier: ${node.getText(source)}`);
  }
  for (const node of collectNodes(body, ts.isTaggedTemplateExpression)) {
    violations.push(`tagged template inside the classifier: ${node.getText(source)}`);
  }

  for (const access of collectNodes(body, ts.isPropertyAccessExpression)) {
    if (
      ts.isIdentifier(access.expression) &&
      parameters.has(access.expression.text) &&
      access.name.text !== "startsWith"
    ) {
      violations.push(`property access on a raw parameter: ${access.getText(source)}`);
    }
  }
  for (const access of collectNodes(body, ts.isElementAccessExpression)) {
    if (ts.isIdentifier(access.expression) && parameters.has(access.expression.text)) {
      violations.push(`element access on a raw parameter: ${access.getText(source)}`);
    }
  }

  for (const identifier of collectNodes(body, ts.isIdentifier)) {
    if (!isValueReference(identifier)) {
      continue;
    }
    if (parameters.has(identifier.text) || declared.has(identifier.text)) {
      continue;
    }
    violations.push(`identifier outside the classifier's closed binding set: ${identifier.text}`);
  }

  for (const literal of stringLiteralsIn(body)) {
    if (literal === "" || DECLARED_PREFIX_SET.has(literal) || DECLARED_ENUM_VALUE_SET.has(literal)) {
      continue;
    }
    violations.push(`undeclared string literal inside the classifier: ${literal}`);
  }

  return violations;
}

/**
 * AC-F1 rule 1a: each raw parameter may occur in exactly two AST positions — the direct operand of
 * the truthiness test selecting the absent versus non-absent arm, or the receiver of one
 * one-argument startsWith call whose single argument is a declared prefix literal. Every other
 * occurrence fails.
 */
function classifierPositionRule(source: ts.SourceFile): readonly string[] {
  const violations: string[] = [];
  const classifier = findFunctionLike(source, CLASSIFIER_NAME);
  if (!classifier?.body) {
    return [`${CLASSIFIER_NAME} was not found in either the declaration or the arrow-const form`];
  }

  const body = classifier.body;
  const parameters = new Set(parameterNames(classifier));

  for (const identifier of collectNodes(body, ts.isIdentifier)) {
    if (!isValueReference(identifier) || !parameters.has(identifier.text)) {
      continue;
    }

    const parent = identifier.parent;
    if (parent && ts.isIfStatement(parent) && parent.expression === identifier) {
      continue;
    }

    if (
      parent &&
      ts.isPropertyAccessExpression(parent) &&
      parent.expression === identifier &&
      parent.name.text === "startsWith"
    ) {
      const call = parent.parent;
      if (call && ts.isCallExpression(call) && call.expression === parent && call.arguments.length === 1) {
        const argument = call.arguments[0];
        if (argument && ts.isStringLiteral(argument) && DECLARED_PREFIX_SET.has(argument.text)) {
          continue;
        }
      }
    }

    violations.push(
      `raw parameter ${identifier.text} occupies a forbidden position (${
        parent ? ts.SyntaxKind[parent.kind] : "unparented"
      })`,
    );
  }

  return violations;
}

/**
 * AC-F1 rule 1b: exactly one reachable returned expression, resolved through at most one local
 * binding, whose AST is an object literal with exactly the three classification properties, each a
 * shorthand or a property assignment initialised by a body-declared enum binding.
 */
function classifierReturnRule(source: ts.SourceFile): readonly string[] {
  const violations: string[] = [];
  const classifier = findFunctionLike(source, CLASSIFIER_NAME);
  if (!classifier?.body) {
    return [`${CLASSIFIER_NAME} was not found in either the declaration or the arrow-const form`];
  }

  const body = classifier.body;
  const declared = collectDeclaredBindings(classifier);
  const returnStatements = collectNodes(body, ts.isReturnStatement);

  if (returnStatements.length !== 1) {
    violations.push(`classifier has ${returnStatements.length} return statements; exactly one is admitted`);
  }

  const returnStatement = returnStatements[0];
  if (!returnStatement?.expression) {
    violations.push("classifier has no returned expression");
    return violations;
  }

  let returned: ts.Expression = returnStatement.expression;
  if (isWideningAssertion(returned)) {
    violations.push(`assertion widening on the returned expression: ${returned.getText(source)}`);
    return violations;
  }

  if (ts.isIdentifier(returned)) {
    const localName = returned.text;
    const declaration = collectNodes(body, ts.isVariableDeclaration).find(
      (node) => ts.isIdentifier(node.name) && node.name.text === localName,
    );
    if (!declaration?.initializer) {
      violations.push(`returned local binding ${localName} has no resolvable initializer`);
      return violations;
    }
    returned = declaration.initializer;
    if (isWideningAssertion(returned)) {
      violations.push(`assertion widening on the resolved returned expression: ${returned.getText(source)}`);
      return violations;
    }
    if (ts.isIdentifier(returned)) {
      violations.push("returned expression resolves through more than one local binding");
      return violations;
    }
  }

  if (!ts.isObjectLiteralExpression(returned)) {
    violations.push(`returned expression is not an object literal: ${ts.SyntaxKind[returned.kind]}`);
    return violations;
  }

  if (returned.properties.length !== 3) {
    violations.push(`returned object literal has ${returned.properties.length} properties; exactly three are admitted`);
  }

  const seen = new Set<string>();
  for (const property of returned.properties) {
    if (ts.isSpreadAssignment(property)) {
      violations.push("spread element in the returned object literal");
      continue;
    }
    if (
      ts.isGetAccessorDeclaration(property) ||
      ts.isSetAccessorDeclaration(property) ||
      ts.isMethodDeclaration(property)
    ) {
      violations.push("accessor or method in the returned object literal");
      continue;
    }

    const name = property.name;
    if (!name || !ts.isIdentifier(name)) {
      violations.push("computed or non-identifier property name in the returned object literal");
      continue;
    }
    if (seen.has(name.text)) {
      violations.push(`duplicate property ${name.text} in the returned object literal`);
    }
    seen.add(name.text);
    if (!CLASSIFICATION_PROPERTY_SET.has(name.text)) {
      violations.push(`property ${name.text} is not one of the three declared classification properties`);
      continue;
    }

    if (ts.isShorthandPropertyAssignment(property)) {
      if (!declared.has(name.text)) {
        violations.push(`shorthand property ${name.text} does not name a body-declared binding`);
      }
      continue;
    }
    if (ts.isPropertyAssignment(property)) {
      const initializer = property.initializer;
      if (isWideningAssertion(initializer)) {
        violations.push(`assertion widening on property ${name.text}`);
        continue;
      }
      if (!ts.isIdentifier(initializer) || !declared.has(initializer.text)) {
        violations.push(`property ${name.text} is not initialised by a body-declared enum binding`);
      }
      continue;
    }

    violations.push(`unadmitted property form for ${name.text}`);
  }

  for (const required of CLASSIFICATION_PROPERTY_NAMES) {
    if (!seen.has(required)) {
      violations.push(`returned object literal is missing ${required}`);
    }
  }

  return violations;
}

/** Carried control (b) rule 2: the refusal constructor makes one Error and calls nothing. */
function refusalConstructorRule(source: ts.SourceFile): readonly string[] {
  const violations: string[] = [];
  const refusalConstructor = findFunctionLike(source, REFUSAL_CONSTRUCTOR_NAME);
  if (!refusalConstructor?.body) {
    return [`${REFUSAL_CONSTRUCTOR_NAME} was not found`];
  }

  const body = refusalConstructor.body;
  const parameters = new Set(parameterNames(refusalConstructor));
  const declared = collectDeclaredBindings(refusalConstructor);

  const newExpressions = collectNodes(body, ts.isNewExpression);
  if (newExpressions.length !== 1) {
    violations.push(`refusal constructor contains ${newExpressions.length} new expressions; exactly one is admitted`);
  }
  for (const node of newExpressions) {
    if (!ts.isIdentifier(node.expression) || node.expression.text !== "Error") {
      violations.push(`new expression constructee is not Error: ${node.getText(source)}`);
    }
  }

  for (const node of collectNodes(body, ts.isCallExpression)) {
    violations.push(`call inside the refusal constructor: ${node.getText(source)}`);
  }
  for (const node of collectNodes(body, ts.isAwaitExpression)) {
    violations.push(`await inside the refusal constructor: ${node.getText(source)}`);
  }

  for (const identifier of collectNodes(body, ts.isIdentifier)) {
    if (!isValueReference(identifier)) {
      continue;
    }
    if (parameters.has(identifier.text) || declared.has(identifier.text) || identifier.text === "Error") {
      continue;
    }
    violations.push(`identifier outside the refusal constructor's closed binding set: ${identifier.text}`);
  }

  return violations;
}

function isRefusalCall(node: ts.Node): boolean {
  return (
    ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === REFUSAL_CONSTRUCTOR_NAME
  );
}

function refusalBranchesOf(loaderBody: ts.Node): readonly ts.IfStatement[] {
  return collectNodes(loaderBody, ts.isIfStatement).filter((statement) =>
    collectNodes(statement.thenStatement, ts.isThrowStatement).some(
      (thrown) => thrown.expression !== undefined && isRefusalCall(thrown.expression),
    ),
  );
}

function reasonLiteralOf(branch: ts.IfStatement): string | null {
  for (const assignment of collectNodes(branch, ts.isPropertyAssignment)) {
    if (ts.isIdentifier(assignment.name) && assignment.name.text === "reason") {
      return ts.isStringLiteral(assignment.initializer) ? assignment.initializer.text : null;
    }
  }

  return null;
}

/** Carried control (b) seven-branch rule: single-exit refusal branches over a closed allowlist. */
function refusalBranchRule(source: ts.SourceFile): readonly string[] {
  const violations: string[] = [];
  const loader = findFunctionLike(source, LOADER_NAME);
  if (!loader?.body) {
    return [`${LOADER_NAME} was not found`];
  }

  const branches = refusalBranchesOf(loader.body);
  if (branches.length !== EXPECTED_BRANCH_REASONS.length) {
    violations.push(
      `found ${branches.length} refusal branches; exactly ${EXPECTED_BRANCH_REASONS.length} are admitted`,
    );
  }

  const observedReasons = branches.map((branch) => reasonLiteralOf(branch));
  if (JSON.stringify(observedReasons) !== JSON.stringify([...EXPECTED_BRANCH_REASONS])) {
    violations.push(`refusal branch reasons ${JSON.stringify(observedReasons)} do not match the normative K1-K7 order`);
  }

  const allowedIdentifiers = new Set([
    REFUSAL_CONSTRUCTOR_NAME,
    CLASSIFICATION_BINDING_NAME,
    DEPLOYMENT_ENVIRONMENT_BINDING_NAME,
  ]);

  for (const branch of branches) {
    const throwStatements = collectNodes(branch, ts.isThrowStatement);
    if (throwStatements.length !== 1) {
      violations.push(`refusal branch contains ${throwStatements.length} throw statements`);
    }

    const calls = collectNodes(branch, ts.isCallExpression);
    if (calls.length !== 1) {
      violations.push(`refusal branch contains ${calls.length} calls; only the bounded constructor is admitted`);
    }
    for (const call of calls) {
      if (!isRefusalCall(call)) {
        violations.push(`call beside the refusal constructor: ${call.getText(source)}`);
      }
    }
    for (const node of collectNodes(branch, ts.isNewExpression)) {
      violations.push(`new expression inside a refusal branch: ${node.getText(source)}`);
    }
    for (const node of collectNodes(branch, ts.isAwaitExpression)) {
      violations.push(`await inside a refusal branch: ${node.getText(source)}`);
    }

    for (const identifier of collectNodes(branch, ts.isIdentifier)) {
      if (!isValueReference(identifier) || allowedIdentifiers.has(identifier.text)) {
        continue;
      }
      violations.push(`identifier outside the refusal branch allowlist: ${identifier.text}`);
    }

    for (const literal of stringLiteralsIn(branch)) {
      if (!BRANCH_LITERAL_SET.has(literal)) {
        violations.push(`undeclared string literal inside a refusal branch: ${literal}`);
      }
    }
  }

  return violations;
}

// --- AC-F2 clause (1a): static text resolution with maximal, coalesced occurrence identity ---------

const NOT_STATICALLY_RESOLVABLE = Symbol("not-statically-resolvable");

type ResolvedStaticText = string | typeof NOT_STATICALLY_RESOLVABLE;

/**
 * Clause (1a). This resolver governs environment-variable *names* and is deliberately more permissive
 * than clause (1P), which governs *values*: folding a name is inert, folding a value is refused.
 * Every form it does not place falls through the default arm to not-statically-resolvable.
 */
function resolveStaticText(node: ts.Node): ResolvedStaticText {
  switch (node.kind) {
    case ts.SyntaxKind.StringLiteral:
    case ts.SyntaxKind.NoSubstitutionTemplateLiteral:
      return (node as ts.LiteralLikeNode).text;
    case ts.SyntaxKind.TemplateExpression: {
      const template = node as ts.TemplateExpression;
      return template.templateSpans.length === 0 ? template.head.text : NOT_STATICALLY_RESOLVABLE;
    }
    case ts.SyntaxKind.NumericLiteral: {
      const value = Number((node as ts.NumericLiteral).text);
      return Number.isFinite(value) ? String(value) : NOT_STATICALLY_RESOLVABLE;
    }
    case ts.SyntaxKind.ParenthesizedExpression:
      return resolveStaticText((node as ts.ParenthesizedExpression).expression);
    case ts.SyntaxKind.AsExpression:
    case ts.SyntaxKind.SatisfiesExpression:
    case ts.SyntaxKind.NonNullExpression:
      return resolveStaticText((node as ts.AsExpression | ts.SatisfiesExpression | ts.NonNullExpression).expression);
    case ts.SyntaxKind.BinaryExpression: {
      const binary = node as ts.BinaryExpression;
      if (binary.operatorToken.kind !== ts.SyntaxKind.PlusToken) {
        return NOT_STATICALLY_RESOLVABLE;
      }
      const left = resolveStaticText(binary.left);
      const right = resolveStaticText(binary.right);

      return typeof left === "string" && typeof right === "string" ? `${left}${right}` : NOT_STATICALLY_RESOLVABLE;
    }
    default:
      return NOT_STATICALLY_RESOLVABLE;
  }
}

type StaticOccurrence = Readonly<{ node: ts.Node; text: string }>;

/**
 * Occurrence identity is maximal and coalesced, never per node: an expression is exactly one
 * occurrence when it resolves and its parent expression does not, and every descendant of a maximal
 * resolvable expression is suppressed. String-literal *types* are erased and are never occurrences.
 */
function collectMaximalStaticOccurrences(root: ts.Node): readonly StaticOccurrence[] {
  const occurrences: StaticOccurrence[] = [];
  const visit = (node: ts.Node) => {
    if (!isInTypePosition(node)) {
      const text = resolveStaticText(node);
      if (typeof text === "string") {
        occurrences.push({ node, text });
        return;
      }
    }

    ts.forEachChild(node, visit);
  };
  visit(root);

  return occurrences;
}

// --- AC-F2 clause (1P): the provenance relation, dispatching on SyntaxKind before anything else ----

type StripeProvenance =
  | "acquired-secret"
  | "acquired-publishable"
  | "acquired-other-env"
  | "admitted-call"
  | "parameter"
  | "inert"
  | "refused";

/** The named subset of `SyntaxKind` the relation places. Every other kind lands in the default arm. */
const ADMITTED_PROVENANCE_KIND_NAMES = [
  "StringLiteral",
  "NoSubstitutionTemplateLiteral",
  "NumericLiteral",
  "BigIntLiteral",
  "TrueKeyword",
  "FalseKeyword",
  "NullKeyword",
  "Identifier",
  "ParenthesizedExpression",
  "AsExpression",
  "SatisfiesExpression",
  "NonNullExpression",
  "TypeAssertionExpression",
  "CallExpression",
  "NewExpression",
  "BinaryExpression",
  "ConditionalExpression",
  "PropertyAccessExpression",
  "ObjectLiteralExpression",
  "ArrayLiteralExpression",
] as const;

const KEY_SHAPED_LITERAL = /^(sk|rk|pk)_(test|live)_/;

const LOADER_PARAMETER_NAME = "input";
const LOADER_PARAMETER_PROPERTY_NAMES = [
  "productionLike",
  "deploymentEnvironment",
  "productionMissingConfigError",
] as const;
const LOADER_PARAMETER_PROPERTY_SET = new Set<string>(LOADER_PARAMETER_PROPERTY_NAMES);

const ACQUISITION_CALLEE_NAME = "getOptionalEnv";
const ADMITTED_LOADER_CALLEE_NAMES = [
  ACQUISITION_CALLEE_NAME,
  "getOptionalCsvEnv",
  "resolveEnumEnv",
  "loadDeploymentEnvironment",
  CLASSIFIER_NAME,
  REFUSAL_CONSTRUCTOR_NAME,
] as const;
const ADMITTED_LOADER_CALLEE_SET = new Set<string>(ADMITTED_LOADER_CALLEE_NAMES);

/** Clause (1c): globals and the clause (1j) vocabulary constants the loader body may reference. */
const ADMITTED_LOADER_GLOBAL_NAMES = ["Error", "undefined"] as const;
const DECLARED_VOCABULARY_BINDING_NAMES = [
  "PRODUCTION_MISSING_STRIPE_CONFIG_ERRORS",
  "PRODUCTION_MISSING_STRIPE_CONFIG_VOCABULARY_REFUSAL",
] as const;
const ADMITTED_LOADER_FREE_NAMES = new Set<string>([
  ...ADMITTED_LOADER_CALLEE_NAMES,
  ...ADMITTED_LOADER_GLOBAL_NAMES,
  ...DECLARED_VOCABULARY_BINDING_NAMES,
]);

/**
 * An expression carries the *set* of sources it can be, never a single ranked winner. A strength
 * order that collapsed simultaneous sources let a cross-key join such as `publishableKey ?? secretKey`
 * present itself as the stronger `acquired-secret` and reach the named `secretKey` sink undetected.
 * Multiplicity is therefore represented rather than resolved: an aggregate object literal may legitimately
 * carry several sources at once, while the two named credential sinks each require their own singleton.
 */
type StripeProvenanceSources = readonly StripeProvenance[];

/** A canonical order for printing and comparing a source set. Nothing is ranked or collapsed by it. */
const PROVENANCE_SOURCE_ORDER: readonly StripeProvenance[] = [
  "inert",
  "parameter",
  "admitted-call",
  "acquired-other-env",
  "acquired-publishable",
  "acquired-secret",
  "refused",
];

function sourcesOf(provenance: StripeProvenance): StripeProvenanceSources {
  return [provenance];
}

/** Union, not a maximum. `refused` absorbs, and an empty join is `inert`. */
function joinProvenance(values: readonly StripeProvenanceSources[]): StripeProvenanceSources {
  const union = new Set<StripeProvenance>();
  for (const value of values) {
    for (const source of value) {
      union.add(source);
    }
  }
  if (union.has("refused")) {
    return sourcesOf("refused");
  }
  if (union.size === 0) {
    return sourcesOf("inert");
  }

  return PROVENANCE_SOURCE_ORDER.filter((source) => union.has(source));
}

function carriesExactly(sources: StripeProvenanceSources, source: StripeProvenance): boolean {
  return sources.length === 1 && sources[0] === source;
}

function describeSources(sources: StripeProvenanceSources): string {
  return sources.join("+");
}

type ProvenanceSink = Readonly<{ name: string; provenance: StripeProvenanceSources; node: ts.Node }>;

type ProvenanceContext = Readonly<{
  loaderBindings: ReadonlyMap<string, ts.VariableDeclaration>;
  refusedLoaderNames: ReadonlySet<string>;
  sinks: ProvenanceSink[];
  visited: Set<ts.Node>;
  closure: Map<ts.Node, StripeProvenanceSources>;
}>;

/** Loader-body bindings, partitioned into the admitted `const`-with-one-initializer form and the rest. */
function collectLoaderBindings(loader: ClassifierLike): {
  admitted: Map<string, ts.VariableDeclaration>;
  refused: Set<string>;
} {
  const admitted = new Map<string, ts.VariableDeclaration>();
  const refused = new Set<string>();
  const body = loader.body;
  if (!body) {
    return { admitted, refused };
  }

  for (const declaration of collectNodes(body, ts.isVariableDeclaration)) {
    const list = declaration.parent;
    const isConst = ts.isVariableDeclarationList(list) && (list.flags & ts.NodeFlags.Const) !== 0;
    if (ts.isIdentifier(declaration.name) && isConst && declaration.initializer) {
      admitted.set(declaration.name.text, declaration);
      continue;
    }

    const introduced = new Set<string>();
    collectBoundNames(declaration.name, introduced);
    for (const name of introduced) {
      refused.add(name);
    }
  }

  return { admitted, refused };
}

function createProvenanceContext(loader: ClassifierLike): ProvenanceContext {
  const { admitted, refused } = collectLoaderBindings(loader);

  return {
    loaderBindings: admitted,
    refusedLoaderNames: refused,
    sinks: [],
    visited: new Set<ts.Node>(),
    closure: new Map<ts.Node, StripeProvenanceSources>(),
  };
}

/**
 * Clause (1P). The relation dispatches on `expression.kind` before inspecting text, type, or
 * structure. Its default arm — not a sentence of prose — is the closure: a form nobody enumerated and
 * a `SyntaxKind` TypeScript adds after this ships both land in it with no code change.
 */
function provenanceOf(node: ts.Node, context: ProvenanceContext): StripeProvenanceSources {
  const result = computeProvenance(node, context);
  context.closure.set(node, result);

  return result;
}

function computeProvenance(node: ts.Node, context: ProvenanceContext): StripeProvenanceSources {
  switch (node.kind) {
    case ts.SyntaxKind.StringLiteral:
    case ts.SyntaxKind.NoSubstitutionTemplateLiteral:
      return sourcesOf(KEY_SHAPED_LITERAL.test((node as ts.LiteralLikeNode).text) ? "refused" : "inert");
    case ts.SyntaxKind.NumericLiteral:
    case ts.SyntaxKind.BigIntLiteral:
    case ts.SyntaxKind.TrueKeyword:
    case ts.SyntaxKind.FalseKeyword:
    case ts.SyntaxKind.NullKeyword:
      return sourcesOf("inert");
    case ts.SyntaxKind.Identifier:
      return provenanceOfIdentifier(node as ts.Identifier, context);
    case ts.SyntaxKind.ParenthesizedExpression:
      return provenanceOf((node as ts.ParenthesizedExpression).expression, context);
    case ts.SyntaxKind.AsExpression:
    case ts.SyntaxKind.SatisfiesExpression:
    case ts.SyntaxKind.NonNullExpression:
    case ts.SyntaxKind.TypeAssertionExpression:
      return provenanceOf(
        (node as ts.AsExpression | ts.SatisfiesExpression | ts.NonNullExpression | ts.TypeAssertion).expression,
        context,
      );
    case ts.SyntaxKind.CallExpression:
      return sourcesOf(provenanceOfCall(node as ts.CallExpression, context));
    case ts.SyntaxKind.NewExpression:
      return sourcesOf("refused");
    case ts.SyntaxKind.BinaryExpression: {
      const binary = node as ts.BinaryExpression;
      if (binary.operatorToken.kind !== ts.SyntaxKind.QuestionQuestionToken) {
        // A `+` fold is refused at the operator-token dispatch, never by inspecting its text.
        return sourcesOf("refused");
      }

      return joinProvenance([provenanceOf(binary.left, context), provenanceOf(binary.right, context)]);
    }
    case ts.SyntaxKind.ConditionalExpression: {
      // The condition carries no value into the return and is not traversed by this relation; it stays
      // governed by clauses (1b) to (1i) and by carried clause (2).
      const conditional = node as ts.ConditionalExpression;

      return joinProvenance([
        provenanceOf(conditional.whenTrue, context),
        provenanceOf(conditional.whenFalse, context),
      ]);
    }
    case ts.SyntaxKind.PropertyAccessExpression: {
      const access = node as ts.PropertyAccessExpression;

      return sourcesOf(
        ts.isIdentifier(access.expression) &&
          access.expression.text === LOADER_PARAMETER_NAME &&
          LOADER_PARAMETER_PROPERTY_SET.has(access.name.text)
          ? "parameter"
          : "refused",
      );
    }
    case ts.SyntaxKind.ObjectLiteralExpression:
      return provenanceOfObjectLiteral(node as ts.ObjectLiteralExpression, context);
    case ts.SyntaxKind.ArrayLiteralExpression: {
      const array = node as ts.ArrayLiteralExpression;
      if (array.elements.some((element) => ts.isSpreadElement(element) || ts.isOmittedExpression(element))) {
        return sourcesOf("refused");
      }

      return joinProvenance(array.elements.map((element) => provenanceOf(element, context)));
    }
    default:
      return sourcesOf("refused");
  }
}

function provenanceOfIdentifier(node: ts.Identifier, context: ProvenanceContext): StripeProvenanceSources {
  if (node.text === "undefined") {
    return sourcesOf("inert");
  }
  if (node.text === LOADER_PARAMETER_NAME) {
    return sourcesOf("parameter");
  }

  const declaration = context.loaderBindings.get(node.text);
  if (!declaration?.initializer || context.visited.has(declaration)) {
    return sourcesOf("refused");
  }

  context.visited.add(declaration);
  const result = provenanceOf(declaration.initializer, context);
  context.visited.delete(declaration);

  return result;
}

function provenanceOfCall(node: ts.CallExpression, context: ProvenanceContext): StripeProvenance {
  const callee = node.expression;
  if (!ts.isIdentifier(callee)) {
    return "refused";
  }
  if (context.loaderBindings.has(callee.text) || context.refusedLoaderNames.has(callee.text)) {
    return "refused";
  }
  if (!ADMITTED_LOADER_CALLEE_SET.has(callee.text)) {
    return "refused";
  }
  if (callee.text === REFUSAL_CONSTRUCTOR_NAME) {
    // It yields no returned value.
    return "refused";
  }
  if (callee.text !== ACQUISITION_CALLEE_NAME) {
    return "admitted-call";
  }

  const argument = node.arguments.length === 1 ? node.arguments[0] : undefined;
  const name = argument ? resolveStaticText(argument) : NOT_STATICALLY_RESOLVABLE;
  if (typeof name !== "string") {
    return "refused";
  }
  if (name === "STRIPE_SECRET_KEY") {
    return "acquired-secret";
  }
  if (name === "STRIPE_PUBLISHABLE_KEY") {
    return "acquired-publishable";
  }

  return "acquired-other-env";
}

/**
 * A root binding is one acquired *directly*: after the four declared wrapper forms, the initializer is
 * a call the relation places as `acquired-secret` or `acquired-publishable`. A binding that merely
 * joins to a key provenance through a conditional or an object literal is a downstream sink, not a root.
 */
function directAcquisitionProvenance(node: ts.Node, context: ProvenanceContext): StripeProvenance | null {
  let current: ts.Node = node;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isNonNullExpression(current)
  ) {
    current = current.expression;
  }
  if (!ts.isCallExpression(current)) {
    return null;
  }

  const provenance = provenanceOfCall(current, context);

  return provenance === "acquired-secret" || provenance === "acquired-publishable" ? provenance : null;
}

function provenanceOfObjectLiteral(
  node: ts.ObjectLiteralExpression,
  context: ProvenanceContext,
): StripeProvenanceSources {
  const seen = new Set<string>();
  const values: StripeProvenanceSources[] = [];

  for (const property of node.properties) {
    if (!ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property)) {
      // Spread, getter, setter, and method members are all refused.
      return sourcesOf("refused");
    }

    const name = property.name;
    if (!ts.isIdentifier(name) && !ts.isStringLiteral(name)) {
      return sourcesOf("refused");
    }
    if (seen.has(name.text)) {
      return sourcesOf("refused");
    }
    seen.add(name.text);

    const value = ts.isPropertyAssignment(property) ? property.initializer : property.name;
    const provenance = provenanceOf(value, context);
    context.sinks.push({ name: name.text, provenance, node: value });
    values.push(provenance);
  }

  return joinProvenance(values);
}

/**
 * Rootedness never propagates through a declassification. There are exactly two: the single
 * classifier call, whose result is closed enums, and the exactly-named `kind` discriminant of a
 * retaining gateway binding. Every other read of a rooted binding still propagates.
 */
function containsRootedReference(node: ts.Node, rooted: ReadonlySet<string>): boolean {
  let found = false;
  const visit = (current: ts.Node) => {
    if (found) {
      return;
    }
    if (
      ts.isCallExpression(current) &&
      ts.isIdentifier(current.expression) &&
      current.expression.text === CLASSIFIER_NAME
    ) {
      return;
    }
    if (
      ts.isPropertyAccessExpression(current) &&
      current.name.text === GATEWAY_DISCRIMINANT_PROPERTY &&
      ts.isIdentifier(current.expression) &&
      rooted.has(current.expression.text)
    ) {
      return;
    }
    if (ts.isIdentifier(current) && isValueReference(current) && rooted.has(current.text)) {
      found = true;
      return;
    }

    ts.forEachChild(current, visit);
  };
  visit(node);

  return found;
}

/**
 * A retaining object literal counts as a sink only when it is itself proved to terminate at a
 * declared local gateway construction or at the returned config. A reference sitting in a property
 * initializer is never sufficient on its own — that unconditional permission is the gap AC-F2 names.
 */
function objectLiteralTerminatesSafely(objectLiteral: ts.ObjectLiteralExpression, loader: ClassifierLike): boolean {
  let current: ts.Node = objectLiteral;
  let parent: ts.Node | undefined = current.parent;

  while (parent) {
    if (ts.isParenthesizedExpression(parent)) {
      current = parent;
      parent = parent.parent;
      continue;
    }
    if (ts.isConditionalExpression(parent) && parent.condition !== current) {
      current = parent;
      parent = parent.parent;
      continue;
    }
    if (ts.isVariableDeclaration(parent)) {
      return (
        parent.initializer === current &&
        ts.isIdentifier(parent.name) &&
        DECLARED_GATEWAY_BINDINGS.has(parent.name.text)
      );
    }
    if (ts.isReturnStatement(parent)) {
      return (
        parent.expression === current &&
        loader.body !== undefined &&
        ts.isBlock(loader.body) &&
        parent.parent === loader.body &&
        loader.body.statements.at(-1) === parent
      );
    }

    return false;
  }

  return false;
}

/** AC-F2 termination: returns null when the rooted reference reaches an admitted sink. */
function classifyRootedTerminus(
  reference: ts.Identifier,
  source: ts.SourceFile,
  loader: ClassifierLike,
): string | null {
  let current: ts.Node = reference;
  let parent: ts.Node | undefined = current.parent;

  while (parent) {
    if (ts.isParenthesizedExpression(parent)) {
      current = parent;
      parent = parent.parent;
      continue;
    }
    if (ts.isPrefixUnaryExpression(parent) && parent.operator === ts.SyntaxKind.ExclamationToken) {
      current = parent;
      parent = parent.parent;
      continue;
    }
    if (
      ts.isBinaryExpression(parent) &&
      (parent.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
        parent.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
        parent.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken)
    ) {
      current = parent;
      parent = parent.parent;
      continue;
    }
    if (ts.isConditionalExpression(parent)) {
      if (parent.condition === current) {
        current = parent;
        parent = parent.parent;
        continue;
      }
      current = parent;
      parent = parent.parent;
      continue;
    }
    if (ts.isIfStatement(parent)) {
      return parent.expression === current
        ? null
        : `rooted expression reaches an if statement outside its condition: ${reference.text}`;
    }
    if (ts.isCallExpression(parent)) {
      const isDeclassificationArgument =
        ts.isIdentifier(parent.expression) &&
        parent.expression.text === CLASSIFIER_NAME &&
        parent.arguments.some((argument) => argument === current);
      return isDeclassificationArgument
        ? null
        : `rooted expression reaches a call that is not the single ${CLASSIFIER_NAME} declassification boundary: ${parent.getText(source)}`;
    }
    if (ts.isVariableDeclaration(parent)) {
      return parent.initializer === current
        ? null
        : `rooted expression reaches a variable declaration outside its initializer: ${reference.text}`;
    }
    if (ts.isPropertyAssignment(parent) || ts.isShorthandPropertyAssignment(parent)) {
      const name = parent.name;
      if (!ts.isIdentifier(name)) {
        return `rooted expression sits at a computed or non-identifier property name`;
      }
      if (!RETAINING_SINK_PROPERTIES.has(name.text)) {
        return `rooted expression sits at property ${name.text}, which is not a declared retaining sink`;
      }
      const objectLiteral = parent.parent;
      if (!objectLiteral || !ts.isObjectLiteralExpression(objectLiteral)) {
        return `rooted property ${name.text} is not held by an object literal`;
      }
      return objectLiteralTerminatesSafely(objectLiteral, loader)
        ? null
        : `retaining object literal holding ${name.text} does not terminate at a declared gateway construction or the returned config`;
    }
    if (ts.isPropertyAccessExpression(parent) && parent.expression === current) {
      return parent.name.text === GATEWAY_DISCRIMINANT_PROPERTY
        ? null
        : `rooted expression is read through property ${parent.name.text}`;
    }

    return `rooted expression terminates in an unadmitted AST shape: ${ts.SyntaxKind[parent.kind]}`;
  }

  return `rooted expression ${reference.text} has no resolvable terminus`;
}

/**
 * Carried clauses (2) and (3), byte-unchanged in behaviour: rootedness propagated through every
 * expression form and every binding pattern including nested scopes that capture a rooted outer
 * binding, and termination only at the single classifier call or an exact named retaining property.
 *
 * The root bindings themselves are no longer enumerated by an acquisition-side scanner. They are
 * derived from clause (1P): a loader-body `const` whose initializer carries `acquired-secret` or
 * `acquired-publishable`, exactly one of each.
 */
function provenanceRule(source: ts.SourceFile): readonly string[] {
  const violations: string[] = [];
  const loader = findFunctionLike(source, LOADER_NAME);
  if (!loader?.body) {
    return [`${LOADER_NAME} was not found`];
  }

  const body = loader.body;

  const context = createProvenanceContext(loader);
  const rootBindings = new Set<string>();
  const acquisitionCounts = new Map<StripeProvenance, number>([
    ["acquired-secret", 0],
    ["acquired-publishable", 0],
  ]);
  for (const [name, declaration] of context.loaderBindings) {
    if (!declaration.initializer) {
      continue;
    }
    const provenance = directAcquisitionProvenance(declaration.initializer, context);
    if (provenance === null) {
      continue;
    }

    rootBindings.add(name);
    acquisitionCounts.set(provenance, (acquisitionCounts.get(provenance) ?? 0) + 1);
  }

  for (const [provenance, count] of acquisitionCounts) {
    if (count !== 1) {
      violations.push(
        `${provenance} is bound ${count} times inside ${LOADER_NAME}; exactly one acquisition is admitted`,
      );
    }
  }
  if (rootBindings.size !== STRIPE_KEY_ENVIRONMENT_NAMES.length) {
    violations.push(
      `expected ${STRIPE_KEY_ENVIRONMENT_NAMES.length} declared root bindings, resolved ${rootBindings.size}`,
    );
  }

  const rooted = new Set(rootBindings);
  const declarations = collectNodes(body, ts.isVariableDeclaration);
  let changed = true;
  while (changed) {
    changed = false;
    for (const declaration of declarations) {
      if (!declaration.initializer || !containsRootedReference(declaration.initializer, rooted)) {
        continue;
      }
      const introduced = new Set<string>();
      collectBoundNames(declaration.name, introduced);
      for (const name of introduced) {
        if (!rooted.has(name)) {
          rooted.add(name);
          changed = true;
        }
      }
    }
  }

  for (const identifier of collectNodes(body, ts.isIdentifier)) {
    if (!isValueReference(identifier) || !rooted.has(identifier.text)) {
      continue;
    }
    const terminus = classifyRootedTerminus(identifier, source, loader);
    if (terminus !== null) {
      violations.push(terminus);
    }
  }

  return violations;
}

// --- AC-F2 clause (1S): the return closure, derived by traversal rather than authored -------------

type ReturnClosureInventory = Readonly<{
  expressions: number;
  refusedExpressions: readonly string[];
  sinks: readonly ProvenanceSink[];
  secretKeySinks: number;
  publishableKeySinks: number;
}>;

function deriveReturnClosure(source: ts.SourceFile): ReturnClosureInventory | null {
  const loader = findFunctionLike(source, LOADER_NAME);
  if (!loader?.body || !ts.isBlock(loader.body)) {
    return null;
  }

  const returns = collectNodes(loader.body, ts.isReturnStatement);
  const returned = returns.length === 1 ? returns[0]?.expression : undefined;
  if (!returned) {
    return null;
  }

  const context = createProvenanceContext(loader);
  provenanceOf(returned, context);

  const refusedExpressions: string[] = [];
  for (const [node, provenance] of context.closure) {
    if (provenance.includes("refused")) {
      refusedExpressions.push(`${ts.SyntaxKind[node.kind]}: ${node.getText(source).slice(0, 120)}`);
    }
  }

  return {
    expressions: context.closure.size,
    refusedExpressions,
    sinks: context.sinks,
    secretKeySinks: context.sinks.filter((sink) => sink.name === "secretKey").length,
    publishableKeySinks: context.sinks.filter((sink) => sink.name === "publishableKey").length,
  };
}

/**
 * Clause (1S). The sink surface is the transitive value closure of the loader's single `return`, not
 * a named list: no expression in it may carry `refused`, every property named `secretKey` must carry
 * exactly the singleton `acquired-secret`, and every `publishableKey` exactly the singleton
 * `acquired-publishable`. `inert`, `parameter`, `admitted-call`, and `acquired-other-env` therefore all
 * fail at those two names, and so does any *set* that merely contains the required source alongside
 * another — a cross-key join hands one credential to the other's sink and can no longer hide behind it.
 */
function returnClosureRule(source: ts.SourceFile): readonly string[] {
  const inventory = deriveReturnClosure(source);
  if (!inventory) {
    return [`${LOADER_NAME} does not expose exactly one returned expression`];
  }

  const violations: string[] = [];
  for (const refused of inventory.refusedExpressions) {
    violations.push(`return-closure expression carries a refused provenance: ${refused}`);
  }
  for (const sink of inventory.sinks) {
    if (sink.name === "secretKey" && !carriesExactly(sink.provenance, "acquired-secret")) {
      violations.push(
        `return-closure sink secretKey carries ${describeSources(sink.provenance)} rather than exactly acquired-secret`,
      );
    }
    if (sink.name === "publishableKey" && !carriesExactly(sink.provenance, "acquired-publishable")) {
      violations.push(
        `return-closure sink publishableKey carries ${describeSources(sink.provenance)} rather than exactly acquired-publishable`,
      );
    }
  }
  if (inventory.secretKeySinks === 0 || inventory.publishableKeySinks === 0) {
    violations.push(
      `the derived traversal found ${inventory.secretKeySinks} secretKey and ${inventory.publishableKeySinks} publishableKey sinks; a derived sink surface cannot be empty`,
    );
  }

  return violations;
}

// --- AC-F2 clause (1K): kind totality, mechanically derived from the compiler package --------------

type SyntaxKindPartition = Readonly<{
  distinctKinds: number;
  admittedArms: readonly Readonly<{ name: string; kind: number }>[];
  refusedKinds: number;
  compilerVersion: string;
  command: string;
}>;

const SYNTAX_KIND_DERIVATION_COMMAND =
  "node --input-type=module -e \"const m = await import('./packages/typescript-compiler-api/index.mjs'); const K = m.default.SyntaxKind; console.log(new Set(Object.values(K).filter((v) => typeof v === 'number')).size, m.default.version);\"";

function deriveSyntaxKindPartition(): SyntaxKindPartition {
  const distinct = new Set(Object.values(ts.SyntaxKind).filter((value): value is number => typeof value === "number"));
  const admittedArms = ADMITTED_PROVENANCE_KIND_NAMES.map((name) => ({
    name,
    kind: ts.SyntaxKind[name] as unknown as number,
  }));

  return {
    distinctKinds: distinct.size,
    admittedArms,
    refusedKinds: distinct.size - new Set(admittedArms.map((arm) => arm.kind)).size,
    compilerVersion: ts.version,
    command: SYNTAX_KIND_DERIVATION_COMMAND,
  };
}

/**
 * Clause (1K). The universe is derived from the compiler package at run time, never authored: a kind
 * added upstream after this ships lands in the default arm with no code change here.
 */
function kindTotalityRule(source: ts.SourceFile): readonly string[] {
  const violations: string[] = [];
  const partition = deriveSyntaxKindPartition();
  const loader = findFunctionLike(source, LOADER_NAME);
  if (!loader) {
    return [`${LOADER_NAME} was not found`];
  }

  for (const arm of partition.admittedArms) {
    if (typeof arm.kind !== "number") {
      violations.push(`admitted arm ${arm.name} does not resolve to a numeric SyntaxKind`);
    }
  }

  const admittedKinds = new Set(partition.admittedArms.map((arm) => arm.kind));
  const context = createProvenanceContext(loader);
  for (const value of Object.values(ts.SyntaxKind)) {
    if (typeof value !== "number" || admittedKinds.has(value)) {
      continue;
    }

    const bearer = { kind: value } as unknown as ts.Node;
    if (!carriesExactly(computeProvenance(bearer, context), "refused")) {
      violations.push(`a node bearing SyntaxKind ${value} (${ts.SyntaxKind[value]}) is not refused by the default arm`);
    }
  }

  return violations;
}

// --- AC-F2 clauses (1b) to (1i): narrowing rules, none of which claims exhaustiveness --------------

const PROTECTED_ENVIRONMENT_NAMES = new Set<string>(STRIPE_KEY_ENVIRONMENT_NAMES);
const REFUSAL_VARIABLE_PROPERTY_NAME = "variable";

/** Clause (1b): protected-name occurrences are admitted in exactly two module-wide positions. */
function protectedNameRule(source: ts.SourceFile): readonly string[] {
  const violations: string[] = [];
  const loader = findFunctionLike(source, LOADER_NAME);
  if (!loader?.body) {
    return [`${LOADER_NAME} was not found`];
  }

  const loaderBody = loader.body;
  const insideLoader = (node: ts.Node) => {
    let current: ts.Node | undefined = node;
    while (current) {
      if (current === loaderBody) {
        return true;
      }
      current = current.parent;
    }

    return false;
  };

  const acquisitions = new Map<string, number>();
  for (const occurrence of collectMaximalStaticOccurrences(source)) {
    if (!PROTECTED_ENVIRONMENT_NAMES.has(occurrence.text)) {
      continue;
    }

    const parent = occurrence.node.parent;
    if (
      parent &&
      ts.isCallExpression(parent) &&
      ts.isIdentifier(parent.expression) &&
      parent.expression.text === ACQUISITION_CALLEE_NAME &&
      parent.arguments.length === 1 &&
      parent.arguments[0] === occurrence.node &&
      insideLoader(parent)
    ) {
      acquisitions.set(occurrence.text, (acquisitions.get(occurrence.text) ?? 0) + 1);
      continue;
    }

    if (isRefusalVariableValue(occurrence.node, insideLoader)) {
      continue;
    }

    violations.push(
      `protected name ${occurrence.text} occurs at a non-admitted position: ${ts.SyntaxKind[occurrence.node.parent?.kind ?? ts.SyntaxKind.Unknown]}`,
    );
  }

  for (const name of PROTECTED_ENVIRONMENT_NAMES) {
    const count = acquisitions.get(name) ?? 0;
    if (count !== 1) {
      violations.push(`${name} has ${count} admitted acquisitions inside ${LOADER_NAME}; exactly one is admitted`);
    }
  }

  return violations;
}

/** The `variable` property value of the object-literal argument of a `stripeKeyRefusal` call. */
function isRefusalVariableValue(node: ts.Node, insideLoader: (node: ts.Node) => boolean): boolean {
  let current: ts.Node = node;
  let parent: ts.Node | undefined = current.parent;

  while (parent && (ts.isParenthesizedExpression(parent) || ts.isConditionalExpression(parent))) {
    current = parent;
    parent = parent.parent;
  }
  if (!parent || !ts.isPropertyAssignment(parent) || parent.initializer !== current) {
    return false;
  }
  if (!ts.isIdentifier(parent.name) || parent.name.text !== REFUSAL_VARIABLE_PROPERTY_NAME) {
    return false;
  }

  const objectLiteral = parent.parent;
  const call = objectLiteral?.parent;

  return (
    objectLiteral !== undefined &&
    ts.isObjectLiteralExpression(objectLiteral) &&
    call !== undefined &&
    ts.isCallExpression(call) &&
    ts.isIdentifier(call.expression) &&
    call.expression.text === REFUSAL_CONSTRUCTOR_NAME &&
    call.arguments.length === 1 &&
    call.arguments[0] === objectLiteral &&
    insideLoader(call)
  );
}

/** Clause (1c): every free value identifier in the loader body resolves against the derived allowlist. */
function identifierResolutionRule(source: ts.SourceFile): readonly string[] {
  const violations: string[] = [];
  const loader = findFunctionLike(source, LOADER_NAME);
  if (!loader?.body) {
    return [`${LOADER_NAME} was not found`];
  }

  const declared = collectDeclaredBindings(loader);
  for (const parameter of loader.parameters) {
    collectBoundNames(parameter.name, declared);
  }

  const importedNames = new Set<string>();
  for (const specifier of collectNodes(source, ts.isImportSpecifier)) {
    importedNames.add(specifier.name.text);
  }

  for (const identifier of collectNodes(loader.body, ts.isIdentifier)) {
    if (!isValueReference(identifier)) {
      continue;
    }
    if (declared.has(identifier.text)) {
      continue;
    }
    if (importedNames.has(identifier.text)) {
      violations.push(`loader body references imported binding ${identifier.text}`);
      continue;
    }
    if (!ADMITTED_LOADER_FREE_NAMES.has(identifier.text)) {
      violations.push(`loader body references unadmitted free identifier ${identifier.text}`);
    }
  }

  return violations;
}

/** The loader's derived free value-identifier inventory, reported rather than authored. */
function deriveLoaderFreeIdentifiers(source: ts.SourceFile): ReadonlyMap<string, number> {
  const inventory = new Map<string, number>();
  const loader = findFunctionLike(source, LOADER_NAME);
  if (!loader?.body) {
    return inventory;
  }

  const declared = collectDeclaredBindings(loader);
  for (const parameter of loader.parameters) {
    collectBoundNames(parameter.name, declared);
  }
  for (const identifier of collectNodes(loader.body, ts.isIdentifier)) {
    if (!isValueReference(identifier) || declared.has(identifier.text)) {
      continue;
    }
    inventory.set(identifier.text, (inventory.get(identifier.text) ?? 0) + 1);
  }

  return inventory;
}

/** Clause (1d): every call and `new` in the loader body has an admitted bare-identifier callee. */
function calleeRoleRule(source: ts.SourceFile): readonly string[] {
  const violations: string[] = [];
  const loader = findFunctionLike(source, LOADER_NAME);
  if (!loader?.body) {
    return [`${LOADER_NAME} was not found`];
  }

  const { admitted: loaderBindings, refused: refusedNames } = collectLoaderBindings(loader);
  const invocations: readonly ts.Node[] = [
    ...collectNodes(loader.body, ts.isCallExpression),
    ...collectNodes(loader.body, ts.isNewExpression),
    ...collectNodes(loader.body, ts.isTaggedTemplateExpression),
  ];

  for (const invocation of invocations) {
    if (ts.isTaggedTemplateExpression(invocation)) {
      violations.push(`loader body invokes a tagged template: ${invocation.getText(source).slice(0, 80)}`);
      continue;
    }

    const callee = (invocation as ts.CallExpression | ts.NewExpression).expression;
    if (!ts.isIdentifier(callee)) {
      violations.push(`loader body invokes a non bare-identifier callee: ${ts.SyntaxKind[callee.kind]}`);
      continue;
    }
    if (loaderBindings.has(callee.text) || refusedNames.has(callee.text)) {
      violations.push(`loader body invokes locally bound callee ${callee.text}`);
      continue;
    }
    if (!ADMITTED_LOADER_CALLEE_SET.has(callee.text) && callee.text !== "Error") {
      violations.push(`loader body invokes unadmitted callee ${callee.text}`);
      continue;
    }

    if (callee.text === ACQUISITION_CALLEE_NAME || callee.text === "getOptionalCsvEnv") {
      const call = invocation as ts.CallExpression;
      const argument = call.arguments.length === 1 ? call.arguments[0] : undefined;
      const name = argument ? resolveStaticText(argument) : NOT_STATICALLY_RESOLVABLE;
      if (typeof name !== "string") {
        violations.push(`${callee.text} is called without a maximal statically resolvable name argument`);
        continue;
      }
      if (callee.text === "getOptionalCsvEnv" && PROTECTED_ENVIRONMENT_NAMES.has(name)) {
        violations.push(`getOptionalCsvEnv carries protected name ${name}`);
      }
    }
  }

  violations.push(...verifyAdmittedCalleeRoles(source));

  return violations;
}

/** Each admitted callee's declared role, verified from the same module's AST. */
function verifyAdmittedCalleeRoles(source: ts.SourceFile): readonly string[] {
  const violations: string[] = [];

  const selector = findFunctionLike(source, "resolveEnumEnv");
  if (!selector?.body) {
    violations.push("resolveEnumEnv was not found");
  } else if (collectNodes(selector.body, ts.isIdentifier).some((node) => AMBIENT_OBJECT_NAMES.has(node.text))) {
    violations.push("resolveEnumEnv performs an ambient access and is not a pure closed-enum selector");
  }

  const environment = findFunctionLike(source, "loadDeploymentEnvironment");
  const environmentReturnType = environment && "type" in environment ? environment.type : undefined;
  if (!environmentReturnType || environmentReturnType.getText(source) !== "DeploymentEnvironment") {
    violations.push("loadDeploymentEnvironment does not declare a closed DeploymentEnvironment return type");
  }

  const refusalConstructor = findFunctionLike(source, REFUSAL_CONSTRUCTOR_NAME);
  if (!refusalConstructor?.body) {
    violations.push(`${REFUSAL_CONSTRUCTOR_NAME} was not found`);
  }

  return violations;
}

/** Clause (1e): the loader body declares no nested function-like or class construct. */
function nestedConstructRule(source: ts.SourceFile): readonly string[] {
  const violations: string[] = [];
  const loader = findFunctionLike(source, LOADER_NAME);
  if (!loader?.body) {
    return [`${LOADER_NAME} was not found`];
  }

  const nested = [
    ...collectNodes(loader.body, ts.isFunctionDeclaration),
    ...collectNodes(loader.body, ts.isFunctionExpression),
    ...collectNodes(loader.body, ts.isArrowFunction),
    ...collectNodes(loader.body, ts.isClassDeclaration),
    ...collectNodes(loader.body, ts.isClassExpression),
    ...collectNodes(loader.body, ts.isMethodDeclaration),
  ];
  for (const construct of nested) {
    violations.push(`loader body declares a nested ${ts.SyntaxKind[construct.kind]}`);
  }

  return violations;
}

// --- AC-F2 clause (1f): ambient attribution by nearest-enclosing-runtime-function ownership --------

const AMBIENT_OBJECT_NAMES = new Set(["process", "globalThis", "global"]);
const AMBIENT_HOST_NAMES = new Set([
  "getOptionalEnv",
  "loadDeploymentEnvironment",
  "getOptionalCsvEnv",
  "getOptionalPositiveNumberEnv",
]);
const RUNTIME_FUNCTION_LIKE_KINDS = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.FunctionDeclaration,
  ts.SyntaxKind.FunctionExpression,
  ts.SyntaxKind.ArrowFunction,
  ts.SyntaxKind.MethodDeclaration,
  ts.SyntaxKind.GetAccessor,
  ts.SyntaxKind.SetAccessor,
  ts.SyntaxKind.Constructor,
  ts.SyntaxKind.ClassStaticBlockDeclaration,
]);

function nearestRuntimeFunctionLike(node: ts.Node): ts.Node | undefined {
  let current: ts.Node | undefined = node.parent;
  while (current) {
    if (RUNTIME_FUNCTION_LIKE_KINDS.has(current.kind)) {
      return current;
    }
    current = current.parent;
  }

  return undefined;
}

type AmbientOwnershipInventory = Readonly<{
  occurrences: readonly Readonly<{ host: string; line: number }>[];
  hosts: readonly string[];
  violations: readonly string[];
}>;

/**
 * Clause (1f). Ownership is the nearest enclosing runtime function-like, decided here rather than by
 * lexical containment, because the two readings disagreed on an executed nested-function control. A
 * body-less overload or `declare` signature is erased and can never host an occurrence.
 */
function deriveAmbientOwnership(source: ts.SourceFile): AmbientOwnershipInventory {
  const occurrences: { host: string; line: number }[] = [];
  const violations: string[] = [];
  const hosts = new Set<string>();

  for (const identifier of collectNodes(source, ts.isIdentifier)) {
    if (!AMBIENT_OBJECT_NAMES.has(identifier.text) || !isValueReference(identifier)) {
      continue;
    }

    const line = source.getLineAndCharacterOfPosition(identifier.getStart(source)).line + 1;
    const owner = nearestRuntimeFunctionLike(identifier);
    if (!owner) {
      violations.push(`ambient ${identifier.text} at line ${line} has no enclosing function-like owner`);
      continue;
    }
    if (
      !ts.isFunctionDeclaration(owner) ||
      owner.parent !== source ||
      owner.body === undefined ||
      owner.name === undefined ||
      !AMBIENT_HOST_NAMES.has(owner.name.text)
    ) {
      const ownerName = ts.isFunctionDeclaration(owner) && owner.name ? owner.name.text : ts.SyntaxKind[owner.kind];
      violations.push(
        `ambient ${identifier.text} at line ${line} is owned by ${ownerName}, which is not an admitted host`,
      );
      continue;
    }

    hosts.add(owner.name.text);
    occurrences.push({ host: owner.name.text, line });
  }

  for (const importDeclaration of collectNodes(source, ts.isImportDeclaration)) {
    const specifier = importDeclaration.moduleSpecifier;
    if (ts.isStringLiteral(specifier) && (specifier.text === "process" || specifier.text === "node:process")) {
      violations.push("the module imports a process binding");
    }
  }

  const loader = findFunctionLike(source, LOADER_NAME);
  if (loader?.body) {
    for (const identifier of collectNodes(loader.body, ts.isIdentifier)) {
      if (AMBIENT_OBJECT_NAMES.has(identifier.text) && isValueReference(identifier)) {
        violations.push(`ambient ${identifier.text} occurs inside ${LOADER_NAME}`);
      }
    }
  }

  return { occurrences, hosts: [...hosts].sort(), violations };
}

function ambientOwnershipRule(source: ts.SourceFile): readonly string[] {
  return deriveAmbientOwnership(source).violations;
}

/** Clause (1g): every element-access key and computed binding name in the loader body resolves. */
function selectionDeterminacyRule(source: ts.SourceFile): readonly string[] {
  const violations: string[] = [];
  const loader = findFunctionLike(source, LOADER_NAME);
  if (!loader?.body) {
    return [`${LOADER_NAME} was not found`];
  }

  for (const access of collectNodes(loader.body, ts.isElementAccessExpression)) {
    if (typeof resolveStaticText(access.argumentExpression) !== "string") {
      violations.push(`element-access key does not resolve: ${access.getText(source).slice(0, 80)}`);
    }
  }
  for (const element of collectNodes(loader.body, ts.isBindingElement)) {
    const propertyName = element.propertyName;
    if (
      propertyName &&
      ts.isComputedPropertyName(propertyName) &&
      typeof resolveStaticText(propertyName.expression) !== "string"
    ) {
      violations.push(`computed binding-pattern property name does not resolve: ${propertyName.getText(source)}`);
    }
  }

  return violations;
}

/** Clause (1h): no key-shaped literal is planted as source text anywhere in the loader body. */
function literalSourceRule(source: ts.SourceFile): readonly string[] {
  const violations: string[] = [];
  const loader = findFunctionLike(source, LOADER_NAME);
  if (!loader?.body) {
    return [`${LOADER_NAME} was not found`];
  }

  for (const literal of collectNodes(loader.body, ts.isStringLiteral)) {
    if (KEY_SHAPED_LITERAL.test(literal.text)) {
      violations.push(`key-shaped literal planted in the loader body: ${literal.text.slice(0, 16)}`);
    }
  }
  for (const literal of collectNodes(loader.body, ts.isNoSubstitutionTemplateLiteral)) {
    if (KEY_SHAPED_LITERAL.test(literal.text)) {
      violations.push(`key-shaped template literal planted in the loader body: ${literal.text.slice(0, 16)}`);
    }
  }

  return violations;
}

/** Clause (1i): the loader keeps exactly its declared single `input` parameter of three properties. */
function parameterPinRule(source: ts.SourceFile): readonly string[] {
  const violations: string[] = [];
  const loader = findFunctionLike(source, LOADER_NAME);
  if (!loader) {
    return [`${LOADER_NAME} was not found`];
  }

  if (loader.parameters.length !== 1) {
    violations.push(`${LOADER_NAME} declares ${loader.parameters.length} parameters; exactly one is admitted`);

    return violations;
  }

  const parameter = loader.parameters[0];
  if (!parameter || !ts.isIdentifier(parameter.name) || parameter.name.text !== LOADER_PARAMETER_NAME) {
    violations.push(`${LOADER_NAME} does not declare its single \`${LOADER_PARAMETER_NAME}\` parameter`);

    return violations;
  }
  if (parameter.dotDotDotToken || parameter.initializer) {
    violations.push(`${LOADER_NAME} declares a rest or defaulted parameter`);
  }

  const parameterType = parameter.type;
  if (!parameterType || !ts.isTypeLiteralNode(parameterType)) {
    violations.push(`${LOADER_NAME} does not declare an inline parameter type literal`);

    return violations;
  }

  const declaredProperties = parameterType.members.map((member) =>
    member.name && ts.isIdentifier(member.name) ? member.name.text : "<non-identifier>",
  );
  if (declaredProperties.join(",") !== LOADER_PARAMETER_PROPERTY_NAMES.join(",")) {
    violations.push(`${LOADER_NAME} declares parameter properties [${declaredProperties.join(", ")}]`);
  }

  return violations;
}

// --- AC-F2 clause (1j), loader side: the internal production missing-config vocabulary -------------

const VOCABULARY_TUPLE_NAME = "PRODUCTION_MISSING_STRIPE_CONFIG_ERRORS";
const VOCABULARY_REFUSAL_NAME = "PRODUCTION_MISSING_STRIPE_CONFIG_VOCABULARY_REFUSAL";
const MISSING_CONFIG_PARAMETER_NAME = "productionMissingConfigError";
const MISSING_CONFIG_PARAMETER_TYPE = "PlatformStripeProductionMissingConfigError";

function deriveDeclaredVocabulary(source: ts.SourceFile): readonly string[] | null {
  const declaration = collectNodes(source, ts.isVariableDeclaration).find(
    (node) => ts.isIdentifier(node.name) && node.name.text === VOCABULARY_TUPLE_NAME,
  );
  const initializer = declaration?.initializer;
  if (!initializer || !ts.isAsExpression(initializer) || !ts.isArrayLiteralExpression(initializer.expression)) {
    return null;
  }
  if (initializer.type.getText(source) !== "const") {
    return null;
  }

  const members: string[] = [];
  for (const element of initializer.expression.elements) {
    if (!ts.isStringLiteral(element)) {
      return null;
    }
    members.push(element.text);
  }

  return members;
}

/**
 * Clause (1j), production side. A TypeScript annotation alone is erased at runtime, so the loader also
 * refuses a non-member as its first statement, before either acquisition. The comparison set is
 * required to be exactly the declared tuple's own indices, so adding a third member without a
 * comparison reds rather than shipping an unchecked message.
 */
function missingConfigVocabularyRule(source: ts.SourceFile): readonly string[] {
  const violations: string[] = [];
  const vocabulary = deriveDeclaredVocabulary(source);
  if (!vocabulary) {
    return [`${VOCABULARY_TUPLE_NAME} is not declared as an \`as const\` tuple of string literals`];
  }

  const loader = findFunctionLike(source, LOADER_NAME);
  if (!loader?.body || !ts.isBlock(loader.body)) {
    return [`${LOADER_NAME} was not found`];
  }

  const parameterType = loader.parameters[0]?.type;
  const declaredMemberType =
    parameterType && ts.isTypeLiteralNode(parameterType)
      ? parameterType.members.find(
          (member) => member.name && ts.isIdentifier(member.name) && member.name.text === MISSING_CONFIG_PARAMETER_NAME,
        )
      : undefined;
  const declaredTypeText =
    declaredMemberType && ts.isPropertySignature(declaredMemberType) && declaredMemberType.type
      ? declaredMemberType.type.getText(source)
      : null;
  if (declaredTypeText !== MISSING_CONFIG_PARAMETER_TYPE) {
    violations.push(
      `${MISSING_CONFIG_PARAMETER_NAME} is declared \`${declaredTypeText}\` rather than the union derived from ${VOCABULARY_TUPLE_NAME}`,
    );
  }

  const firstStatement = loader.body.statements[0];
  if (!firstStatement || !ts.isIfStatement(firstStatement)) {
    violations.push(`${LOADER_NAME} does not refuse a non-member vocabulary value as its first statement`);

    return violations;
  }

  const comparedIndices: number[] = [];
  for (const binary of collectNodes(firstStatement.expression, ts.isBinaryExpression)) {
    if (binary.operatorToken.kind !== ts.SyntaxKind.ExclamationEqualsEqualsToken) {
      continue;
    }
    const left = binary.left;
    const right = binary.right;
    const readsParameter =
      ts.isPropertyAccessExpression(left) &&
      ts.isIdentifier(left.expression) &&
      left.expression.text === LOADER_PARAMETER_NAME &&
      left.name.text === MISSING_CONFIG_PARAMETER_NAME;
    if (!readsParameter) {
      violations.push(`the vocabulary refusal compares something other than input.${MISSING_CONFIG_PARAMETER_NAME}`);
      continue;
    }
    if (
      !ts.isElementAccessExpression(right) ||
      !ts.isIdentifier(right.expression) ||
      right.expression.text !== VOCABULARY_TUPLE_NAME
    ) {
      violations.push("the vocabulary refusal compares against something other than a declared tuple element");
      continue;
    }
    const index = resolveStaticText(right.argumentExpression);
    if (typeof index !== "string") {
      violations.push("the vocabulary refusal indexes the declared tuple with an unresolvable key");
      continue;
    }
    comparedIndices.push(Number(index));
  }

  const expectedIndices = vocabulary.map((_, index) => index);
  if ([...comparedIndices].sort((left, right) => left - right).join(",") !== expectedIndices.join(",")) {
    violations.push(
      `the vocabulary refusal compares indices [${comparedIndices.join(", ")}] against a tuple of ${vocabulary.length} members`,
    );
  }

  const throws = collectNodes(firstStatement.thenStatement, ts.isThrowStatement);
  const thrown = throws.length === 1 ? throws[0]?.expression : undefined;
  if (
    !thrown ||
    !ts.isNewExpression(thrown) ||
    !ts.isIdentifier(thrown.expression) ||
    thrown.expression.text !== "Error" ||
    thrown.arguments?.length !== 1 ||
    !ts.isIdentifier(thrown.arguments[0] as ts.Node) ||
    (thrown.arguments[0] as ts.Identifier).text !== VOCABULARY_REFUSAL_NAME
  ) {
    violations.push("the vocabulary refusal does not throw the fixed internal refusal message");
  }

  return violations;
}

/** AC-08 inside the runtime module: exactly one classifier call answers every downstream read. */
function singleClassifierRule(source: ts.SourceFile): readonly string[] {
  const violations: string[] = [];

  const classifierCalls = collectNodes(source, ts.isCallExpression).filter(
    (call) => ts.isIdentifier(call.expression) && call.expression.text === CLASSIFIER_NAME,
  );
  if (classifierCalls.length !== 1) {
    violations.push(`${CLASSIFIER_NAME} is called ${classifierCalls.length} times; exactly one call is admitted`);
  }

  const call = classifierCalls[0];
  if (!call) {
    return violations;
  }

  const declaration = call.parent;
  if (
    !declaration ||
    !ts.isVariableDeclaration(declaration) ||
    declaration.initializer !== call ||
    !ts.isIdentifier(declaration.name) ||
    declaration.name.text !== CLASSIFICATION_BINDING_NAME
  ) {
    violations.push(`the ${CLASSIFIER_NAME} call does not bind to exactly one ${CLASSIFICATION_BINDING_NAME} variable`);
  }

  const loader = findFunctionLike(source, LOADER_NAME);
  if (!loader?.body) {
    violations.push(`${LOADER_NAME} was not found`);
    return violations;
  }
  if (!collectNodes(loader.body, ts.isCallExpression).includes(call)) {
    violations.push(`the ${CLASSIFIER_NAME} call does not sit inside ${LOADER_NAME}`);
  }

  for (const branch of refusalBranchesOf(loader.body)) {
    for (const access of collectNodes(branch, ts.isPropertyAccessExpression)) {
      if (!ts.isIdentifier(access.expression)) {
        continue;
      }
      if (access.expression.text !== CLASSIFICATION_BINDING_NAME) {
        violations.push(`refusal predicate reads ${access.getText(source)} rather than the one classification binding`);
      }
    }
  }

  const effectiveModeDeclaration = collectNodes(loader.body, ts.isVariableDeclaration).find(
    (node) => ts.isIdentifier(node.name) && node.name.text === "effectiveMode",
  );
  if (!effectiveModeDeclaration?.initializer) {
    violations.push("effectiveMode is not declared with an initializer inside the loader");
    return violations;
  }

  const allowedEffectiveModeIdentifiers = new Set([CLASSIFICATION_BINDING_NAME, ...DECLARED_GATEWAY_BINDINGS]);
  for (const identifier of collectNodes(effectiveModeDeclaration.initializer, ts.isIdentifier)) {
    if (!isValueReference(identifier) || allowedEffectiveModeIdentifiers.has(identifier.text)) {
      continue;
    }
    violations.push(`effectiveMode initializer consumes ${identifier.text} beyond the classification and the gateways`);
  }

  return violations;
}

function evaluateConfigSchemaProvenance(sourceText: string): StripeProvenanceReport {
  const source = parseModule(CONFIG_SCHEMA_PATH, sourceText);

  return {
    "classifier-calls": classifierCallRule(source),
    "classifier-positions": classifierPositionRule(source),
    "classifier-return": classifierReturnRule(source),
    "refusal-constructor": refusalConstructorRule(source),
    "refusal-branches": refusalBranchRule(source),
    "return-closure": returnClosureRule(source),
    "kind-totality": kindTotalityRule(source),
    "protected-names": protectedNameRule(source),
    "identifier-resolution": identifierResolutionRule(source),
    "callee-roles": calleeRoleRule(source),
    "nested-constructs": nestedConstructRule(source),
    "ambient-ownership": ambientOwnershipRule(source),
    "selection-determinacy": selectionDeterminacyRule(source),
    "literal-source": literalSourceRule(source),
    "parameter-pin": parameterPinRule(source),
    "missing-config-vocabulary": missingConfigVocabularyRule(source),
    provenance: provenanceRule(source),
    "single-classifier": singleClassifierRule(source),
  };
}

function provenanceViolationCount(report: StripeProvenanceReport): number {
  return Object.values(report).reduce((total, violations) => total + violations.length, 0);
}

/** AC-08 inside platform-api: the diagnostic is exactly the shared classification comparison. */
function evaluatePlatformApiClassifierShape(sourceText: string): readonly string[] {
  const source = parseModule(PLATFORM_API_CONFIG_PATH, sourceText);
  const assignments = collectNodes(source, ts.isPropertyAssignment).filter(
    (assignment) => ts.isIdentifier(assignment.name) && assignment.name.text === "liveSecretKeyLikely",
  );
  if (assignments.length !== 1) {
    return [`expected exactly one liveSecretKeyLikely initializer, found ${assignments.length}`];
  }

  const initializer = assignments[0]?.initializer;
  if (!initializer) {
    return ["liveSecretKeyLikely has no initializer"];
  }
  if (!ts.isBinaryExpression(initializer) || initializer.operatorToken.kind !== ts.SyntaxKind.EqualsEqualsEqualsToken) {
    return [`liveSecretKeyLikely is not a strict equality comparison: ${initializer.getText(source)}`];
  }
  if (!ts.isStringLiteral(initializer.right) || initializer.right.text !== "live") {
    return [`liveSecretKeyLikely is not compared against "live": ${initializer.getText(source)}`];
  }

  const left = initializer.left;
  if (!ts.isPropertyAccessExpression(left) || left.name.text !== "serverKeyMode") {
    return [`liveSecretKeyLikely does not read serverKeyMode: ${initializer.getText(source)}`];
  }
  const middle = left.expression;
  if (!ts.isPropertyAccessExpression(middle) || middle.name.text !== CLASSIFICATION_BINDING_NAME) {
    return [
      `liveSecretKeyLikely does not read the shared ${CLASSIFICATION_BINDING_NAME}: ${initializer.getText(source)}`,
    ];
  }
  if (!ts.isIdentifier(middle.expression) || middle.expression.text !== "stripeProvider") {
    return [`liveSecretKeyLikely is not rooted at the loaded stripeProvider: ${initializer.getText(source)}`];
  }

  return [];
}

/** Applies a named source mutation, refusing if its anchor has drifted. */
function mutateSource(sourceText: string, anchor: string, replacement: string): string {
  const occurrences = sourceText.split(anchor).length - 1;
  if (occurrences !== 1) {
    throw new Error(`mutation anchor matched ${occurrences} times instead of once: ${anchor}`);
  }

  return sourceText.replace(anchor, () => replacement);
}

// --- Named source mutants, applied to the real modules and re-parsed --------------------------------

const CLASSIFIER_DECLARATION_ANCHOR =
  "function classifyStripeKeys(secretKey: string | null, publishableKey: string | null): PlatformStripeKeyClassification {";
const CLASSIFIER_ARROW_REPLACEMENT =
  "const classifyStripeKeys = (secretKey: string | null, publishableKey: string | null): PlatformStripeKeyClassification => {";
const CLASSIFIER_BODY_ANCHOR = '  if (secretKey) {\n    if (secretKey.startsWith("sk_test_")) {';
const CLASSIFIER_RETURN_ANCHOR = "  return { serverKeyMode, serverKeyClass, publishableKeyMode };";
const CONSTRUCTOR_DESTRUCTURE_ANCHOR =
  "  const { reason, variable, serverKeyMode, serverKeyClass, publishableKeyMode, deploymentEnvironment } = payload;";
const CLASSIFICATION_CALL_ANCHOR = "  const keyClassification = classifyStripeKeys(secretKey, publishableKey);";
const K1_BRANCH_ANCHOR =
  '  if (keyClassification.serverKeyMode === "unknown") {\n    throw stripeKeyRefusal({\n      reason: "stripe-secret-key-unrecognized",';
const K4_BRANCH_ANCHOR = '  ) {\n    throw stripeKeyRefusal({\n      reason: "stripe-live-key-outside-production",';
const K7_BRANCH_ANCHOR =
  '  if (deploymentEnvironment === "production" && keyClassification.serverKeyClass === "restricted") {\n    throw stripeKeyRefusal({';
const LIVE_SECRET_KEY_LIKELY_ANCHOR =
  '      liveSecretKeyLikely: stripeProvider.keyClassification.serverKeyMode === "live",';

/** Inserts statements immediately after the single classification call, before the first rule. */
function afterClassification(statements: string): { anchor: string; replacement: string } {
  return { anchor: CLASSIFICATION_CALL_ANCHOR, replacement: `${CLASSIFICATION_CALL_ANCHOR}\n${statements}` };
}

/** Adds a payload property to the K1 refusal call. */
function widenK1Payload(property: string): { anchor: string; replacement: string } {
  return { anchor: K1_BRANCH_ANCHOR, replacement: `${K1_BRANCH_ANCHOR}\n      ${property}` };
}

/** Emits a value beside a clean constructor call inside a named refusal branch. */
function emitBesideBranch(anchor: string, statement: string): { anchor: string; replacement: string } {
  const [head, ...rest] = anchor.split("\n    throw stripeKeyRefusal({");
  return {
    anchor,
    replacement: `${head}\n    ${statement}\n    throw stripeKeyRefusal({${rest.join("\n    throw stripeKeyRefusal({")}`,
  };
}

type MutationStep = Readonly<{ anchor: string; replacement: string }>;

type NamedSourceMutant = Readonly<{
  name: string;
  rule: StripeProvenanceRuleId;
  anchor?: string;
  replacement?: string;
  steps?: readonly MutationStep[];
}>;

function mutantSteps(mutant: NamedSourceMutant): readonly MutationStep[] {
  if (mutant.steps) {
    return mutant.steps;
  }

  return mutant.anchor !== undefined && mutant.replacement !== undefined
    ? [{ anchor: mutant.anchor, replacement: mutant.replacement }]
    : [];
}

function applyMutantSteps(sourceText: string, steps: readonly MutationStep[]): string {
  return steps.reduce((text, step) => mutateSource(text, step.anchor, step.replacement), sourceText);
}

/**
 * The repository's canonical importer authority scans every tracked file's bytes with
 * `ts.preProcessFile`, which has no template-literal context: an `import ... from "..."` sequence
 * spelled inside a synthetic module text below is reported as a phantom specifier that this file's own
 * AST cannot cover, and the authority refuses. The keywords are therefore assembled rather than
 * spelled, so this test's bytes carry no scannable import token. The repair belongs here, in the
 * consumer's bytes, never in the authority.
 */
const SYNTHETIC_IMPORT_KEYWORD = ["im", "port"].join("");
const SYNTHETIC_EXPORT_KEYWORD = ["ex", "port"].join("");
const SYNTHETIC_FROM_KEYWORD = ["fr", "om"].join("");

/** The module-scope and helper-scope anchors the clause (1f) and transport controls attach to. */
const OPTIONAL_ENV_HELPER_ANCHOR = "export function getOptionalEnv(name: string) {";
const OPTIONAL_ENV_READ_ANCHOR = "  const value = process.env[name];";
const CONFIG_SCHEMA_IMPORT_ANCHOR = 'import { ENVIRONMENT_DATA_PROFILES } from "@chase-sets/bounded-context-module";';
const GATEWAY_SECRET_KEY_ANCHOR = '          kind: "stripe",\n          secretKey,\n          publishableKey,';
const ACQUISITION_CALL_ANCHOR = 'getOptionalEnv("STRIPE_SECRET_KEY")';

/** Replaces the `secretKey` sink of the declared `paymentProcessor` gateway construction. */
function plantIntoGateway(expression: string): MutationStep {
  return {
    anchor: GATEWAY_SECRET_KEY_ANCHOR,
    replacement: `          kind: "stripe",\n          secretKey: ${expression},\n          publishableKey,`,
  };
}

/** The mirror position: the `publishableKey` sink of the same gateway construction. */
function plantIntoPublishableSink(expression: string): MutationStep {
  return {
    anchor: GATEWAY_SECRET_KEY_ANCHOR,
    replacement: `          kind: "stripe",\n          secretKey,\n          publishableKey: ${expression},`,
  };
}

const CONFIG_SCHEMA_MUTANTS: readonly NamedSourceMutant[] = [
  // AC-F1: the required new mutant, rejected independently by rule 1b and by rule 1a.
  {
    name: "classifier-raw-property-smuggle",
    rule: "classifier-return",
    anchor: CLASSIFIER_RETURN_ANCHOR,
    replacement:
      "  const classified = { serverKeyMode, serverKeyClass, publishableKeyMode, rawKey: secretKey };\n  return classified;",
  },
  {
    name: "classifier-raw-property-smuggle (position rule)",
    rule: "classifier-positions",
    anchor: CLASSIFIER_RETURN_ANCHOR,
    replacement:
      "  const classified = { serverKeyMode, serverKeyClass, publishableKeyMode, rawKey: secretKey };\n  return classified;",
  },

  // AC-F1 rule 1b omission sweep: each rejected return shape reddens on its own.
  {
    name: "classifier-computed-property",
    rule: "classifier-return",
    anchor: CLASSIFIER_RETURN_ANCHOR,
    replacement: '  return { ["serverKeyMode"]: serverKeyMode, serverKeyClass, publishableKeyMode };',
  },
  {
    name: "classifier-accessor-property",
    rule: "classifier-return",
    anchor: CLASSIFIER_RETURN_ANCHOR,
    replacement: "  return { get serverKeyMode() { return serverKeyMode; }, serverKeyClass, publishableKeyMode };",
  },
  {
    name: "classifier-spread-property",
    rule: "classifier-return",
    anchor: CLASSIFIER_RETURN_ANCHOR,
    replacement: "  const partial = { serverKeyMode, serverKeyClass, publishableKeyMode };\n  return { ...partial };",
  },
  {
    name: "classifier-duplicate-property",
    rule: "classifier-return",
    anchor: CLASSIFIER_RETURN_ANCHOR,
    replacement: "  return { serverKeyMode, serverKeyClass, publishableKeyMode, publishableKeyMode };",
  },
  {
    name: "classifier-fourth-property",
    rule: "classifier-return",
    anchor: CLASSIFIER_RETURN_ANCHOR,
    replacement: "  return { serverKeyMode, serverKeyClass, publishableKeyMode, extraMode: serverKeyMode };",
  },
  {
    name: "classifier-return-as-widening",
    rule: "classifier-return",
    anchor: CLASSIFIER_RETURN_ANCHOR,
    replacement: "  return { serverKeyMode, serverKeyClass, publishableKeyMode } as PlatformStripeKeyClassification;",
  },
  {
    name: "classifier-return-satisfies-widening",
    rule: "classifier-return",
    anchor: CLASSIFIER_RETURN_ANCHOR,
    replacement:
      "  return { serverKeyMode, serverKeyClass, publishableKeyMode } satisfies PlatformStripeKeyClassification;",
  },
  {
    name: "classifier-property-non-null-widening",
    rule: "classifier-return",
    anchor: CLASSIFIER_RETURN_ANCHOR,
    replacement: "  return { serverKeyMode: serverKeyMode!, serverKeyClass, publishableKeyMode };",
  },
  {
    name: "classifier-alternate-return",
    rule: "classifier-return",
    anchor: CLASSIFIER_RETURN_ANCHOR,
    replacement:
      '  if (serverKeyMode === "unknown") {\n    return { serverKeyMode, serverKeyClass, publishableKeyMode };\n  }\n  return { serverKeyMode, serverKeyClass, publishableKeyMode };',
  },

  // Carried classifier-scope mutants.
  {
    name: "length-inside-classifier",
    rule: "classifier-positions",
    anchor: CLASSIFIER_BODY_ANCHOR,
    replacement: CLASSIFIER_BODY_ANCHOR.replace(
      "  if (secretKey) {",
      "  if (secretKey) {\n    console.warn(secretKey.length);",
    ),
  },
  {
    name: "undeclared-prefix-classifier",
    rule: "classifier-calls",
    anchor: 'secretKey.startsWith("sk_test_")',
    replacement: 'secretKey.startsWith("sk_")',
  },

  // Carried refusal-constructor-scope mutant.
  {
    name: "ambient-hash-inside-constructor",
    rule: "refusal-constructor",
    anchor: CONSTRUCTOR_DESTRUCTURE_ANCHOR,
    replacement: `${CONSTRUCTOR_DESTRUCTURE_ANCHOR}\n  const ambientDigest = createHash("sha256").update(String(process.env.STRIPE_SECRET_KEY)).digest("hex");`,
  },

  // Carried constructor-widening mutants, seen from control (b)'s branch rule.
  {
    name: "raw-key-in-refusal",
    rule: "refusal-branches",
    ...widenK1Payload("rawKey: secretKey,"),
  },
  {
    name: "key-prefix-in-refusal",
    rule: "refusal-branches",
    ...widenK1Payload("rawKeyPrefix: secretKey.slice(0, 8),"),
  },
  {
    name: "key-length-in-refusal",
    rule: "refusal-branches",
    ...widenK1Payload("rawKeyLength: secretKey.length,"),
  },
  {
    name: "key-hash-in-refusal",
    rule: "refusal-branches",
    ...widenK1Payload('rawKeyDigest: createHash("sha256").update(secretKey).digest("hex"),'),
  },

  // Carried beside-the-constructor mutants: clean payload, emission in the same branch.
  {
    name: "prefix-log-beside-refusal",
    rule: "refusal-branches",
    ...emitBesideBranch(K1_BRANCH_ANCHOR, "console.warn(secretKey.slice(0, 8));"),
  },
  {
    name: "length-log-beside-refusal",
    rule: "refusal-branches",
    ...emitBesideBranch(K4_BRANCH_ANCHOR, "console.warn(secretKey.length);"),
  },
  {
    name: "hash-log-beside-refusal",
    rule: "refusal-branches",
    ...emitBesideBranch(K7_BRANCH_ANCHOR, 'console.warn(createHash("sha256").update(secretKey).digest("hex"));'),
  },

  // Carried cross-scope mutants that a branch-scoped rule admits.
  {
    name: "prefix-before-first-rule",
    rule: "provenance",
    ...afterClassification("  console.warn(secretKey.slice(0, 8));"),
  },
  {
    name: "alias-then-emit",
    rule: "provenance",
    ...afterClassification("  const alias = secretKey;\n  console.warn(alias);"),
  },
  {
    name: "object-alias-then-emit",
    rule: "provenance",
    ...afterClassification("  const aliasObject = { secretKey };\n  console.warn(aliasObject.secretKey);"),
  },
  {
    name: "template-alias-then-emit",
    rule: "provenance",
    ...afterClassification("  const aliasTemplate = `${secretKey}`;\n  console.warn(aliasTemplate);"),
  },
  {
    name: "two-step-alias",
    rule: "provenance",
    ...afterClassification(
      "  const firstAlias = secretKey;\n  const secondAlias = firstAlias;\n  console.warn(secondAlias);",
    ),
  },

  // AC-F2: the six newly named mutants, each reddening on its own.
  {
    name: "ambient-reread-before-first-rule",
    rule: "ambient-ownership",
    ...afterClassification("  console.warn(process.env.STRIPE_SECRET_KEY?.slice(0, 8));"),
  },
  {
    name: "object-destructure-alias-then-emit",
    rule: "provenance",
    ...afterClassification("  const { leaked } = { leaked: secretKey };\n  console.warn(leaked);"),
  },
  {
    name: "object-assignment-exfiltration",
    rule: "provenance",
    ...afterClassification("  (globalThis as Record<string, unknown>).__leakedStripe = { secretKey };"),
  },
  {
    name: "guarded-assignment-exfiltration",
    rule: "provenance",
    ...afterClassification('  (globalThis as Record<string, unknown>).__leakedStripe = secretKey ?? "";'),
  },
  {
    name: "array-destructure-alias-then-emit",
    rule: "provenance",
    ...afterClassification("  const [leakedFirst] = [secretKey];\n  console.warn(leakedFirst);"),
  },
  {
    name: "unknown-terminal-sink",
    rule: "provenance",
    ...afterClassification('  reportGateway({ secretKey, kind: "stripe" });'),
  },

  // Independent exact-shape regressions for the governing g1 review findings.
  {
    name: "ambient-env-object-alias-reread",
    rule: "ambient-ownership",
    ...afterClassification(
      "  const ambientStripeEnvironment = process.env;\n  const leakedSecretKey = ambientStripeEnvironment.STRIPE_SECRET_KEY;\n  console.warn(leakedSecretKey);",
    ),
  },
  {
    name: "nested-return-retaining-object-escape",
    rule: "provenance",
    ...afterClassification(
      "  function leakFromNestedScope() { return { secretKey }; }\n  console.warn(leakFromNestedScope());",
    ),
  },
  {
    name: "conditional-truthiness-to-unknown-call",
    rule: "provenance",
    ...afterClassification('  console.warn(secretKey ? "configured" : "absent");'),
  },
  {
    name: "prefix-not-truthiness-to-unknown-call",
    rule: "provenance",
    ...afterClassification("  console.warn(!secretKey);"),
  },

  // AC-C3 / AC-08.
  {
    name: "second-classifier-call",
    rule: "single-classifier",
    ...afterClassification("  const secondClassification = classifyStripeKeys(secretKey, publishableKey);"),
  },

  // --- AC-F2 clause (1S): the six return-closure controls, five executed by the governing review ---
  {
    name: "folded-planted-key-to-gateway",
    rule: "return-closure",
    steps: [plantIntoGateway('"sk_live_" + "SYNTHETIC_REVIEW_ONLY"')],
  },
  {
    name: "template-planted-key-to-gateway",
    rule: "return-closure",
    steps: [plantIntoGateway('`sk_live_${"SYNTHETIC_REVIEW_ONLY"}`')],
  },
  {
    name: "regex-source-planted-key-to-gateway",
    rule: "return-closure",
    steps: [plantIntoGateway("/sk_live_SYNTHETIC_REVIEW_ONLY/.source")],
  },
  {
    name: "getter-planted-key-to-gateway",
    rule: "return-closure",
    steps: [
      {
        anchor: GATEWAY_SECRET_KEY_ANCHOR,
        replacement:
          '          kind: "stripe",\n          get secretKey() {\n            return "sk_live_SYNTHETIC_REVIEW_ONLY";\n          },\n          publishableKey,',
      },
    ],
  },
  {
    name: "tagged-template-planted-key-to-gateway",
    rule: "return-closure",
    steps: [plantIntoGateway("String.raw`sk_live_SYNTHETIC_REVIEW_ONLY`")],
  },
  {
    // The sixth form is chosen here rather than in the brief and is named in no receipt on this
    // lineage: an element access on an array literal, which lands in the relation's default arm.
    name: "unenumerated-expression-form-to-gateway",
    rule: "return-closure",
    steps: [plantIntoGateway('["sk_live_SYNTHETIC_REVIEW_ONLY"][0]')],
  },

  // --- Clause (1S) cross-key joins: no planted literal, only the two declared credentials swapped --
  {
    // Both credentials are required for this construction to exist, so this hands the *publishable*
    // credential to Stripe as the server secret while every other rule stays clean. The scalar
    // strength order ranked `acquired-secret` above `acquired-publishable` and reported the join as
    // the stronger member, which is exactly what the set-valued join now refuses to do.
    name: "cross-key-join-to-secret-sink",
    rule: "return-closure",
    steps: [plantIntoGateway("publishableKey ?? secretKey")],
  },
  {
    // The mirror at the publishable sink, filed now rather than left for a later review. The old
    // ordering already reddened it, but only incidentally — because `acquired-secret` outranked
    // `acquired-publishable` rather than because the join was mixed. It is pinned here so the
    // symmetry survives any future change to the source set.
    name: "cross-key-join-to-publishable-sink",
    rule: "return-closure",
    steps: [plantIntoPublishableSink("secretKey ?? publishableKey")],
  },
  {
    // The same mechanism with a non-credential source: an unrelated environment read joined to the
    // secret ranked below it and was hidden by the identical collapse.
    name: "foreign-source-join-to-secret-sink",
    rule: "return-closure",
    steps: [plantIntoGateway("apiBaseUrl ?? secretKey")],
  },

  // --- AC-F2 clause (1f): ambient ownership, decided as nearest-enclosing-function attribution ----
  {
    name: "nested-ambient-inside-allowed-helper",
    rule: "ambient-ownership",
    steps: [
      {
        anchor: OPTIONAL_ENV_READ_ANCHOR,
        replacement: `  const nestedAmbientReader = () => process.env[name];\n${OPTIONAL_ENV_READ_ANCHOR}`,
      },
    ],
  },
  {
    name: "future-ambient-helper",
    rule: "ambient-ownership",
    steps: [
      {
        anchor: OPTIONAL_ENV_HELPER_ANCHOR,
        replacement: `export function getFutureAmbientHelper(name: string) {\n  return process.env[name] ?? null;\n}\n\n${OPTIONAL_ENV_HELPER_ANCHOR}`,
      },
    ],
  },

  // --- AC-F2: the seven ownership-universe transports the loader-only boundary admitted ------------
  {
    name: "outer-binding-direct",
    rule: "identifier-resolution",
    ...afterClassification("  console.warn(outerSecretAlias);"),
  },
  {
    name: "zero-arg-helper-return",
    rule: "callee-roles",
    ...afterClassification(
      "  const transportedSecret = readSecretFromOuterScope();\n  console.warn(transportedSecret);",
    ),
  },
  {
    name: "outer-object-property",
    rule: "identifier-resolution",
    ...afterClassification("  console.warn(outerEnvironmentBag.STRIPE_SECRET_KEY);"),
  },
  {
    name: "closure-capture",
    rule: "nested-constructs",
    ...afterClassification("  const captureSecret = () => secretKey;\n  console.warn(captureSecret());"),
  },
  {
    name: "reflect-apply-helper",
    rule: "callee-roles",
    ...afterClassification('  console.warn(Reflect.apply(getOptionalEnv, undefined, ["STRIPE_SECRET_KEY"]));'),
  },
  {
    name: "destructure-default-rest-from-outer-object",
    rule: "identifier-resolution",
    ...afterClassification(
      '  const { STRIPE_SECRET_KEY: destructuredSecret = "", ...restOfEnvironment } = outerEnvironmentBag;\n  console.warn(destructuredSecret, restOfEnvironment);',
    ),
  },
  {
    name: "imported-binding-transport",
    rule: "identifier-resolution",
    steps: [
      {
        anchor: CONFIG_SCHEMA_IMPORT_ANCHOR,
        replacement: `${CONFIG_SCHEMA_IMPORT_ANCHOR}\n${SYNTHETIC_IMPORT_KEYWORD} { importedSecretTransport } ${SYNTHETIC_FROM_KEYWORD} "./imported-secret-transport";`,
      },
      {
        anchor: CLASSIFICATION_CALL_ANCHOR,
        replacement: `${CLASSIFICATION_CALL_ANCHOR}\n  console.warn(importedSecretTransport);`,
      },
    ],
  },

  // --- AC-F2: the ten carried escapes, unchanged in name and shape ---------------------------------
  {
    name: "nested-destructure-from-process-global",
    rule: "ambient-ownership",
    ...afterClassification(
      "  const {\n    env: { STRIPE_SECRET_KEY: nestedSecret },\n  } = process;\n  console.warn(nestedSecret);",
    ),
  },
  {
    name: "nested-destructure-computed-env-key",
    rule: "selection-determinacy",
    ...afterClassification(
      '  const computedSecretName = "STRIPE_SECRET_KEY";\n  const { [computedSecretName]: computedSecret } = process.env;\n  console.warn(computedSecret);',
    ),
  },
  {
    name: "process-alias-then-nested-destructure",
    rule: "ambient-ownership",
    ...afterClassification(
      "  const processAlias = process;\n  const {\n    env: { STRIPE_SECRET_KEY: aliasedSecret },\n  } = processAlias;\n  console.warn(aliasedSecret);",
    ),
  },
  {
    name: "globalThis-nested-destructure",
    rule: "ambient-ownership",
    ...afterClassification(
      "  const globalSecret = globalThis.process.env.STRIPE_SECRET_KEY;\n  console.warn(globalSecret);",
    ),
  },
  {
    name: "publishable-nested-destructure",
    rule: "ambient-ownership",
    ...afterClassification(
      "  const {\n    env: { STRIPE_PUBLISHABLE_KEY: nestedPublishable },\n  } = process;\n  console.warn(nestedPublishable);",
    ),
  },
  {
    name: "nested-destructure-then-retain",
    rule: "ambient-ownership",
    ...afterClassification(
      "  const {\n    env: { STRIPE_SECRET_KEY: retainedSecret },\n  } = process;\n  const retainer = { secretKey: retainedSecret };\n  console.warn(retainer);",
    ),
  },
  {
    name: "template-literal-env-name-secret",
    rule: "protected-names",
    ...afterClassification(
      "  const secondSecret = getOptionalEnv(`STRIPE_SECRET_KEY`);\n  console.warn(secondSecret);",
    ),
  },
  {
    name: "template-literal-env-name-publishable",
    rule: "protected-names",
    ...afterClassification(
      "  const secondPublishable = getOptionalEnv(`STRIPE_PUBLISHABLE_KEY`);\n  console.warn(secondPublishable);",
    ),
  },
  {
    name: "concatenated-env-name",
    rule: "protected-names",
    ...afterClassification(
      '  const foldedSecret = getOptionalEnv("STRIPE_" + "SECRET_KEY");\n  console.warn(foldedSecret);',
    ),
  },
  {
    name: "reflect-get-env",
    rule: "callee-roles",
    ...afterClassification('  console.warn(Reflect.get(process.env, "STRIPE_SECRET_KEY"));'),
  },

  // --- AC-F2: two default-arm discriminators naming none of the rules' admitted tokens -------------
  {
    name: "unresolvable-container-unresolvable-key",
    rule: "selection-determinacy",
    ...afterClassification(
      "  const opaqueContainer = buildOpaqueContainer();\n  const opaqueKey = deriveOpaqueKey();\n  const selected = opaqueContainer[opaqueKey];\n  console.warn(selected);",
    ),
  },
  {
    name: "unresolvable-name-text-acquisition",
    rule: "callee-roles",
    ...afterClassification(
      "  const derivedName = buildEnvironmentName();\n  const derivedSecret = getOptionalEnv(derivedName);\n  console.warn(derivedSecret);",
    ),
  },
];

/** Each of these must redden exactly one named clause, so no clause can hide behind another. */
const SINGLE_CLAUSE_DISCRIMINATORS: readonly NamedSourceMutant[] = [
  {
    name: "wrapped-protected-text-at-non-admitted-consumer",
    rule: "protected-names",
    ...afterClassification('  const wrappedProtectedText = ("STRIPE_SECRET_KEY" as string) satisfies string;'),
  },
  {
    name: "unresolvable-index-on-inert-array",
    rule: "selection-determinacy",
    ...afterClassification(
      '  const inertArray = ["alpha", "beta"];\n  const inertSelection = inertArray[connectAccountsApi];',
    ),
  },
  {
    name: "planted-key-shaped-literal",
    rule: "literal-source",
    ...afterClassification('  const plantedKeyShapedLiteral = "sk_live_SYNTHETIC_REVIEW_ONLY";'),
  },
];

const GREEN_STYLE_CONTROLS: readonly Readonly<{ name: string; anchor: string; replacement: string }>[] = [
  {
    name: "classifier-as-arrow-const",
    anchor: CLASSIFIER_DECLARATION_ANCHOR,
    replacement: CLASSIFIER_ARROW_REPLACEMENT,
  },
  {
    name: "classifier-property-assignment-control",
    anchor: CLASSIFIER_RETURN_ANCHOR,
    replacement:
      "  return { serverKeyMode: serverKeyMode, serverKeyClass: serverKeyClass, publishableKeyMode: publishableKeyMode };",
  },
  {
    name: "classifier-one-local-binding-control",
    anchor: CLASSIFIER_RETURN_ANCHOR,
    replacement: "  const classified = { serverKeyMode, serverKeyClass, publishableKeyMode };\n  return classified;",
  },
  {
    // Clause (1a) governs environment-variable *names*, so all four declared wrapper forms coalesce
    // into exactly one occurrence at the acquisition position and the value stays `acquired-secret`.
    name: "wrapper-chain-acquisition",
    anchor: ACQUISITION_CALL_ANCHOR,
    replacement: 'getOptionalEnv(((("STRIPE_SECRET_KEY" as string) satisfies string))!)',
  },
  {
    // A `+` fold at the same position, still exactly one coalesced occurrence: folding a name is
    // inert, while clause (1P) refuses a folded *value* at the operator-token dispatch.
    name: "folded-acquisition",
    anchor: ACQUISITION_CALL_ANCHOR,
    replacement: 'getOptionalEnv("STRIPE_" + "SECRET_KEY")',
  },
  {
    // Ordinary indexing stays admitted, so the grammar refuses unplaceable denotation rather than
    // incidental syntax. This inert array never reaches the return closure.
    name: "resolvable-index-on-inert-array",
    anchor: CLASSIFICATION_CALL_ANCHOR,
    replacement: `${CLASSIFICATION_CALL_ANCHOR}\n  const inertArray = ["alpha", "beta"];\n  const inertSelection = inertArray[0];`,
  },
  {
    // A body-less overload is erased and can never host an ambient occurrence, so it changes neither
    // the host count nor the occurrence count.
    name: "overload-signature-erased",
    anchor: OPTIONAL_ENV_HELPER_ANCHOR,
    replacement: `export function getOptionalEnv(name: string): string | null;\n${OPTIONAL_ENV_HELPER_ANCHOR}`,
  },
];

const EMPTY_PROVENANCE_REPORT: StripeProvenanceReport = {
  "classifier-calls": [],
  "classifier-positions": [],
  "classifier-return": [],
  "refusal-constructor": [],
  "refusal-branches": [],
  "return-closure": [],
  "kind-totality": [],
  "protected-names": [],
  "identifier-resolution": [],
  "callee-roles": [],
  "nested-constructs": [],
  "ambient-ownership": [],
  "selection-determinacy": [],
  "literal-source": [],
  "parameter-pin": [],
  "missing-config-vocabulary": [],
  provenance: [],
  "single-classifier": [],
};

describe("Stripe key classification provenance", () => {
  it("the clean candidate satisfies every rule with no violation anywhere", () => {
    expect(evaluateConfigSchemaProvenance(CONFIG_SCHEMA_SOURCE)).toEqual(EMPTY_PROVENANCE_REPORT);
    expect(evaluatePlatformApiClassifierShape(PLATFORM_API_CONFIG_SOURCE)).toEqual([]);
  });

  for (const control of GREEN_STYLE_CONTROLS) {
    it(`green control ${control.name} keeps every rule clean`, () => {
      const mutated = mutateSource(CONFIG_SCHEMA_SOURCE, control.anchor, control.replacement);
      expect(mutated).not.toBe(CONFIG_SCHEMA_SOURCE);
      expect(evaluateConfigSchemaProvenance(mutated)).toEqual(EMPTY_PROVENANCE_REPORT);
    });
  }

  for (const mutant of [...CONFIG_SCHEMA_MUTANTS, ...SINGLE_CLAUSE_DISCRIMINATORS]) {
    it(`mutant ${mutant.name} reddens ${mutant.rule} on its own`, () => {
      const mutated = applyMutantSteps(CONFIG_SCHEMA_SOURCE, mutantSteps(mutant));
      expect(mutated).not.toBe(CONFIG_SCHEMA_SOURCE);

      const report = evaluateConfigSchemaProvenance(mutated);
      // The named rule must fail by itself: no global "at least one violation somewhere" backstop.
      expect(report[mutant.rule]).not.toEqual([]);
    });
  }

  for (const discriminator of SINGLE_CLAUSE_DISCRIMINATORS) {
    it(`single-clause discriminator ${discriminator.name} reddens exactly ${discriminator.rule}`, () => {
      const mutated = applyMutantSteps(CONFIG_SCHEMA_SOURCE, mutantSteps(discriminator));
      const report = evaluateConfigSchemaProvenance(mutated);
      const reddened = Object.entries(report)
        .filter(([, violations]) => violations.length > 0)
        .map(([rule]) => rule);

      expect(reddened).toEqual([discriminator.rule]);
    });
  }

  it("every rule is exercised by at least one named mutant", () => {
    const covered = new Set([...CONFIG_SCHEMA_MUTANTS, ...SINGLE_CLAUSE_DISCRIMINATORS].map((mutant) => mutant.rule));
    expect([...covered].sort()).toEqual(
      [
        "ambient-ownership",
        "callee-roles",
        "classifier-calls",
        "classifier-positions",
        "classifier-return",
        "identifier-resolution",
        "literal-source",
        "nested-constructs",
        "protected-names",
        "provenance",
        "refusal-branches",
        "refusal-constructor",
        "return-closure",
        "selection-determinacy",
        "single-classifier",
      ].sort(),
    );
  });

  it("clause (1K): the SyntaxKind universe is derived from the compiler package, never authored", () => {
    const partition = deriveSyntaxKindPartition();

    expect(partition.distinctKinds).toBeGreaterThan(partition.admittedArms.length);
    expect(partition.compilerVersion).toMatch(/^\d+\.\d+\.\d+/);
    for (const arm of partition.admittedArms) {
      expect(typeof arm.kind).toBe("number");
    }
    expect(new Set(partition.admittedArms.map((arm) => arm.kind)).size).toBe(partition.admittedArms.length);
    // Published as the derivation artefact; the count is reported, never contractually pinned.
    console.log(
      `[clause-1K] ${JSON.stringify({
        distinctKinds: partition.distinctKinds,
        admittedArms: partition.admittedArms.map((arm) => arm.name),
        refusedKinds: partition.refusedKinds,
        compilerVersion: partition.compilerVersion,
        command: partition.command,
      })}`,
    );
  });

  it("clause (1S): the sink inventory agrees with its own traversal", () => {
    const inventory = deriveReturnClosure(parseModule(CONFIG_SCHEMA_PATH, CONFIG_SCHEMA_SOURCE));
    expect(inventory).not.toBeNull();
    if (!inventory) {
      return;
    }

    expect(inventory.refusedExpressions).toEqual([]);
    expect(inventory.secretKeySinks).toBe(inventory.sinks.filter((sink) => sink.name === "secretKey").length);
    expect(inventory.publishableKeySinks).toBe(inventory.sinks.filter((sink) => sink.name === "publishableKey").length);
    for (const sink of inventory.sinks) {
      // Exactly the singleton, not merely containing it: a mixed-source set fails here too.
      if (sink.name === "secretKey") {
        expect(sink.provenance).toEqual(["acquired-secret"]);
      }
      if (sink.name === "publishableKey") {
        expect(sink.provenance).toEqual(["acquired-publishable"]);
      }
    }
    console.log(
      `[clause-1S] ${JSON.stringify({
        closureExpressions: inventory.expressions,
        refusedExpressions: inventory.refusedExpressions.length,
        secretKeySinks: inventory.secretKeySinks,
        publishableKeySinks: inventory.publishableKeySinks,
        sinkNames: inventory.sinks.map((sink) => `${sink.name}:${describeSources(sink.provenance)}`),
      })}`,
    );
  });

  it("clause (1f): the clean module reports its derived ambient hosts and occurrences", () => {
    const inventory = deriveAmbientOwnership(parseModule(CONFIG_SCHEMA_PATH, CONFIG_SCHEMA_SOURCE));

    expect(inventory.violations).toEqual([]);
    expect(inventory.hosts).toEqual([...AMBIENT_HOST_NAMES].sort());
    expect(inventory.occurrences).toHaveLength(inventory.hosts.length);
    console.log(`[clause-1f] ${JSON.stringify({ hosts: inventory.hosts, occurrences: inventory.occurrences })}`);
  });

  it("clause (1c): the loader's derived free value-identifier inventory is reported", () => {
    const inventory = deriveLoaderFreeIdentifiers(parseModule(CONFIG_SCHEMA_PATH, CONFIG_SCHEMA_SOURCE));

    for (const name of inventory.keys()) {
      expect(ADMITTED_LOADER_FREE_NAMES.has(name)).toBe(true);
    }
    console.log(`[clause-1c] ${JSON.stringify(Object.fromEntries([...inventory].sort()))}`);
  });

  it("mutant duplicated-regex-classifier reddens the platform-api classifier shape", () => {
    const mutated = mutateSource(
      PLATFORM_API_CONFIG_SOURCE,
      LIVE_SECRET_KEY_LIKELY_ANCHOR,
      '      liveSecretKeyLikely: /^(?:sk|rk)_live_/.test(stripeProvider.secretKey ?? ""),',
    );
    expect(evaluatePlatformApiClassifierShape(mutated)).not.toEqual([]);
  });

  it("mutant character-slice-classifier reddens the platform-api classifier shape", () => {
    const mutated = mutateSource(
      PLATFORM_API_CONFIG_SOURCE,
      LIVE_SECRET_KEY_LIKELY_ANCHOR,
      '      liveSecretKeyLikely: (stripeProvider.secretKey ?? "").slice(3, 8) === "live_",',
    );
    expect(evaluatePlatformApiClassifierShape(mutated)).not.toEqual([]);
  });

  it("counts exactly seven refusal branches carrying the normative K1-K7 reason sequence", () => {
    const source = parseModule(CONFIG_SCHEMA_PATH, CONFIG_SCHEMA_SOURCE);
    const loader = findFunctionLike(source, LOADER_NAME);
    expect(loader?.body).toBeDefined();

    const branches = loader?.body ? refusalBranchesOf(loader.body) : [];
    expect(branches).toHaveLength(7);
    expect(branches.map((branch) => reasonLiteralOf(branch))).toEqual([...EXPECTED_BRANCH_REASONS]);
  });
});

// --- AC-C3: the runtime caller proof and the shared-classification behavioural controls ------------

const SYNTHETIC_API_PAYMENTS_WEBHOOK_SECRET = "whsec_SYNTHETICAPIPAYMENTS";
const SYNTHETIC_API_CONNECT_WEBHOOK_SECRET = "whsec_SYNTHETICAPICONNECT";

function loadStripeProviderForApi(secretKey: string | null, publishableKey: string | null, environment: string) {
  if (secretKey === null) {
    delete process.env.STRIPE_SECRET_KEY;
  } else {
    process.env.STRIPE_SECRET_KEY = secretKey;
  }
  if (publishableKey === null) {
    delete process.env.STRIPE_PUBLISHABLE_KEY;
  } else {
    process.env.STRIPE_PUBLISHABLE_KEY = publishableKey;
  }
  process.env.STRIPE_WEBHOOK_SECRET = SYNTHETIC_API_PAYMENTS_WEBHOOK_SECRET;
  process.env.STRIPE_CONNECT_WEBHOOK_SECRET = SYNTHETIC_API_CONNECT_WEBHOOK_SECRET;
  process.env.DEPLOYMENT_ENVIRONMENT = environment;

  return loadStripeProviderConfig({
    productionLike: false,
    productionMissingConfigError:
      "STRIPE_SECRET_KEY, STRIPE_PUBLISHABLE_KEY, STRIPE_WEBHOOK_SECRET, and STRIPE_CONNECT_WEBHOOK_SECRET are required for Stripe payment processing and Connect money movement in production.",
  });
}

/**
 * The classification is observable whether the load is admitted or refused: an admitted load carries
 * it on the returned config, and a refusal reports it through the bounded refusal constructor.
 */
function observeServerKeyMode(secretKey: string | null, environment: string): string {
  try {
    return loadStripeProviderForApi(secretKey, null, environment).keyClassification.serverKeyMode;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const matched = /serverKeyMode=([a-z]+)/.exec(message);
    return matched?.[1] ?? "unobserved";
  }
}

/** Mirrors the AST-pinned `liveSecretKeyLikely` initializer asserted above. */
function liveSecretKeyLikelyFrom(serverKeyMode: string): boolean {
  return serverKeyMode === "live";
}

describe("AC-C3 shared Stripe key classification across runtime sites", () => {
  it("exposes effectiveMode and keyClassification to the platform-api caller", () => {
    const provider = loadStripeProviderForApi("sk_test_SYNTHETICAPI", "pk_test_SYNTHETICAPI", "dev");

    expect(provider.keyClassification).toEqual({
      serverKeyMode: "test",
      serverKeyClass: "standard",
      publishableKeyMode: "test",
    });
    expect(provider.effectiveMode).toBe("test");
    expect(liveSecretKeyLikelyFrom(provider.keyClassification.serverKeyMode)).toBe(false);
  });

  it("derives the go-live diagnostic from the shared classification", () => {
    process.env.DATABASE_URL = "postgresql://localhost/chase_sets";
    process.env.STRIPE_SECRET_KEY = "sk_test_SYNTHETICAPI";
    process.env.STRIPE_PUBLISHABLE_KEY = "pk_test_SYNTHETICAPI";
    process.env.STRIPE_WEBHOOK_SECRET = SYNTHETIC_API_PAYMENTS_WEBHOOK_SECRET;
    process.env.STRIPE_CONNECT_WEBHOOK_SECRET = SYNTHETIC_API_CONNECT_WEBHOOK_SECRET;

    expect(loadConfig().stripeGoLive.liveSecretKeyLikely).toBe(false);
    expect(liveSecretKeyLikelyFrom(observeServerKeyMode("sk_test_SYNTHETICAPI", "dev"))).toBe(false);
  });

  it("reports restricted live authority that the pre-change predicate missed", () => {
    // rk_live_ is refused in every environment — K4 outside production and K7 inside it — so the
    // classification is observed through the bounded refusal rather than through an admitted boot.
    const serverKeyMode = observeServerKeyMode("rk_live_SYNTHETICAPI", "staging");
    expect(serverKeyMode).toBe("live");
    expect(liveSecretKeyLikelyFrom(serverKeyMode)).toBe(true);

    // The discriminating fact: the pre-change predicate reported false for the same value.
    expect("rk_live_SYNTHETICAPI".startsWith("sk_live")).toBe(false);
  });

  it("reports false for rk_test_, sk_test_, and an absent secret key", () => {
    expect(liveSecretKeyLikelyFrom(observeServerKeyMode("rk_test_SYNTHETICAPI", "dev"))).toBe(false);
    expect(liveSecretKeyLikelyFrom(observeServerKeyMode("sk_test_SYNTHETICAPI", "dev"))).toBe(false);
    expect(liveSecretKeyLikelyFrom(observeServerKeyMode(null, "dev"))).toBe(false);
  });
});

// -------------------------------------------------------------------------------------------------
// AC-F2 clause (1j), caller side — the complete, symbol-resolved `loadStripeProviderConfig` inventory.
//
// Call identity is TypeScript symbol resolution to the exported declaration in
// `infrastructure/platform-runtime/config-schema.ts`, never the callee's spelling and never a
// bare-name or substring text match, so a call is discovered whether it is reached through a direct
// import, a renamed import, a namespace or property access, or a re-export chain of any depth. Every
// unresolved callee symbol, parse failure, and project or file-discovery failure refuses with its own
// named guard error rather than a silent empty pass.
//
// Stated limit: a module specifier that resolves outside this repository's own executable source
// (an external package) is outside the analysed project graph by construction and is reported as
// such rather than refused. A local value binding is likewise not a module-system alias.
// -------------------------------------------------------------------------------------------------

const REPOSITORY_ROOT = normalizeAnalysisPath(join(stripeProvenanceTestDirectory, "../../.."));
const EXECUTABLE_SOURCE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".mjs", ".cjs"] as const;
const NON_SOURCE_DIRECTORY_NAMES = new Set([
  ".git",
  ".cache",
  ".next",
  ".turbo",
  ".vite",
  "artifacts",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "out",
  "playwright-report",
  "test-results",
]);

type DiscoveryFailureCode = "discovery-project-failure" | "discovery-parse-failure" | "discovery-unresolved-symbol";

class LoaderDiscoveryError extends Error {
  constructor(
    readonly code: DiscoveryFailureCode,
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = "LoaderDiscoveryError";
  }
}

function normalizeAnalysisPath(value: string): string {
  return value.replace(/\\/g, "/");
}

function analysisKey(value: string): string {
  return normalizeAnalysisPath(value).toLowerCase();
}

const ANALYSIS_EXTENSIONS: readonly Readonly<{ suffix: string; extension: ts.Extension }>[] = [
  { suffix: ".tsx", extension: ts.Extension.Tsx },
  { suffix: ".mts", extension: ts.Extension.Mts },
  { suffix: ".cts", extension: ts.Extension.Cts },
  { suffix: ".ts", extension: ts.Extension.Ts },
  { suffix: ".mjs", extension: ts.Extension.Mjs },
  { suffix: ".cjs", extension: ts.Extension.Cjs },
  { suffix: ".jsx", extension: ts.Extension.Jsx },
  { suffix: ".js", extension: ts.Extension.Js },
];

function analysisExtension(path: string): ts.Extension {
  return ANALYSIS_EXTENSIONS.find((entry) => path.endsWith(entry.suffix))?.extension ?? ts.Extension.Ts;
}

type RepositoryScan = Readonly<{
  files: readonly string[];
  specifiers: ReadonlyMap<string, readonly string[]>;
  workspaceExports: ReadonlyMap<string, string>;
  workspaceExportPatterns: readonly Readonly<{ prefix: string; suffix: string; target: string }>[];
}>;

type DiscoveryPorts = Readonly<{
  listSourceFiles: () => readonly string[];
  readSource: (path: string) => string;
}>;

function walkRepositorySources(root: string): readonly string[] {
  const found: string[] = [];
  const visit = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = normalizeAnalysisPath(join(directory, entry.name));
      if (entry.isDirectory()) {
        if (!NON_SOURCE_DIRECTORY_NAMES.has(entry.name)) {
          visit(absolute);
        }
        continue;
      }
      if (EXECUTABLE_SOURCE_EXTENSIONS.some((extension) => absolute.endsWith(extension))) {
        found.push(absolute);
      }
    }
  };
  visit(root);

  return found;
}

function collectWorkspaceExports(root: string): {
  exact: Map<string, string>;
  patterns: { prefix: string; suffix: string; target: string }[];
} {
  const exact = new Map<string, string>();
  const patterns: { prefix: string; suffix: string; target: string }[] = [];
  const visit = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = normalizeAnalysisPath(join(directory, entry.name));
      if (entry.isDirectory()) {
        if (!NON_SOURCE_DIRECTORY_NAMES.has(entry.name)) {
          visit(absolute);
        }
        continue;
      }
      if (entry.name !== "package.json") {
        continue;
      }

      const manifest: unknown = JSON.parse(readFileSync(absolute, "utf8"));
      if (typeof manifest !== "object" || manifest === null) {
        continue;
      }
      const name = (manifest as { name?: unknown }).name;
      const exportsField = (manifest as { exports?: unknown }).exports;
      if (typeof name !== "string" || typeof exportsField !== "object" || exportsField === null) {
        continue;
      }

      const packageDirectory = normalizeAnalysisPath(dirname(absolute));
      for (const [key, value] of Object.entries(exportsField as Record<string, unknown>)) {
        const target = typeof value === "string" ? value : undefined;
        if (!target) {
          continue;
        }
        const resolved = normalizeAnalysisPath(join(packageDirectory, target.replace(/^\.\//, "")));
        const specifier = key === "." ? name : `${name}/${key.replace(/^\.\//, "")}`;
        if (!specifier.includes("*")) {
          exact.set(specifier, resolved);
          continue;
        }
        const [prefix = "", suffix = ""] = specifier.split("*");
        patterns.push({ prefix, suffix, target: resolved });
      }
    }
  };
  visit(root);

  return { exact, patterns };
}

let cachedRepositoryScan: RepositoryScan | null = null;

/**
 * File discovery plus a cheap import-specifier scan of every declared executable source in the
 * repository. A file can reference the exported loader symbol only through a module specifier that
 * resolves to a module aliasing it, so this scan is what makes the later bounded program sound rather
 * than a name-based prefilter.
 */
function scanRepository(ports: DiscoveryPorts): RepositoryScan {
  if (cachedRepositoryScan && ports === DEFAULT_DISCOVERY_PORTS) {
    return cachedRepositoryScan;
  }

  let files: readonly string[];
  let workspace: ReturnType<typeof collectWorkspaceExports>;
  try {
    files = ports.listSourceFiles();
    workspace = collectWorkspaceExports(REPOSITORY_ROOT);
  } catch (error) {
    throw new LoaderDiscoveryError(
      "discovery-project-failure",
      `repository source enumeration failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const specifiers = new Map<string, readonly string[]>();
  for (const file of files) {
    let text: string;
    try {
      text = ports.readSource(file);
    } catch (error) {
      throw new LoaderDiscoveryError(
        "discovery-project-failure",
        `could not read ${file}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    specifiers.set(
      analysisKey(file),
      ts.preProcessFile(text, true, true).importedFiles.map((entry) => entry.fileName),
    );
  }

  const scan: RepositoryScan = {
    files,
    specifiers,
    workspaceExports: workspace.exact,
    workspaceExportPatterns: workspace.patterns,
  };
  if (ports === DEFAULT_DISCOVERY_PORTS) {
    cachedRepositoryScan = scan;
  }

  return scan;
}

const DEFAULT_DISCOVERY_PORTS: DiscoveryPorts = {
  listSourceFiles: () => walkRepositorySources(REPOSITORY_ROOT),
  readSource: (path) => readFileSync(path, "utf8"),
};

function resolveWithinRepository(
  fromFile: string,
  specifier: string,
  scan: RepositoryScan,
  known: ReadonlySet<string>,
): string | null {
  const candidates: string[] = [];
  const push = (base: string) => {
    candidates.push(base);
    for (const extension of EXECUTABLE_SOURCE_EXTENSIONS) {
      candidates.push(`${base}${extension}`);
      candidates.push(normalizeAnalysisPath(join(base, `index${extension}`)));
    }
    const rewritten = base
      .replace(/\.js$/, ".ts")
      .replace(/\.mjs$/, ".mts")
      .replace(/\.cjs$/, ".cts");
    if (rewritten !== base) {
      candidates.push(rewritten);
    }
  };

  if (specifier.startsWith(".")) {
    push(normalizeAnalysisPath(join(dirname(fromFile), specifier)));
  } else {
    const exact = scan.workspaceExports.get(specifier);
    if (exact) {
      push(exact);
    }
    for (const pattern of scan.workspaceExportPatterns) {
      if (specifier.startsWith(pattern.prefix) && specifier.endsWith(pattern.suffix)) {
        const middle = specifier.slice(pattern.prefix.length, specifier.length - (pattern.suffix.length || 0));
        push(pattern.target.replace("*", middle));
      }
    }
  }

  for (const candidate of candidates) {
    if (known.has(analysisKey(candidate))) {
      return candidate;
    }
  }

  return null;
}
type LoaderCallSite = Readonly<{
  file: string;
  line: number;
  callee: string;
  argumentKind: string;
  argumentText: string | null;
  admitted: boolean;
}>;

type LoaderCallerInventory = Readonly<{
  calls: readonly LoaderCallSite[];
  violations: readonly string[];
  aliasModules: readonly string[];
  candidateCallerFiles: readonly string[];
  scannedFiles: number;
}>;

type DiscoveryOptions = Readonly<{
  overlay?: ReadonlyMap<string, string>;
  ports?: DiscoveryPorts;
}>;

/**
 * Clause (1j), caller side. Discovery is: enumerate every declared executable source, derive the set
 * of modules that alias the exported declaration through re-export chains of any depth, build a
 * bounded program over the alias modules and everything importing one, then resolve every call's
 * callee symbol to a declaration. Only a successfully derived inventory may pass.
 */
function discoverLoaderCallers(options: DiscoveryOptions = {}): LoaderCallerInventory {
  const ports = options.ports ?? DEFAULT_DISCOVERY_PORTS;
  const overlay = options.overlay ?? new Map<string, string>();
  const scan = scanRepository(ports);

  const sources = new Map<string, { path: string; text: string }>();
  for (const file of scan.files) {
    sources.set(analysisKey(file), { path: file, text: "" });
  }
  const specifiers = new Map<string, readonly string[]>(scan.specifiers);
  for (const [path, text] of overlay) {
    const normalized = normalizeAnalysisPath(path);
    sources.set(analysisKey(normalized), { path: normalized, text });
    specifiers.set(
      analysisKey(normalized),
      ts.preProcessFile(text, true, true).importedFiles.map((e) => e.fileName),
    );
  }
  const known = new Set(sources.keys());

  const readSource = (path: string): string => {
    const overlaid = overlay.get(path) ?? overlay.get(normalizeAnalysisPath(path));
    if (overlaid !== undefined) {
      return overlaid;
    }

    return ports.readSource(path);
  };

  const configSchemaPath = normalizeAnalysisPath(CONFIG_SCHEMA_PATH);
  if (!known.has(analysisKey(configSchemaPath))) {
    throw new LoaderDiscoveryError("discovery-project-failure", `${configSchemaPath} is not inside the project graph`);
  }

  // --- alias closure: (module, exported name) pairs that alias the exported declaration -----------
  const aliasNames = new Map<string, Set<string>>([[analysisKey(configSchemaPath), new Set([LOADER_NAME])]]);
  const aliasPaths = new Map<string, string>([[analysisKey(configSchemaPath), configSchemaPath]]);
  const parsedCache = new Map<string, ts.SourceFile>();
  const parseAnalysed = (path: string): ts.SourceFile => {
    const key = analysisKey(path);
    const cached = parsedCache.get(key);
    if (cached) {
      return cached;
    }
    const parsed = ts.createSourceFile(path, readSource(path), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    parsedCache.set(key, parsed);

    return parsed;
  };

  const importersOf = (moduleKeys: ReadonlySet<string>): readonly string[] => {
    const importers: string[] = [];
    for (const [fileKey, list] of specifiers) {
      const entry = sources.get(fileKey);
      if (!entry) {
        continue;
      }
      for (const specifier of list) {
        const resolved = resolveWithinRepository(entry.path, specifier, scan, known);
        if (resolved && moduleKeys.has(analysisKey(resolved))) {
          importers.push(entry.path);
          break;
        }
      }
    }

    return importers;
  };

  let grew = true;
  while (grew) {
    grew = false;
    const moduleKeys = new Set(aliasNames.keys());
    for (const importer of importersOf(moduleKeys)) {
      const source = parseAnalysed(importer);
      for (const declaration of collectNodes(source, ts.isExportDeclaration)) {
        const moduleSpecifier = declaration.moduleSpecifier;
        if (!moduleSpecifier || !ts.isStringLiteral(moduleSpecifier)) {
          continue;
        }
        const resolved = resolveWithinRepository(importer, moduleSpecifier.text, scan, known);
        const upstream = resolved ? aliasNames.get(analysisKey(resolved)) : undefined;
        if (!upstream) {
          continue;
        }

        const own = aliasNames.get(analysisKey(importer)) ?? new Set<string>();
        const before = own.size;
        const clause = declaration.exportClause;
        if (!clause) {
          for (const name of upstream) {
            own.add(name);
          }
        } else if (ts.isNamedExports(clause)) {
          for (const element of clause.elements) {
            if (upstream.has((element.propertyName ?? element.name).text)) {
              own.add(element.name.text);
            }
          }
        } else if (ts.isNamespaceExport(clause)) {
          own.add(clause.name.text);
        }

        if (own.size > before) {
          aliasNames.set(analysisKey(importer), own);
          aliasPaths.set(analysisKey(importer), importer);
          grew = true;
        }
      }
    }
  }

  const aliasModuleKeys = new Set(aliasNames.keys());
  const candidateCallerFiles = importersOf(aliasModuleKeys);
  const analysedPaths = [
    ...new Set([...aliasPaths.values(), ...candidateCallerFiles, ...overlay.keys()].map(normalizeAnalysisPath)),
  ];
  const analysedKeys = new Set(analysedPaths.map(analysisKey));

  // --- bounded program: symbol resolution over exactly the alias modules and their importers ------
  const compilerHost: ts.CompilerHost = {
    fileExists: (fileName) => known.has(analysisKey(fileName)),
    readFile: (fileName) => {
      const entry = sources.get(analysisKey(fileName));

      return entry ? readSource(entry.path) : undefined;
    },
    getSourceFile: (fileName) => {
      const entry = sources.get(analysisKey(fileName));

      return entry
        ? ts.createSourceFile(entry.path, readSource(entry.path), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
        : undefined;
    },
    getDefaultLibFileName: () => "lib.d.ts",
    writeFile: () => undefined,
    getCurrentDirectory: () => REPOSITORY_ROOT,
    getCanonicalFileName: (fileName) => analysisKey(fileName),
    useCaseSensitiveFileNames: () => false,
    getNewLine: () => "\n",
    resolveModuleNameLiterals: (literals, containingFile) =>
      literals.map((literal): ts.ResolvedModuleWithFailedLookupLocations => {
        const resolved = resolveWithinRepository(normalizeAnalysisPath(containingFile), literal.text, scan, known);

        return resolved && analysedKeys.has(analysisKey(resolved))
          ? { resolvedModule: { resolvedFileName: resolved, extension: analysisExtension(resolved) } }
          : { resolvedModule: undefined };
      }),
  };

  const program = ts.createProgram({
    rootNames: analysedPaths,
    options: { noLib: true, allowJs: true, target: ts.ScriptTarget.Latest, module: ts.ModuleKind.ESNext },
    host: compilerHost,
  });
  const checker = program.getTypeChecker();

  const declaringSource = program.getSourceFile(aliasPaths.get(analysisKey(configSchemaPath)) ?? configSchemaPath);
  if (!declaringSource) {
    throw new LoaderDiscoveryError("discovery-project-failure", "the declaring module is absent from the program");
  }
  const targetDeclaration = collectNodes(declaringSource, ts.isFunctionDeclaration).find(
    (node) => node.name?.text === LOADER_NAME,
  );
  if (!targetDeclaration) {
    throw new LoaderDiscoveryError("discovery-unresolved-symbol", `${LOADER_NAME} has no exported declaration`);
  }

  const resolveThroughAliases = (symbol: ts.Symbol | undefined): ts.Symbol | undefined => {
    let current = symbol;
    const seen = new Set<ts.Symbol>();
    while (current && (current.flags & ts.SymbolFlags.Alias) !== 0 && !seen.has(current)) {
      seen.add(current);
      const aliased = checker.getAliasedSymbol(current);
      if (!aliased || aliased === current) {
        break;
      }
      current = aliased;
    }

    return current;
  };

  const calls: LoaderCallSite[] = [];
  const violations: string[] = [];
  const vocabulary = new Set(
    deriveDeclaredVocabulary(parseModule(CONFIG_SCHEMA_PATH, readSource(configSchemaPath))) ?? [],
  );

  for (const path of analysedPaths) {
    const sourceFile = program.getSourceFile(path);
    if (!sourceFile) {
      throw new LoaderDiscoveryError("discovery-project-failure", `${path} could not be added to the program`);
    }
    const syntactic = program.getSyntacticDiagnostics(sourceFile);
    if (syntactic.length > 0) {
      throw new LoaderDiscoveryError(
        "discovery-parse-failure",
        `${path}: ${ts.flattenDiagnosticMessageText(syntactic[0]?.messageText, " ")}`,
      );
    }

    for (const binding of collectNodes(sourceFile, ts.isImportSpecifier)) {
      const declaration = binding.parent.parent.parent;
      const moduleSpecifier = declaration.moduleSpecifier;
      if (!ts.isStringLiteral(moduleSpecifier)) {
        continue;
      }
      const resolved = resolveWithinRepository(path, moduleSpecifier.text, scan, known);
      if (!resolved || !analysedKeys.has(analysisKey(resolved))) {
        continue;
      }
      const resolvedSymbol = resolveThroughAliases(checker.getSymbolAtLocation(binding.name));
      if (!resolvedSymbol || (resolvedSymbol.declarations ?? []).length === 0) {
        throw new LoaderDiscoveryError(
          "discovery-unresolved-symbol",
          `${path}: ${binding.name.text} imported from ${moduleSpecifier.text} resolves to no declaration`,
        );
      }
    }

    for (const call of collectNodes(sourceFile, ts.isCallExpression)) {
      const callee = call.expression;
      if (!ts.isIdentifier(callee) && !ts.isPropertyAccessExpression(callee)) {
        continue;
      }
      const resolved = resolveThroughAliases(checker.getSymbolAtLocation(callee));
      if (!resolved || !(resolved.declarations ?? []).includes(targetDeclaration)) {
        continue;
      }

      const line = sourceFile.getLineAndCharacterOfPosition(call.getStart(sourceFile)).line + 1;
      const relative = path.slice(REPOSITORY_ROOT.length + 1);
      const argument = call.arguments.length === 1 ? call.arguments[0] : undefined;
      if (!argument || !ts.isObjectLiteralExpression(argument)) {
        violations.push(`${relative}:${line} does not pass a single object-literal argument`);
        calls.push({
          file: relative,
          line,
          callee: callee.getText(sourceFile),
          argumentKind: "<none>",
          argumentText: null,
          admitted: false,
        });
        continue;
      }

      const property = argument.properties.find(
        (member) =>
          (ts.isPropertyAssignment(member) || ts.isShorthandPropertyAssignment(member)) &&
          member.name !== undefined &&
          ts.isIdentifier(member.name) &&
          member.name.text === MISSING_CONFIG_PARAMETER_NAME,
      );
      if (!property || !ts.isPropertyAssignment(property)) {
        violations.push(`${relative}:${line} does not pass ${MISSING_CONFIG_PARAMETER_NAME} as a plain property`);
        calls.push({
          file: relative,
          line,
          callee: callee.getText(sourceFile),
          argumentKind: "<missing>",
          argumentText: null,
          admitted: false,
        });
        continue;
      }

      const value = property.initializer;
      const isAdmittedLiteral =
        value.kind === ts.SyntaxKind.StringLiteral && vocabulary.has((value as ts.StringLiteral).text);
      if (!isAdmittedLiteral) {
        violations.push(
          `${relative}:${line} passes ${MISSING_CONFIG_PARAMETER_NAME} as ${ts.SyntaxKind[value.kind]}, not an admitted tuple-member string literal`,
        );
      }
      calls.push({
        file: relative,
        line,
        callee: callee.getText(sourceFile),
        argumentKind: ts.SyntaxKind[value.kind],
        argumentText: value.kind === ts.SyntaxKind.StringLiteral ? (value as ts.StringLiteral).text : null,
        admitted: isAdmittedLiteral,
      });
    }
  }

  return {
    calls: [...calls].sort((left, right) =>
      left.file === right.file ? left.line - right.line : left.file < right.file ? -1 : 1,
    ),
    violations,
    aliasModules: [...aliasPaths.values()].map((path) => path.slice(REPOSITORY_ROOT.length + 1)).sort(),
    candidateCallerFiles: candidateCallerFiles.map((path) => path.slice(REPOSITORY_ROOT.length + 1)).sort(),
    scannedFiles: scan.files.length,
  };
}
const SYNTHETIC_REVIEW_DIRECTORY = normalizeAnalysisPath(
  join(REPOSITORY_ROOT, "infrastructure/platform-runtime/__synthetic_review__"),
);
const ADMITTED_TUPLE_MEMBER =
  "STRIPE_SECRET_KEY, STRIPE_PUBLISHABLE_KEY, STRIPE_WEBHOOK_SECRET, and STRIPE_CONNECT_WEBHOOK_SECRET are required for Stripe payment processing and Connect money movement in production.";
const PLATFORM_API_ARGUMENT_ANCHOR = `    productionMissingConfigError:\n      "${ADMITTED_TUPLE_MEMBER}",`;

function syntheticImport(clause: string, specifier: string): string {
  return `${SYNTHETIC_IMPORT_KEYWORD} ${clause} ${SYNTHETIC_FROM_KEYWORD} ${JSON.stringify(specifier)};\n`;
}

function syntheticReexport(clause: string, specifier: string): string {
  return `${SYNTHETIC_EXPORT_KEYWORD} ${clause} ${SYNTHETIC_FROM_KEYWORD} ${JSON.stringify(specifier)};\n`;
}

/** Every future-site and discovery-refusal control is synthetic and adds no tracked repository file. */
function syntheticOverlay(entries: Readonly<Record<string, string>>): ReadonlyMap<string, string> {
  return new Map(
    Object.entries(entries).map(([name, text]) => [
      normalizeAnalysisPath(join(SYNTHETIC_REVIEW_DIRECTORY, name)),
      text,
    ]),
  );
}

function syntheticCallBody(callee: string, argument: string): string {
  return `\nexport function syntheticFutureSite() {\n  return ${callee}({\n    productionLike: false,\n    deploymentEnvironment: "dev",\n    productionMissingConfigError: ${argument},\n  });\n}\n`;
}

const ADMITTED_ARGUMENT_LITERAL = JSON.stringify(ADMITTED_TUPLE_MEMBER);

type FutureSiteControl = Readonly<{
  name: string;
  files: Readonly<Record<string, string>>;
  identifierFiles: Readonly<Record<string, string>>;
}>;

const FUTURE_SITE_CONTROLS: readonly FutureSiteControl[] = [
  {
    name: "future-call-site-direct-import",
    files: {
      "direct-import.ts": `${syntheticImport(`{ ${LOADER_NAME} }`, "../config-schema")}${syntheticCallBody(LOADER_NAME, ADMITTED_ARGUMENT_LITERAL)}`,
    },
    identifierFiles: {
      "direct-import.ts": `${syntheticImport(`{ ${LOADER_NAME} }`, "../config-schema")}const message = ${ADMITTED_ARGUMENT_LITERAL};\n${syntheticCallBody(LOADER_NAME, "message")}`,
    },
  },
  {
    name: "future-call-site-renamed-import",
    files: {
      "renamed-import.ts": `${syntheticImport(`{ ${LOADER_NAME} as loadProviderConfig }`, "../config-schema")}${syntheticCallBody("loadProviderConfig", ADMITTED_ARGUMENT_LITERAL)}`,
    },
    identifierFiles: {
      "renamed-import.ts": `${syntheticImport(`{ ${LOADER_NAME} as loadProviderConfig }`, "../config-schema")}const message = ${ADMITTED_ARGUMENT_LITERAL};\n${syntheticCallBody("loadProviderConfig", "message")}`,
    },
  },
  {
    name: "future-call-site-namespace-access",
    files: {
      "namespace-access.ts": `${syntheticImport("* as configSchema", "../config-schema")}${syntheticCallBody(`configSchema.${LOADER_NAME}`, ADMITTED_ARGUMENT_LITERAL)}`,
    },
    identifierFiles: {
      "namespace-access.ts": `${syntheticImport("* as configSchema", "../config-schema")}const message = ${ADMITTED_ARGUMENT_LITERAL};\n${syntheticCallBody(`configSchema.${LOADER_NAME}`, "message")}`,
    },
  },
  {
    // A two-level re-export whose calling file contains no occurrence of the loader's own spelling:
    // exactly the shape a bare-name scanner cannot see.
    name: "future-call-site-reexport",
    files: {
      "reexport-level-one.ts": syntheticReexport(`{ ${LOADER_NAME} as reexportedLoader }`, "../config-schema"),
      "reexport-level-two.ts": syntheticReexport("*", "./reexport-level-one"),
      "reexport-caller.ts": `${syntheticImport("{ reexportedLoader }", "./reexport-level-two")}${syntheticCallBody("reexportedLoader", ADMITTED_ARGUMENT_LITERAL)}`,
    },
    identifierFiles: {
      "reexport-level-one.ts": syntheticReexport(`{ ${LOADER_NAME} as reexportedLoader }`, "../config-schema"),
      "reexport-level-two.ts": syntheticReexport("*", "./reexport-level-one"),
      "reexport-caller.ts": `${syntheticImport("{ reexportedLoader }", "./reexport-level-two")}const message = ${ADMITTED_ARGUMENT_LITERAL};\n${syntheticCallBody("reexportedLoader", "message")}`,
    },
  },
  {
    // Placed in an otherwise call-free executable file of a declared executable extension.
    name: "future-call-site-call-free-file",
    files: {
      "call-free-file.mts": `${syntheticImport(`{ ${LOADER_NAME} }`, "../config-schema")}${syntheticCallBody(LOADER_NAME, ADMITTED_ARGUMENT_LITERAL)}`,
    },
    identifierFiles: {
      "call-free-file.mts": `${syntheticImport(`{ ${LOADER_NAME} }`, "../config-schema")}const message = ${ADMITTED_ARGUMENT_LITERAL};\n${syntheticCallBody(LOADER_NAME, "message")}`,
    },
  },
];

const CALLER_ARGUMENT_CONTROLS: readonly Readonly<{ name: string; replacement: string }>[] = [
  { name: "caller-passes-identifier", replacement: "    productionMissingConfigError: missingConfigMessage," },
  { name: "caller-passes-template", replacement: `    productionMissingConfigError: \`${ADMITTED_TUPLE_MEMBER}\`,` },
  {
    name: "caller-passes-fold",
    replacement: `    productionMissingConfigError:\n      "${ADMITTED_TUPLE_MEMBER.slice(0, 40)}" + "${ADMITTED_TUPLE_MEMBER.slice(40)}",`,
  },
  {
    name: "caller-passes-assertion",
    replacement: `    productionMissingConfigError:\n      "${ADMITTED_TUPLE_MEMBER}" as PlatformStripeProductionMissingConfigError,`,
  },
  {
    name: "caller-passes-spread",
    replacement: `    ...{ productionMissingConfigError: "${ADMITTED_TUPLE_MEMBER}" },`,
  },
  {
    name: "caller-passes-computed-name",
    replacement: `    ["productionMissingConfigError"]:\n      "${ADMITTED_TUPLE_MEMBER}",`,
  },
  {
    name: "caller-passes-conditional",
    replacement: `    productionMissingConfigError: providerRequired\n      ? "${ADMITTED_TUPLE_MEMBER}"\n      : "${ADMITTED_TUPLE_MEMBER}",`,
  },
  {
    name: "caller-passes-unadmitted-literal",
    replacement: '    productionMissingConfigError: "production Stripe config is required.",',
  },
];

describe("AC-F2 clause (1j) symbol-resolved caller inventory", () => {
  it("reports exactly twelve calls, every argument an admitted tuple-member string literal", () => {
    const inventory = discoverLoaderCallers();

    expect(inventory.violations).toEqual([]);
    expect(inventory.calls).toHaveLength(12);
    expect(inventory.calls.filter((call) => call.argumentKind === "StringLiteral")).toHaveLength(12);
    expect(inventory.calls.every((call) => call.admitted)).toBe(true);
    expect(inventory.calls.filter((call) => call.file.startsWith("deployables/platform-api/src/"))).toHaveLength(1);
    expect(inventory.calls.filter((call) => call.file.startsWith("deployables/platform-worker/src/"))).toHaveLength(1);
    console.log(
      `[clause-1j] ${JSON.stringify({
        scannedFiles: inventory.scannedFiles,
        aliasModules: inventory.aliasModules,
        candidateCallerFiles: inventory.candidateCallerFiles,
        calls: inventory.calls.map((call) => `${call.file}:${call.line} ${call.callee} ${call.argumentKind}`),
      })}`,
    );
  });

  it("no discovered call is fed by an identifier and no PRODUCTION_MISSING_CONFIG_ERROR reference survives", () => {
    const inventory = discoverLoaderCallers();

    expect(inventory.calls.filter((call) => call.argumentKind === "Identifier")).toEqual([]);
    expect(
      readFileSync(join(REPOSITORY_ROOT, "infrastructure/platform-runtime/config-schema.test.ts"), "utf8"),
    ).not.toContain("PRODUCTION_MISSING_CONFIG_ERROR");
  });

  for (const control of CALLER_ARGUMENT_CONTROLS) {
    it(`control ${control.name} reddens the caller rule on its own`, () => {
      const mutated = mutateSource(PLATFORM_API_CONFIG_SOURCE, PLATFORM_API_ARGUMENT_ANCHOR, control.replacement);
      const inventory = discoverLoaderCallers({
        overlay: new Map([[normalizeAnalysisPath(PLATFORM_API_CONFIG_PATH), mutated]]),
      });

      expect(inventory.calls).toHaveLength(12);
      expect(inventory.violations).toHaveLength(1);
    });
  }

  for (const control of FUTURE_SITE_CONTROLS) {
    it(`control ${control.name} raises the derived inventory from twelve to thirteen and is judged`, () => {
      const admitted = discoverLoaderCallers({ overlay: syntheticOverlay(control.files) });
      expect(admitted.calls).toHaveLength(13);
      expect(admitted.violations).toEqual([]);

      const refused = discoverLoaderCallers({ overlay: syntheticOverlay(control.identifierFiles) });
      expect(refused.calls).toHaveLength(13);
      expect(refused.violations).toHaveLength(1);
      expect(refused.violations[0]).toContain("Identifier");
    });
  }

  it("control discovery-unresolved-symbol refuses with its own named guard error", () => {
    expect(() =>
      discoverLoaderCallers({
        overlay: syntheticOverlay({
          "unresolved-symbol.ts": `${syntheticImport(`{ ${LOADER_NAME}, notAnExportedDeclaration }`, "../config-schema")}export const probe = [${LOADER_NAME}, notAnExportedDeclaration];\n`,
        }),
      }),
    ).toThrow(/^discovery-unresolved-symbol: /);
  });

  it("control discovery-parse-failure refuses with its own named guard error", () => {
    expect(() =>
      discoverLoaderCallers({
        overlay: syntheticOverlay({
          "parse-failure.ts": `${syntheticImport(`{ ${LOADER_NAME} }`, "../config-schema")}export function broken( {\n`,
        }),
      }),
    ).toThrow(/^discovery-parse-failure: /);
  });

  it("control discovery-project-failure refuses with its own named guard error", () => {
    expect(() =>
      discoverLoaderCallers({
        ports: {
          listSourceFiles: () => {
            throw new Error("synthetic project enumeration failure");
          },
          readSource: (path) => readFileSync(path, "utf8"),
        },
      }),
    ).toThrow(/^discovery-project-failure: /);
  });

  it("bare grep is only a lower bound and never the authority", () => {
    // Every current call is directly spelled, so the bare-spelling lower bound agrees at twelve. The
    // renamed and re-exported future-site controls above are the shapes it cannot see.
    const inventory = discoverLoaderCallers();
    const spelled = inventory.calls.filter((call) => call.callee.includes(LOADER_NAME));

    expect(spelled).toHaveLength(inventory.calls.length);
  });
});

// -------------------------------------------------------------------------------------------------
// Provider mode observation retention (#7414).
//
// The serving loader retains one closed observation from the single shared Stripe provider load. The
// bootstrap loader never classifies a provider key, so the credential-free bootstrap Job keeps
// loading in staging and production with zero STRIPE_* variables present.
// -------------------------------------------------------------------------------------------------

const PROVIDER_MODE_OBSERVATION_MEMBERS = [
  "deploymentEnvironment",
  "mode",
  "moneyMovementKind",
  "paymentProcessorKind",
] as const;

function setSyntheticStripeTestModeEnv() {
  process.env.DATABASE_URL = "postgresql://localhost/chase_sets";
  process.env.STRIPE_SECRET_KEY = "sk_test_SYNTHETICAPI";
  process.env.STRIPE_PUBLISHABLE_KEY = "pk_test_SYNTHETICAPI";
  process.env.STRIPE_WEBHOOK_SECRET = SYNTHETIC_API_PAYMENTS_WEBHOOK_SECRET;
  process.env.STRIPE_CONNECT_WEBHOOK_SECRET = SYNTHETIC_API_CONNECT_WEBHOOK_SECRET;
}

function setCredentialFreeBootstrapEnv(deploymentEnvironment: string) {
  delete process.env.STRIPE_SECRET_KEY;
  delete process.env.STRIPE_PUBLISHABLE_KEY;
  delete process.env.STRIPE_WEBHOOK_SECRET;
  delete process.env.STRIPE_CONNECT_WEBHOOK_SECRET;
  process.env.DATABASE_URL = "postgresql://localhost/chase_sets";
  process.env.PLATFORM_CONTROL_DATABASE_URL = "postgresql://localhost/control";
  process.env[PLATFORM_INTERNAL_AUTH_SECRET_ENV] = "internal-test-secret";
  process.env.CATALOG_ASSET_STORAGE_KIND = "s3";
  process.env.CATALOG_ASSET_S3_BUCKET = "assets";
  process.env.CATALOG_ASSET_S3_REGION = "nyc3";
  process.env.CATALOG_ASSET_PUBLIC_BASE_URL = "https://assets.chasesets.test";
  process.env.DEPLOYMENT_ENVIRONMENT = deploymentEnvironment;
}

function stripeVariablesPresent() {
  return Object.keys(process.env).filter((name) => name.startsWith("STRIPE_"));
}

describe("platform api provider mode observation", () => {
  it("retains one provider observation in main config", () => {
    setSyntheticStripeTestModeEnv();
    loadStripeProviderConfigCallCount.value = 0;

    const config = loadConfig();

    expect(loadStripeProviderConfigCallCount.value, "the serving loader must classify exactly once").toBe(1);
    expect(config.providerModeObservation).toEqual({
      mode: "test",
      paymentProcessorKind: "stripe",
      moneyMovementKind: "stripe",
      deploymentEnvironment: "dev",
    });
    expect(Object.keys(config.providerModeObservation).sort()).toEqual([...PROVIDER_MODE_OBSERVATION_MEMBERS]);

    // Differing-second-read mutant. A member re-derived from the environment after the load diverges
    // from the retained observation, and the equality asserted above is what turns that mutant red.
    process.env.DEPLOYMENT_ENVIRONMENT = "staging";
    const rereadMutant = {
      ...config.providerModeObservation,
      deploymentEnvironment: loadDeploymentEnvironment(),
    };
    expect(rereadMutant).not.toEqual(config.providerModeObservation);
    expect(config.providerModeObservation.deploymentEnvironment).toBe("dev");
  });

  it("never classifies provider keys in bootstrap config", () => {
    setSyntheticStripeTestModeEnv();
    loadStripeProviderConfigCallCount.value = 0;

    const bootstrapConfig = loadBootstrapConfig();

    expect(loadStripeProviderConfigCallCount.value, "the bootstrap loader must never classify").toBe(0);
    expect(Object.keys(bootstrapConfig)).not.toContain("providerModeObservation");
    expect("providerModeObservation" in bootstrapConfig).toBe(false);
  });

  it("loads bootstrap config with no Stripe variables in staging and production", () => {
    for (const deploymentEnvironment of ["staging", "production"] as const) {
      setCredentialFreeBootstrapEnv(deploymentEnvironment);
      loadStripeProviderConfigCallCount.value = 0;

      expect(stripeVariablesPresent(), `${deploymentEnvironment} must carry zero STRIPE_* variables`).toEqual([]);

      const bootstrapConfig = loadBootstrapConfig();

      expect(bootstrapConfig.deploymentEnvironment).toBe(deploymentEnvironment);
      expect("providerModeObservation" in bootstrapConfig).toBe(false);
      expect(
        loadStripeProviderConfigCallCount.value,
        `${deploymentEnvironment} bootstrap must not reach the classifier`,
      ).toBe(0);

      // The classifier-reintroduction mutant: the same frozen environment run through the serving
      // loader still refuses, which is exactly what adding that call to the bootstrap loader would do
      // to the credential-free Job.
      expect(() => loadConfig(), `${deploymentEnvironment} serving load must still refuse`).toThrow();
    }

    setCredentialFreeBootstrapEnv("staging");
    expect(() => loadConfig()).toThrow(
      "STRIPE_CONNECT_WEBHOOK_SECRET is required when DEPLOYMENT_ENVIRONMENT=staging; staging must use a distinct Connect webhook secret.",
    );
  });

  it("reports the merged 6829 provider test-mode observation without contacting Stripe", () => {
    const transport = vi.spyOn(globalThis, "fetch");

    // Connect-only: a synthetic test-mode secret key plus a Connect webhook secret, with no
    // publishable key, is the supported shape that keeps the payment processor fake while money
    // movement is Stripe. The fixtures are unmistakably synthetic and nothing leaves this process.
    process.env.DATABASE_URL = "postgresql://localhost/chase_sets";
    process.env.STRIPE_SECRET_KEY = "sk_test_SYNTHETICAPI";
    delete process.env.STRIPE_PUBLISHABLE_KEY;
    delete process.env.STRIPE_WEBHOOK_SECRET;
    process.env.STRIPE_CONNECT_WEBHOOK_SECRET = SYNTHETIC_API_CONNECT_WEBHOOK_SECRET;

    const config = loadConfig();

    expect(config.providerModeObservation).toEqual({
      mode: "test",
      paymentProcessorKind: "fake",
      moneyMovementKind: "stripe",
      deploymentEnvironment: "dev",
    });
    expect(config.paymentProcessor.kind).toBe("fake");
    expect(config.moneyMovement.kind).toBe("stripe");
    expect(transport, "the observation is locally configured, never a provider call").not.toHaveBeenCalled();

    transport.mockRestore();
  });

  it("has one Stripe mode classifier and no observation-side classifier", () => {
    const repositoryRoot = normalizeAnalysisPath(join(stripeProvenanceTestDirectory, "../../.."));
    const readRepositorySource = (relativePath: string) => readFileSync(join(repositoryRoot, relativePath), "utf8");

    // Key-classification constructs. A surface that carries any of them is deciding provider mode for
    // itself instead of transporting the single shared decision.
    const classifierConstructs = [
      "classifyStripeKeys",
      "loadStripeProviderConfig",
      "serverKeyMode",
      "serverKeyClass",
      "publishableKeyMode",
      "keyClassification",
      "STRIPE_SECRET_KEY",
      "STRIPE_PUBLISHABLE_KEY",
      "sk_test",
      "sk_live",
      "pk_test",
      "pk_live",
      "rk_test",
      "rk_live",
    ] as const;
    const constructsIn = (source: string) => classifierConstructs.filter((construct) => source.includes(construct));

    // The observation-side surfaces: the Payments contract, handler, router and services, plus the
    // platform host composition and the actor middleware.
    const observationSurfaces = [
      "bounded-contexts/payments/features/payments/api/contracts.ts",
      "bounded-contexts/payments/features/payments/api/route.ts",
      "bounded-contexts/payments/api.ts",
      "bounded-contexts/payments/support/runtime-support/services.ts",
      "deployables/platform-api/src/app.ts",
      "deployables/platform-api/src/middleware/auth-context.ts",
    ] as const;

    for (const surface of observationSurfaces) {
      expect(constructsIn(readRepositorySource(surface)), `${surface} must carry no classifier construct`).toEqual([]);
    }

    // The semantically equivalent widening mutant: a surface that re-derives the mode from the
    // classification under a different spelling is still caught, so this is not a syntax-only guard.
    const wideningMutant = [
      "const mode = keyClassification.serverKeyMode === 'live' ? 'live' : 'test';",
      "export const observedMode = mode;",
    ].join("\n");
    expect(constructsIn(wideningMutant)).toEqual(["serverKeyMode", "keyClassification"]);

    // The single classifier and the single serving-loader call site.
    const classifierSource = readRepositorySource("infrastructure/platform-runtime/config-schema.ts");
    expect(classifierSource.split("export function loadStripeProviderConfig(").length - 1).toBe(1);
    expect(classifierSource.split("function classifyStripeKeys(").length - 1).toBe(1);

    const platformApiConfigSource = readRepositorySource("deployables/platform-api/src/config.ts");
    expect(platformApiConfigSource.split("loadStripeProviderConfig({").length - 1).toBe(1);
    expect(platformApiConfigSource.includes("classifyStripeKeys")).toBe(false);
    expect(platformApiConfigSource.split("effectiveMode").length - 1).toBe(1);
  });
});
