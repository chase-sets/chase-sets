export type MarketplaceApiBaseConfig = Readonly<{
  databaseUrls: Readonly<{
    catalog: string;
    discovery: string;
    fulfillment: string;
    identity: string;
    inventory: string;
    marketplace: string;
    ordering: string;
    payments: string;
    pricing: string;
    reputation: string;
    settlement: string;
  }>;
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
  const requireEnv = (name: string) => {
    const value = process.env[name];

    if (!value) {
      throw new Error(`${name} environment variable is required.`);
    }

    return value;
  };

  return {
    databaseUrls: {
      catalog: requireEnv("CATALOG_DATABASE_URL"),
      discovery: requireEnv("DISCOVERY_DATABASE_URL"),
      fulfillment: requireEnv("FULFILLMENT_DATABASE_URL"),
      identity: requireEnv("IDENTITY_DATABASE_URL"),
      inventory: requireEnv("INVENTORY_DATABASE_URL"),
      marketplace: requireEnv("MARKETPLACE_DATABASE_URL"),
      ordering: requireEnv("ORDERING_DATABASE_URL"),
      payments: requireEnv("PAYMENTS_DATABASE_URL"),
      pricing: requireEnv("PRICING_DATABASE_URL"),
      reputation: requireEnv("REPUTATION_DATABASE_URL"),
      settlement: requireEnv("SETTLEMENT_DATABASE_URL"),
    },
    identityApiBaseUrl: requireEnv("IDENTITY_API_BASE_URL"),
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
