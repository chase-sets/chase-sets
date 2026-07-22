import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PLATFORM_INTERNAL_AUTH_SECRET_ENV } from "@chase-sets/platform-runtime/http";
import { DEFAULT_UCP_SIGNATURE_CREATED_FRESHNESS_WINDOW_MS } from "@chase-sets/platform-runtime/ucp";
import { STRIPE_API_VERSION } from "@chase-sets/stripe-config";
import {
  getContextDatabaseEnvName,
  getContextWaiterDatabaseEnvName,
  getPlatformApiContextsForRuntimeProfile,
  loadBootstrapConfig,
  loadConfig,
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
    process.env.STRIPE_SECRET_KEY = "sk_test";
    process.env.STRIPE_WEBHOOK_SECRET = "whsec_test";
    process.env.STRIPE_CONNECT_WEBHOOK_SECRET = "whsec_connect_test";
    process.env.STRIPE_API_BASE_URL = "https://stripe.test";

    expect(loadConfig().moneyMovement).toEqual({
      kind: "stripe",
      secretKey: "sk_test",
      webhookSecret: "whsec_connect_test",
      previousWebhookSecrets: [],
      connectAccountsApi: "v2",
      apiBaseUrl: "https://stripe.test",
    });
  });

  it("loads explicit Stripe Connect Accounts API posture", () => {
    process.env.DATABASE_URL = "postgresql://localhost/chase_sets";
    process.env.STRIPE_SECRET_KEY = "sk_test";
    process.env.STRIPE_WEBHOOK_SECRET = "whsec_test";
    process.env.STRIPE_CONNECT_WEBHOOK_SECRET = "whsec_connect_test";
    process.env.STRIPE_CONNECT_ACCOUNTS_API = "v1";

    expect(loadConfig().moneyMovement).toEqual({
      kind: "stripe",
      secretKey: "sk_test",
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
    process.env.STRIPE_SECRET_KEY = "sk_test";
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

    expect(() => loadConfig()).toThrow("Live Stripe keys are only allowed when DEPLOYMENT_ENVIRONMENT=production.");
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
