import {
  getApiHostContextNames,
  nonProductionDataProfiles,
  productionLikeDataProfiles,
  type ApiHostContextName,
  type EnvironmentDataProfile,
} from "@chase-sets/platform-runtime/api";
import {
  getBooleanEnv,
  getContextDatabaseEnvName as getSharedContextDatabaseEnvName,
  getContextWaiterDatabaseEnvName as getSharedContextWaiterDatabaseEnvName,
  getOptionalCsvEnv,
  getOptionalEnv,
  getOptionalJsonEnv,
  getOptionalPositiveNumberEnv,
  getPositiveNumberEnv,
  getReadConsistencyExactDependencyModeEnv,
  getRequiredPositiveNumberEnv,
  loadDeploymentEnvironment,
  loadReadConsistencyRouteTuningEnv,
  loadCatalogAssetStorageConfig,
  loadPlatformDatabaseConfig,
  loadPoolConfig,
  loadPostageConfig,
  loadStorageConfig,
  loadStripeProviderConfig,
  loadTcgplayerAutomationConfig,
  PLATFORM_DATA_PROFILES,
  resolveMobileMessagingProvider,
  type DeploymentEnvironment,
  type PlatformCatalogAssetStorageConfig,
  type PlatformMoneyMovementConfig,
  type PlatformPaymentProcessorConfig,
  type PlatformPoolConfig,
  type PlatformPostageConfig,
  type PlatformStripeConnectAccountsApi,
  type PlatformTcgplayerAutomationConfig,
} from "@chase-sets/platform-runtime/config-schema";
import {
  isPlatformApiRuntimeProfile,
  type PlatformApiRuntimeProfile,
} from "@chase-sets/platform-runtime/runtime-profiles";
import {
  PLATFORM_INTERNAL_AUTH_SECRET_ENV,
  resolvePlatformInternalAuthSecret,
} from "@chase-sets/platform-runtime/http";
import {
  DEFAULT_UCP_SIGNATURE_CREATED_FRESHNESS_WINDOW_MS,
  type UcpBusinessSigningKeySet,
} from "@chase-sets/platform-runtime/ucp";
import {
  DEFAULT_AGENT_GRANT_RATE_LIMIT_RULE,
  DEFAULT_AGENT_GRANT_SPEND_CAP_CENTS,
  DEFAULT_AGENT_GRANT_SPEND_CAP_WINDOW_MS,
  type AgentGrantSpendCapPolicyOptions,
} from "@chase-sets/platform-runtime/agent-guardrails";
import type { RateLimitRule } from "@chase-sets/http/rate-limit";
import type {
  ReadConsistencyExactDependencyMode,
  ReadConsistencyRouteTuning,
} from "@chase-sets/bounded-context-runtime";
import { apiContextRegistry } from "./generated/api-context-registry";

export type PlatformApiPaymentProcessorConfig = PlatformPaymentProcessorConfig;

export type PlatformApiMoneyMovementConfig = PlatformMoneyMovementConfig;

export type PlatformApiPostageConfig = PlatformPostageConfig<true>;

export type PlatformApiTcgplayerAutomationConfig = PlatformTcgplayerAutomationConfig;

export type PlatformApiSocialLoginProviderConfig = Readonly<{
  clientId: string;
  clientSecret: string;
}>;

export type PlatformApiSocialLoginConfig = Readonly<{
  google?: PlatformApiSocialLoginProviderConfig;
  facebook?: PlatformApiSocialLoginProviderConfig;
}>;

export type PlatformApiAdminGoogleWorkspaceSsoConfig = Readonly<{
  allowedHostedDomains: readonly string[];
}>;

export type PlatformApiRegistrationAdmissionConfig = Readonly<{
  mode: "invitation" | "open";
  disposableEmailMode: "enforce" | "log-only";
  disposableEmailDomains: readonly string[];
}>;

export type PlatformApiCatalogAssetStorageConfig = PlatformCatalogAssetStorageConfig;

export type PlatformApiListingPhotoStorageConfig = PlatformApiCatalogAssetStorageConfig;

export type PlatformApiContextName = ApiHostContextName<typeof apiContextRegistry>;

const DEPLOYMENT_ENVIRONMENTS = ["production", "staging", "preview", "test", "dev", "local", "remote-dev"] as const;

export type PlatformApiBaseConfig = Readonly<{
  runtimeProfile: PlatformApiRuntimeProfile;
  sharedDatabaseUrl: string | null;
  controlDatabaseUrl?: string;
  workSignalDatabaseUrl?: string | null;
  contextDatabaseUrls: Readonly<Partial<Record<PlatformApiContextName, string>>>;
  contextWaiterDatabaseUrls?: Readonly<Partial<Record<PlatformApiContextName, string>>>;
  pool?: PlatformApiPoolConfig;
  port: number;
  internalAuthSecret?: string;
  realtime?: PlatformApiRealtimeConfig;
  mcpToolCallLimits?: PlatformApiMcpToolCallLimitsConfig;
  agentGrantRateLimit?: RateLimitRule;
  agentGrantSpendCap?: AgentGrantSpendCapPolicyOptions;
  readConsistency?: PlatformApiReadConsistencyConfig;
  paymentReconciliationIntervalMs?: number | null;
  sellerFundsReleaseIntervalMs?: number | null;
  payoutReconciliationIntervalMs?: number | null;
  deploymentEnvironment?: DeploymentEnvironment;
  dataProfiles?: readonly EnvironmentDataProfile[];
  adminRegistrationEnabled?: boolean;
  registrationAdmission?: PlatformApiRegistrationAdmissionConfig;
  taxProviderBackedQuotesRequired?: boolean;
}>;

export type PlatformApiBootstrapConfig = PlatformApiBaseConfig &
  Readonly<{
    listingPhotoStorage: PlatformApiListingPhotoStorageConfig;
    platformAdmin: PlatformApiPlatformAdminConfig | null;
    previewPostgresAdminUrl: string | null;
  }>;

export type PlatformApiPlatformAdminConfig = Readonly<{
  email: string;
  password: string;
  displayName: string;
  accountName: string;
}>;

export type PlatformApiPoolConfig = PlatformPoolConfig;

export type PlatformApiRealtimeConfig = Readonly<{
  batchSize: number;
  pollIntervalMs: number;
  heartbeatIntervalMs: number;
  retentionPruneIntervalMs: number;
  backgroundMaintenanceEnabled: boolean;
  wakeSignalEnabled: boolean;
  maxConsecutiveFullBatches: number;
  maxTopicsPerStream: number;
  maxActiveStreams: number;
  maxActiveStreamsPerConnectionKey: number;
  cursorSigningSecret?: string;
  previousCursorSigningSecrets: readonly string[];
  streamLimiter: PlatformApiRealtimeStreamLimiterConfig;
}>;

export type PlatformApiMcpToolCallLimitsConfig = Readonly<{
  maxConcurrentToolCalls: number;
  maxConcurrentToolCallsPerPrincipal: number;
  maxConcurrentWriteToolCallsPerPrincipal: number;
  maxConcurrentExternalProviderToolCallsPerPrincipal: number;
}>;

export type PlatformApiReadConsistencyConfig = Readonly<{
  timeoutMs: number;
  pollIntervalMs: number;
  exactDependencyMode: ReadConsistencyExactDependencyMode;
  routeTuning: readonly ReadConsistencyRouteTuning[];
  wakeBeforeWaitEnabled: boolean;
  readinessNotificationsEnabled: boolean;
}>;

// Issue #1225: critical post-write routes keep exact-dependency waits. These
// defaults are always prepended to environment route tuning, so a global
// READ_CONSISTENCY_EXACT_DEPENDENCY_MODE downgrade cannot widen these waits.
export const CRITICAL_READ_CONSISTENCY_ROUTE_TUNING: readonly ReadConsistencyRouteTuning[] = [
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
];

export type PlatformApiRealtimeStreamLimiterConfig =
  | Readonly<{
      kind: "postgres";
      leaseTtlMs: number;
      renewIntervalMs: number;
    }>
  | Readonly<{
      kind: "local";
    }>
  | Readonly<{
      kind: "redis";
      url: string;
      namespace?: string;
      leaseTtlSeconds?: number;
    }>;

export type PlatformApiConfig = Omit<PlatformApiBaseConfig, "realtime"> &
  Readonly<{
    realtime: PlatformApiRealtimeConfig;
    paymentProcessor: PlatformApiPaymentProcessorConfig;
    moneyMovement: PlatformApiMoneyMovementConfig;
    mobileMessaging: PlatformApiMobileMessagingConfig;
    postage: PlatformApiPostageConfig;
    socialLogin: PlatformApiSocialLoginConfig;
    adminGoogleWorkspaceSso: PlatformApiAdminGoogleWorkspaceSsoConfig | null;
    catalogAssetStorage: PlatformApiCatalogAssetStorageConfig;
    tcgplayerAutomation: PlatformApiTcgplayerAutomationConfig | null;
    listingPhotoStorage: PlatformApiListingPhotoStorageConfig;
    stripeGoLive: StripeGoLiveCheckReport;
    ucpBusinessSigningKeys?: UcpBusinessSigningKeySet;
    ucpSignatureCreatedFreshnessWindowMs: number;
  }>;

export type PlatformApiMobileMessagingConfig =
  | Readonly<{ kind: "noop" }>
  | Readonly<{
      kind: "twilio";
      authToken: string;
      requireWebhookSignature: boolean;
    }>;

export const STRIPE_PLATFORM_API_VERSION = "2026-03-25.dahlia";

const REQUIRED_STRIPE_PAYMENT_WEBHOOK_EVENTS = [
  "checkout.session.completed",
  "checkout.session.async_payment_succeeded",
  "checkout.session.async_payment_failed",
  "checkout.session.expired",
  "payment_intent.processing",
  "payment_intent.amount_capturable_updated",
  "payment_intent.succeeded",
  "payment_intent.payment_failed",
  "charge.refunded",
  "charge.dispute.created",
  "charge.dispute.updated",
  "charge.dispute.closed",
  "radar.early_fraud_warning.created",
  "review.opened",
  "review.closed",
  "shared_payment.granted_token.used",
  "shared_payment.granted_token.deactivated",
] as const;

const REQUIRED_STRIPE_CONNECT_ACCOUNT_WEBHOOK_EVENTS: Readonly<Record<PlatformStripeConnectAccountsApi, string[]>> = {
  v1: ["account.updated"],
  v2: ["v2.core.account[requirements].updated", "v2.core.account.updated"],
};

export function requiredStripeWebhookEvents(connectAccountsApi: PlatformStripeConnectAccountsApi) {
  return [
    ...REQUIRED_STRIPE_PAYMENT_WEBHOOK_EVENTS,
    ...REQUIRED_STRIPE_CONNECT_ACCOUNT_WEBHOOK_EVENTS[connectAccountsApi],
    "payout.paid",
    "payout.failed",
  ];
}

export type StripeGoLiveCheckReport = Readonly<{
  apiVersion: typeof STRIPE_PLATFORM_API_VERSION;
  requiredWebhookEvents: readonly string[];
  paymentsConfigured: boolean;
  connectConfigured: boolean;
  fakeFallbackAllowed: boolean;
  liveSecretKeyLikely: boolean;
}>;

export function getPlatformApiContextsForRuntimeProfile(
  runtimeProfile: PlatformApiRuntimeProfile,
): readonly PlatformApiContextName[] {
  return getApiHostContextNames(apiContextRegistry, "platform-api", runtimeProfile);
}

function loadReadConsistencyRouteTuning(): readonly ReadConsistencyRouteTuning[] {
  return loadReadConsistencyRouteTuningEnv({
    envName: "READ_CONSISTENCY_ROUTE_TUNING_JSON",
    criticalRouteTuning: CRITICAL_READ_CONSISTENCY_ROUTE_TUNING,
  });
}

function getDeploymentEnvironment() {
  return loadDeploymentEnvironment();
}

function loadRuntimeProfile(): PlatformApiRuntimeProfile {
  const value = getOptionalEnv("CHASE_SETS_RUNTIME_PROFILE") ?? "public";
  if (!isPlatformApiRuntimeProfile(value)) {
    throw new Error("CHASE_SETS_RUNTIME_PROFILE must be landing, proof, or public.");
  }

  return value;
}

function isLongLivedEnvironment(environmentName: string) {
  return environmentName === "production" || environmentName === "staging";
}

function assertDataProfilesAllowed(
  environmentName: string,
  profiles: readonly EnvironmentDataProfile[],
): readonly EnvironmentDataProfile[] {
  if (environmentName === "production" && profiles.includes("representative-commerce-state")) {
    throw new Error("representative-commerce-state is not allowed when DEPLOYMENT_ENVIRONMENT=production.");
  }

  return profiles;
}

function loadDataProfiles(environmentName: string): readonly EnvironmentDataProfile[] {
  const explicitProfiles = getOptionalCsvEnv("PLATFORM_DATA_PROFILES");
  if (explicitProfiles.length > 0) {
    const allowedProfiles = new Set<EnvironmentDataProfile>(PLATFORM_DATA_PROFILES);
    for (const profile of explicitProfiles) {
      if (!allowedProfiles.has(profile as EnvironmentDataProfile)) {
        throw new Error(`PLATFORM_DATA_PROFILES contains unsupported data profile '${profile}'.`);
      }
    }

    return assertDataProfilesAllowed(environmentName, explicitProfiles as readonly EnvironmentDataProfile[]);
  }

  if (isLongLivedEnvironment(environmentName)) {
    return assertDataProfilesAllowed(environmentName, productionLikeDataProfiles);
  }

  return assertDataProfilesAllowed(environmentName, nonProductionDataProfiles);
}

function loadRegistrationAdmissionMode(environmentName: string): PlatformApiRegistrationAdmissionConfig["mode"] {
  const configured = getOptionalEnv("REGISTRATION_ADMISSION_MODE");
  if (configured === "invitation" || configured === "open") {
    return configured;
  }
  if (configured) {
    throw new Error("REGISTRATION_ADMISSION_MODE must be invitation or open.");
  }

  return isLongLivedEnvironment(environmentName) ? "invitation" : "open";
}

function loadDisposableEmailMode(): PlatformApiRegistrationAdmissionConfig["disposableEmailMode"] {
  const configured = getOptionalEnv("REGISTRATION_DISPOSABLE_EMAIL_MODE");
  if (!configured) {
    return "log-only";
  }
  if (configured === "enforce" || configured === "log-only") {
    return configured;
  }

  throw new Error("REGISTRATION_DISPOSABLE_EMAIL_MODE must be enforce or log-only.");
}

function loadPlatformAdminConfig(): PlatformApiPlatformAdminConfig | null {
  const email = getOptionalEnv("PLATFORM_ADMIN_EMAIL");
  const password = getOptionalEnv("PLATFORM_ADMIN_PASSWORD");

  if (!email && !password) {
    return null;
  }

  if (!email || !password) {
    throw new Error("PLATFORM_ADMIN_EMAIL and PLATFORM_ADMIN_PASSWORD must be configured together.");
  }

  return {
    email,
    password,
    displayName: getOptionalEnv("PLATFORM_ADMIN_DISPLAY_NAME") ?? "Platform Admin",
    accountName: getOptionalEnv("PLATFORM_ADMIN_ACCOUNT_NAME") ?? "Chase Sets Platform",
  };
}

function loadListingPhotoStorageConfig(
  port: number,
  productionLike: boolean,
  fallbackStorage?: PlatformApiCatalogAssetStorageConfig,
): PlatformApiListingPhotoStorageConfig {
  const explicitKind = getOptionalEnv("MARKETPLACE_LISTING_PHOTO_STORAGE_KIND");
  if (!explicitKind && productionLike && fallbackStorage) {
    return fallbackStorage;
  }

  return loadStorageConfig({
    kindEnvName: "MARKETPLACE_LISTING_PHOTO_STORAGE_KIND",
    localRootEnvName: "MARKETPLACE_LISTING_PHOTO_LOCAL_ROOT",
    publicBaseUrlEnvName: "MARKETPLACE_LISTING_PHOTO_PUBLIC_BASE_URL",
    s3BucketEnvName: "MARKETPLACE_LISTING_PHOTO_S3_BUCKET",
    s3RegionEnvName: "MARKETPLACE_LISTING_PHOTO_S3_REGION",
    s3EndpointEnvName: "MARKETPLACE_LISTING_PHOTO_S3_ENDPOINT",
    s3AccessKeyIdEnvName: "MARKETPLACE_LISTING_PHOTO_S3_ACCESS_KEY_ID",
    s3SecretAccessKeyEnvName: "MARKETPLACE_LISTING_PHOTO_S3_SECRET_ACCESS_KEY",
    s3ForcePathStyleEnvName: "MARKETPLACE_LISTING_PHOTO_S3_FORCE_PATH_STYLE",
    defaultLocalRoot: "artifacts/marketplace-listing-photos",
    defaultPublicBaseUrl: `http://localhost:${port}/marketplace-listing-photos`,
    productionLike,
    productionFilesystemError:
      "MARKETPLACE_LISTING_PHOTO_STORAGE_KIND=s3 is required for Marketplace listing photo storage in production.",
    invalidKindError: "MARKETPLACE_LISTING_PHOTO_STORAGE_KIND must be filesystem or s3.",
    missingS3ConfigError:
      "MARKETPLACE_LISTING_PHOTO_S3_BUCKET, MARKETPLACE_LISTING_PHOTO_S3_REGION, and MARKETPLACE_LISTING_PHOTO_PUBLIC_BASE_URL are required when MARKETPLACE_LISTING_PHOTO_STORAGE_KIND=s3.",
    mismatchedS3CredentialsError:
      "MARKETPLACE_LISTING_PHOTO_S3_ACCESS_KEY_ID and MARKETPLACE_LISTING_PHOTO_S3_SECRET_ACCESS_KEY must be configured together.",
  });
}

function loadUcpBusinessSigningKeys(productionLike: boolean): UcpBusinessSigningKeySet | undefined {
  const privateJwk = getOptionalJsonEnv<JsonWebKey>("UCP_BUSINESS_SIGNING_PRIVATE_JWK");
  const kid = getOptionalEnv("UCP_BUSINESS_SIGNING_KEY_ID");
  const alg = getOptionalEnv("UCP_BUSINESS_SIGNING_ALG") ?? "ES256";
  const previousPublicJwks =
    getOptionalJsonEnv<readonly JsonWebKey[]>("UCP_BUSINESS_SIGNING_PREVIOUS_PUBLIC_JWKS") ?? [];

  if (!privateJwk && !kid) {
    return undefined;
  }
  if (!privateJwk || !kid) {
    throw new Error("UCP_BUSINESS_SIGNING_PRIVATE_JWK and UCP_BUSINESS_SIGNING_KEY_ID must be configured together.");
  }
  if (alg !== "ES256" && alg !== "ES384" && alg !== "ES512") {
    throw new Error("UCP_BUSINESS_SIGNING_ALG must be ES256, ES384, or ES512.");
  }
  if (productionLike && privateJwk.kty !== "EC") {
    throw new Error("UCP business response signing requires an EC private JWK in production.");
  }

  return {
    current: {
      kid,
      alg,
      privateJwk,
    },
    previousPublicJwks,
  };
}

export function getContextDatabaseEnvName(contextName: PlatformApiContextName) {
  return getSharedContextDatabaseEnvName(contextName);
}

export function getContextWaiterDatabaseEnvName(contextName: PlatformApiContextName) {
  return getSharedContextWaiterDatabaseEnvName(contextName);
}

function loadBaseConfig(): PlatformApiBaseConfig {
  const deploymentEnvironment = getDeploymentEnvironment();
  const productionLike = deploymentEnvironment === "production";
  const runtimeProfile = loadRuntimeProfile();
  const databaseConfig = loadPlatformDatabaseConfig({
    contextNames: getPlatformApiContextsForRuntimeProfile(runtimeProfile),
    missingControlDatabaseUrlError:
      "PLATFORM_CONTROL_DATABASE_URL or DATABASE_URL is required for platform control-plane coordination.",
    productionLike,
    productionMissingExplicitControlDatabaseUrlError:
      "PLATFORM_CONTROL_DATABASE_URL is required for platform control-plane coordination in production.",
  });

  return {
    runtimeProfile,
    ...databaseConfig,
    pool: loadPoolConfig(),
    port: Number(process.env.PORT ?? 6182),
    internalAuthSecret: resolvePlatformInternalAuthSecret({
      requireExplicitInProduction: true,
      productionLike,
      productionMissingSecretError: `${PLATFORM_INTERNAL_AUTH_SECRET_ENV} is required for internal platform API capabilities in production.`,
    }),
    realtime: {
      batchSize: getPositiveNumberEnv("REALTIME_BATCH_SIZE", 100),
      pollIntervalMs: getPositiveNumberEnv("REALTIME_POLL_INTERVAL_MS", 1_000),
      heartbeatIntervalMs: getPositiveNumberEnv("REALTIME_HEARTBEAT_INTERVAL_MS", 15_000),
      retentionPruneIntervalMs: getPositiveNumberEnv("REALTIME_RETENTION_PRUNE_INTERVAL_MS", 60_000),
      backgroundMaintenanceEnabled: getBooleanEnv("REALTIME_BACKGROUND_MAINTENANCE_ENABLED", true),
      wakeSignalEnabled: getBooleanEnv("REALTIME_WAKE_SIGNAL_ENABLED", true),
      maxConsecutiveFullBatches: getPositiveNumberEnv("REALTIME_MAX_CONSECUTIVE_FULL_BATCHES", 3),
      maxTopicsPerStream: getPositiveNumberEnv("REALTIME_MAX_TOPICS_PER_STREAM", 16),
      maxActiveStreams: getPositiveNumberEnv("REALTIME_MAX_ACTIVE_STREAMS", 1_000),
      maxActiveStreamsPerConnectionKey: getPositiveNumberEnv("REALTIME_MAX_ACTIVE_STREAMS_PER_CONNECTION_KEY", 6),
      cursorSigningSecret: getOptionalEnv("REALTIME_CURSOR_SIGNING_SECRET") ?? undefined,
      previousCursorSigningSecrets: getOptionalCsvEnv("REALTIME_PREVIOUS_CURSOR_SIGNING_SECRETS"),
      streamLimiter: loadRealtimeStreamLimiterConfig(),
    },
    mcpToolCallLimits: {
      maxConcurrentToolCalls: getPositiveNumberEnv("MCP_MAX_CONCURRENT_TOOL_CALLS", 100),
      maxConcurrentToolCallsPerPrincipal: getPositiveNumberEnv("MCP_MAX_CONCURRENT_TOOL_CALLS_PER_PRINCIPAL", 8),
      maxConcurrentWriteToolCallsPerPrincipal: getPositiveNumberEnv(
        "MCP_MAX_CONCURRENT_WRITE_TOOL_CALLS_PER_PRINCIPAL",
        2,
      ),
      maxConcurrentExternalProviderToolCallsPerPrincipal: getPositiveNumberEnv(
        "MCP_MAX_CONCURRENT_EXTERNAL_PROVIDER_TOOL_CALLS_PER_PRINCIPAL",
        2,
      ),
    },
    agentGrantRateLimit: {
      max: getPositiveNumberEnv("AGENT_GRANT_WRITE_RATE_LIMIT_MAX", DEFAULT_AGENT_GRANT_RATE_LIMIT_RULE.max),
      windowMs: getPositiveNumberEnv(
        "AGENT_GRANT_WRITE_RATE_LIMIT_WINDOW_MS",
        DEFAULT_AGENT_GRANT_RATE_LIMIT_RULE.windowMs,
      ),
      disabled: getBooleanEnv("AGENT_GRANT_WRITE_RATE_LIMIT_DISABLED", false),
    },
    agentGrantSpendCap: {
      capCents: getPositiveNumberEnv("AGENT_GRANT_SPEND_CAP_CENTS", DEFAULT_AGENT_GRANT_SPEND_CAP_CENTS),
      windowMs: getPositiveNumberEnv("AGENT_GRANT_SPEND_CAP_WINDOW_MS", DEFAULT_AGENT_GRANT_SPEND_CAP_WINDOW_MS),
      disabled: getBooleanEnv("AGENT_GRANT_SPEND_CAP_DISABLED", false),
    },
    readConsistency: {
      timeoutMs: getRequiredPositiveNumberEnv("READ_CONSISTENCY_TIMEOUT_MS", 2_500),
      pollIntervalMs: getRequiredPositiveNumberEnv("READ_CONSISTENCY_POLL_INTERVAL_MS", 75),
      exactDependencyMode: getReadConsistencyExactDependencyModeEnv("READ_CONSISTENCY_EXACT_DEPENDENCY_MODE"),
      routeTuning: loadReadConsistencyRouteTuning(),
      wakeBeforeWaitEnabled: getBooleanEnv("READ_CONSISTENCY_WAKE_BEFORE_WAIT_ENABLED", false),
      readinessNotificationsEnabled: getBooleanEnv("READ_CONSISTENCY_READINESS_NOTIFICATIONS_ENABLED", false),
    },
    paymentReconciliationIntervalMs: getOptionalPositiveNumberEnv("PAYMENT_RECONCILIATION_INTERVAL_MS", 300_000),
    sellerFundsReleaseIntervalMs: getOptionalPositiveNumberEnv("SELLER_FUNDS_RELEASE_INTERVAL_MS", 300_000),
    payoutReconciliationIntervalMs: getOptionalPositiveNumberEnv("PAYOUT_RECONCILIATION_INTERVAL_MS", 300_000),
    deploymentEnvironment,
    dataProfiles: loadDataProfiles(deploymentEnvironment),
    adminRegistrationEnabled: getBooleanEnv("ADMIN_REGISTRATION_ENABLED", false),
    registrationAdmission: {
      mode: loadRegistrationAdmissionMode(deploymentEnvironment),
      disposableEmailMode: loadDisposableEmailMode(),
      disposableEmailDomains: getOptionalCsvEnv("REGISTRATION_DISPOSABLE_EMAIL_DOMAINS"),
    },
    taxProviderBackedQuotesRequired: getBooleanEnv("TAX_PROVIDER_BACKED_QUOTES_REQUIRED", false),
  };
}

export function loadBootstrapConfig(): PlatformApiBootstrapConfig {
  const baseConfig = loadBaseConfig();
  const productionLike = baseConfig.deploymentEnvironment === "production";
  const catalogAssetStorage = loadCatalogAssetStorageConfig({
    port: baseConfig.port,
    productionLike,
    defaultPublicBaseUrl: `http://localhost:${baseConfig.port}/catalog-assets`,
  });

  return {
    ...baseConfig,
    listingPhotoStorage: loadListingPhotoStorageConfig(baseConfig.port, productionLike, catalogAssetStorage),
    platformAdmin: loadPlatformAdminConfig(),
    previewPostgresAdminUrl: loadPreviewPostgresAdminUrl(baseConfig.deploymentEnvironment),
  };
}

function loadPreviewPostgresAdminUrl(deploymentEnvironment: DeploymentEnvironment | undefined): string | null {
  const adminUrl = getOptionalEnv("PLATFORM_PREVIEW_POSTGRES_ADMIN_URL");
  if (!adminUrl) {
    return null;
  }

  if (deploymentEnvironment !== "preview") {
    throw new Error("PLATFORM_PREVIEW_POSTGRES_ADMIN_URL may only be configured for preview deployments.");
  }

  return adminUrl;
}

export function loadConfig(): PlatformApiConfig {
  const baseConfig = loadBaseConfig() as PlatformApiBaseConfig & {
    realtime: PlatformApiRealtimeConfig;
  };
  const productionLike = baseConfig.deploymentEnvironment === "production";
  const providerRequired = productionLike && baseConfig.runtimeProfile !== "landing";
  const easyPostApiKey = getOptionalEnv("EASYPOST_API_KEY");
  const googleSocialLoginClientId = getOptionalEnv("GOOGLE_SOCIAL_LOGIN_CLIENT_ID");
  const googleSocialLoginClientSecret = getOptionalEnv("GOOGLE_SOCIAL_LOGIN_CLIENT_SECRET");
  const adminGoogleWorkspaceSsoDomains = getOptionalCsvEnv("ADMIN_GOOGLE_WORKSPACE_HOSTED_DOMAINS").map((value) =>
    value.toLowerCase(),
  );
  const facebookSocialLoginClientId = getOptionalEnv("FACEBOOK_SOCIAL_LOGIN_CLIENT_ID");
  const facebookSocialLoginClientSecret = getOptionalEnv("FACEBOOK_SOCIAL_LOGIN_CLIENT_SECRET");
  const mobileMessagingProvider = resolveMobileMessagingProvider(getOptionalEnv("MOBILE_MESSAGING_PROVIDER"));
  const twilioAuthToken = getOptionalEnv("TWILIO_AUTH_TOKEN");
  const twilioRequireWebhookSignature = getBooleanEnv("TWILIO_WEBHOOK_SIGNATURE_REQUIRED", true);
  const ucpBusinessSigningKeys = loadUcpBusinessSigningKeys(productionLike);
  const ucpSignatureCreatedFreshnessWindowMs = getRequiredPositiveNumberEnv(
    "UCP_SIGNATURE_CREATED_FRESHNESS_WINDOW_MS",
    DEFAULT_UCP_SIGNATURE_CREATED_FRESHNESS_WINDOW_MS,
  );

  if (
    providerRequired &&
    (baseConfig.realtime.streamLimiter.kind !== "postgres" || !baseConfig.realtime.wakeSignalEnabled)
  ) {
    throw new Error(
      "REALTIME_STREAM_LIMITER=postgres, REALTIME_WAKE_SIGNAL_ENABLED=true, and PLATFORM_CONTROL_DATABASE_URL are required for horizontally scalable SSE in production.",
    );
  }

  const stripeProvider = loadStripeProviderConfig({
    productionLike: providerRequired,
    deploymentEnvironment: baseConfig.deploymentEnvironment,
    productionMissingConfigError:
      "STRIPE_SECRET_KEY, STRIPE_PUBLISHABLE_KEY, STRIPE_WEBHOOK_SECRET, and STRIPE_CONNECT_WEBHOOK_SECRET are required for Stripe payment processing and Connect money movement in production.",
  });

  if (providerRequired && !easyPostApiKey) {
    throw new Error("EASYPOST_API_KEY is required for USPS postage label purchasing in production.");
  }
  if (productionLike && Boolean(googleSocialLoginClientId) !== Boolean(googleSocialLoginClientSecret)) {
    throw new Error("GOOGLE_SOCIAL_LOGIN_CLIENT_ID and GOOGLE_SOCIAL_LOGIN_CLIENT_SECRET must be configured together.");
  }
  if (adminGoogleWorkspaceSsoDomains.length > 0 && (!googleSocialLoginClientId || !googleSocialLoginClientSecret)) {
    throw new Error(
      "ADMIN_GOOGLE_WORKSPACE_HOSTED_DOMAINS requires GOOGLE_SOCIAL_LOGIN_CLIENT_ID and GOOGLE_SOCIAL_LOGIN_CLIENT_SECRET.",
    );
  }
  if (productionLike && Boolean(facebookSocialLoginClientId) !== Boolean(facebookSocialLoginClientSecret)) {
    throw new Error(
      "FACEBOOK_SOCIAL_LOGIN_CLIENT_ID and FACEBOOK_SOCIAL_LOGIN_CLIENT_SECRET must be configured together.",
    );
  }
  if (mobileMessagingProvider === "twilio" && !twilioAuthToken) {
    throw new Error("TWILIO_AUTH_TOKEN is required when MOBILE_MESSAGING_PROVIDER=twilio.");
  }
  const postage = loadPostageConfig({
    productionLike: providerRequired,
    productionMissingApiKeyError: "EASYPOST_API_KEY is required for USPS postage label purchasing in production.",
    includeWebhookSecret: true,
    productionMissingWebhookSecretError:
      "EASYPOST_WEBHOOK_SECRET is required for EasyPost webhook verification in production.",
  });
  const catalogAssetStorage = loadCatalogAssetStorageConfig({
    port: baseConfig.port,
    productionLike,
    defaultPublicBaseUrl: `http://localhost:${baseConfig.port}/catalog-assets`,
  });
  const listingPhotoStorage = loadListingPhotoStorageConfig(baseConfig.port, providerRequired, catalogAssetStorage);

  const socialLogin: PlatformApiSocialLoginConfig = {
    ...(googleSocialLoginClientId && googleSocialLoginClientSecret
      ? {
          google: {
            clientId: googleSocialLoginClientId,
            clientSecret: googleSocialLoginClientSecret,
          },
        }
      : {}),
    ...(facebookSocialLoginClientId && facebookSocialLoginClientSecret
      ? {
          facebook: {
            clientId: facebookSocialLoginClientId,
            clientSecret: facebookSocialLoginClientSecret,
          },
        }
      : {}),
  };
  const adminGoogleWorkspaceSso =
    adminGoogleWorkspaceSsoDomains.length > 0
      ? {
          allowedHostedDomains: adminGoogleWorkspaceSsoDomains,
        }
      : null;

  const mobileMessaging =
    mobileMessagingProvider === "twilio"
      ? {
          kind: "twilio" as const,
          authToken: twilioAuthToken as string,
          requireWebhookSignature: twilioRequireWebhookSignature,
        }
      : {
          kind: "noop" as const,
        };

  return {
    ...baseConfig,
    moneyMovement: stripeProvider.moneyMovement,
    mobileMessaging,
    postage,
    stripeGoLive: {
      apiVersion: STRIPE_PLATFORM_API_VERSION,
      requiredWebhookEvents: requiredStripeWebhookEvents(stripeProvider.connectAccountsApi),
      paymentsConfigured: stripeProvider.paymentProcessor.kind === "stripe",
      connectConfigured: stripeProvider.moneyMovement.kind === "stripe",
      fakeFallbackAllowed: !productionLike,
      liveSecretKeyLikely: Boolean(stripeProvider.secretKey?.startsWith("sk_live")),
    },
    catalogAssetStorage,
    tcgplayerAutomation: loadTcgplayerAutomationConfig(),
    listingPhotoStorage,
    socialLogin,
    adminGoogleWorkspaceSso,
    ucpBusinessSigningKeys,
    ucpSignatureCreatedFreshnessWindowMs,
    paymentProcessor: stripeProvider.paymentProcessor,
  };
}

function loadRealtimeStreamLimiterConfig(): PlatformApiRealtimeStreamLimiterConfig {
  const kind = getOptionalEnv("REALTIME_STREAM_LIMITER") ?? "postgres";
  if (kind === "postgres") {
    return {
      kind: "postgres",
      leaseTtlMs: getPositiveNumberEnv("REALTIME_STREAM_LEASE_TTL_MS", 30_000),
      renewIntervalMs: getPositiveNumberEnv("REALTIME_STREAM_LEASE_RENEW_INTERVAL_MS", 10_000),
    };
  }

  if (kind === "local") {
    return { kind: "local" };
  }

  if (kind !== "redis") {
    throw new Error("REALTIME_STREAM_LIMITER must be local or redis.");
  }

  const redisUrl = getOptionalEnv("REALTIME_REDIS_URL") ?? getOptionalEnv("REDIS_URL");
  if (!redisUrl) {
    throw new Error("REALTIME_REDIS_URL or REDIS_URL is required when REALTIME_STREAM_LIMITER=redis.");
  }

  return {
    kind: "redis",
    url: redisUrl,
    namespace: getOptionalEnv("REALTIME_REDIS_NAMESPACE") ?? undefined,
    leaseTtlSeconds: getOptionalPositiveNumberEnv("REALTIME_REDIS_LEASE_TTL_SECONDS", 60) ?? undefined,
  };
}
