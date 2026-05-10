import {
  getApiHostContextNames,
  type ApiHostContextName,
} from "@chase-sets/platform-runtime/api";
import {
  PLATFORM_INTERNAL_AUTH_SECRET_ENV,
  resolvePlatformInternalAuthSecret,
} from "@chase-sets/platform-runtime/http";
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

export type PlatformApiContextName = ApiHostContextName<typeof apiContextRegistry>;

export type PlatformApiBaseConfig = Readonly<{
  sharedDatabaseUrl: string | null;
  controlDatabaseUrl?: string;
  contextDatabaseUrls: Readonly<Partial<Record<PlatformApiContextName, string>>>;
  pool?: PlatformApiPoolConfig;
  port: number;
  internalAuthSecret?: string;
  realtime?: PlatformApiRealtimeConfig;
  paymentReconciliationIntervalMs?: number | null;
  sellerFundsReleaseIntervalMs?: number | null;
  payoutReconciliationIntervalMs?: number | null;
}>;

export type PlatformApiBootstrapConfig = PlatformApiBaseConfig & Readonly<{
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
  postage: PlatformApiPostageConfig;
  stripeGoLive: StripeGoLiveCheckReport;
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

function getOptionalCsvEnv(name: string): readonly string[] {
  return (process.env[name] ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
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

export function getContextDatabaseEnvName(contextName: PlatformApiContextName) {
  return `DATABASE_URL_${contextName.replaceAll("-", "_").toUpperCase()}`;
}

function loadBaseConfig(): PlatformApiBaseConfig {
  const sharedDatabaseUrl = getOptionalEnv("DATABASE_URL");
  const explicitControlDatabaseUrl = getOptionalEnv("PLATFORM_CONTROL_DATABASE_URL");
  const productionLike = process.env.NODE_ENV === "production";
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
    realtime: {
      batchSize: getPositiveNumberEnv("REALTIME_BATCH_SIZE", 100),
      pollIntervalMs: getPositiveNumberEnv("REALTIME_POLL_INTERVAL_MS", 1_000),
      heartbeatIntervalMs: getPositiveNumberEnv("REALTIME_HEARTBEAT_INTERVAL_MS", 15_000),
      retentionPruneIntervalMs: getPositiveNumberEnv("REALTIME_RETENTION_PRUNE_INTERVAL_MS", 60_000),
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
  };
}

export function loadBootstrapConfig(): PlatformApiBootstrapConfig {
  return {
    ...loadBaseConfig(),
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
  const productionLike = process.env.NODE_ENV === "production";

  if (
    productionLike &&
    baseConfig.realtime.streamLimiter.kind !== "postgres"
  ) {
    throw new Error(
      "REALTIME_STREAM_LIMITER=postgres and PLATFORM_CONTROL_DATABASE_URL are required for horizontally scalable SSE in production.",
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

  if (stripeSecretKey && stripePublishableKey && stripeWebhookSecret) {
    return {
      ...baseConfig,
      moneyMovement,
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
