import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config";

const originalEnv = { ...process.env };

function resetEnv() {
  process.env = { ...originalEnv };
}

describe("loadConfig", () => {
  afterEach(() => {
    resetEnv();
  });

  it("falls back to the fake payment processor when Stripe env vars are missing", () => {
    process.env.DATABASE_URL = "postgresql://catalog:catalog@localhost:5432/catalog";
    delete process.env.STRIPE_SECRET_KEY;
    delete process.env.STRIPE_PUBLISHABLE_KEY;
    delete process.env.STRIPE_WEBHOOK_SECRET;

    const config = loadConfig();

    expect(config.paymentProcessor).toEqual({ kind: "fake" });
  });

  it("falls back to the fake payment processor when Stripe config is incomplete", () => {
    process.env.DATABASE_URL = "postgresql://catalog:catalog@localhost:5432/catalog";
    process.env.STRIPE_SECRET_KEY = "sk_test_123";
    process.env.STRIPE_PUBLISHABLE_KEY = "pk_test_123";
    delete process.env.STRIPE_WEBHOOK_SECRET;

    const config = loadConfig();

    expect(config.paymentProcessor).toEqual({ kind: "fake" });
  });

  it("uses the Stripe payment processor when all Stripe env vars are present", () => {
    process.env.DATABASE_URL = "postgresql://catalog:catalog@localhost:5432/catalog";
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
});
