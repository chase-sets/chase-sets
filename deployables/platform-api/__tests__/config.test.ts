import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import ts from "@chase-sets/typescript-compiler-api";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadStripeProviderConfig } from "@chase-sets/platform-runtime/config-schema";
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

function isAmbientEnvironmentObject(node: ts.Node): boolean {
  return (
    (ts.isPropertyAccessExpression(node) && node.name.text === "env") ||
    (ts.isElementAccessExpression(node) &&
      node.argumentExpression !== undefined &&
      ts.isStringLiteral(node.argumentExpression) &&
      node.argumentExpression.text === "env")
  );
}

function containsEnvironmentObjectReference(node: ts.Node, environmentObjects: ReadonlySet<string>): boolean {
  let found = false;
  const visit = (current: ts.Node) => {
    if (found) {
      return;
    }
    if (isAmbientEnvironmentObject(current)) {
      found = true;
      return;
    }
    if (ts.isIdentifier(current) && isValueReference(current) && environmentObjects.has(current.text)) {
      found = true;
      return;
    }
    ts.forEachChild(current, visit);
  };
  visit(node);
  return found;
}

/** Ambient environment-container aliases, including aliases introduced through binding patterns. */
function collectEnvironmentObjectBindings(root: ts.Node): ReadonlySet<string> {
  const environmentObjects = new Set<string>();
  const declarations = collectNodes(root, ts.isVariableDeclaration);
  let changed = true;

  while (changed) {
    changed = false;
    for (const declaration of declarations) {
      if (!declaration.initializer) {
        continue;
      }

      let derivesFromEnvironmentObject = containsEnvironmentObjectReference(
        declaration.initializer,
        environmentObjects,
      );
      if (
        !derivesFromEnvironmentObject &&
        ts.isIdentifier(declaration.initializer) &&
        declaration.initializer.text === "process" &&
        ts.isObjectBindingPattern(declaration.name)
      ) {
        derivesFromEnvironmentObject = declaration.name.elements.some((element) => {
          const selected = element.propertyName ?? element.name;
          return ts.isIdentifier(selected) && selected.text === "env";
        });
      }
      if (!derivesFromEnvironmentObject) {
        continue;
      }

      const introduced = new Set<string>();
      collectBoundNames(declaration.name, introduced);
      for (const name of introduced) {
        if (!environmentObjects.has(name)) {
          environmentObjects.add(name);
          changed = true;
        }
      }
    }
  }

  return environmentObjects;
}

/** Reads of a Stripe key environment name, by closed code-shape provenance rather than token text. */
function collectEnvironmentReads(root: ts.Node, environmentName: string): readonly ts.Node[] {
  const reads: ts.Node[] = [];
  const environmentObjects = collectEnvironmentObjectBindings(root);
  const isEnvironmentObject = (node: ts.Node) =>
    isAmbientEnvironmentObject(node) ||
    (ts.isIdentifier(node) && isValueReference(node) && environmentObjects.has(node.text));
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && node.arguments.length === 1) {
      const argument = node.arguments[0];
      if (argument && ts.isStringLiteral(argument) && argument.text === environmentName) {
        reads.push(node);
      }
    }
    if (
      ts.isPropertyAccessExpression(node) &&
      node.name.text === environmentName &&
      isEnvironmentObject(node.expression)
    ) {
      reads.push(node);
    }
    if (ts.isElementAccessExpression(node) && isEnvironmentObject(node.expression)) {
      const argument = node.argumentExpression;
      if (ts.isStringLiteral(argument) && argument.text === environmentName) {
        reads.push(node);
      }
    }

    ts.forEachChild(node, visit);
  };
  visit(root);

  for (const binding of collectNodes(root, ts.isBindingElement)) {
    const selected = binding.propertyName ?? binding.name;
    if (!ts.isIdentifier(selected) || selected.text !== environmentName) {
      continue;
    }
    let ancestor: ts.Node | undefined = binding.parent;
    while (ancestor && !ts.isVariableDeclaration(ancestor)) {
      ancestor = ancestor.parent;
    }
    if (ancestor?.initializer && containsEnvironmentObjectReference(ancestor.initializer, environmentObjects)) {
      reads.push(binding);
    }
  }

  return reads;
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
 * AC-F2: one acquisition per Stripe key environment name, rootedness propagated through every
 * expression form and every binding pattern including nested scopes that capture a rooted outer
 * binding, and termination only at the single classifier call or an exact named retaining property.
 */
function provenanceRule(source: ts.SourceFile): readonly string[] {
  const violations: string[] = [];
  const loader = findFunctionLike(source, LOADER_NAME);
  if (!loader?.body) {
    return [`${LOADER_NAME} was not found`];
  }

  const body = loader.body;

  const rootBindings = new Set<string>();
  for (const environmentName of STRIPE_KEY_ENVIRONMENT_NAMES) {
    const reads = collectEnvironmentReads(body, environmentName);
    if (reads.length !== 1) {
      violations.push(
        `${environmentName} is read ${reads.length} times inside ${LOADER_NAME}; exactly one acquisition is admitted`,
      );
      continue;
    }

    const read = reads[0];
    const declaration = read?.parent;
    if (
      !read ||
      !declaration ||
      !ts.isVariableDeclaration(declaration) ||
      declaration.initializer !== read ||
      !ts.isIdentifier(declaration.name)
    ) {
      violations.push(`${environmentName} is not acquired into exactly one declared root binding`);
      continue;
    }

    rootBindings.add(declaration.name.text);
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

type NamedSourceMutant = Readonly<{
  name: string;
  rule: StripeProvenanceRuleId;
  anchor: string;
  replacement: string;
}>;

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
    rule: "provenance",
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
    rule: "provenance",
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
];

const EMPTY_PROVENANCE_REPORT: StripeProvenanceReport = {
  "classifier-calls": [],
  "classifier-positions": [],
  "classifier-return": [],
  "refusal-constructor": [],
  "refusal-branches": [],
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

  for (const mutant of CONFIG_SCHEMA_MUTANTS) {
    it(`mutant ${mutant.name} reddens ${mutant.rule} on its own`, () => {
      const mutated = mutateSource(CONFIG_SCHEMA_SOURCE, mutant.anchor, mutant.replacement);
      expect(mutated).not.toBe(CONFIG_SCHEMA_SOURCE);

      const report = evaluateConfigSchemaProvenance(mutated);
      // The named rule must fail by itself: no global "at least one violation somewhere" backstop.
      expect(report[mutant.rule]).not.toEqual([]);
    });
  }

  it("every rule is exercised by at least one named mutant", () => {
    const covered = new Set(CONFIG_SCHEMA_MUTANTS.map((mutant) => mutant.rule));
    expect([...covered].sort()).toEqual(
      [
        "classifier-calls",
        "classifier-positions",
        "classifier-return",
        "provenance",
        "refusal-branches",
        "refusal-constructor",
        "single-classifier",
      ].sort(),
    );
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
    productionMissingConfigError: "production Stripe config is required.",
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
