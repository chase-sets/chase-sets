import { afterEach, describe, expect, it } from "vitest";
import {
  PLATFORM_DATA_PROFILES,
  getBooleanEnv,
  getReadConsistencyExactDependencyModeEnv,
  loadReadConsistencyRouteTuningEnv,
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

  it("derives platform data profiles from the bounded-context contract", () => {
    expect(PLATFORM_DATA_PROFILES).toEqual([
      "critical-bootstrap",
      "catalog-integration-bootstrap",
      "scenario-seed",
      "representative-commerce-state",
    ]);
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
});
