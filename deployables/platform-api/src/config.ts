import {
  getApiHostContextNames,
  type ApiHostContextName,
} from "@chase-sets/platform-runtime/api";
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
  contextDatabaseUrls: Readonly<Partial<Record<PlatformApiContextName, string>>>;
  port: number;
  paymentReconciliationIntervalMs?: number | null;
  sellerFundsReleaseIntervalMs?: number | null;
  payoutReconciliationIntervalMs?: number | null;
}>;

export type PlatformApiConfig = PlatformApiBaseConfig & Readonly<{
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

export function getContextDatabaseEnvName(contextName: PlatformApiContextName) {
  return `DATABASE_URL_${contextName.replaceAll("-", "_").toUpperCase()}`;
}

function loadBaseConfig(): PlatformApiBaseConfig {
  const sharedDatabaseUrl = getOptionalEnv("DATABASE_URL");
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
    contextDatabaseUrls,
    port: Number(process.env.PORT ?? 6182),
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

export function loadBootstrapConfig(): PlatformApiBaseConfig {
  return loadBaseConfig();
}

export function loadConfig(): PlatformApiConfig {
  const baseConfig = loadBaseConfig();
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
