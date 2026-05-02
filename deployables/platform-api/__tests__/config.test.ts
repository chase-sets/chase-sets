import { afterEach, describe, expect, it } from "vitest";
import {
  getContextDatabaseEnvName,
  loadBootstrapConfig,
  loadConfig,
} from "../src/config";
import { getApiHostContextNames } from "@chase-sets/platform-runtime/api";
import { apiContextRegistry } from "../src/generated/api-context-registry";

const envNames = [
  "DATABASE_URL",
  ...platformApiContextNames().map((contextName) =>
    getContextDatabaseEnvName(contextName),
  ),
];

function platformApiContextNames() {
  return getApiHostContextNames(apiContextRegistry, "platform-api");
}

afterEach(() => {
  for (const envName of envNames) {
    delete process.env[envName];
  }

  delete process.env.PORT;
  delete process.env.STRIPE_SECRET_KEY;
  delete process.env.STRIPE_PUBLISHABLE_KEY;
  delete process.env.STRIPE_WEBHOOK_SECRET;
  delete process.env.STRIPE_API_BASE_URL;
  delete process.env.STRIPE_CHECKOUT_UI_MODE;
  delete process.env.STRIPE_CONNECT_RETURN_URL;
  delete process.env.STRIPE_CONNECT_REFRESH_URL;
  delete process.env.EASYPOST_API_KEY;
  delete process.env.EASYPOST_API_BASE_URL;
  delete process.env.EASYPOST_MODE;
  delete process.env.PAYMENT_RECONCILIATION_INTERVAL_MS;
  delete process.env.PAYOUT_RECONCILIATION_INTERVAL_MS;
  delete process.env.SELLER_FUNDS_RELEASE_INTERVAL_MS;
  delete process.env.NODE_ENV;
});

describe("platform api config", () => {
  it("loads the shared database url", () => {
    process.env.DATABASE_URL = "postgresql://localhost/chase_sets";

    const config = loadBootstrapConfig();

    expect(config.sharedDatabaseUrl).toBe("postgresql://localhost/chase_sets");
    expect(config.contextDatabaseUrls).toEqual({});
    expect(config.paymentReconciliationIntervalMs).toBe(300_000);
    expect(config.payoutReconciliationIntervalMs).toBe(300_000);
    expect(config.sellerFundsReleaseIntervalMs).toBe(300_000);
  });

  it("loads per-context database urls without a shared fallback", () => {
    delete process.env.DATABASE_URL;
    for (const contextName of platformApiContextNames()) {
      process.env[getContextDatabaseEnvName(contextName)] =
        `postgresql://localhost/${contextName.replaceAll("-", "_")}`;
    }

    const config = loadBootstrapConfig();

    expect(config.sharedDatabaseUrl).toBeNull();
    expect(config.contextDatabaseUrls.auth).toBe("postgresql://localhost/auth");
    expect(config.contextDatabaseUrls.checkout).toBe("postgresql://localhost/checkout");
    expect(config.contextDatabaseUrls["commercial-terms"]).toBe(
      "postgresql://localhost/commercial_terms",
    );
    expect(config.contextDatabaseUrls.settlement).toBe("postgresql://localhost/settlement");
  });

  it("supports mixed shared and per-context database urls", () => {
    process.env.DATABASE_URL = "postgresql://localhost/shared";
    process.env.DATABASE_URL_PAYMENTS = "postgresql://localhost/payments";

    const config = loadBootstrapConfig();

    expect(config.sharedDatabaseUrl).toBe("postgresql://localhost/shared");
    expect(config.contextDatabaseUrls.payments).toBe("postgresql://localhost/payments");
  });

  it("falls back to the fake payment processor when stripe env vars are missing", () => {
    process.env.DATABASE_URL = "postgresql://localhost/chase_sets";

    expect(loadConfig().paymentProcessor).toEqual({ kind: "fake" });
    expect(loadConfig().moneyMovement).toEqual({ kind: "fake" });
  });

  it("loads Stripe Connect money movement config from Stripe env vars", () => {
    process.env.DATABASE_URL = "postgresql://localhost/chase_sets";
    process.env.STRIPE_SECRET_KEY = "sk_test";
    process.env.STRIPE_WEBHOOK_SECRET = "whsec_test";
    process.env.STRIPE_API_BASE_URL = "https://stripe.test";
    process.env.STRIPE_CONNECT_RETURN_URL = "https://example.test/return";
    process.env.STRIPE_CONNECT_REFRESH_URL = "https://example.test/refresh";

    expect(loadConfig().moneyMovement).toEqual({
      kind: "stripe",
      secretKey: "sk_test",
      webhookSecret: "whsec_test",
      apiBaseUrl: "https://stripe.test",
      onboardingReturnUrl: "https://example.test/return",
      onboardingRefreshUrl: "https://example.test/refresh",
    });
  });

  it("fails production config when Stripe payment or Connect secrets are missing", () => {
    process.env.DATABASE_URL = "postgresql://localhost/chase_sets";
    process.env.NODE_ENV = "production";

    expect(() => loadConfig()).toThrow(
      "STRIPE_SECRET_KEY, STRIPE_PUBLISHABLE_KEY, and STRIPE_WEBHOOK_SECRET are required for Stripe payment processing and Connect money movement in production.",
    );
  });

  it("fails production config when hosted payout setup URLs are missing", () => {
    process.env.DATABASE_URL = "postgresql://localhost/chase_sets";
    process.env.NODE_ENV = "production";
    process.env.STRIPE_SECRET_KEY = "sk_live_123";
    process.env.STRIPE_PUBLISHABLE_KEY = "pk_live_123";
    process.env.STRIPE_WEBHOOK_SECRET = "whsec_live";
    process.env.EASYPOST_API_KEY = "EZAK_live";

    expect(() => loadConfig()).toThrow(
      "STRIPE_CONNECT_RETURN_URL and STRIPE_CONNECT_REFRESH_URL are required for hosted payout setup in production.",
    );
  });

  it("reports Stripe go-live checks", () => {
    process.env.DATABASE_URL = "postgresql://localhost/chase_sets";
    process.env.STRIPE_SECRET_KEY = "sk_live_123";
    process.env.STRIPE_PUBLISHABLE_KEY = "pk_live_123";
    process.env.STRIPE_WEBHOOK_SECRET = "whsec_live";
    process.env.STRIPE_CONNECT_RETURN_URL = "https://example.test/return";
    process.env.STRIPE_CONNECT_REFRESH_URL = "https://example.test/refresh";

    expect(loadConfig().stripeGoLive).toMatchObject({
      apiVersion: "2026-02-25.clover",
      paymentsConfigured: true,
      connectConfigured: true,
      onboardingUrlsConfigured: true,
      fakeFallbackAllowed: true,
      liveSecretKeyLikely: true,
    });
    expect(loadConfig().stripeGoLive.requiredWebhookEvents).toContain(
      "checkout.session.completed",
    );
    expect(loadConfig().stripeGoLive.requiredWebhookEvents).toContain(
      "payment_intent.succeeded",
    );
    expect(loadConfig().stripeGoLive.requiredWebhookEvents).toContain(
      "v2.core.account[requirements].updated",
    );
    expect(loadConfig().stripeGoLive.requiredWebhookEvents).toContain("payout.failed");
  });

  it("forces Stripe adapters and disables fake fallback in production", () => {
    process.env.DATABASE_URL = "postgresql://localhost/chase_sets";
    process.env.NODE_ENV = "production";
    process.env.STRIPE_SECRET_KEY = "sk_live_123";
    process.env.STRIPE_PUBLISHABLE_KEY = "pk_live_123";
    process.env.STRIPE_WEBHOOK_SECRET = "whsec_live";
    process.env.STRIPE_CONNECT_RETURN_URL = "https://example.test/return";
    process.env.STRIPE_CONNECT_REFRESH_URL = "https://example.test/refresh";
    process.env.EASYPOST_API_KEY = "EZAK_live";

    const config = loadConfig();

    expect(config.paymentProcessor).toMatchObject({ kind: "stripe" });
    expect(config.moneyMovement).toMatchObject({ kind: "stripe" });
    expect(config.stripeGoLive).toMatchObject({
      paymentsConfigured: true,
      connectConfigured: true,
      onboardingUrlsConfigured: true,
      fakeFallbackAllowed: false,
      liveSecretKeyLikely: true,
    });
  });

  it("loads hosted Checkout fallback configuration", () => {
    process.env.DATABASE_URL = "postgresql://localhost/chase_sets";
    process.env.STRIPE_SECRET_KEY = "sk_test_123";
    process.env.STRIPE_PUBLISHABLE_KEY = "pk_test_123";
    process.env.STRIPE_WEBHOOK_SECRET = "whsec_test";
    process.env.STRIPE_CHECKOUT_UI_MODE = "hosted";

    expect(loadConfig().paymentProcessor).toMatchObject({
      kind: "stripe",
      checkoutUiMode: "hosted",
    });
  });

  it("can disable scheduled payout reconciliation", () => {
    process.env.DATABASE_URL = "postgresql://localhost/chase_sets";
    process.env.PAYOUT_RECONCILIATION_INTERVAL_MS = "0";

    expect(loadConfig().payoutReconciliationIntervalMs).toBeNull();
  });
});
