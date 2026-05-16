import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config";

const envNames = [
  "DATABASE_URL",
  "PLATFORM_CONTROL_DATABASE_URL",
  "NODE_ENV",
  "STRIPE_SECRET_KEY",
  "STRIPE_PUBLISHABLE_KEY",
  "STRIPE_WEBHOOK_SECRET",
  "STRIPE_API_BASE_URL",
  "STRIPE_CHECKOUT_UI_MODE",
  "STRIPE_CONNECT_RETURN_URL",
  "STRIPE_CONNECT_REFRESH_URL",
  "EASYPOST_API_KEY",
  "EASYPOST_API_BASE_URL",
  "EASYPOST_MODE",
  "NOTIFICATION_EMAIL_PROVIDER",
  "SES_AWS_REGION",
  "SES_FROM_EMAIL",
  "SES_CONFIGURATION_SET_NAME",
  "SES_SOURCE_ARN",
  "MOBILE_MESSAGING_PROVIDER",
  "TWILIO_ACCOUNT_SID",
  "TWILIO_AUTH_TOKEN",
  "TWILIO_MESSAGING_SERVICE_SID",
  "TWILIO_API_BASE_URL",
  "TWILIO_STATUS_CALLBACK_BASE_URL",
];

afterEach(() => {
  for (const envName of envNames) {
    delete process.env[envName];
  }
});

describe("platform worker config", () => {
  it("falls back to fake provider adapters outside production", () => {
    process.env.DATABASE_URL = "postgresql://localhost/chase_sets";

    const config = loadConfig();

    expect(config.paymentProcessor).toEqual({ kind: "fake" });
    expect(config.moneyMovement).toEqual({ kind: "fake" });
    expect(config.mobileMessaging).toEqual({ kind: "noop" });
    expect(config.postage).toEqual({ kind: "sandbox" });
  });

  it("loads Twilio mobile messaging configuration when enabled", () => {
    process.env.DATABASE_URL = "postgresql://localhost/chase_sets";
    process.env.MOBILE_MESSAGING_PROVIDER = "twilio";
    process.env.TWILIO_ACCOUNT_SID = "AC123";
    process.env.TWILIO_AUTH_TOKEN = "secret";
    process.env.TWILIO_MESSAGING_SERVICE_SID = "MG123";
    process.env.TWILIO_API_BASE_URL = "https://twilio.test";
    process.env.TWILIO_STATUS_CALLBACK_BASE_URL =
      "https://api.chasesets.test/api/notifications/provider/mobile-messaging/webhooks";

    expect(loadConfig().mobileMessaging).toEqual({
      kind: "twilio",
      accountSid: "AC123",
      authToken: "secret",
      messagingServiceSid: "MG123",
      apiBaseUrl: "https://twilio.test",
      statusCallbackBaseUrl:
        "https://api.chasesets.test/api/notifications/provider/mobile-messaging/webhooks",
    });
  });

  it("requires Twilio sender config when mobile messaging is enabled", () => {
    process.env.DATABASE_URL = "postgresql://localhost/chase_sets";
    process.env.MOBILE_MESSAGING_PROVIDER = "twilio";
    process.env.TWILIO_ACCOUNT_SID = "AC123";

    expect(() => loadConfig()).toThrow(
      "TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, and TWILIO_MESSAGING_SERVICE_SID are required when MOBILE_MESSAGING_PROVIDER=twilio.",
    );
  });

  it("fails production config when Stripe provider secrets are missing", () => {
    process.env.DATABASE_URL = "postgresql://localhost/chase_sets";
    process.env.PLATFORM_CONTROL_DATABASE_URL = "postgresql://localhost/control";
    process.env.NODE_ENV = "production";

    expect(() => loadConfig()).toThrow(
      "STRIPE_SECRET_KEY, STRIPE_PUBLISHABLE_KEY, and STRIPE_WEBHOOK_SECRET are required for platform worker payment processing and money movement in production.",
    );
  });

  it("fails production config when EasyPost is missing", () => {
    process.env.DATABASE_URL = "postgresql://localhost/chase_sets";
    process.env.PLATFORM_CONTROL_DATABASE_URL = "postgresql://localhost/control";
    process.env.NODE_ENV = "production";
    process.env.STRIPE_SECRET_KEY = "sk_test_123";
    process.env.STRIPE_PUBLISHABLE_KEY = "pk_test_123";
    process.env.STRIPE_WEBHOOK_SECRET = "whsec_test";

    expect(() => loadConfig()).toThrow(
      "EASYPOST_API_KEY is required for platform worker postage label work in production.",
    );
  });

  it("fails production config when Stripe Connect URLs are missing", () => {
    process.env.DATABASE_URL = "postgresql://localhost/chase_sets";
    process.env.PLATFORM_CONTROL_DATABASE_URL = "postgresql://localhost/control";
    process.env.NODE_ENV = "production";
    process.env.STRIPE_SECRET_KEY = "sk_test_123";
    process.env.STRIPE_PUBLISHABLE_KEY = "pk_test_123";
    process.env.STRIPE_WEBHOOK_SECRET = "whsec_test";
    process.env.EASYPOST_API_KEY = "EZTK_test";

    expect(() => loadConfig()).toThrow(
      "STRIPE_CONNECT_RETURN_URL and STRIPE_CONNECT_REFRESH_URL are required for platform worker hosted payout setup in production.",
    );
  });

  it("loads production provider adapters when staging-style provider config is complete", () => {
    process.env.DATABASE_URL = "postgresql://localhost/chase_sets";
    process.env.PLATFORM_CONTROL_DATABASE_URL = "postgresql://localhost/control";
    process.env.NODE_ENV = "production";
    process.env.STRIPE_SECRET_KEY = "sk_test_123";
    process.env.STRIPE_PUBLISHABLE_KEY = "pk_test_123";
    process.env.STRIPE_WEBHOOK_SECRET = "whsec_test";
    process.env.STRIPE_CONNECT_RETURN_URL =
      "https://marketplace.staging.chasesets.com/account/payouts";
    process.env.STRIPE_CONNECT_REFRESH_URL =
      "https://marketplace.staging.chasesets.com/account/payouts/setup";
    process.env.EASYPOST_API_KEY = "EZTK_test";
    process.env.EASYPOST_MODE = "test";

    const config = loadConfig();

    expect(config.paymentProcessor).toMatchObject({ kind: "stripe" });
    expect(config.moneyMovement).toMatchObject({
      kind: "stripe",
      onboardingReturnUrl: "https://marketplace.staging.chasesets.com/account/payouts",
      onboardingRefreshUrl:
        "https://marketplace.staging.chasesets.com/account/payouts/setup",
    });
    expect(config.postage).toEqual({
      kind: "easypost",
      apiKey: "EZTK_test",
      apiBaseUrl: undefined,
      mode: "test",
    });
  });

  it("fails when Amazon SES email is selected without complete SES config", () => {
    process.env.DATABASE_URL = "postgresql://localhost/chase_sets";
    process.env.NOTIFICATION_EMAIL_PROVIDER = "amazon-ses";
    process.env.SES_AWS_REGION = "us-east-2";
    process.env.SES_FROM_EMAIL = "notifications@preview.chasesets.com";

    expect(() => loadConfig()).toThrow(
      "SES_AWS_REGION, SES_FROM_EMAIL, SES_CONFIGURATION_SET_NAME, and SES_SOURCE_ARN are required when NOTIFICATION_EMAIL_PROVIDER=amazon-ses.",
    );
  });

  it("loads Amazon SES email provider config when complete", () => {
    process.env.DATABASE_URL = "postgresql://localhost/chase_sets";
    process.env.NOTIFICATION_EMAIL_PROVIDER = "amazon-ses";
    process.env.SES_AWS_REGION = "us-east-2";
    process.env.SES_FROM_EMAIL = "notifications@preview.chasesets.com";
    process.env.SES_CONFIGURATION_SET_NAME = "transactional-preview";
    process.env.SES_SOURCE_ARN =
      "arn:aws:ses:us-east-2:812517519777:identity/preview.chasesets.com";

    const config = loadConfig();

    expect(config.notificationEmail).toEqual({
      provider: "amazon-ses",
      ses: {
        region: "us-east-2",
        fromEmail: "notifications@preview.chasesets.com",
        configurationSetName: "transactional-preview",
        sourceArn:
          "arn:aws:ses:us-east-2:812517519777:identity/preview.chasesets.com",
      },
    });
  });
});
