export type MarketplaceApiBaseConfig = Readonly<{
  databaseUrl: string;
  identityApiBaseUrl: string;
  port: number;
  stripeApiBaseUrl?: string;
}>;

export type MarketplaceApiConfig = MarketplaceApiBaseConfig & Readonly<{
  stripeSecretKey: string;
  stripePublishableKey: string;
  stripeWebhookSecret: string;
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
    stripeApiBaseUrl: process.env.STRIPE_API_BASE_URL,
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

  if (!stripeSecretKey) {
    throw new Error("STRIPE_SECRET_KEY environment variable is required.");
  }
  if (!stripePublishableKey) {
    throw new Error("STRIPE_PUBLISHABLE_KEY environment variable is required.");
  }
  if (!stripeWebhookSecret) {
    throw new Error("STRIPE_WEBHOOK_SECRET environment variable is required.");
  }

  return {
    ...baseConfig,
    stripeSecretKey,
    stripePublishableKey,
    stripeWebhookSecret,
  };
}
