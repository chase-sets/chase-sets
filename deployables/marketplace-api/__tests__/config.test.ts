import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config";

const originalEnv = { ...process.env };

function resetEnv() {
  process.env = { ...originalEnv };
}

function createContextDatabaseUrl(contextName: string) {
  return `postgresql://${contextName}:${contextName}@localhost:5432/${contextName}`;
}

function setRequiredMarketplaceApiEnv() {
  process.env.CATALOG_DATABASE_URL = createContextDatabaseUrl("catalog");
  process.env.DISCOVERY_DATABASE_URL = createContextDatabaseUrl("discovery");
  process.env.FULFILLMENT_DATABASE_URL = createContextDatabaseUrl("fulfillment");
  process.env.IDENTITY_DATABASE_URL = createContextDatabaseUrl("identity");
  process.env.INVENTORY_DATABASE_URL = createContextDatabaseUrl("inventory");
  process.env.MARKETPLACE_DATABASE_URL = createContextDatabaseUrl("marketplace");
  process.env.ORDERING_DATABASE_URL = createContextDatabaseUrl("ordering");
  process.env.PAYMENTS_DATABASE_URL = createContextDatabaseUrl("payments");
  process.env.PRICING_DATABASE_URL = createContextDatabaseUrl("pricing");
  process.env.REPUTATION_DATABASE_URL = createContextDatabaseUrl("reputation");
  process.env.SETTLEMENT_DATABASE_URL = createContextDatabaseUrl("settlement");
  process.env.IDENTITY_API_BASE_URL = "http://localhost:6181";
}

describe("loadConfig", () => {
  afterEach(() => {
    resetEnv();
  });

  it("falls back to the fake payment processor when Stripe env vars are missing", () => {
    setRequiredMarketplaceApiEnv();
    delete process.env.STRIPE_SECRET_KEY;
    delete process.env.STRIPE_PUBLISHABLE_KEY;
    delete process.env.STRIPE_WEBHOOK_SECRET;

    const config = loadConfig();

    expect(config.paymentProcessor).toEqual({ kind: "fake" });
  });

  it("falls back to the fake payment processor when Stripe config is incomplete", () => {
    setRequiredMarketplaceApiEnv();
    process.env.STRIPE_SECRET_KEY = "sk_test_123";
    process.env.STRIPE_PUBLISHABLE_KEY = "pk_test_123";
    delete process.env.STRIPE_WEBHOOK_SECRET;

    const config = loadConfig();

    expect(config.paymentProcessor).toEqual({ kind: "fake" });
  });

  it("uses the Stripe payment processor when all Stripe env vars are present", () => {
    setRequiredMarketplaceApiEnv();
    process.env.STRIPE_SECRET_KEY = "sk_test_123";
    process.env.STRIPE_PUBLISHABLE_KEY = "pk_test_123";
    process.env.STRIPE_WEBHOOK_SECRET = "whsec_123";
    process.env.STRIPE_API_BASE_URL = "https://stripe.test";

    const config = loadConfig();

    expect(config.paymentProcessor).toEqual({
      kind: "stripe",
      secretKey: "sk_test_123",
      publishableKey: "pk_test_123",
      webhookSecret: "whsec_123",
      apiBaseUrl: "https://stripe.test",
    });
  });

  it("keeps each bounded context on its own database credentials", () => {
    setRequiredMarketplaceApiEnv();

    const config = loadConfig();

    for (const [contextName, databaseUrl] of Object.entries(config.databaseUrls)) {
      const parsed = new URL(databaseUrl);
      expect(parsed.username).toBe(contextName);
      expect(parsed.password).toBe(contextName);
      expect(parsed.pathname).toBe(`/${contextName}`);
    }
  });
});
