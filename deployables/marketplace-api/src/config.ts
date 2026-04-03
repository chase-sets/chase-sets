export type MarketplaceApiBaseConfig = Readonly<{
  databaseUrl: string;
  identityApiBaseUrl: string;
  port: number;
}>;

export type MarketplaceApiPaymentProcessorConfig =
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

export type MarketplaceApiConfig = MarketplaceApiBaseConfig & Readonly<{
  paymentProcessor: MarketplaceApiPaymentProcessorConfig;
}>;

function loadBaseConfig(): MarketplaceApiBaseConfig {
  const databaseUrl = process.env.DATABASE_URL;
  const identityApiBaseUrl =
    process.env.IDENTITY_API_BASE_URL ?? "http://localhost:6181/api/identity";

  if (!databaseUrl) {
    throw new Error("DATABASE_URL environment variable is required.");
  }

  return {
    databaseUrl,
    identityApiBaseUrl,
    port: Number(process.env.PORT ?? 6182),
  };
}

export function loadBootstrapConfig(): MarketplaceApiBaseConfig {
  return loadBaseConfig();
}

export function loadConfig(): MarketplaceApiConfig {
  const baseConfig = loadBaseConfig();
  const stripeSecretKey = process.env.STRIPE_SECRET_KEY;
  const stripePublishableKey = process.env.STRIPE_PUBLISHABLE_KEY;
  const stripeWebhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  const stripeApiBaseUrl = process.env.STRIPE_API_BASE_URL;

  if (stripeSecretKey && stripePublishableKey && stripeWebhookSecret) {
    return {
      ...baseConfig,
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
    paymentProcessor: {
      kind: "fake",
    },
  };
}
