import { afterEach, describe, expect, it } from "vitest";
import { getBooleanEnv, resolveEnumEnv } from "./config-schema";

const envName = "PLATFORM_RUNTIME_CONFIG_SCHEMA_TEST_FLAG";

afterEach(() => {
  delete process.env[envName];
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
    expect(getBooleanEnv(envName, true)).toBe(true);

    process.env[envName] = "off";
    expect(getBooleanEnv(envName, true)).toBe(false);

    process.env[envName] = "YES";
    expect(getBooleanEnv(envName, false)).toBe(true);

    process.env[envName] = "required";
    expect(() => getBooleanEnv(envName, false)).toThrow(
      "PLATFORM_RUNTIME_CONFIG_SCHEMA_TEST_FLAG must be a boolean value: 1, true, yes, on, 0, false, no, off.",
    );
  });
});
