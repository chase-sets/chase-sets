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
  getOptionalCsvEnv,
  getOptionalEnv,
  getOptionalJsonEnv,
  getOptionalPositiveNumberEnv,
  getPositiveNumberEnv,
  getRequiredPositiveNumberEnv,
  loadCatalogAssetStorageConfig,
  loadPlatformDatabaseConfig,
  loadPoolConfig,
  loadPostageConfig,
  loadStorageConfig,
  loadStripeProviderConfig,
  resolveMobileMessagingProvider,
  type PlatformCatalogAssetStorageConfig,
  type PlatformMoneyMovementConfig,
  type PlatformPaymentProcessorConfig,
  type PlatformPoolConfig,
  type PlatformPostageConfig,
} from "@chase-sets/platform-runtime/config-schema";
import {
  PLATFORM_INTERNAL_AUTH_SECRET_ENV,
  resolvePlatformInternalAuthSecret,
} from "@chase-sets/platform-runtime/http";
import type { UcpBusinessSigningKeySet } from "@chase-sets/platform-runtime/ucp";
import type {
  ReadConsistencyExactDependencyMode,
  ReadConsistencyRouteTuning,
} from "@chase-sets/bounded-context-runtime";
import { apiContextRegistry } from "./generated/api-context-registry";

export type PlatformApiPaymentProcessorConfig = PlatformPaymentProcessorConfig;

export type PlatformApiMoneyMovementConfig = PlatformMoneyMovementConfig;

export type PlatformApiPostageConfig = PlatformPostageConfig<true>;

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

export type PlatformApiCatalogAssetStorageConfig = PlatformCatalogAssetStorageConfig;

export type PlatformApiListingPhotoStorageConfig = PlatformApiCatalogAssetStorageConfig;

export type PlatformApiContextName = ApiHostContextName<typeof apiContextRegistry>;

export type PlatformApiBaseConfig = Readonly<{
  sharedDatabaseUrl: string | null;
  controlDatabaseUrl?: string;
  contextDatabaseUrls: Readonly<Partial<Record<PlatformApiContextName, string>>>;
  pool?: PlatformApiPoolConfig;
  port: number;
  internalAuthSecret?: string;
  realtime?: PlatformApiRealtimeConfig;
  readConsistency?: PlatformApiReadConsistencyConfig;
  paymentReconciliationIntervalMs?: number | null;
  sellerFundsReleaseIntervalMs?: number | null;
  payoutReconciliationIntervalMs?: number | null;
  deploymentEnvironment?: string | null;
  dataProfiles?: readonly EnvironmentDataProfile[];
  taxProviderBackedQuotesRequired?: boolean;
}>;

export type PlatformApiBootstrapConfig = PlatformApiBaseConfig &
  Readonly<{
    listingPhotoStorage: PlatformApiListingPhotoStorageConfig;
    platformAdmin: PlatformApiPlatformAdminConfig | null;
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

export type PlatformApiReadConsistencyConfig = Readonly<{
  timeoutMs: number;
  pollIntervalMs: number;
  exactDependencyMode: ReadConsistencyExactDependencyMode;
  routeTuning: readonly ReadConsistencyRouteTuning[];
  wakeBeforeWaitEnabled: boolean;
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
    routePath: "/account/checkout-sessions/:sessionId",
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
    listingPhotoStorage: PlatformApiListingPhotoStorageConfig;
    stripeGoLive: StripeGoLiveCheckReport;
    ucpBusinessSigningKeys?: UcpBusinessSigningKeySet;
  }>;

export type PlatformApiMobileMessagingConfig =
  | Readonly<{ kind: "noop" }>
  | Readonly<{
      kind: "twilio";
      authToken: string;
      requireWebhookSignature: boolean;
    }>;

export const STRIPE_PLATFORM_API_VERSION = "2026-03-25.dahlia";

export const REQUIRED_STRIPE_WEBHOOK_EVENTS = [
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
  "v2.core.account[requirements].updated",
  "v2.core.account.updated",
  "payout.paid",
  "payout.failed",
] as const;

export type StripeGoLiveCheckReport = Readonly<{
  apiVersion: typeof STRIPE_PLATFORM_API_VERSION;
  requiredWebhookEvents: readonly string[];
  paymentsConfigured: boolean;
  connectConfigured: boolean;
  fakeFallbackAllowed: boolean;
  liveSecretKeyLikely: boolean;
}>;

const platformApiContexts = getApiHostContextNames(apiContextRegistry, "platform-api");

function getReadConsistencyExactDependencyModeEnv(name: string): ReadConsistencyExactDependencyMode {
  const value = getOptionalEnv(name) ?? "enabled";
  if (value === "enabled" || value === "target-context") {
    return value;
  }

  throw new Error(`${name} must be enabled or target-context.`);
}

function loadReadConsistencyRouteTuning(): readonly ReadConsistencyRouteTuning[] {
  const value = getOptionalJsonEnv<unknown>("READ_CONSISTENCY_ROUTE_TUNING_JSON") ?? [];
  if (!Array.isArray(value)) {
    throw new Error("READ_CONSISTENCY_ROUTE_TUNING_JSON must be a JSON array.");
  }

  const environmentRouteTuning = value.map((entry, index) => {
    if (!isRecord(entry)) {
      throw new Error(`READ_CONSISTENCY_ROUTE_TUNING_JSON[${index}] must be an object.`);
    }

    const mountPath = entry.mountPath;
    const routePath = entry.routePath;
    const targetContextName = entry.targetContextName;
    const timeoutMs = entry.timeoutMs;
    const pollIntervalMs = entry.pollIntervalMs;
    const exactDependencyMode = entry.exactDependencyMode;

    if (typeof mountPath !== "string" || !mountPath.trim().startsWith("/")) {
      throw new Error(`READ_CONSISTENCY_ROUTE_TUNING_JSON[${index}].mountPath must be an absolute path string.`);
    }
    if (typeof routePath !== "string" || !routePath.trim().startsWith("/")) {
      throw new Error(`READ_CONSISTENCY_ROUTE_TUNING_JSON[${index}].routePath must be an absolute path string.`);
    }
    if (targetContextName !== undefined && (typeof targetContextName !== "string" || !targetContextName.trim())) {
      throw new Error(`READ_CONSISTENCY_ROUTE_TUNING_JSON[${index}].targetContextName must be a string when set.`);
    }
    if (timeoutMs !== undefined && !isPositiveNumber(timeoutMs)) {
      throw new Error(`READ_CONSISTENCY_ROUTE_TUNING_JSON[${index}].timeoutMs must be a positive number when set.`);
    }
    if (pollIntervalMs !== undefined && !isPositiveNumber(pollIntervalMs)) {
      throw new Error(
        `READ_CONSISTENCY_ROUTE_TUNING_JSON[${index}].pollIntervalMs must be a positive number when set.`,
      );
    }
    if (
      exactDependencyMode !== undefined &&
      exactDependencyMode !== "enabled" &&
      exactDependencyMode !== "target-context"
    ) {
      throw new Error(
        `READ_CONSISTENCY_ROUTE_TUNING_JSON[${index}].exactDependencyMode must be enabled or target-context when set.`,
      );
    }

    return {
      mountPath: mountPath.trim(),
      routePath: routePath.trim(),
      ...(typeof targetContextName === "string" ? { targetContextName: targetContextName.trim() } : {}),
      ...(typeof timeoutMs === "number" ? { timeoutMs } : {}),
      ...(typeof pollIntervalMs === "number" ? { pollIntervalMs } : {}),
      ...(typeof exactDependencyMode === "string"
        ? { exactDependencyMode: exactDependencyMode as ReadConsistencyExactDependencyMode }
        : {}),
    };
  });

  return [...CRITICAL_READ_CONSISTENCY_ROUTE_TUNING, ...environmentRouteTuning];
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPositiveNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function getDeploymentEnvironment() {
  const deploymentEnvironment = getOptionalEnv("DEPLOYMENT_ENVIRONMENT");
  if (deploymentEnvironment) {
    return deploymentEnvironment;
  }

  if (process.env.NODE_ENV === "production") {
    return "production";
  }
  if (process.env.NODE_ENV === "test") {
    return "test";
  }

  return "dev";
}

function isProductionDeployment() {
  return getDeploymentEnvironment() === "production";
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
    const allowedProfiles = new Set<EnvironmentDataProfile>([
      "critical-bootstrap",
      "catalog-integration-bootstrap",
      "scenario-seed",
      "representative-commerce-state",
    ]);
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

function loadBaseConfig(): PlatformApiBaseConfig {
  const deploymentEnvironment = getDeploymentEnvironment();
  const productionLike = isProductionDeployment();
  const databaseConfig = loadPlatformDatabaseConfig({
    contextNames: platformApiContexts,
    missingControlDatabaseUrlError:
      "PLATFORM_CONTROL_DATABASE_URL or DATABASE_URL is required for platform control-plane coordination.",
    productionLike,
    productionMissingExplicitControlDatabaseUrlError:
      "PLATFORM_CONTROL_DATABASE_URL is required for platform control-plane coordination in production.",
  });

  return {
    ...databaseConfig,
    pool: loadPoolConfig(),
    port: Number(process.env.PORT ?? 6182),
    internalAuthSecret: resolvePlatformInternalAuthSecret(),
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
    readConsistency: {
      timeoutMs: getRequiredPositiveNumberEnv("READ_CONSISTENCY_TIMEOUT_MS", 2_500),
      pollIntervalMs: getRequiredPositiveNumberEnv("READ_CONSISTENCY_POLL_INTERVAL_MS", 75),
      exactDependencyMode: getReadConsistencyExactDependencyModeEnv("READ_CONSISTENCY_EXACT_DEPENDENCY_MODE"),
      routeTuning: loadReadConsistencyRouteTuning(),
      wakeBeforeWaitEnabled: getBooleanEnv("READ_CONSISTENCY_WAKE_BEFORE_WAIT_ENABLED", false),
    },
    paymentReconciliationIntervalMs: getOptionalPositiveNumberEnv("PAYMENT_RECONCILIATION_INTERVAL_MS", 300_000),
    sellerFundsReleaseIntervalMs: getOptionalPositiveNumberEnv("SELLER_FUNDS_RELEASE_INTERVAL_MS", 300_000),
    payoutReconciliationIntervalMs: getOptionalPositiveNumberEnv("PAYOUT_RECONCILIATION_INTERVAL_MS", 300_000),
    deploymentEnvironment,
    dataProfiles: loadDataProfiles(deploymentEnvironment),
    taxProviderBackedQuotesRequired: getBooleanEnv("TAX_PROVIDER_BACKED_QUOTES_REQUIRED", false),
  };
}

export function loadBootstrapConfig(): PlatformApiBootstrapConfig {
  const baseConfig = loadBaseConfig();
  const productionLike = isProductionDeployment();
  const catalogAssetStorage = loadCatalogAssetStorageConfig({
    port: baseConfig.port,
    productionLike,
    defaultPublicBaseUrl: `http://localhost:${baseConfig.port}/catalog-assets`,
  });

  return {
    ...baseConfig,
    listingPhotoStorage: loadListingPhotoStorageConfig(baseConfig.port, productionLike, catalogAssetStorage),
    platformAdmin: loadPlatformAdminConfig(),
  };
}

export function loadConfig(): PlatformApiConfig {
  const baseConfig = loadBaseConfig() as PlatformApiBaseConfig & {
    realtime: PlatformApiRealtimeConfig;
  };
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
  const productionLike = isProductionDeployment();
  const ucpBusinessSigningKeys = loadUcpBusinessSigningKeys(productionLike);

  if (
    productionLike &&
    (baseConfig.realtime.streamLimiter.kind !== "postgres" || !baseConfig.realtime.wakeSignalEnabled)
  ) {
    throw new Error(
      "REALTIME_STREAM_LIMITER=postgres, REALTIME_WAKE_SIGNAL_ENABLED=true, and PLATFORM_CONTROL_DATABASE_URL are required for horizontally scalable SSE in production.",
    );
  }

  const stripeProvider = loadStripeProviderConfig({
    productionLike,
    productionMissingConfigError:
      "STRIPE_SECRET_KEY, STRIPE_PUBLISHABLE_KEY, STRIPE_WEBHOOK_SECRET, and STRIPE_CONNECT_WEBHOOK_SECRET are required for Stripe payment processing and Connect money movement in production.",
  });

  if (productionLike && !easyPostApiKey) {
    throw new Error("EASYPOST_API_KEY is required for USPS postage label purchasing in production.");
  }
  if (productionLike && !getOptionalEnv(PLATFORM_INTERNAL_AUTH_SECRET_ENV)) {
    throw new Error(
      `${PLATFORM_INTERNAL_AUTH_SECRET_ENV} is required for internal platform API capabilities in production.`,
    );
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
    productionLike,
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
  const listingPhotoStorage = loadListingPhotoStorageConfig(baseConfig.port, productionLike, catalogAssetStorage);

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
      requiredWebhookEvents: REQUIRED_STRIPE_WEBHOOK_EVENTS,
      paymentsConfigured: stripeProvider.paymentProcessor.kind === "stripe",
      connectConfigured: stripeProvider.moneyMovement.kind === "stripe",
      fakeFallbackAllowed: !productionLike,
      liveSecretKeyLikely: Boolean(stripeProvider.secretKey?.startsWith("sk_live")),
    },
    catalogAssetStorage,
    listingPhotoStorage,
    socialLogin,
    adminGoogleWorkspaceSso,
    ucpBusinessSigningKeys,
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
