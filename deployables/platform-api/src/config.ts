import {
  getApiHostContextNames,
  nonProductionDataProfiles,
  productionLikeDataProfiles,
  type ApiHostContextName,
  type EnvironmentDataProfile,
} from "@chase-sets/platform-runtime/api";
import {
  PLATFORM_INTERNAL_AUTH_SECRET_ENV,
  resolvePlatformInternalAuthSecret,
} from "@chase-sets/platform-runtime/http";
import type { UcpBusinessSigningKeySet } from "@chase-sets/platform-runtime/ucp";
import { apiContextRegistry } from "./generated/api-context-registry";

export type PlatformApiPaymentProcessorConfig =
  | Readonly<{
      kind: "fake";
    }>
  | Readonly<{
      kind: "stripe";
      secretKey: string;
      publishableKey: string;
      webhookSecret: string;
      apiBaseUrl?: string;
      checkoutUiMode?: "elements" | "hosted";
    }>;

export type PlatformApiMoneyMovementConfig =
  | Readonly<{
      kind: "fake";
    }>
  | Readonly<{
      kind: "stripe";
      secretKey: string;
      webhookSecret: string;
      apiBaseUrl?: string;
      onboardingReturnUrl?: string;
      onboardingRefreshUrl?: string;
    }>;

export type PlatformApiPostageConfig =
  | Readonly<{
      kind: "sandbox";
    }>
  | Readonly<{
      kind: "easypost";
      apiKey: string;
      apiBaseUrl?: string;
      mode: "test" | "production";
    }>;

export type PlatformApiSocialLoginProviderConfig = Readonly<{
  clientId: string;
  clientSecret: string;
}>;

export type PlatformApiSocialLoginConfig = Readonly<{
  google?: PlatformApiSocialLoginProviderConfig;
  facebook?: PlatformApiSocialLoginProviderConfig;
}>;

export type PlatformApiCatalogAssetStorageConfig =
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
  writeConsistencyDrainEnabled?: boolean;
  paymentReconciliationIntervalMs?: number | null;
  sellerFundsReleaseIntervalMs?: number | null;
  payoutReconciliationIntervalMs?: number | null;
  deploymentEnvironment?: string | null;
  dataProfiles?: readonly EnvironmentDataProfile[];
}>;

export type PlatformApiBootstrapConfig = PlatformApiBaseConfig & Readonly<{
  listingPhotoStorage: PlatformApiListingPhotoStorageConfig;
  platformAdmin: PlatformApiPlatformAdminConfig | null;
}>;

export type PlatformApiPlatformAdminConfig = Readonly<{
  email: string;
  password: string;
  displayName: string;
  accountName: string;
}>;

export type PlatformApiPoolConfig = Readonly<{
  max: number;
  idleTimeoutMillis: number;
  connectionTimeoutMillis: number;
}>;

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

export type PlatformApiConfig = Omit<PlatformApiBaseConfig, "realtime"> & Readonly<{
  realtime: PlatformApiRealtimeConfig;
  paymentProcessor: PlatformApiPaymentProcessorConfig;
  moneyMovement: PlatformApiMoneyMovementConfig;
  mobileMessaging: PlatformApiMobileMessagingConfig;
  postage: PlatformApiPostageConfig;
  socialLogin: PlatformApiSocialLoginConfig;
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

export const STRIPE_PLATFORM_API_VERSION = "2026-02-25.clover";

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
  "shared_payment.granted_token.used",
  "shared_payment.granted_token.deactivated",
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
  onboardingUrlsConfigured: boolean;
  fakeFallbackAllowed: boolean;
  liveSecretKeyLikely: boolean;
}>;

const platformApiContexts = getApiHostContextNames(apiContextRegistry, "platform-api");

function getOptionalEnv(name: string) {
  const value = process.env[name];

  return value?.trim() ? value.trim() : null;
}

function getOptionalPositiveNumberEnv(name: string, defaultValue: number) {
  const parsed = Number(process.env[name] ?? defaultValue);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function getPositiveNumberEnv(name: string, defaultValue: number) {
  return getOptionalPositiveNumberEnv(name, defaultValue) ?? defaultValue;
}

function getBooleanEnv(name: string, defaultValue: boolean) {
  const value = getOptionalEnv(name);
  if (!value) {
    return defaultValue;
  }

  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function getOptionalCsvEnv(name: string): readonly string[] {
  return (process.env[name] ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

function getOptionalJsonEnv<T>(name: string): T | null {
  const value = getOptionalEnv(name);
  if (!value) {
    return null;
  }
  try {
    return JSON.parse(value) as T;
  } catch (error) {
    throw new Error(`${name} must contain valid JSON.`);
  }
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

function loadDataProfiles(environmentName: string): readonly EnvironmentDataProfile[] {
  const explicitProfiles = getOptionalCsvEnv("PLATFORM_DATA_PROFILES");
  if (explicitProfiles.length > 0) {
    const allowedProfiles = new Set<EnvironmentDataProfile>([
      "critical-bootstrap",
      "catalog-integration-bootstrap",
      "scenario-seed",
    ]);
    for (const profile of explicitProfiles) {
      if (!allowedProfiles.has(profile as EnvironmentDataProfile)) {
        throw new Error(
          `PLATFORM_DATA_PROFILES contains unsupported data profile '${profile}'.`,
        );
      }
    }

    return explicitProfiles as readonly EnvironmentDataProfile[];
  }

  if (isLongLivedEnvironment(environmentName)) {
    return productionLikeDataProfiles;
  }

  return nonProductionDataProfiles;
}

function loadPlatformAdminConfig(): PlatformApiPlatformAdminConfig | null {
  const email = getOptionalEnv("PLATFORM_ADMIN_EMAIL");
  const password = getOptionalEnv("PLATFORM_ADMIN_PASSWORD");

  if (!email && !password) {
    return null;
  }

  if (!email || !password) {
    throw new Error(
      "PLATFORM_ADMIN_EMAIL and PLATFORM_ADMIN_PASSWORD must be configured together.",
    );
  }

  return {
    email,
    password,
    displayName: getOptionalEnv("PLATFORM_ADMIN_DISPLAY_NAME") ?? "Platform Admin",
    accountName: getOptionalEnv("PLATFORM_ADMIN_ACCOUNT_NAME") ?? "Chase Sets Platform",
  };
}

function loadCatalogAssetStorageConfig(
  port: number,
  productionLike: boolean,
): PlatformApiCatalogAssetStorageConfig {
  const kind = getOptionalEnv("CATALOG_ASSET_STORAGE_KIND") ??
    (productionLike ? "s3" : "filesystem");

  if (kind === "filesystem") {
    if (productionLike) {
      throw new Error(
        "CATALOG_ASSET_STORAGE_KIND=s3 is required for Catalog asset storage in production.",
      );
    }

    return {
      kind: "filesystem",
      rootDir: getOptionalEnv("CATALOG_ASSET_LOCAL_ROOT") ??
        "artifacts/catalog-assets",
      publicBaseUrl: getOptionalEnv("CATALOG_ASSET_PUBLIC_BASE_URL") ??
        `http://localhost:${port}/catalog-assets`,
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

function loadListingPhotoStorageConfig(
  port: number,
  productionLike: boolean,
  fallbackStorage?: PlatformApiCatalogAssetStorageConfig,
): PlatformApiListingPhotoStorageConfig {
  const explicitKind = getOptionalEnv("MARKETPLACE_LISTING_PHOTO_STORAGE_KIND");
  if (!explicitKind && productionLike && fallbackStorage) {
    return fallbackStorage;
  }

  const kind = explicitKind ?? (productionLike ? "s3" : "filesystem");

  if (kind === "filesystem") {
    if (productionLike) {
      throw new Error(
        "MARKETPLACE_LISTING_PHOTO_STORAGE_KIND=s3 is required for Marketplace listing photo storage in production.",
      );
    }

    return {
      kind: "filesystem",
      rootDir: getOptionalEnv("MARKETPLACE_LISTING_PHOTO_LOCAL_ROOT") ??
        "artifacts/marketplace-listing-photos",
      publicBaseUrl: getOptionalEnv("MARKETPLACE_LISTING_PHOTO_PUBLIC_BASE_URL") ??
        `http://localhost:${port}/marketplace-listing-photos`,
    };
  }

  if (kind !== "s3") {
    throw new Error("MARKETPLACE_LISTING_PHOTO_STORAGE_KIND must be filesystem or s3.");
  }

  const bucket = getOptionalEnv("MARKETPLACE_LISTING_PHOTO_S3_BUCKET");
  const region = getOptionalEnv("MARKETPLACE_LISTING_PHOTO_S3_REGION");
  const publicBaseUrl = getOptionalEnv("MARKETPLACE_LISTING_PHOTO_PUBLIC_BASE_URL");
  const accessKeyId = getOptionalEnv("MARKETPLACE_LISTING_PHOTO_S3_ACCESS_KEY_ID");
  const secretAccessKey = getOptionalEnv("MARKETPLACE_LISTING_PHOTO_S3_SECRET_ACCESS_KEY");

  if (!bucket || !region || !publicBaseUrl) {
    throw new Error(
      "MARKETPLACE_LISTING_PHOTO_S3_BUCKET, MARKETPLACE_LISTING_PHOTO_S3_REGION, and MARKETPLACE_LISTING_PHOTO_PUBLIC_BASE_URL are required when MARKETPLACE_LISTING_PHOTO_STORAGE_KIND=s3.",
    );
  }
  if (Boolean(accessKeyId) !== Boolean(secretAccessKey)) {
    throw new Error(
      "MARKETPLACE_LISTING_PHOTO_S3_ACCESS_KEY_ID and MARKETPLACE_LISTING_PHOTO_S3_SECRET_ACCESS_KEY must be configured together.",
    );
  }

  return {
    kind: "s3",
    bucket,
    region,
    publicBaseUrl,
    endpoint: getOptionalEnv("MARKETPLACE_LISTING_PHOTO_S3_ENDPOINT") ?? undefined,
    accessKeyId: accessKeyId ?? undefined,
    secretAccessKey: secretAccessKey ?? undefined,
    forcePathStyle: getBooleanEnv("MARKETPLACE_LISTING_PHOTO_S3_FORCE_PATH_STYLE", false),
  };
}

function loadUcpBusinessSigningKeys(
  productionLike: boolean,
): UcpBusinessSigningKeySet | undefined {
  const privateJwk = getOptionalJsonEnv<JsonWebKey>("UCP_BUSINESS_SIGNING_PRIVATE_JWK");
  const kid = getOptionalEnv("UCP_BUSINESS_SIGNING_KEY_ID");
  const alg = getOptionalEnv("UCP_BUSINESS_SIGNING_ALG") ?? "ES256";
  const previousPublicJwks =
    getOptionalJsonEnv<readonly JsonWebKey[]>("UCP_BUSINESS_SIGNING_PREVIOUS_PUBLIC_JWKS") ?? [];

  if (!privateJwk && !kid) {
    return undefined;
  }
  if (!privateJwk || !kid) {
    throw new Error(
      "UCP_BUSINESS_SIGNING_PRIVATE_JWK and UCP_BUSINESS_SIGNING_KEY_ID must be configured together.",
    );
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
  return `DATABASE_URL_${contextName.replaceAll("-", "_").toUpperCase()}`;
}

function loadBaseConfig(): PlatformApiBaseConfig {
  const sharedDatabaseUrl = getOptionalEnv("DATABASE_URL");
  const explicitControlDatabaseUrl = getOptionalEnv("PLATFORM_CONTROL_DATABASE_URL");
  const deploymentEnvironment = getDeploymentEnvironment();
  const productionLike = isProductionDeployment();
  const controlDatabaseUrl = explicitControlDatabaseUrl ?? sharedDatabaseUrl;
  if (!controlDatabaseUrl) {
    throw new Error(
      "PLATFORM_CONTROL_DATABASE_URL or DATABASE_URL is required for platform control-plane coordination.",
    );
  }
  if (productionLike && !explicitControlDatabaseUrl) {
    throw new Error(
      "PLATFORM_CONTROL_DATABASE_URL is required for platform control-plane coordination in production.",
    );
  }
  const contextDatabaseUrls = Object.fromEntries(
    platformApiContexts.flatMap((contextName) => {
      const databaseUrl = getOptionalEnv(getContextDatabaseEnvName(contextName));

      return databaseUrl ? [[contextName, databaseUrl]] : [];
    }),
  ) as Readonly<Partial<Record<PlatformApiContextName, string>>>;
  const missingContextNames = platformApiContexts.filter(
    (contextName) => !sharedDatabaseUrl && !contextDatabaseUrls[contextName],
  );

  if (missingContextNames.length > 0) {
    throw new Error(
      `DATABASE_URL or per-context database URLs are required. Missing: ${missingContextNames
        .map((contextName) => getContextDatabaseEnvName(contextName))
        .join(", ")}.`,
    );
  }

  return {
    sharedDatabaseUrl,
    controlDatabaseUrl,
    contextDatabaseUrls,
    pool: {
      max: getPositiveNumberEnv("DATABASE_POOL_MAX", 10),
      idleTimeoutMillis: getPositiveNumberEnv("DATABASE_POOL_IDLE_TIMEOUT_MS", 30_000),
      connectionTimeoutMillis: getPositiveNumberEnv("DATABASE_POOL_CONNECTION_TIMEOUT_MS", 5_000),
    },
    port: Number(process.env.PORT ?? 6182),
    internalAuthSecret: resolvePlatformInternalAuthSecret(),
    writeConsistencyDrainEnabled: getBooleanEnv("WRITE_CONSISTENCY_DRAIN_ENABLED", true),
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
      maxActiveStreamsPerConnectionKey: getPositiveNumberEnv(
        "REALTIME_MAX_ACTIVE_STREAMS_PER_CONNECTION_KEY",
        6,
      ),
      cursorSigningSecret: getOptionalEnv("REALTIME_CURSOR_SIGNING_SECRET") ?? undefined,
      previousCursorSigningSecrets: getOptionalCsvEnv(
        "REALTIME_PREVIOUS_CURSOR_SIGNING_SECRETS",
      ),
      streamLimiter: loadRealtimeStreamLimiterConfig(),
    },
    paymentReconciliationIntervalMs: getOptionalPositiveNumberEnv(
      "PAYMENT_RECONCILIATION_INTERVAL_MS",
      300_000,
    ),
    sellerFundsReleaseIntervalMs: getOptionalPositiveNumberEnv(
      "SELLER_FUNDS_RELEASE_INTERVAL_MS",
      300_000,
    ),
    payoutReconciliationIntervalMs: getOptionalPositiveNumberEnv(
      "PAYOUT_RECONCILIATION_INTERVAL_MS",
      300_000,
    ),
    deploymentEnvironment,
    dataProfiles: loadDataProfiles(deploymentEnvironment),
  };
}

export function loadBootstrapConfig(): PlatformApiBootstrapConfig {
  const baseConfig = loadBaseConfig();
  const productionLike = isProductionDeployment();
  const catalogAssetStorage = loadCatalogAssetStorageConfig(
    baseConfig.port,
    productionLike,
  );

  return {
    ...baseConfig,
    listingPhotoStorage: loadListingPhotoStorageConfig(
      baseConfig.port,
      productionLike,
      catalogAssetStorage,
    ),
    platformAdmin: loadPlatformAdminConfig(),
  };
}

export function loadConfig(): PlatformApiConfig {
  const baseConfig = loadBaseConfig() as PlatformApiBaseConfig & {
    realtime: PlatformApiRealtimeConfig;
  };
  const stripeSecretKey = getOptionalEnv("STRIPE_SECRET_KEY");
  const stripePublishableKey = getOptionalEnv("STRIPE_PUBLISHABLE_KEY");
  const stripeWebhookSecret = getOptionalEnv("STRIPE_WEBHOOK_SECRET");
  const stripeApiBaseUrl = getOptionalEnv("STRIPE_API_BASE_URL") ?? undefined;
  const stripeCheckoutUiMode = getOptionalEnv("STRIPE_CHECKOUT_UI_MODE");
  const stripeConnectReturnUrl =
    getOptionalEnv("STRIPE_CONNECT_RETURN_URL") ?? undefined;
  const stripeConnectRefreshUrl =
    getOptionalEnv("STRIPE_CONNECT_REFRESH_URL") ?? undefined;
  const easyPostApiKey = getOptionalEnv("EASYPOST_API_KEY");
  const easyPostApiBaseUrl = getOptionalEnv("EASYPOST_API_BASE_URL") ?? undefined;
  const easyPostMode =
    getOptionalEnv("EASYPOST_MODE") === "production" ? "production" : "test";
  const googleSocialLoginClientId = getOptionalEnv("GOOGLE_SOCIAL_LOGIN_CLIENT_ID");
  const googleSocialLoginClientSecret = getOptionalEnv("GOOGLE_SOCIAL_LOGIN_CLIENT_SECRET");
  const facebookSocialLoginClientId = getOptionalEnv("FACEBOOK_SOCIAL_LOGIN_CLIENT_ID");
  const facebookSocialLoginClientSecret = getOptionalEnv("FACEBOOK_SOCIAL_LOGIN_CLIENT_SECRET");
  const mobileMessagingProvider = getOptionalEnv("MOBILE_MESSAGING_PROVIDER");
  const twilioAuthToken = getOptionalEnv("TWILIO_AUTH_TOKEN");
  const twilioRequireWebhookSignature = getBooleanEnv(
    "TWILIO_WEBHOOK_SIGNATURE_REQUIRED",
    true,
  );
  const productionLike = isProductionDeployment();
  const ucpBusinessSigningKeys = loadUcpBusinessSigningKeys(productionLike);

  if (
    productionLike &&
    (baseConfig.realtime.streamLimiter.kind !== "postgres" ||
      !baseConfig.realtime.wakeSignalEnabled)
  ) {
    throw new Error(
      "REALTIME_STREAM_LIMITER=postgres, REALTIME_WAKE_SIGNAL_ENABLED=true, and PLATFORM_CONTROL_DATABASE_URL are required for horizontally scalable SSE in production.",
    );
  }

  if (
    productionLike &&
    (!stripeSecretKey || !stripePublishableKey || !stripeWebhookSecret)
  ) {
    throw new Error(
      "STRIPE_SECRET_KEY, STRIPE_PUBLISHABLE_KEY, and STRIPE_WEBHOOK_SECRET are required for Stripe payment processing and Connect money movement in production.",
    );
  }
  if (productionLike && !easyPostApiKey) {
    throw new Error(
      "EASYPOST_API_KEY is required for USPS postage label purchasing in production.",
    );
  }
  if (
    productionLike &&
    (!stripeConnectReturnUrl || !stripeConnectRefreshUrl)
  ) {
    throw new Error(
      "STRIPE_CONNECT_RETURN_URL and STRIPE_CONNECT_REFRESH_URL are required for hosted payout setup in production.",
    );
  }
  if (productionLike && !getOptionalEnv(PLATFORM_INTERNAL_AUTH_SECRET_ENV)) {
    throw new Error(
      `${PLATFORM_INTERNAL_AUTH_SECRET_ENV} is required for internal platform API capabilities in production.`,
    );
  }
  if (
    productionLike &&
    Boolean(googleSocialLoginClientId) !== Boolean(googleSocialLoginClientSecret)
  ) {
    throw new Error(
      "GOOGLE_SOCIAL_LOGIN_CLIENT_ID and GOOGLE_SOCIAL_LOGIN_CLIENT_SECRET must be configured together.",
    );
  }
  if (
    productionLike &&
    Boolean(facebookSocialLoginClientId) !== Boolean(facebookSocialLoginClientSecret)
  ) {
    throw new Error(
      "FACEBOOK_SOCIAL_LOGIN_CLIENT_ID and FACEBOOK_SOCIAL_LOGIN_CLIENT_SECRET must be configured together.",
    );
  }
  if (mobileMessagingProvider === "twilio" && !twilioAuthToken) {
    throw new Error(
      "TWILIO_AUTH_TOKEN is required when MOBILE_MESSAGING_PROVIDER=twilio.",
    );
  }
  const catalogAssetStorage = loadCatalogAssetStorageConfig(
    baseConfig.port,
    productionLike,
  );
  const listingPhotoStorage = loadListingPhotoStorageConfig(
    baseConfig.port,
    productionLike,
    catalogAssetStorage,
  );

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

  const moneyMovement = stripeSecretKey && stripeWebhookSecret
    ? {
        kind: "stripe" as const,
        secretKey: stripeSecretKey,
        webhookSecret: stripeWebhookSecret,
        apiBaseUrl: stripeApiBaseUrl,
        onboardingReturnUrl: stripeConnectReturnUrl,
        onboardingRefreshUrl: stripeConnectRefreshUrl,
      }
    : {
        kind: "fake" as const,
      };
  const mobileMessaging = mobileMessagingProvider === "twilio"
    ? {
        kind: "twilio" as const,
        authToken: twilioAuthToken as string,
        requireWebhookSignature: twilioRequireWebhookSignature,
      }
    : {
        kind: "noop" as const,
      };

  if (stripeSecretKey && stripePublishableKey && stripeWebhookSecret) {
    return {
      ...baseConfig,
      moneyMovement,
      mobileMessaging,
      postage: easyPostApiKey
        ? {
            kind: "easypost",
            apiKey: easyPostApiKey,
            apiBaseUrl: easyPostApiBaseUrl,
            mode: easyPostMode,
          }
        : { kind: "sandbox" },
      stripeGoLive: {
        apiVersion: STRIPE_PLATFORM_API_VERSION,
        requiredWebhookEvents: REQUIRED_STRIPE_WEBHOOK_EVENTS,
        paymentsConfigured: true,
        connectConfigured: moneyMovement.kind === "stripe",
        onboardingUrlsConfigured: Boolean(stripeConnectReturnUrl && stripeConnectRefreshUrl),
        fakeFallbackAllowed: !productionLike,
        liveSecretKeyLikely: stripeSecretKey.startsWith("sk_live"),
      },
      catalogAssetStorage,
      listingPhotoStorage,
      socialLogin,
      ucpBusinessSigningKeys,
      paymentProcessor: {
        kind: "stripe",
        secretKey: stripeSecretKey,
        publishableKey: stripePublishableKey,
        webhookSecret: stripeWebhookSecret,
        apiBaseUrl: stripeApiBaseUrl,
        checkoutUiMode:
          stripeCheckoutUiMode === "hosted" ? "hosted" : "elements",
      },
    };
  }

  return {
    ...baseConfig,
    moneyMovement,
    mobileMessaging,
    postage: easyPostApiKey
      ? {
          kind: "easypost",
          apiKey: easyPostApiKey,
          apiBaseUrl: easyPostApiBaseUrl,
          mode: easyPostMode,
        }
      : { kind: "sandbox" },
    stripeGoLive: {
      apiVersion: STRIPE_PLATFORM_API_VERSION,
      requiredWebhookEvents: REQUIRED_STRIPE_WEBHOOK_EVENTS,
      paymentsConfigured: false,
      connectConfigured: moneyMovement.kind === "stripe",
      onboardingUrlsConfigured: Boolean(stripeConnectReturnUrl && stripeConnectRefreshUrl),
      fakeFallbackAllowed: !productionLike,
      liveSecretKeyLikely: Boolean(stripeSecretKey?.startsWith("sk_live")),
    },
    catalogAssetStorage,
    listingPhotoStorage,
    socialLogin,
    ucpBusinessSigningKeys,
    paymentProcessor: {
      kind: "fake",
    },
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
