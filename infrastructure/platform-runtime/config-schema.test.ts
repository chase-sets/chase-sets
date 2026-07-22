import { afterEach, describe, expect, it } from "vitest";
import {
  PLATFORM_DATA_PROFILES,
  getBooleanEnv,
  getBoundedDurationEnv,
  getReadConsistencyExactDependencyModeEnv,
  loadPoolConfig,
  loadDeploymentEnvironment,
  loadReadConsistencyRouteTuningEnv,
  loadStripeProviderConfig,
  resolveEnumEnv,
} from "./config-schema";

const originalEnv = { ...process.env };
const booleanEnvName = "PLATFORM_RUNTIME_CONFIG_SCHEMA_TEST_FLAG";

afterEach(() => {
  process.env = { ...originalEnv };
});

describe("platform runtime config schema", () => {
  it("resolves enum env values case-insensitively and fails closed on typos", () => {
    expect(resolveEnumEnv("TEST_PROVIDER", null, ["noop", "twilio"], "noop")).toBe("noop");
    expect(resolveEnumEnv("TEST_PROVIDER", " TwIlIo ", ["noop", "twilio"], "noop")).toBe("twilio");
    expect(() => resolveEnumEnv("TEST_PROVIDER", "twillio", ["noop", "twilio"], "noop")).toThrow(
      "TEST_PROVIDER must be one of: noop, twilio.",
    );
  });

  it("parses explicit boolean values and fails closed on unknown values", () => {
    expect(getBooleanEnv(booleanEnvName, true)).toBe(true);

    process.env[booleanEnvName] = "off";
    expect(getBooleanEnv(booleanEnvName, true)).toBe(false);

    process.env[booleanEnvName] = "YES";
    expect(getBooleanEnv(booleanEnvName, false)).toBe(true);

    process.env[booleanEnvName] = "required";
    expect(() => getBooleanEnv(booleanEnvName, false)).toThrow(
      "PLATFORM_RUNTIME_CONFIG_SCHEMA_TEST_FLAG must be a boolean value: 1, true, yes, on, 0, false, no, off.",
    );
  });

  it("loads deployment environment from DEPLOYMENT_ENVIRONMENT before NODE_ENV", () => {
    expect(loadDeploymentEnvironment({ deploymentEnvironment: null, nodeEnv: "production" })).toBe("production");
    expect(loadDeploymentEnvironment({ deploymentEnvironment: "staging", nodeEnv: "production" })).toBe("staging");
    expect(loadDeploymentEnvironment({ deploymentEnvironment: "Preview", nodeEnv: "production" })).toBe("preview");
    expect(loadDeploymentEnvironment({ deploymentEnvironment: "Production", nodeEnv: "test" })).toBe("production");
    expect(loadDeploymentEnvironment({ deploymentEnvironment: null, nodeEnv: "test" })).toBe("test");
    expect(loadDeploymentEnvironment({ deploymentEnvironment: null, nodeEnv: "development" })).toBe("dev");
    expect(() => loadDeploymentEnvironment({ deploymentEnvironment: "prod", nodeEnv: "production" })).toThrow(
      "DEPLOYMENT_ENVIRONMENT must be one of: production, staging, preview, test, dev, local, remote-dev.",
    );
  });

  it("derives platform data profiles from the bounded-context contract", () => {
    expect(PLATFORM_DATA_PROFILES).toEqual([
      "critical-bootstrap",
      "catalog-integration-bootstrap",
      "scenario-seed",
      "representative-commerce-state",
      "admin-qa-actor-fixtures",
      "representative-catalog",
    ]);
  });

  it("returns the compiled default when a bounded duration env var is unset", () => {
    expect(
      getBoundedDurationEnv("PLATFORM_RUNTIME_CONFIG_SCHEMA_TEST_DURATION_MS", 900_000, {
        minMs: 300_000,
        maxMs: 3_600_000,
      }),
    ).toBe(900_000);
  });

  it("loads a bounded duration env var within bounds", () => {
    process.env.PLATFORM_RUNTIME_CONFIG_SCHEMA_TEST_DURATION_MS = "600000";

    expect(
      getBoundedDurationEnv("PLATFORM_RUNTIME_CONFIG_SCHEMA_TEST_DURATION_MS", 900_000, {
        minMs: 300_000,
        maxMs: 3_600_000,
      }),
    ).toBe(600_000);
  });

  it("fails closed at boot when a bounded duration env var is out of bounds", () => {
    process.env.PLATFORM_RUNTIME_CONFIG_SCHEMA_TEST_DURATION_MS = "60000";

    expect(() =>
      getBoundedDurationEnv("PLATFORM_RUNTIME_CONFIG_SCHEMA_TEST_DURATION_MS", 900_000, {
        minMs: 300_000,
        maxMs: 3_600_000,
      }),
    ).toThrow("PLATFORM_RUNTIME_CONFIG_SCHEMA_TEST_DURATION_MS must be between 300000ms and 3600000ms, got 60000ms.");
  });

  it("fails closed at boot when a bounded duration env var is not a positive number", () => {
    process.env.PLATFORM_RUNTIME_CONFIG_SCHEMA_TEST_DURATION_MS = "not-a-number";

    expect(() =>
      getBoundedDurationEnv("PLATFORM_RUNTIME_CONFIG_SCHEMA_TEST_DURATION_MS", 900_000, {
        minMs: 300_000,
        maxMs: 3_600_000,
      }),
    ).toThrow("PLATFORM_RUNTIME_CONFIG_SCHEMA_TEST_DURATION_MS must be a positive number of milliseconds.");
  });

  it("loads the optional idle-in-transaction pool timeout", () => {
    process.env.DATABASE_POOL_IDLE_IN_TRANSACTION_SESSION_TIMEOUT_MS = "15000";

    expect(loadPoolConfig()).toEqual(
      expect.objectContaining({
        idleInTransactionSessionTimeoutMillis: 15_000,
      }),
    );
  });

  it("loads read consistency exact dependency mode from environment", () => {
    process.env.READ_CONSISTENCY_EXACT_DEPENDENCY_MODE = "target-context";

    expect(getReadConsistencyExactDependencyModeEnv("READ_CONSISTENCY_EXACT_DEPENDENCY_MODE")).toBe("target-context");
  });

  it("rejects unsupported read consistency exact dependency modes", () => {
    process.env.READ_CONSISTENCY_EXACT_DEPENDENCY_MODE = "disabled";

    expect(() => getReadConsistencyExactDependencyModeEnv("READ_CONSISTENCY_EXACT_DEPENDENCY_MODE")).toThrow(
      "READ_CONSISTENCY_EXACT_DEPENDENCY_MODE must be enabled or target-context.",
    );
  });

  it("loads read consistency route tuning from environment", () => {
    process.env.READ_CONSISTENCY_ROUTE_TUNING_JSON = JSON.stringify([
      {
        mountPath: " /api/marketplace ",
        routePath: " /account/cart ",
        targetContextName: " checkout ",
        timeoutMs: 900,
        pollIntervalMs: 50,
        exactDependencyMode: "target-context",
      },
    ]);

    expect(
      loadReadConsistencyRouteTuningEnv({
        envName: "READ_CONSISTENCY_ROUTE_TUNING_JSON",
        criticalRouteTuning: [{ mountPath: "/api/settlement", routePath: "/payouts/:id" }],
      }),
    ).toEqual([
      { mountPath: "/api/settlement", routePath: "/payouts/:id" },
      {
        mountPath: "/api/marketplace",
        routePath: "/account/cart",
        targetContextName: "checkout",
        timeoutMs: 900,
        pollIntervalMs: 50,
        exactDependencyMode: "target-context",
      },
    ]);
  });

  it("rejects invalid read consistency route tuning entries", () => {
    process.env.READ_CONSISTENCY_ROUTE_TUNING_JSON = JSON.stringify([{ mountPath: "api", routePath: "/account" }]);

    expect(() =>
      loadReadConsistencyRouteTuningEnv({
        envName: "READ_CONSISTENCY_ROUTE_TUNING_JSON",
      }),
    ).toThrow("READ_CONSISTENCY_ROUTE_TUNING_JSON[0].mountPath must be an absolute path string.");
  });

  it("keeps the no-key Stripe fake-provider path outside production", () => {
    expect(
      loadStripeProviderConfig({
        productionLike: false,
        deploymentEnvironment: "dev",
        productionMissingConfigError: "production Stripe config is required.",
      }),
    ).toMatchObject({
      paymentProcessor: { kind: "fake" },
      moneyMovement: { kind: "fake" },
    });
  });

  it("rejects live Stripe keys outside production", () => {
    process.env.STRIPE_SECRET_KEY = "sk_live_123";
    process.env.STRIPE_PUBLISHABLE_KEY = "pk_live_123";
    process.env.STRIPE_WEBHOOK_SECRET = "whsec_test";
    process.env.STRIPE_CONNECT_WEBHOOK_SECRET = "whsec_connect_test";

    expect(() =>
      loadStripeProviderConfig({
        productionLike: false,
        deploymentEnvironment: "staging",
        productionMissingConfigError: "production Stripe config is required.",
      }),
    ).toThrow("Live Stripe keys are only allowed when DEPLOYMENT_ENVIRONMENT=production.");
  });

  it("fails staging when the distinct Connect webhook secret is missing", () => {
    process.env.STRIPE_SECRET_KEY = "sk_test_123";
    process.env.STRIPE_PUBLISHABLE_KEY = "pk_test_123";
    process.env.STRIPE_WEBHOOK_SECRET = "whsec_payment";

    expect(() =>
      loadStripeProviderConfig({
        productionLike: false,
        deploymentEnvironment: "staging",
        productionMissingConfigError: "production Stripe config is required.",
      }),
    ).toThrow(
      "STRIPE_CONNECT_WEBHOOK_SECRET is required when DEPLOYMENT_ENVIRONMENT=staging; staging must use a distinct Connect webhook secret.",
    );
  });

  it("rejects test Stripe keys in production", () => {
    process.env.STRIPE_SECRET_KEY = "sk_test_123";
    process.env.STRIPE_PUBLISHABLE_KEY = "pk_test_123";
    process.env.STRIPE_WEBHOOK_SECRET = "whsec_test";
    process.env.STRIPE_CONNECT_WEBHOOK_SECRET = "whsec_connect_test";

    expect(() =>
      loadStripeProviderConfig({
        productionLike: true,
        deploymentEnvironment: "production",
        productionMissingConfigError: "production Stripe config is required.",
      }),
    ).toThrow("STRIPE_SECRET_KEY and STRIPE_PUBLISHABLE_KEY must use live-mode keys in production.");
  });

  it("loads live Stripe keys in production", () => {
    process.env.STRIPE_SECRET_KEY = "sk_live_123";
    process.env.STRIPE_PUBLISHABLE_KEY = "pk_live_123";
    process.env.STRIPE_WEBHOOK_SECRET = "whsec_live";
    process.env.STRIPE_CONNECT_WEBHOOK_SECRET = "whsec_connect_live";

    expect(
      loadStripeProviderConfig({
        productionLike: true,
        deploymentEnvironment: "production",
        productionMissingConfigError: "production Stripe config is required.",
      }),
    ).toMatchObject({
      paymentProcessor: { kind: "stripe", secretKey: "sk_live_123", publishableKey: "pk_live_123" },
      moneyMovement: { kind: "stripe", secretKey: "sk_live_123", webhookSecret: "whsec_connect_live" },
    });
  });

  it("loads comma-separated previous Stripe webhook secrets for overlap rotation", () => {
    process.env.STRIPE_SECRET_KEY = "sk_test_123";
    process.env.STRIPE_PUBLISHABLE_KEY = "pk_test_123";
    process.env.STRIPE_WEBHOOK_SECRET = "whsec_current";
    process.env.STRIPE_CONNECT_WEBHOOK_SECRET = "whsec_connect_current";
    process.env.STRIPE_WEBHOOK_SECRET_PREVIOUS = " whsec_previous_1, whsec_previous_2 ";
    process.env.STRIPE_CONNECT_WEBHOOK_SECRET_PREVIOUS = "whsec_connect_previous";

    expect(
      loadStripeProviderConfig({
        productionLike: false,
        deploymentEnvironment: "test",
        productionMissingConfigError: "production Stripe config is required.",
      }),
    ).toMatchObject({
      paymentProcessor: {
        kind: "stripe",
        previousWebhookSecrets: ["whsec_previous_1", "whsec_previous_2"],
      },
      moneyMovement: {
        kind: "stripe",
        previousWebhookSecrets: ["whsec_connect_previous"],
      },
    });
  });

  it("shares previous Payments webhook secrets with non-production Connect fallback", () => {
    process.env.STRIPE_SECRET_KEY = "sk_test_123";
    process.env.STRIPE_PUBLISHABLE_KEY = "pk_test_123";
    process.env.STRIPE_WEBHOOK_SECRET = "whsec_current";
    process.env.STRIPE_WEBHOOK_SECRET_PREVIOUS = "whsec_previous";

    expect(
      loadStripeProviderConfig({
        productionLike: false,
        deploymentEnvironment: "test",
        productionMissingConfigError: "production Stripe config is required.",
      }).moneyMovement,
    ).toMatchObject({
      kind: "stripe",
      webhookSecret: "whsec_current",
      previousWebhookSecrets: ["whsec_previous"],
    });
  });
});
