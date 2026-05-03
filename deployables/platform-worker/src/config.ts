import {
  getWorkerHostContextNames,
  type WorkerHostContextName,
} from "@chase-sets/platform-runtime/worker";
import { workerContextRegistry } from "./generated/worker-context-registry";

export type PlatformWorkerContextName = WorkerHostContextName<typeof workerContextRegistry>;

export type PlatformWorkerPoolConfig = Readonly<{
  max: number;
  idleTimeoutMillis: number;
  connectionTimeoutMillis: number;
}>;

export type PlatformWorkerConfig = Readonly<{
  sharedDatabaseUrl: string | null;
  controlDatabaseUrl: string;
  contextDatabaseUrls: Readonly<Partial<Record<PlatformWorkerContextName, string>>>;
  pool: PlatformWorkerPoolConfig;
  port: number;
  workerId: string;
  maxConcurrentRunners: number;
  pollIntervalMs: number;
  leaseTtlMs: number;
  leaseRenewIntervalMs: number;
  paymentReconciliationIntervalMs: number | null;
  sellerFundsReleaseIntervalMs: number | null;
  payoutReconciliationIntervalMs: number | null;
  paymentProcessor: PlatformWorkerPaymentProcessorConfig;
  moneyMovement: PlatformWorkerMoneyMovementConfig;
  postage: PlatformWorkerPostageConfig;
}>;

export type PlatformWorkerPaymentProcessorConfig =
  | Readonly<{ kind: "fake" }>
  | Readonly<{
      kind: "stripe";
      secretKey: string;
      publishableKey: string;
      webhookSecret: string;
      apiBaseUrl?: string;
      checkoutUiMode?: "elements" | "hosted";
    }>;

export type PlatformWorkerMoneyMovementConfig =
  | Readonly<{ kind: "fake" }>
  | Readonly<{
      kind: "stripe";
      secretKey: string;
      webhookSecret: string;
      apiBaseUrl?: string;
      onboardingReturnUrl?: string;
      onboardingRefreshUrl?: string;
    }>;

export type PlatformWorkerPostageConfig =
  | Readonly<{ kind: "sandbox" }>
  | Readonly<{
      kind: "easypost";
      apiKey: string;
      apiBaseUrl?: string;
      mode: "test" | "production";
    }>;

const workerContexts = getWorkerHostContextNames(workerContextRegistry, "platform-worker");

export function getContextDatabaseEnvName(contextName: PlatformWorkerContextName) {
  return `DATABASE_URL_${contextName.replaceAll("-", "_").toUpperCase()}`;
}

export function loadConfig(): PlatformWorkerConfig {
  const sharedDatabaseUrl = getOptionalEnv("DATABASE_URL");
  const controlDatabaseUrl = getOptionalEnv("PLATFORM_CONTROL_DATABASE_URL") ??
    sharedDatabaseUrl;
  if (!controlDatabaseUrl) {
    throw new Error("PLATFORM_CONTROL_DATABASE_URL or DATABASE_URL is required.");
  }

  const contextDatabaseUrls = Object.fromEntries(
    workerContexts.flatMap((contextName) => {
      const databaseUrl = getOptionalEnv(getContextDatabaseEnvName(contextName));
      return databaseUrl ? [[contextName, databaseUrl]] : [];
    }),
  ) as Readonly<Partial<Record<PlatformWorkerContextName, string>>>;
  const missingContextNames = workerContexts.filter(
    (contextName) => !sharedDatabaseUrl && !contextDatabaseUrls[contextName],
  );
  if (missingContextNames.length > 0) {
    throw new Error(
      `DATABASE_URL or per-context database URLs are required. Missing: ${missingContextNames
        .map((contextName) => getContextDatabaseEnvName(contextName))
        .join(", ")}.`,
    );
  }

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

  return {
    sharedDatabaseUrl,
    controlDatabaseUrl,
    contextDatabaseUrls,
    pool: {
      max: getPositiveNumberEnv("DATABASE_POOL_MAX", 10),
      idleTimeoutMillis: getPositiveNumberEnv("DATABASE_POOL_IDLE_TIMEOUT_MS", 30_000),
      connectionTimeoutMillis: getPositiveNumberEnv("DATABASE_POOL_CONNECTION_TIMEOUT_MS", 5_000),
    },
    port: Number(process.env.PORT ?? 6183),
    workerId: getOptionalEnv("WORKER_ID") ??
      `platform-worker-${process.pid}-${Date.now().toString(36)}`,
    maxConcurrentRunners: getPositiveNumberEnv("WORKER_MAX_CONCURRENT_RUNNERS", 4),
    pollIntervalMs: getPositiveNumberEnv("WORKER_POLL_INTERVAL_MS", 1_000),
    leaseTtlMs: getPositiveNumberEnv("WORKER_LEASE_TTL_MS", 30_000),
    leaseRenewIntervalMs: getPositiveNumberEnv("WORKER_LEASE_RENEW_INTERVAL_MS", 10_000),
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
    paymentProcessor: stripeSecretKey && stripePublishableKey && stripeWebhookSecret
      ? {
          kind: "stripe",
          secretKey: stripeSecretKey,
          publishableKey: stripePublishableKey,
          webhookSecret: stripeWebhookSecret,
          apiBaseUrl: stripeApiBaseUrl,
          checkoutUiMode:
            stripeCheckoutUiMode === "hosted" ? "hosted" : "elements",
        }
      : { kind: "fake" },
    moneyMovement: stripeSecretKey && stripeWebhookSecret
      ? {
          kind: "stripe",
          secretKey: stripeSecretKey,
          webhookSecret: stripeWebhookSecret,
          apiBaseUrl: stripeApiBaseUrl,
          onboardingReturnUrl: stripeConnectReturnUrl,
          onboardingRefreshUrl: stripeConnectRefreshUrl,
        }
      : { kind: "fake" },
    postage: easyPostApiKey
      ? {
          kind: "easypost",
          apiKey: easyPostApiKey,
          apiBaseUrl: easyPostApiBaseUrl,
          mode: easyPostMode,
        }
      : { kind: "sandbox" },
  };
}

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
