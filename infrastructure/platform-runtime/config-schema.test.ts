import { afterEach, describe, expect, it } from "vitest";
import {
  PLATFORM_DATA_PROFILES,
  PRODUCTION_MISSING_STRIPE_CONFIG_ERRORS,
  PRODUCTION_MISSING_STRIPE_CONFIG_VOCABULARY_REFUSAL,
  getBooleanEnv,
  getBoundedDurationEnv,
  getReadConsistencyExactDependencyModeEnv,
  loadPoolConfig,
  loadDeploymentEnvironment,
  loadReadConsistencyRouteTuningEnv,
  loadStripeProviderConfig,
  resolveEnumEnv,
  stripeKeyRefusal,
} from "./config-schema";
import type {
  DeploymentEnvironment,
  PlatformStripeEffectiveMode,
  PlatformStripeKeyClassification,
  PlatformStripePublishableKeyMode,
  PlatformStripeRefusalReason,
  PlatformStripeRefusalVariable,
  PlatformStripeServerKeyClass,
  PlatformStripeServerKeyMode,
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
        productionMissingConfigError:
          "STRIPE_SECRET_KEY, STRIPE_PUBLISHABLE_KEY, STRIPE_WEBHOOK_SECRET, and STRIPE_CONNECT_WEBHOOK_SECRET are required for Stripe payment processing and Connect money movement in production.",
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
        productionMissingConfigError:
          "STRIPE_SECRET_KEY, STRIPE_PUBLISHABLE_KEY, STRIPE_WEBHOOK_SECRET, and STRIPE_CONNECT_WEBHOOK_SECRET are required for Stripe payment processing and Connect money movement in production.",
      }),
    ).toThrow(
      "STRIPE_SECRET_KEY was refused by Stripe key classification (reason=stripe-live-key-outside-production, serverKeyMode=live, serverKeyClass=standard, publishableKeyMode=live, deploymentEnvironment=staging).",
    );
  });

  it("fails staging when the distinct Connect webhook secret is missing", () => {
    process.env.STRIPE_SECRET_KEY = "sk_test_123";
    process.env.STRIPE_PUBLISHABLE_KEY = "pk_test_123";
    process.env.STRIPE_WEBHOOK_SECRET = "whsec_payment";

    expect(() =>
      loadStripeProviderConfig({
        productionLike: false,
        deploymentEnvironment: "staging",
        productionMissingConfigError:
          "STRIPE_SECRET_KEY, STRIPE_PUBLISHABLE_KEY, STRIPE_WEBHOOK_SECRET, and STRIPE_CONNECT_WEBHOOK_SECRET are required for Stripe payment processing and Connect money movement in production.",
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
        productionMissingConfigError:
          "STRIPE_SECRET_KEY, STRIPE_PUBLISHABLE_KEY, STRIPE_WEBHOOK_SECRET, and STRIPE_CONNECT_WEBHOOK_SECRET are required for Stripe payment processing and Connect money movement in production.",
      }),
    ).toThrow(
      "STRIPE_SECRET_KEY was refused by Stripe key classification (reason=stripe-non-live-key-in-production, serverKeyMode=test, serverKeyClass=standard, publishableKeyMode=test, deploymentEnvironment=production).",
    );
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
        productionMissingConfigError:
          "STRIPE_SECRET_KEY, STRIPE_PUBLISHABLE_KEY, STRIPE_WEBHOOK_SECRET, and STRIPE_CONNECT_WEBHOOK_SECRET are required for Stripe payment processing and Connect money movement in production.",
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
        productionMissingConfigError:
          "STRIPE_SECRET_KEY, STRIPE_PUBLISHABLE_KEY, STRIPE_WEBHOOK_SECRET, and STRIPE_CONNECT_WEBHOOK_SECRET are required for Stripe payment processing and Connect money movement in production.",
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
        productionMissingConfigError:
          "STRIPE_SECRET_KEY, STRIPE_PUBLISHABLE_KEY, STRIPE_WEBHOOK_SECRET, and STRIPE_CONNECT_WEBHOOK_SECRET are required for Stripe payment processing and Connect money movement in production.",
      }).moneyMovement,
    ).toMatchObject({
      kind: "stripe",
      webhookSecret: "whsec_current",
      previousWebhookSecrets: ["whsec_previous"],
    });
  });
});

// -------------------------------------------------------------------------------------------------
// Stripe key mode classification — #6826, carrying #6800 AC-01 through AC-09.
//
// Every Stripe key literal in this section is an unmistakably synthetic, non-functional value. None
// is a real credential, none is transmitted anywhere, and nothing here claims anything about the
// value or classification of a secret configured in any deployment: this evidence is offline and
// code-domain only.
// -------------------------------------------------------------------------------------------------

const SYNTHETIC_PAYMENTS_WEBHOOK_SECRET = "whsec_SYNTHETICPAYMENTS";
const SYNTHETIC_CONNECT_WEBHOOK_SECRET = "whsec_SYNTHETICCONNECT";

/** AC-01: non-axis Stripe variables are deleted rather than assumed unset. */
const NON_AXIS_STRIPE_VARIABLES = [
  "STRIPE_WEBHOOK_SECRET_PREVIOUS",
  "STRIPE_CONNECT_WEBHOOK_SECRET_PREVIOUS",
  "STRIPE_API_BASE_URL",
  "STRIPE_CONNECT_ACCOUNTS_API",
] as const;

type StripeEnvironmentFixture = Readonly<{
  secretKey: string | null;
  publishableKey: string | null;
  webhookSecret: string | null;
  connectWebhookSecret: string | null;
}>;

function setOrDeleteEnv(name: string, value: string | null) {
  if (value === null) {
    delete process.env[name];
    return;
  }

  process.env[name] = value;
}

function applyStripeEnvironment(fixture: StripeEnvironmentFixture) {
  for (const name of NON_AXIS_STRIPE_VARIABLES) {
    delete process.env[name];
  }

  setOrDeleteEnv("STRIPE_SECRET_KEY", fixture.secretKey);
  setOrDeleteEnv("STRIPE_PUBLISHABLE_KEY", fixture.publishableKey);
  setOrDeleteEnv("STRIPE_WEBHOOK_SECRET", fixture.webhookSecret);
  setOrDeleteEnv("STRIPE_CONNECT_WEBHOOK_SECRET", fixture.connectWebhookSecret);
}

const REFUSAL_MESSAGE_PATTERN =
  /^(STRIPE_SECRET_KEY|STRIPE_PUBLISHABLE_KEY) was refused by Stripe key classification \(reason=([a-z-]+), serverKeyMode=([a-z]+), serverKeyClass=([a-z]+), publishableKeyMode=([a-z]+), deploymentEnvironment=([a-z-]+)\)\.$/;

type StripeObservation =
  | Readonly<{
      outcome: "accepted";
      effectiveMode: PlatformStripeEffectiveMode;
      paymentProcessorKind: "fake" | "stripe";
      moneyMovementKind: "fake" | "stripe";
    }>
  | Readonly<{
      outcome: "refused";
      reason: PlatformStripeRefusalReason;
      variable: PlatformStripeRefusalVariable;
      classification: PlatformStripeKeyClassification;
    }>;

function observeStripeLoad(input: {
  fixture: StripeEnvironmentFixture;
  deploymentEnvironment: DeploymentEnvironment;
  productionLike?: boolean;
}): StripeObservation {
  applyStripeEnvironment(input.fixture);

  try {
    const config = loadStripeProviderConfig({
      productionLike: input.productionLike ?? false,
      deploymentEnvironment: input.deploymentEnvironment,
      productionMissingConfigError:
        "STRIPE_SECRET_KEY, STRIPE_PUBLISHABLE_KEY, STRIPE_WEBHOOK_SECRET, and STRIPE_CONNECT_WEBHOOK_SECRET are required for Stripe payment processing and Connect money movement in production.",
    });

    return {
      outcome: "accepted",
      effectiveMode: config.effectiveMode,
      paymentProcessorKind: config.paymentProcessor.kind,
      moneyMovementKind: config.moneyMovement.kind,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const matched = REFUSAL_MESSAGE_PATTERN.exec(message);
    if (!matched) {
      throw new Error(`Stripe load did not refuse through the bounded refusal constructor: ${message}`);
    }

    return {
      outcome: "refused",
      variable: matched[1] as PlatformStripeRefusalVariable,
      reason: matched[2] as PlatformStripeRefusalReason,
      classification: {
        serverKeyMode: matched[3] as PlatformStripeServerKeyMode,
        serverKeyClass: matched[4] as PlatformStripeServerKeyClass,
        publishableKeyMode: matched[5] as PlatformStripePublishableKeyMode,
      },
    };
  }
}

// --- Executable specification of the classification and the K1-K7 order ---------------------------
//
// This specification is not itself the evidence. It is bound to the production implementation by the
// 48-row matrix below, which asserts that the real loadStripeProviderConfig agrees with it on every
// admissible input, and by the differential oracle, which runs it over the full 35-cell axis set in
// both environments. Because the specification and the implementation are pinned to agree, a named
// mutant of the specification that changes the answer at a witness row proves that an implementation
// behaving like that mutant would fail this suite's assertion at that row: candidate green plus
// mutant red, with every non-governing input frozen and one governing variable varied.

type StripeRuleId = "K1" | "K2" | "K3" | "K4" | "K5" | "K6" | "K7";

type StripeRule = Readonly<{
  id: StripeRuleId;
  reason: PlatformStripeRefusalReason;
  matches: (classification: PlatformStripeKeyClassification, deploymentEnvironment: DeploymentEnvironment) => boolean;
  variable: (classification: PlatformStripeKeyClassification) => PlatformStripeRefusalVariable;
}>;

function classifySpec(secretKey: string | null, publishableKey: string | null): PlatformStripeKeyClassification {
  let serverKeyMode: PlatformStripeServerKeyMode = "absent";
  let serverKeyClass: PlatformStripeServerKeyClass = "absent";
  let publishableKeyMode: PlatformStripePublishableKeyMode = "absent";

  if (secretKey) {
    if (secretKey.startsWith("sk_test_")) {
      serverKeyMode = "test";
      serverKeyClass = "standard";
    } else if (secretKey.startsWith("sk_live_")) {
      serverKeyMode = "live";
      serverKeyClass = "standard";
    } else if (secretKey.startsWith("rk_test_")) {
      serverKeyMode = "test";
      serverKeyClass = "restricted";
    } else if (secretKey.startsWith("rk_live_")) {
      serverKeyMode = "live";
      serverKeyClass = "restricted";
    } else {
      serverKeyMode = "unknown";
      serverKeyClass = "unknown";
    }
  }

  if (publishableKey) {
    if (publishableKey.startsWith("pk_test_")) {
      publishableKeyMode = "test";
    } else if (publishableKey.startsWith("pk_live_")) {
      publishableKeyMode = "live";
    } else {
      publishableKeyMode = "unknown";
    }
  }

  return { serverKeyMode, serverKeyClass, publishableKeyMode };
}

const SPEC_RULES: readonly StripeRule[] = [
  {
    id: "K1",
    reason: "stripe-secret-key-unrecognized",
    matches: (classification) => classification.serverKeyMode === "unknown",
    variable: () => "STRIPE_SECRET_KEY",
  },
  {
    id: "K2",
    reason: "stripe-publishable-key-unrecognized",
    matches: (classification) => classification.publishableKeyMode === "unknown",
    variable: () => "STRIPE_PUBLISHABLE_KEY",
  },
  {
    id: "K3",
    reason: "stripe-key-mode-mismatch",
    matches: (classification) =>
      (classification.serverKeyMode === "test" || classification.serverKeyMode === "live") &&
      (classification.publishableKeyMode === "test" || classification.publishableKeyMode === "live") &&
      classification.serverKeyMode !== classification.publishableKeyMode,
    variable: () => "STRIPE_PUBLISHABLE_KEY",
  },
  {
    id: "K4",
    reason: "stripe-live-key-outside-production",
    matches: (classification, deploymentEnvironment) =>
      deploymentEnvironment !== "production" &&
      (classification.serverKeyMode === "live" || classification.publishableKeyMode === "live"),
    variable: (classification) =>
      classification.serverKeyMode === "live" ? "STRIPE_SECRET_KEY" : "STRIPE_PUBLISHABLE_KEY",
  },
  {
    id: "K5",
    reason: "stripe-non-live-key-in-production",
    matches: (classification, deploymentEnvironment) =>
      deploymentEnvironment === "production" &&
      classification.serverKeyMode !== "absent" &&
      classification.serverKeyMode !== "live",
    variable: () => "STRIPE_SECRET_KEY",
  },
  {
    id: "K6",
    reason: "stripe-non-live-key-in-production",
    matches: (classification, deploymentEnvironment) =>
      deploymentEnvironment === "production" &&
      classification.publishableKeyMode !== "absent" &&
      classification.publishableKeyMode !== "live",
    variable: () => "STRIPE_PUBLISHABLE_KEY",
  },
  {
    id: "K7",
    reason: "stripe-restricted-key-in-production",
    matches: (classification, deploymentEnvironment) =>
      deploymentEnvironment === "production" && classification.serverKeyClass === "restricted",
    variable: () => "STRIPE_SECRET_KEY",
  },
];

type SpecRefusal = Readonly<{
  rule: StripeRuleId;
  reason: PlatformStripeRefusalReason;
  variable: PlatformStripeRefusalVariable;
}>;

function evaluateSpec(
  rules: readonly StripeRule[],
  classification: PlatformStripeKeyClassification,
  deploymentEnvironment: DeploymentEnvironment,
): SpecRefusal | null {
  for (const rule of rules) {
    if (rule.matches(classification, deploymentEnvironment)) {
      return { rule: rule.id, reason: rule.reason, variable: rule.variable(classification) };
    }
  }

  return null;
}

/** AC-04b named mutant shape: move `lower` immediately above `higher`. */
function withPrecedenceSwapped(higher: StripeRuleId, lower: StripeRuleId): readonly StripeRule[] {
  const lowerRule = SPEC_RULES.find((rule) => rule.id === lower);
  if (!lowerRule) {
    throw new Error(`unknown rule ${lower}`);
  }

  const remaining = SPEC_RULES.filter((rule) => rule.id !== lower);
  const higherIndex = remaining.findIndex((rule) => rule.id === higher);
  if (higherIndex < 0) {
    throw new Error(`unknown rule ${higher}`);
  }

  return [...remaining.slice(0, higherIndex), lowerRule, ...remaining.slice(higherIndex)];
}

// --- AC-01: the 48-row matrix over a completely frozen non-axis fixture ---------------------------

type ServerAxisValue = Readonly<{
  label: string;
  value: string | null;
  mode: PlatformStripeServerKeyMode;
  keyClass: PlatformStripeServerKeyClass;
}>;

type PublishableAxisValue = Readonly<{
  label: string;
  value: string | null;
  mode: PlatformStripePublishableKeyMode;
}>;

const SERVER_AXIS: readonly ServerAxisValue[] = [
  { label: "absent", value: null, mode: "absent", keyClass: "absent" },
  { label: "sk_test_", value: "sk_test_SYNTHETICMATRIX", mode: "test", keyClass: "standard" },
  { label: "sk_live_", value: "sk_live_SYNTHETICMATRIX", mode: "live", keyClass: "standard" },
  { label: "rk_test_", value: "rk_test_SYNTHETICMATRIX", mode: "test", keyClass: "restricted" },
  { label: "rk_live_", value: "rk_live_SYNTHETICMATRIX", mode: "live", keyClass: "restricted" },
  { label: "unrecognized", value: "xk_bogus_SYNTHETICMATRIX", mode: "unknown", keyClass: "unknown" },
];

const PUBLISHABLE_AXIS: readonly PublishableAxisValue[] = [
  { label: "absent", value: null, mode: "absent" },
  { label: "pk_test_", value: "pk_test_SYNTHETICMATRIX", mode: "test" },
  { label: "pk_live_", value: "pk_live_SYNTHETICMATRIX", mode: "live" },
  { label: "unrecognized", value: "xk_bogus_SYNTHETICMATRIX", mode: "unknown" },
];

const MATRIX_ENVIRONMENTS = ["staging", "production"] as const;

/**
 * The entire non-axis fixture is frozen and identical in both arms: `productionLike: false` so the
 * pre-existing production missing-config throw cannot mask a row, and both webhook secrets present
 * as distinct synthetic literals so the staging Connect throw cannot mask one either.
 */
function matrixFixture(server: ServerAxisValue, publishable: PublishableAxisValue): StripeEnvironmentFixture {
  return {
    secretKey: server.value,
    publishableKey: publishable.value,
    webhookSecret: SYNTHETIC_PAYMENTS_WEBHOOK_SECRET,
    connectWebhookSecret: SYNTHETIC_CONNECT_WEBHOOK_SECRET,
  };
}

function expectedAcceptance(server: ServerAxisValue, publishable: PublishableAxisValue) {
  const paymentProcessorKind = server.value !== null && publishable.value !== null ? "stripe" : "fake";
  const moneyMovementKind = server.value !== null ? "stripe" : "fake";
  const effectiveMode: PlatformStripeEffectiveMode =
    paymentProcessorKind === "fake" && moneyMovementKind === "fake"
      ? "unconfigured"
      : server.mode === "live"
        ? "live"
        : "test";

  return { outcome: "accepted" as const, effectiveMode, paymentProcessorKind, moneyMovementKind };
}

describe("AC-01 Stripe key matrix", () => {
  for (const deploymentEnvironment of MATRIX_ENVIRONMENTS) {
    for (const server of SERVER_AXIS) {
      for (const publishable of PUBLISHABLE_AXIS) {
        it(`matrix ${deploymentEnvironment} server ${server.label} by publishable ${publishable.label}`, () => {
          // Double entry: the classifier's own mapping is derived here and pinned to the declared axis.
          const classification = classifySpec(server.value, publishable.value);
          expect(classification).toEqual({
            serverKeyMode: server.mode,
            serverKeyClass: server.keyClass,
            publishableKeyMode: publishable.mode,
          });

          const expected = evaluateSpec(SPEC_RULES, classification, deploymentEnvironment);
          const observed = observeStripeLoad({
            fixture: matrixFixture(server, publishable),
            deploymentEnvironment,
          });

          if (expected === null) {
            expect(observed).toEqual(expectedAcceptance(server, publishable));
            return;
          }

          expect(observed).toEqual({
            outcome: "refused",
            reason: expected.reason,
            variable: expected.variable,
            classification,
          });
        });
      }
    }
  }

  it("covers exactly 48 rows and reproduces the derived outcome partition", () => {
    const counts = new Map<string, number>();
    let rows = 0;

    for (const deploymentEnvironment of MATRIX_ENVIRONMENTS) {
      for (const server of SERVER_AXIS) {
        for (const publishable of PUBLISHABLE_AXIS) {
          rows += 1;
          const refusal = evaluateSpec(
            SPEC_RULES,
            classifySpec(server.value, publishable.value),
            deploymentEnvironment,
          );
          const key = refusal === null ? "ACCEPT" : refusal.rule;
          counts.set(key, (counts.get(key) ?? 0) + 1);
        }
      }
    }

    expect(rows).toBe(48);
    expect(Object.fromEntries([...counts.entries()].sort())).toEqual({
      ACCEPT: 10,
      K1: 8,
      K2: 10,
      K3: 8,
      K4: 5,
      K5: 4,
      K6: 1,
      K7: 2,
    });
  });

  it("O1 omitting STRIPE_WEBHOOK_SECRET moves staging sk_test_ / pk_test_ from stripe/stripe to fake/stripe", () => {
    const frozen = observeStripeLoad({
      fixture: {
        secretKey: "sk_test_SYNTHETICMATRIX",
        publishableKey: "pk_test_SYNTHETICMATRIX",
        webhookSecret: SYNTHETIC_PAYMENTS_WEBHOOK_SECRET,
        connectWebhookSecret: SYNTHETIC_CONNECT_WEBHOOK_SECRET,
      },
      deploymentEnvironment: "staging",
    });
    expect(frozen).toMatchObject({ paymentProcessorKind: "stripe", moneyMovementKind: "stripe" });

    const omitted = observeStripeLoad({
      fixture: {
        secretKey: "sk_test_SYNTHETICMATRIX",
        publishableKey: "pk_test_SYNTHETICMATRIX",
        webhookSecret: null,
        connectWebhookSecret: SYNTHETIC_CONNECT_WEBHOOK_SECRET,
      },
      deploymentEnvironment: "staging",
    });
    expect(omitted).toMatchObject({ paymentProcessorKind: "fake", moneyMovementKind: "stripe" });
  });

  it("O2 omitting both webhook secrets moves production sk_live_ / pk_live_ to fake/fake", () => {
    const frozen = observeStripeLoad({
      fixture: {
        secretKey: "sk_live_SYNTHETICMATRIX",
        publishableKey: "pk_live_SYNTHETICMATRIX",
        webhookSecret: SYNTHETIC_PAYMENTS_WEBHOOK_SECRET,
        connectWebhookSecret: SYNTHETIC_CONNECT_WEBHOOK_SECRET,
      },
      deploymentEnvironment: "production",
    });
    expect(frozen).toMatchObject({ paymentProcessorKind: "stripe", moneyMovementKind: "stripe" });

    const omitted = observeStripeLoad({
      fixture: {
        secretKey: "sk_live_SYNTHETICMATRIX",
        publishableKey: "pk_live_SYNTHETICMATRIX",
        webhookSecret: null,
        connectWebhookSecret: null,
      },
      deploymentEnvironment: "production",
    });
    expect(omitted).toMatchObject({ paymentProcessorKind: "fake", moneyMovementKind: "fake" });
  });

  // Recorded deliberately: omitting STRIPE_CONNECT_WEBHOOK_SECRET *alone* at productionLike: false is
  // NOT used as an omission control. The Connect secret falls back to STRIPE_WEBHOOK_SECRET outside
  // production, so the cell reaches the same terminal result through a different clause and is
  // non-discriminating. O1 and O2 above are the load-bearing controls instead.
  it("records the Connect-only omission as non-discriminating", () => {
    const connectOmitted = observeStripeLoad({
      fixture: {
        secretKey: "sk_test_SYNTHETICMATRIX",
        publishableKey: "pk_test_SYNTHETICMATRIX",
        webhookSecret: SYNTHETIC_PAYMENTS_WEBHOOK_SECRET,
        connectWebhookSecret: null,
      },
      deploymentEnvironment: "dev",
    });

    expect(connectOmitted).toMatchObject({ paymentProcessorKind: "stripe", moneyMovementKind: "stripe" });
  });
});

// --- AC-02: R1 and R2 pinned with distinct refusal reasons ----------------------------------------

const R1_SECRET_KEY = "rk_live_SYNTHETIC_REVIEW_CONTROL";
const R1_PUBLISHABLE_KEY = "pk_test_SYNTHETIC_REVIEW_CONTROL";

/** The pre-change predicate pair, recognising only the two `sk_live` / `pk_live` prefixes. */
function revertedTwoPrefixRefuses(
  secretKey: string | null,
  publishableKey: string | null,
  deploymentEnvironment: DeploymentEnvironment,
): boolean {
  if (deploymentEnvironment === "production") {
    const secretRefuses = secretKey !== null && !secretKey.startsWith("sk_live");
    const publishableRefuses = publishableKey !== null && !publishableKey.startsWith("pk_live");
    return secretRefuses || publishableRefuses;
  }

  const secretLive = secretKey !== null && secretKey.startsWith("sk_live");
  const publishableLive = publishableKey !== null && publishableKey.startsWith("pk_live");
  return secretLive || publishableLive;
}

describe("AC-02 R1 and R2 regression pins", () => {
  it("refuses staging rk_live_ secret with pk_test_ publishable", () => {
    const observed = observeStripeLoad({
      fixture: {
        secretKey: R1_SECRET_KEY,
        publishableKey: R1_PUBLISHABLE_KEY,
        webhookSecret: SYNTHETIC_PAYMENTS_WEBHOOK_SECRET,
        connectWebhookSecret: SYNTHETIC_CONNECT_WEBHOOK_SECRET,
      },
      deploymentEnvironment: "staging",
    });

    expect(observed).toEqual({
      outcome: "refused",
      reason: "stripe-key-mode-mismatch",
      variable: "STRIPE_PUBLISHABLE_KEY",
      classification: { serverKeyMode: "live", serverKeyClass: "restricted", publishableKeyMode: "test" },
    });
    expect(evaluateSpec(SPEC_RULES, classifySpec(R1_SECRET_KEY, R1_PUBLISHABLE_KEY), "staging")?.rule).toBe("K3");

    // Mutant `reverted-two-prefix-predicate`: the old predicate pair accepts R1 outright.
    expect(revertedTwoPrefixRefuses(R1_SECRET_KEY, R1_PUBLISHABLE_KEY, "staging")).toBe(false);
  });

  it("refuses staging rk_live_ secret with no publishable key", () => {
    const observed = observeStripeLoad({
      fixture: {
        secretKey: R1_SECRET_KEY,
        publishableKey: null,
        webhookSecret: SYNTHETIC_PAYMENTS_WEBHOOK_SECRET,
        connectWebhookSecret: SYNTHETIC_CONNECT_WEBHOOK_SECRET,
      },
      deploymentEnvironment: "staging",
    });

    expect(observed).toEqual({
      outcome: "refused",
      reason: "stripe-live-key-outside-production",
      variable: "STRIPE_SECRET_KEY",
      classification: { serverKeyMode: "live", serverKeyClass: "restricted", publishableKeyMode: "absent" },
    });
    expect(evaluateSpec(SPEC_RULES, classifySpec(R1_SECRET_KEY, null), "staging")?.rule).toBe("K4");

    // R1 and R2 refuse through *distinct* rules; one shared reason would mask the declared order.
    expect(evaluateSpec(SPEC_RULES, classifySpec(R1_SECRET_KEY, R1_PUBLISHABLE_KEY), "staging")?.reason).not.toBe(
      evaluateSpec(SPEC_RULES, classifySpec(R1_SECRET_KEY, null), "staging")?.reason,
    );

    // Mutant `reverted-two-prefix-predicate`: the old predicate pair accepts R2 outright, and
    // moneyMovement is never constructed here because the load refuses before construction.
    expect(revertedTwoPrefixRefuses(R1_SECRET_KEY, null, "staging")).toBe(false);
    expect(observed.outcome).toBe("refused");
  });
});

// --- AC-03: prefix matching is exact --------------------------------------------------------------

const MIDSTRING_SECRET_KEY = "prefixed_sk_live_SYNTHETICMIDSTRING";
const MIDSTRING_PUBLISHABLE_KEY = "prefixed_pk_live_SYNTHETICMIDSTRING";

function classifyWithIncludes(
  secretKey: string | null,
  publishableKey: string | null,
): PlatformStripeKeyClassification {
  let serverKeyMode: PlatformStripeServerKeyMode = "absent";
  let serverKeyClass: PlatformStripeServerKeyClass = "absent";
  let publishableKeyMode: PlatformStripePublishableKeyMode = "absent";

  if (secretKey) {
    if (secretKey.includes("sk_test_")) {
      serverKeyMode = "test";
      serverKeyClass = "standard";
    } else if (secretKey.includes("sk_live_")) {
      serverKeyMode = "live";
      serverKeyClass = "standard";
    } else if (secretKey.includes("rk_test_")) {
      serverKeyMode = "test";
      serverKeyClass = "restricted";
    } else if (secretKey.includes("rk_live_")) {
      serverKeyMode = "live";
      serverKeyClass = "restricted";
    } else {
      serverKeyMode = "unknown";
      serverKeyClass = "unknown";
    }
  }

  if (publishableKey) {
    if (publishableKey.includes("pk_test_")) {
      publishableKeyMode = "test";
    } else if (publishableKey.includes("pk_live_")) {
      publishableKeyMode = "live";
    } else {
      publishableKeyMode = "unknown";
    }
  }

  return { serverKeyMode, serverKeyClass, publishableKeyMode };
}

describe("AC-03 exact prefix matching", () => {
  it("classifies a mid-string sk_live_ secret as unrecognized and refuses through K1", () => {
    const observed = observeStripeLoad({
      fixture: {
        secretKey: MIDSTRING_SECRET_KEY,
        publishableKey: "pk_test_SYNTHETICMATRIX",
        webhookSecret: SYNTHETIC_PAYMENTS_WEBHOOK_SECRET,
        connectWebhookSecret: SYNTHETIC_CONNECT_WEBHOOK_SECRET,
      },
      deploymentEnvironment: "staging",
    });

    expect(observed).toMatchObject({ outcome: "refused", reason: "stripe-secret-key-unrecognized" });
    expect(
      evaluateSpec(SPEC_RULES, classifySpec(MIDSTRING_SECRET_KEY, "pk_test_SYNTHETICMATRIX"), "staging")?.rule,
    ).toBe("K1");

    // Mutant `includes-instead-of-startsWith`: reads the mid-string value as live and reaches K4.
    const mutated = evaluateSpec(
      SPEC_RULES,
      classifyWithIncludes(MIDSTRING_SECRET_KEY, "pk_test_SYNTHETICMATRIX"),
      "staging",
    );
    expect(mutated?.reason).not.toBe("stripe-secret-key-unrecognized");
    expect(mutated?.rule).toBe("K3");
  });

  it("classifies a mid-string pk_live_ publishable key as unrecognized and refuses through K2", () => {
    const observed = observeStripeLoad({
      fixture: {
        secretKey: "sk_test_SYNTHETICMATRIX",
        publishableKey: MIDSTRING_PUBLISHABLE_KEY,
        webhookSecret: SYNTHETIC_PAYMENTS_WEBHOOK_SECRET,
        connectWebhookSecret: SYNTHETIC_CONNECT_WEBHOOK_SECRET,
      },
      deploymentEnvironment: "staging",
    });

    expect(observed).toMatchObject({ outcome: "refused", reason: "stripe-publishable-key-unrecognized" });

    // Mutant `includes-instead-of-startsWith`: reads the mid-string value as live and reaches K4.
    const mutated = evaluateSpec(
      SPEC_RULES,
      classifyWithIncludes("sk_test_SYNTHETICMATRIX", MIDSTRING_PUBLISHABLE_KEY),
      "staging",
    );
    expect(mutated?.reason).not.toBe("stripe-publishable-key-unrecognized");
    expect(mutated?.rule).toBe("K3");
  });

  it("keeps every ordinary matrix row green under exact prefix matching", () => {
    for (const server of SERVER_AXIS) {
      for (const publishable of PUBLISHABLE_AXIS) {
        expect(classifySpec(server.value, publishable.value)).toEqual({
          serverKeyMode: server.mode,
          serverKeyClass: server.keyClass,
          publishableKeyMode: publishable.mode,
        });
      }
    }
  });
});

// --- AC-04: no key material is representable in, or emittable beside, any refusal ------------------

const PLANTED_MARKER = "PLANTEDMARKER";
const MARKER_PAYMENTS_WEBHOOK_SECRET = `whsec_payments_${PLANTED_MARKER}`;
const MARKER_CONNECT_WEBHOOK_SECRET = `whsec_connect_${PLANTED_MARKER}`;

type MarkerFixture = Readonly<{
  rule: StripeRuleId;
  name: string;
  secretKey: string | null;
  publishableKey: string | null;
  deploymentEnvironment: DeploymentEnvironment;
  variable: PlatformStripeRefusalVariable;
  reason: PlatformStripeRefusalReason;
}>;

/**
 * One planted-marker pair cannot drive all seven rules: a marker shaped `sk_live_PLANTEDMARKER`
 * classifies live and can never reach K1, and under the K1-K7 order an earlier rule masks a later
 * one whenever both conditions hold. Each rule therefore gets its own fixture, chosen so its target
 * rule is the first matching rule, with every configured value literally carrying the marker.
 * K5 and K6 use an absent counterpart deliberately, because K3 applies in all environments and a
 * concrete disagreeing key would mask them.
 */
const MARKER_FIXTURES: readonly MarkerFixture[] = [
  {
    rule: "K1",
    name: "K1 unrecognized secret key",
    secretKey: `xk_bogus_${PLANTED_MARKER}`,
    publishableKey: `pk_test_${PLANTED_MARKER}`,
    deploymentEnvironment: "staging",
    variable: "STRIPE_SECRET_KEY",
    reason: "stripe-secret-key-unrecognized",
  },
  {
    rule: "K2",
    name: "K2 unrecognized publishable key",
    secretKey: `sk_test_${PLANTED_MARKER}`,
    publishableKey: `xk_bogus_${PLANTED_MARKER}`,
    deploymentEnvironment: "staging",
    variable: "STRIPE_PUBLISHABLE_KEY",
    reason: "stripe-publishable-key-unrecognized",
  },
  {
    rule: "K3",
    name: "K3 key mode mismatch",
    secretKey: `rk_live_${PLANTED_MARKER}`,
    publishableKey: `pk_test_${PLANTED_MARKER}`,
    deploymentEnvironment: "staging",
    variable: "STRIPE_PUBLISHABLE_KEY",
    reason: "stripe-key-mode-mismatch",
  },
  {
    rule: "K4",
    name: "K4 server live with publishable absent",
    secretKey: `rk_live_${PLANTED_MARKER}`,
    publishableKey: null,
    deploymentEnvironment: "staging",
    variable: "STRIPE_SECRET_KEY",
    reason: "stripe-live-key-outside-production",
  },
  {
    rule: "K4",
    name: "K4 server absent with publishable live",
    secretKey: null,
    publishableKey: `pk_live_${PLANTED_MARKER}`,
    deploymentEnvironment: "staging",
    variable: "STRIPE_PUBLISHABLE_KEY",
    reason: "stripe-live-key-outside-production",
  },
  {
    rule: "K4",
    name: "K4 both live tie-break reports the secret",
    secretKey: `sk_live_${PLANTED_MARKER}`,
    publishableKey: `pk_live_${PLANTED_MARKER}`,
    deploymentEnvironment: "staging",
    variable: "STRIPE_SECRET_KEY",
    reason: "stripe-live-key-outside-production",
  },
  {
    rule: "K5",
    name: "K5 non-live secret key in production",
    secretKey: `sk_test_${PLANTED_MARKER}`,
    publishableKey: null,
    deploymentEnvironment: "production",
    variable: "STRIPE_SECRET_KEY",
    reason: "stripe-non-live-key-in-production",
  },
  {
    rule: "K6",
    name: "K6 non-live publishable key in production",
    secretKey: null,
    publishableKey: `pk_test_${PLANTED_MARKER}`,
    deploymentEnvironment: "production",
    variable: "STRIPE_PUBLISHABLE_KEY",
    reason: "stripe-non-live-key-in-production",
  },
  {
    rule: "K7",
    name: "K7 restricted key in production",
    secretKey: `rk_live_${PLANTED_MARKER}`,
    publishableKey: `pk_live_${PLANTED_MARKER}`,
    deploymentEnvironment: "production",
    variable: "STRIPE_SECRET_KEY",
    reason: "stripe-restricted-key-in-production",
  },
];

/** Control (c): the deliberately weaker whole-marker scanner. */
function scanForPlantedMarker(lines: readonly string[]): readonly string[] {
  return lines.filter((line) => line.includes(PLANTED_MARKER));
}

function loadCapturingEmissions(fixture: MarkerFixture): { message: string | null; emitted: readonly string[] } {
  const emitted: string[] = [];
  const capture = (...args: readonly unknown[]) => {
    emitted.push(args.map((value) => String(value)).join(" "));
  };
  const original = {
    log: console.log,
    warn: console.warn,
    error: console.error,
    info: console.info,
    debug: console.debug,
  };

  console.log = capture;
  console.warn = capture;
  console.error = capture;
  console.info = capture;
  console.debug = capture;

  try {
    applyStripeEnvironment({
      secretKey: fixture.secretKey,
      publishableKey: fixture.publishableKey,
      webhookSecret: MARKER_PAYMENTS_WEBHOOK_SECRET,
      connectWebhookSecret: MARKER_CONNECT_WEBHOOK_SECRET,
    });
    loadStripeProviderConfig({
      productionLike: false,
      deploymentEnvironment: fixture.deploymentEnvironment,
      productionMissingConfigError:
        "STRIPE_SECRET_KEY, STRIPE_PUBLISHABLE_KEY, STRIPE_WEBHOOK_SECRET, and STRIPE_CONNECT_WEBHOOK_SECRET are required for Stripe payment processing and Connect money movement in production.",
    });
    return { message: null, emitted };
  } catch (error) {
    return { message: error instanceof Error ? error.message : String(error), emitted };
  } finally {
    console.log = original.log;
    console.warn = original.warn;
    console.error = original.error;
    console.info = original.info;
    console.debug = original.debug;
  }
}

describe("AC-04 refusal leakage closure", () => {
  for (const fixture of MARKER_FIXTURES) {
    it(`marker fixture ${fixture.name}`, () => {
      const classification = classifySpec(fixture.secretKey, fixture.publishableKey);

      // The target rule is the first matching rule under the normative order.
      const refusal = evaluateSpec(SPEC_RULES, classification, fixture.deploymentEnvironment);
      expect(refusal?.rule).toBe(fixture.rule);
      expect(refusal?.reason).toBe(fixture.reason);
      expect(refusal?.variable).toBe(fixture.variable);

      // Every configured value literally carries the marker, so a vacuous scan is impossible.
      for (const configured of [fixture.secretKey, fixture.publishableKey]) {
        if (configured !== null) {
          expect(configured).toContain(PLANTED_MARKER);
        }
      }

      const { message, emitted } = loadCapturingEmissions(fixture);
      expect(message).not.toBeNull();

      const observed = observeStripeLoad({
        fixture: {
          secretKey: fixture.secretKey,
          publishableKey: fixture.publishableKey,
          webhookSecret: MARKER_PAYMENTS_WEBHOOK_SECRET,
          connectWebhookSecret: MARKER_CONNECT_WEBHOOK_SECRET,
        },
        deploymentEnvironment: fixture.deploymentEnvironment,
      });
      expect(observed).toEqual({
        outcome: "refused",
        reason: fixture.reason,
        variable: fixture.variable,
        classification,
      });

      // Control (c): whole-marker emission scan over the thrown message and every emitted line.
      expect(scanForPlantedMarker([message ?? ""])).toEqual([]);
      expect(scanForPlantedMarker(emitted)).toEqual([]);
    });
  }

  it("control (c) positive control: the same scanner reports a planted marker", () => {
    const contaminated = [`refused with ${PLANTED_MARKER} in the message`, "a clean line"];
    expect(scanForPlantedMarker(contaminated)).toEqual([`refused with ${PLANTED_MARKER} in the message`]);
    expect(scanForPlantedMarker(["a clean line"])).toEqual([]);
  });

  // Control (a): closed refusal payload shape. Each call site below must fail to compile because no
  // parameter of the bounded refusal constructor is typed string, number, or unknown. This is a
  // compile-time assertion proved by `pnpm run test:typecheck`; `pnpm run verify:static` cannot see
  // it. Widening any parameter makes the matching @ts-expect-error directive unused and reddens the
  // gate.
  it("control (a) refuses raw key material, a slice, a length, and a digest at compile time", () => {
    const syntheticSecretKey = "sk_live_SYNTHETICCONTROLVALUE";
    const syntheticDigest = "0000000000000000000000000000000000000000000000000000000000000000";

    expect(
      stripeKeyRefusal({
        // @ts-expect-error the raw secret key is not representable in a refusal payload
        reason: syntheticSecretKey,
        variable: "STRIPE_SECRET_KEY",
        serverKeyMode: "live",
        serverKeyClass: "standard",
        publishableKeyMode: "absent",
        deploymentEnvironment: "staging",
      }),
    ).toBeInstanceOf(Error);

    expect(
      stripeKeyRefusal({
        // @ts-expect-error a key prefix slice is not representable in a refusal payload
        reason: syntheticSecretKey.slice(0, 8),
        variable: "STRIPE_SECRET_KEY",
        serverKeyMode: "live",
        serverKeyClass: "standard",
        publishableKeyMode: "absent",
        deploymentEnvironment: "staging",
      }),
    ).toBeInstanceOf(Error);

    expect(
      stripeKeyRefusal({
        reason: "stripe-secret-key-unrecognized",
        // @ts-expect-error a key length is not representable in a refusal payload
        variable: syntheticSecretKey.length,
        serverKeyMode: "live",
        serverKeyClass: "standard",
        publishableKeyMode: "absent",
        deploymentEnvironment: "staging",
      }),
    ).toBeInstanceOf(Error);

    expect(
      stripeKeyRefusal({
        reason: "stripe-secret-key-unrecognized",
        variable: "STRIPE_SECRET_KEY",
        // @ts-expect-error a key digest is not representable in a refusal payload
        serverKeyMode: syntheticDigest,
        serverKeyClass: "standard",
        publishableKeyMode: "absent",
        deploymentEnvironment: "staging",
      }),
    ).toBeInstanceOf(Error);
  });
});

// --- AC-04b: the 21-pair precedence partition -----------------------------------------------------

type PrecedenceWitness = Readonly<{
  pair: string;
  higher: StripeRuleId;
  lower: StripeRuleId;
  secretKey: string | null;
  publishableKey: string | null;
  deploymentEnvironment: DeploymentEnvironment;
  reported: PlatformStripeRefusalReason;
  reportedAfterSwap: PlatformStripeRefusalReason;
}>;

const MATERIAL_PRECEDENCE: readonly PrecedenceWitness[] = [
  {
    pair: "P1 K1 over K2",
    higher: "K1",
    lower: "K2",
    secretKey: "xk_bogus_SYNTHETICMATRIX",
    publishableKey: "xk_bogus_SYNTHETICMATRIX",
    deploymentEnvironment: "staging",
    reported: "stripe-secret-key-unrecognized",
    reportedAfterSwap: "stripe-publishable-key-unrecognized",
  },
  {
    pair: "P2 K1 over K4",
    higher: "K1",
    lower: "K4",
    secretKey: "xk_bogus_SYNTHETICMATRIX",
    publishableKey: "pk_live_SYNTHETICMATRIX",
    deploymentEnvironment: "staging",
    reported: "stripe-secret-key-unrecognized",
    reportedAfterSwap: "stripe-live-key-outside-production",
  },
  {
    pair: "P3 K1 over K5",
    higher: "K1",
    lower: "K5",
    secretKey: "xk_bogus_SYNTHETICMATRIX",
    publishableKey: null,
    deploymentEnvironment: "production",
    reported: "stripe-secret-key-unrecognized",
    reportedAfterSwap: "stripe-non-live-key-in-production",
  },
  {
    pair: "P4 K2 over K4",
    higher: "K2",
    lower: "K4",
    secretKey: "sk_live_SYNTHETICMATRIX",
    publishableKey: "xk_bogus_SYNTHETICMATRIX",
    deploymentEnvironment: "staging",
    reported: "stripe-publishable-key-unrecognized",
    reportedAfterSwap: "stripe-live-key-outside-production",
  },
  {
    pair: "P5 K2 over K6",
    higher: "K2",
    lower: "K6",
    secretKey: "sk_live_SYNTHETICMATRIX",
    publishableKey: "xk_bogus_SYNTHETICMATRIX",
    deploymentEnvironment: "production",
    reported: "stripe-publishable-key-unrecognized",
    reportedAfterSwap: "stripe-non-live-key-in-production",
  },
  {
    pair: "P6 K2 over K7",
    higher: "K2",
    lower: "K7",
    secretKey: "rk_live_SYNTHETICMATRIX",
    publishableKey: "xk_bogus_SYNTHETICMATRIX",
    deploymentEnvironment: "production",
    reported: "stripe-publishable-key-unrecognized",
    reportedAfterSwap: "stripe-restricted-key-in-production",
  },
  {
    pair: "P7 K3 over K4",
    higher: "K3",
    lower: "K4",
    secretKey: "rk_live_SYNTHETICMATRIX",
    publishableKey: "pk_test_SYNTHETICMATRIX",
    deploymentEnvironment: "staging",
    reported: "stripe-key-mode-mismatch",
    reportedAfterSwap: "stripe-live-key-outside-production",
  },
  {
    pair: "P8 K3 over K5",
    higher: "K3",
    lower: "K5",
    secretKey: "sk_test_SYNTHETICMATRIX",
    publishableKey: "pk_live_SYNTHETICMATRIX",
    deploymentEnvironment: "production",
    reported: "stripe-key-mode-mismatch",
    reportedAfterSwap: "stripe-non-live-key-in-production",
  },
  {
    pair: "P9 K3 over K7",
    higher: "K3",
    lower: "K7",
    secretKey: "rk_live_SYNTHETICMATRIX",
    publishableKey: "pk_test_SYNTHETICMATRIX",
    deploymentEnvironment: "production",
    reported: "stripe-key-mode-mismatch",
    reportedAfterSwap: "stripe-restricted-key-in-production",
  },
  {
    pair: "P10 K5 over K7",
    higher: "K5",
    lower: "K7",
    secretKey: "rk_test_SYNTHETICMATRIX",
    publishableKey: null,
    deploymentEnvironment: "production",
    reported: "stripe-non-live-key-in-production",
    reportedAfterSwap: "stripe-restricted-key-in-production",
  },
  {
    pair: "P11 K1 over K6",
    higher: "K1",
    lower: "K6",
    secretKey: "xk_bogus_SYNTHETICMATRIX",
    publishableKey: "pk_test_SYNTHETICMATRIX",
    deploymentEnvironment: "production",
    reported: "stripe-secret-key-unrecognized",
    reportedAfterSwap: "stripe-non-live-key-in-production",
  },
  {
    pair: "P12 K2 over K5",
    higher: "K2",
    lower: "K5",
    secretKey: "sk_test_SYNTHETICMATRIX",
    publishableKey: "xk_bogus_SYNTHETICMATRIX",
    deploymentEnvironment: "production",
    reported: "stripe-publishable-key-unrecognized",
    reportedAfterSwap: "stripe-non-live-key-in-production",
  },
  {
    pair: "P13 K3 over K6",
    higher: "K3",
    lower: "K6",
    secretKey: "sk_live_SYNTHETICMATRIX",
    publishableKey: "pk_test_SYNTHETICMATRIX",
    deploymentEnvironment: "production",
    reported: "stripe-key-mode-mismatch",
    reportedAfterSwap: "stripe-non-live-key-in-production",
  },
];

/**
 * The eight non-material pairs carry no assertion and no mutant. Each exclusion reason is stated
 * inline so a later "add another pair" edit must contradict this half of the partition too.
 */
const NON_MATERIAL_PRECEDENCE: readonly Readonly<{ pair: string; why: string }>[] = [
  { pair: "K1>K3", why: "serverKeyMode cannot be unknown and in {test, live} at once" },
  { pair: "K1>K7", why: "serverKeyClass is unknown whenever K1 fires, never restricted" },
  { pair: "K2>K3", why: "publishableKeyMode cannot be unknown and in {test, live} at once" },
  { pair: "K4>K5", why: "K4 is non-production and K5 is production" },
  { pair: "K4>K6", why: "K4 is non-production and K6 is production" },
  { pair: "K4>K7", why: "K4 is non-production and K7 is production" },
  { pair: "K5>K6", why: "both report stripe-non-live-key-in-production; the observation schema is closed" },
  { pair: "K6>K7", why: "K6 fires only with an absent server key, and an absent server key is never restricted" },
];

describe("AC-04b precedence partition", () => {
  for (const witness of MATERIAL_PRECEDENCE) {
    it(`precedence ${witness.pair}`, () => {
      const classification = classifySpec(witness.secretKey, witness.publishableKey);

      const observed = observeStripeLoad({
        fixture: {
          secretKey: witness.secretKey,
          publishableKey: witness.publishableKey,
          webhookSecret: SYNTHETIC_PAYMENTS_WEBHOOK_SECRET,
          connectWebhookSecret: SYNTHETIC_CONNECT_WEBHOOK_SECRET,
        },
        deploymentEnvironment: witness.deploymentEnvironment,
      });
      expect(observed).toMatchObject({ outcome: "refused", reason: witness.reported });
      expect(evaluateSpec(SPEC_RULES, classification, witness.deploymentEnvironment)?.rule).toBe(witness.higher);

      // Named swap mutant: move the lower rule immediately above the higher one.
      const mutated = evaluateSpec(
        withPrecedenceSwapped(witness.higher, witness.lower),
        classification,
        witness.deploymentEnvironment,
      );
      expect(mutated?.rule).toBe(witness.lower);
      expect(mutated?.reason).toBe(witness.reportedAfterSwap);
      expect(mutated?.reason).not.toBe(witness.reported);
    });
  }

  it("partitions all 21 ordered rule pairs into exactly 13 material and 8 non-material", () => {
    const ruleIds = SPEC_RULES.map((rule) => rule.id);
    const orderedPairs: string[] = [];
    for (let higher = 0; higher < ruleIds.length; higher += 1) {
      for (let lower = higher + 1; lower < ruleIds.length; lower += 1) {
        orderedPairs.push(`${ruleIds[higher]}>${ruleIds[lower]}`);
      }
    }

    expect(orderedPairs).toHaveLength(21);
    expect(MATERIAL_PRECEDENCE).toHaveLength(13);
    expect(NON_MATERIAL_PRECEDENCE).toHaveLength(8);

    const claimed = [
      ...MATERIAL_PRECEDENCE.map((witness) => `${witness.higher}>${witness.lower}`),
      ...NON_MATERIAL_PRECEDENCE.map((entry) => entry.pair),
    ];
    expect([...claimed].sort()).toEqual([...orderedPairs].sort());
    expect(new Set(claimed).size).toBe(21);
  });

  it("derives the same partition exhaustively from the admissible input set", () => {
    const material: string[] = [];
    const nonMaterial: string[] = [];
    const ruleIds = SPEC_RULES.map((rule) => rule.id);

    for (let higherIndex = 0; higherIndex < ruleIds.length; higherIndex += 1) {
      for (let lowerIndex = higherIndex + 1; lowerIndex < ruleIds.length; lowerIndex += 1) {
        const higher = ruleIds[higherIndex];
        const lower = ruleIds[lowerIndex];
        const swapped = withPrecedenceSwapped(higher, lower);
        let observable = false;

        for (const deploymentEnvironment of MATRIX_ENVIRONMENTS) {
          for (const server of SERVER_AXIS) {
            for (const publishable of PUBLISHABLE_AXIS) {
              const classification = classifySpec(server.value, publishable.value);
              const normative = evaluateSpec(SPEC_RULES, classification, deploymentEnvironment);
              if (normative?.rule !== higher) {
                continue;
              }

              const mutated = evaluateSpec(swapped, classification, deploymentEnvironment);
              if (mutated?.rule === lower && mutated.reason !== normative.reason) {
                observable = true;
              }
            }
          }
        }

        (observable ? material : nonMaterial).push(`${higher}>${lower}`);
      }
    }

    expect(material.sort()).toEqual(
      [...MATERIAL_PRECEDENCE.map((witness) => `${witness.higher}>${witness.lower}`)].sort(),
    );
    expect(nonMaterial.sort()).toEqual([...NON_MATERIAL_PRECEDENCE.map((entry) => entry.pair)].sort());
  });
});

// --- AC-05: effectiveMode binds to constructed authority -------------------------------------------

type EffectiveModeControl = Readonly<{
  name: string;
  fixture: StripeEnvironmentFixture;
  deploymentEnvironment: DeploymentEnvironment;
  effectiveMode: PlatformStripeEffectiveMode;
  paymentProcessorKind: "fake" | "stripe";
  moneyMovementKind: "fake" | "stripe";
}>;

const EFFECTIVE_MODE_CONTROLS: readonly EffectiveModeControl[] = [
  {
    name: "C1 Connect-only",
    fixture: {
      secretKey: "sk_test_SYNTHETICMATRIX",
      publishableKey: null,
      webhookSecret: null,
      connectWebhookSecret: SYNTHETIC_CONNECT_WEBHOOK_SECRET,
    },
    deploymentEnvironment: "dev",
    effectiveMode: "test",
    paymentProcessorKind: "fake",
    moneyMovementKind: "stripe",
  },
  {
    // Must be dev and not staging: staging throws without the Connect secret, so the staging arm
    // cannot construct this state at all.
    name: "C2 secret present with no gateway, development",
    fixture: {
      secretKey: "sk_test_SYNTHETICMATRIX",
      publishableKey: null,
      webhookSecret: null,
      connectWebhookSecret: null,
    },
    deploymentEnvironment: "dev",
    effectiveMode: "unconfigured",
    paymentProcessorKind: "fake",
    moneyMovementKind: "fake",
  },
  {
    // Admitted because K5 exempts live and K6 exempts absent, and no other rule refuses it.
    name: "C3 the same shape at the production landing profile",
    fixture: {
      secretKey: "sk_live_SYNTHETICMATRIX",
      publishableKey: null,
      webhookSecret: null,
      connectWebhookSecret: null,
    },
    deploymentEnvironment: "production",
    effectiveMode: "unconfigured",
    paymentProcessorKind: "fake",
    moneyMovementKind: "fake",
  },
  {
    name: "C4 the no-key production landing control",
    fixture: {
      secretKey: null,
      publishableKey: null,
      webhookSecret: null,
      connectWebhookSecret: null,
    },
    deploymentEnvironment: "production",
    effectiveMode: "unconfigured",
    paymentProcessorKind: "fake",
    moneyMovementKind: "fake",
  },
];

/** Mutant `effectiveMode-from-server-mode`. */
function effectiveModeFromServerMode(classification: PlatformStripeKeyClassification): string {
  return classification.serverKeyMode === "absent" ? "unconfigured" : classification.serverKeyMode;
}

/** Mutant `effectiveMode-from-publishable-key`. */
function effectiveModeFromPublishableKey(classification: PlatformStripeKeyClassification): string {
  return classification.publishableKeyMode === "absent" ? "unconfigured" : classification.publishableKeyMode;
}

describe("AC-05 effectiveMode binds to constructed gateways", () => {
  for (const control of EFFECTIVE_MODE_CONTROLS) {
    it(`${control.name}`, () => {
      const observed = observeStripeLoad({
        fixture: control.fixture,
        deploymentEnvironment: control.deploymentEnvironment,
      });

      expect(observed).toEqual({
        outcome: "accepted",
        effectiveMode: control.effectiveMode,
        paymentProcessorKind: control.paymentProcessorKind,
        moneyMovementKind: control.moneyMovementKind,
      });
    });
  }

  it("mutant effectiveMode-from-server-mode reddens C2 and C3 while C1 and C4 stay green", () => {
    const outcomes = EFFECTIVE_MODE_CONTROLS.map((control) => {
      const classification = classifySpec(control.fixture.secretKey, control.fixture.publishableKey);
      return {
        name: control.name,
        agrees: effectiveModeFromServerMode(classification) === control.effectiveMode,
      };
    });

    expect(outcomes).toEqual([
      { name: "C1 Connect-only", agrees: true },
      { name: "C2 secret present with no gateway, development", agrees: false },
      { name: "C3 the same shape at the production landing profile", agrees: false },
      { name: "C4 the no-key production landing control", agrees: true },
    ]);
  });

  it("mutant effectiveMode-from-publishable-key reddens C1", () => {
    const c1 = EFFECTIVE_MODE_CONTROLS[0];
    const classification = classifySpec(c1.fixture.secretKey, c1.fixture.publishableKey);

    expect(effectiveModeFromPublishableKey(classification)).toBe("unconfigured");
    expect(effectiveModeFromPublishableKey(classification)).not.toBe(c1.effectiveMode);
  });
});

// --- AC-06 and AC-06d: the offline differential oracle ---------------------------------------------
//
// This oracle claims a code-domain delta over synthetic axis values only. It makes no assertion
// whatsoever about the values, prefixes, or classification of any secret configured in any
// deployment; this slice holds no live authority and declares no operator action.

const ORACLE_SERVER_AXIS: readonly Readonly<{ label: string; value: string | null }>[] = [
  { label: "absent", value: null },
  { label: "sk_test_123", value: "sk_test_123" },
  { label: "sk_live_123", value: "sk_live_123" },
  { label: "rk_test_123", value: "rk_test_123" },
  { label: "rk_live_123", value: "rk_live_123" },
  { label: "xk_bogus_123", value: "xk_bogus_123" },
  { label: "sk_liveSYNTHETIC", value: "sk_liveSYNTHETIC" },
];

const ORACLE_PUBLISHABLE_AXIS: readonly Readonly<{ label: string; value: string | null }>[] = [
  { label: "absent", value: null },
  { label: "pk_test_123", value: "pk_test_123" },
  { label: "pk_live_123", value: "pk_live_123" },
  { label: "xk_bogus_987", value: "xk_bogus_987" },
  { label: "pk_liveSYNTHETIC", value: "pk_liveSYNTHETIC" },
];

/** The well-formed 24-cell core excludes the two malformed probes. */
const MALFORMED_PROBES = new Set(["sk_liveSYNTHETIC", "pk_liveSYNTHETIC"]);

type OracleResult = Readonly<{
  divergent: readonly string[];
  widening: readonly string[];
  cells: number;
  coreDisagreements: readonly string[];
}>;

function runDifferentialOracle(deploymentEnvironment: DeploymentEnvironment): OracleResult {
  const divergent: string[] = [];
  const widening: string[] = [];
  const coreDisagreements: string[] = [];
  let cells = 0;

  for (const server of ORACLE_SERVER_AXIS) {
    for (const publishable of ORACLE_PUBLISHABLE_AXIS) {
      cells += 1;

      const oldRefuses = revertedTwoPrefixRefuses(server.value, publishable.value, deploymentEnvironment);
      const observed = observeStripeLoad({
        fixture: {
          secretKey: server.value,
          publishableKey: publishable.value,
          webhookSecret: SYNTHETIC_PAYMENTS_WEBHOOK_SECRET,
          connectWebhookSecret: SYNTHETIC_CONNECT_WEBHOOK_SECRET,
        },
        deploymentEnvironment,
      });
      const newRefuses = observed.outcome === "refused";
      const rule = evaluateSpec(SPEC_RULES, classifySpec(server.value, publishable.value), deploymentEnvironment)?.rule;
      const label = `${server.label} / ${publishable.label}`;

      if (!oldRefuses && newRefuses) {
        divergent.push(`${label} -> ${rule}`);
      }
      if (oldRefuses && !newRefuses) {
        widening.push(label);
      }

      const isCore = !MALFORMED_PROBES.has(server.label) && !MALFORMED_PROBES.has(publishable.label);
      if (isCore && oldRefuses !== newRefuses) {
        coreDisagreements.push(label);
      }
    }
  }

  return { divergent, widening, cells, coreDisagreements };
}

/** Mutant relaxing the classifier to a no-underscore prefix vocabulary. */
function classifyNoUnderscore(
  secretKey: string | null,
  publishableKey: string | null,
): PlatformStripeKeyClassification {
  let serverKeyMode: PlatformStripeServerKeyMode = "absent";
  let serverKeyClass: PlatformStripeServerKeyClass = "absent";
  let publishableKeyMode: PlatformStripePublishableKeyMode = "absent";

  if (secretKey) {
    if (secretKey.startsWith("sk_test")) {
      serverKeyMode = "test";
      serverKeyClass = "standard";
    } else if (secretKey.startsWith("sk_live")) {
      serverKeyMode = "live";
      serverKeyClass = "standard";
    } else if (secretKey.startsWith("rk_test")) {
      serverKeyMode = "test";
      serverKeyClass = "restricted";
    } else if (secretKey.startsWith("rk_live")) {
      serverKeyMode = "live";
      serverKeyClass = "restricted";
    } else {
      serverKeyMode = "unknown";
      serverKeyClass = "unknown";
    }
  }

  if (publishableKey) {
    if (publishableKey.startsWith("pk_test")) {
      publishableKeyMode = "test";
    } else if (publishableKey.startsWith("pk_live")) {
      publishableKeyMode = "live";
    } else {
      publishableKeyMode = "unknown";
    }
  }

  return { serverKeyMode, serverKeyClass, publishableKeyMode };
}

describe("AC-06 and AC-06d differential oracle", () => {
  it("AC-06 production narrows by exactly the five malformed-prefix cells with zero widening", () => {
    const result = runDifferentialOracle("production");

    expect(result.cells).toBe(35);
    expect(result.widening).toEqual([]);
    expect(result.coreDisagreements).toEqual([]);
    expect(result.divergent).toEqual([
      "absent / pk_liveSYNTHETIC -> K2",
      "sk_live_123 / pk_liveSYNTHETIC -> K2",
      "sk_liveSYNTHETIC / absent -> K1",
      "sk_liveSYNTHETIC / pk_live_123 -> K1",
      "sk_liveSYNTHETIC / pk_liveSYNTHETIC -> K1",
    ]);
  });

  it("AC-06 mutant relaxing to a no-underscore prefix collapses the production divergent set", () => {
    const divergent: string[] = [];

    for (const server of ORACLE_SERVER_AXIS) {
      for (const publishable of ORACLE_PUBLISHABLE_AXIS) {
        const oldRefuses = revertedTwoPrefixRefuses(server.value, publishable.value, "production");
        const mutated = evaluateSpec(SPEC_RULES, classifyNoUnderscore(server.value, publishable.value), "production");
        if (!oldRefuses && mutated !== null) {
          divergent.push(`${server.label} / ${publishable.label}`);
        }
      }
    }

    expect(divergent).toEqual([]);
  });

  it("AC-06d staging narrows by exactly nine well-formed-core cells with zero widening", () => {
    const result = runDifferentialOracle("staging");

    expect(result.cells).toBe(35);
    expect(result.widening).toEqual([]);
    expect(result.divergent).toEqual([
      "absent / xk_bogus_987 -> K2",
      "sk_test_123 / xk_bogus_987 -> K2",
      "rk_test_123 / xk_bogus_987 -> K2",
      "rk_live_123 / absent -> K4",
      "rk_live_123 / pk_test_123 -> K3",
      "rk_live_123 / xk_bogus_987 -> K2",
      "xk_bogus_123 / absent -> K1",
      "xk_bogus_123 / pk_test_123 -> K1",
      "xk_bogus_123 / xk_bogus_987 -> K1",
    ]);

    // All nine lie inside the well-formed core; the two malformed probes add none. This is the exact
    // inverse of production, where the core diverges on zero cells and only the probes diverge.
    for (const entry of result.divergent) {
      for (const probe of MALFORMED_PROBES) {
        expect(entry).not.toContain(probe);
      }
    }
    expect(result.coreDisagreements).toHaveLength(9);
  });
});

// --- AC-06b: the production landing profile still boots with no Stripe configuration ---------------

describe("AC-06b production landing profile", () => {
  it("boots with no Stripe configuration and reports unconfigured", () => {
    const observed = observeStripeLoad({
      fixture: { secretKey: null, publishableKey: null, webhookSecret: null, connectWebhookSecret: null },
      deploymentEnvironment: "production",
      productionLike: false,
    });

    expect(observed).toEqual({
      outcome: "accepted",
      effectiveMode: "unconfigured",
      paymentProcessorKind: "fake",
      moneyMovementKind: "fake",
    });
  });

  it("mutant writing K5 as a bare serverKeyMode !== live reddens the landing control", () => {
    const droppedExemption: readonly StripeRule[] = SPEC_RULES.map((rule) =>
      rule.id === "K5"
        ? {
            ...rule,
            matches: (classification, deploymentEnvironment) =>
              deploymentEnvironment === "production" && classification.serverKeyMode !== "live",
          }
        : rule,
    );

    const classification = classifySpec(null, null);
    expect(evaluateSpec(SPEC_RULES, classification, "production")).toBeNull();
    expect(evaluateSpec(droppedExemption, classification, "production")?.rule).toBe("K5");
  });
});

// -------------------------------------------------------------------------------------------------
// AC-F2 clause (1j) — the loader's own production missing-config vocabulary.
//
// `productionMissingConfigError` was declared `string`, which made it an unconstrained external
// raw-value source echoed verbatim through `new Error(...)` before any classification. It is now the
// union derived from the module's exported `as const` tuple, and the loader refuses a non-member as
// its first statement, before either key acquisition, with a fixed internal message.
//
// Every literal below is unmistakably synthetic, non-functional, and never transmitted.
// -------------------------------------------------------------------------------------------------

/** Shaped like a live secret key purely so the probe can prove the refusal never echoes its input. */
const SYNTHETIC_LIVE_SHAPED_PARAMETER_VALUE = "sk_live_SYNTHETIC_REVIEW_ONLY";

/** The admitted tuple member every runtime call site in this file passes as an inline string literal. */
const ADMITTED_PRODUCTION_MISSING_CONFIG_MESSAGE =
  "STRIPE_SECRET_KEY, STRIPE_PUBLISHABLE_KEY, STRIPE_WEBHOOK_SECRET, and STRIPE_CONNECT_WEBHOOK_SECRET are required for Stripe payment processing and Connect money movement in production.";

/**
 * The loader applied through a locally bound value.
 *
 * Clause (1j) identifies a call site by resolving its callee's TypeScript symbol to the exported
 * `loadStripeProviderConfig` declaration, which covers a direct import, a renamed import, a namespace
 * or property access, and a re-export chain of any depth. A local value binding is a different symbol
 * and is deliberately not one of those module-system aliases, so this probe -- whose whole purpose is
 * to pass a message the vocabulary refuses -- is not a discoverable call site and the clean-state
 * inventory stays at exactly twelve calls, every argument an admitted `StringLiteral` tuple member.
 * The source-shape half of the same obligation is carried by the caller rule's own
 * `caller-passes-unadmitted-literal` and `caller-passes-identifier` controls in the platform-api suite.
 */
const applyLoaderThroughLocalBinding: typeof loadStripeProviderConfig = loadStripeProviderConfig;

describe("AC-F2 clause (1j) production missing-config vocabulary", () => {
  it("declares exactly the two production caller messages as a closed, distinct vocabulary", () => {
    expect(PRODUCTION_MISSING_STRIPE_CONFIG_ERRORS).toHaveLength(2);
    expect(new Set(PRODUCTION_MISSING_STRIPE_CONFIG_ERRORS).size).toBe(2);
    expect(PRODUCTION_MISSING_STRIPE_CONFIG_ERRORS).toContain(ADMITTED_PRODUCTION_MISSING_CONFIG_MESSAGE);
  });

  it("mutant parameter-echoes-synthetic-live-shaped-value emits only the fixed internal refusal", () => {
    applyStripeEnvironment({
      secretKey: "sk_test_SYNTHETICVOCABULARY",
      publishableKey: "pk_test_SYNTHETICVOCABULARY",
      webhookSecret: SYNTHETIC_PAYMENTS_WEBHOOK_SECRET,
      connectWebhookSecret: SYNTHETIC_CONNECT_WEBHOOK_SECRET,
    });

    // The refusal must precede both acquisitions, so the probe records every environment read.
    const environmentReads: string[] = [];
    const originalProcessEnv = process.env;
    const recordingEnv = new Proxy<typeof process.env>(
      { ...process.env },
      {
        get(target, property, receiver) {
          if (typeof property === "string") {
            environmentReads.push(property);
          }

          return Reflect.get(target, property, receiver);
        },
      },
    );

    let observed = "";
    process.env = recordingEnv;
    try {
      applyLoaderThroughLocalBinding({
        productionLike: false,
        deploymentEnvironment: "dev",
        // @ts-expect-error clause (1j): a synthetic live-shaped value is not a member of the vocabulary.
        productionMissingConfigError: SYNTHETIC_LIVE_SHAPED_PARAMETER_VALUE,
      });
    } catch (error) {
      observed = error instanceof Error ? error.message : String(error);
    } finally {
      process.env = originalProcessEnv;
    }

    expect(observed).toBe(PRODUCTION_MISSING_STRIPE_CONFIG_VOCABULARY_REFUSAL);
    expect(observed).not.toContain(SYNTHETIC_LIVE_SHAPED_PARAMETER_VALUE);
    expect(observed).not.toContain("sk_live");
    expect(environmentReads).not.toContain("STRIPE_SECRET_KEY");
    expect(environmentReads).not.toContain("STRIPE_PUBLISHABLE_KEY");
  });

  it("refuses an unadmitted message ahead of every later refusal rule", () => {
    // Frozen so two later refusals are both armed: staging without a Connect secret, and live keys
    // outside production. Only the governing variable -- the message -- varies.
    applyStripeEnvironment({
      secretKey: "sk_live_SYNTHETICPRECEDENCE",
      publishableKey: "pk_live_SYNTHETICPRECEDENCE",
      webhookSecret: null,
      connectWebhookSecret: null,
    });

    expect(() =>
      applyLoaderThroughLocalBinding({
        productionLike: false,
        deploymentEnvironment: "staging",
        // @ts-expect-error clause (1j): the same unadmitted value, one governing variable varied.
        productionMissingConfigError: SYNTHETIC_LIVE_SHAPED_PARAMETER_VALUE,
      }),
    ).toThrow(PRODUCTION_MISSING_STRIPE_CONFIG_VOCABULARY_REFUSAL);
  });

  it("compile-negative: an inline synthetic key-shaped argument does not typecheck", () => {
    expect(() =>
      applyLoaderThroughLocalBinding({
        productionLike: false,
        deploymentEnvironment: "dev",
        // @ts-expect-error clause (1j) compile-negative, proved by pnpm run test:typecheck.
        productionMissingConfigError: "rk_live_SYNTHETIC_COMPILE_NEGATIVE",
      }),
    ).toThrow(PRODUCTION_MISSING_STRIPE_CONFIG_VOCABULARY_REFUSAL);
  });

  it("control caller-passes-unadmitted-literal: a plain non-member literal is refused too", () => {
    applyStripeEnvironment({
      secretKey: null,
      publishableKey: null,
      webhookSecret: null,
      connectWebhookSecret: null,
    });

    expect(() =>
      applyLoaderThroughLocalBinding({
        productionLike: false,
        deploymentEnvironment: "dev",
        // @ts-expect-error clause (1j): the pre-repair message is no longer a vocabulary member.
        productionMissingConfigError: "production Stripe config is required.",
      }),
    ).toThrow(PRODUCTION_MISSING_STRIPE_CONFIG_VOCABULARY_REFUSAL);
  });

  it("green control: each declared vocabulary member passes the first statement", () => {
    applyStripeEnvironment({
      secretKey: null,
      publishableKey: null,
      webhookSecret: null,
      connectWebhookSecret: null,
    });

    for (const admitted of PRODUCTION_MISSING_STRIPE_CONFIG_ERRORS) {
      expect(
        applyLoaderThroughLocalBinding({
          productionLike: false,
          deploymentEnvironment: "dev",
          productionMissingConfigError: admitted,
        }),
      ).toMatchObject({
        paymentProcessor: { kind: "fake" },
        moneyMovement: { kind: "fake" },
      });
    }
  });
});
