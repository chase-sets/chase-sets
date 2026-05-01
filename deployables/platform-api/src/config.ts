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

export type PlatformApiContextName = ApiHostContextName<typeof apiContextRegistry>;

export type PlatformApiBaseConfig = Readonly<{
  sharedDatabaseUrl: string | null;
  contextDatabaseUrls: Readonly<Partial<Record<PlatformApiContextName, string>>>;
  port: number;
}>;

export type PlatformApiConfig = PlatformApiBaseConfig & Readonly<{
  paymentProcessor: PlatformApiPaymentProcessorConfig;
  moneyMovement: PlatformApiMoneyMovementConfig;
}>;

const platformApiContexts = getApiHostContextNames(apiContextRegistry, "platform-api");

function getOptionalEnv(name: string) {
  const value = process.env[name];

  return value?.trim() ? value.trim() : null;
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
  };
}

export function loadBootstrapConfig(): PlatformApiBaseConfig {
  return loadBaseConfig();
}

export function loadConfig(): PlatformApiConfig {
  const baseConfig = loadBaseConfig();
  const stripeSecretKey = process.env.STRIPE_SECRET_KEY;
  const stripePublishableKey = process.env.STRIPE_PUBLISHABLE_KEY;
  const stripeWebhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  const stripeApiBaseUrl = process.env.STRIPE_API_BASE_URL;
  const stripeConnectReturnUrl = process.env.STRIPE_CONNECT_RETURN_URL;
  const stripeConnectRefreshUrl = process.env.STRIPE_CONNECT_REFRESH_URL;

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
      paymentProcessor: {
        kind: "stripe",
        secretKey: stripeSecretKey,
        publishableKey: stripePublishableKey,
        webhookSecret: stripeWebhookSecret,
        apiBaseUrl: stripeApiBaseUrl,
      },
    };
  }

  return {
    ...baseConfig,
    moneyMovement,
    paymentProcessor: {
      kind: "fake",
    },
  };
}
