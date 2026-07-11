import { describe, expect, it } from "vitest";
import {
  applyRateLimitPolicy,
  decodeRateLimitPolicyValue,
  RATE_LIMIT_POLICY_DEFAULT_VALUE,
  rateLimitPolicy,
} from "./rate-limit-policy";

const defaults = { max: 30, windowMs: 10 * 60 * 1000 };

describe("platform-operations rate-limit policy", () => {
  it("decodes the compiled default value", () => {
    expect(decodeRateLimitPolicyValue({ incidentMultiplier: 1, surfaces: {} })).toEqual(
      RATE_LIMIT_POLICY_DEFAULT_VALUE,
    );
  });

  it("declares the neutral no-overrides value as the compiled default fallback", () => {
    expect(rateLimitPolicy.defaultValue).toEqual(RATE_LIMIT_POLICY_DEFAULT_VALUE);
  });

  it("decodes a per-surface override", () => {
    expect(
      decodeRateLimitPolicyValue({
        incidentMultiplier: 1,
        surfaces: { "checkout.anonymous-rail-capture": { max: 10, windowMs: 60_000, disabled: false } },
      }),
    ).toEqual({
      incidentMultiplier: 1,
      surfaces: { "checkout.anonymous-rail-capture": { max: 10, windowMs: 60_000, disabled: false } },
    });
  });

  it("rejects an incident multiplier outside the [0.1, 10] bounds", () => {
    expect(() => decodeRateLimitPolicyValue({ incidentMultiplier: 0, surfaces: {} })).toThrow(/between 0.1 and 10/);
    expect(() => decodeRateLimitPolicyValue({ incidentMultiplier: 11, surfaces: {} })).toThrow(/between 0.1 and 10/);
    expect(() => decodeRateLimitPolicyValue({ incidentMultiplier: Number.NaN, surfaces: {} })).toThrow();
  });

  it("rejects a surface override with a non-positive or absurd max", () => {
    expect(() =>
      decodeRateLimitPolicyValue({ incidentMultiplier: 1, surfaces: { "auth.register.ip": { max: 0 } } }),
    ).toThrow(/whole number between/);
    expect(() =>
      decodeRateLimitPolicyValue({ incidentMultiplier: 1, surfaces: { "auth.register.ip": { max: 1.5 } } }),
    ).toThrow(/whole number between/);
    expect(() =>
      decodeRateLimitPolicyValue({ incidentMultiplier: 1, surfaces: { "auth.register.ip": { max: 2_000_000 } } }),
    ).toThrow(/whole number between/);
  });

  it("rejects a surface override with an out-of-bounds windowMs", () => {
    expect(() =>
      decodeRateLimitPolicyValue({ incidentMultiplier: 1, surfaces: { "auth.register.ip": { windowMs: 500 } } }),
    ).toThrow(/whole number of milliseconds/);
  });

  it("rejects a non-boolean disabled flag", () => {
    expect(() =>
      decodeRateLimitPolicyValue({ incidentMultiplier: 1, surfaces: { "auth.register.ip": { disabled: "yes" } } }),
    ).toThrow(/must be a boolean/);
  });

  it("rejects an empty surface key", () => {
    expect(() => decodeRateLimitPolicyValue({ incidentMultiplier: 1, surfaces: { "  ": { max: 5 } } })).toThrow(
      /non-empty/,
    );
  });

  describe("applyRateLimitPolicy", () => {
    it("falls back to compiled defaults byte-identically when no policy is active", () => {
      expect(
        applyRateLimitPolicy(RATE_LIMIT_POLICY_DEFAULT_VALUE, "checkout.anonymous-rail-capture", defaults),
      ).toEqual({ max: 30, windowMs: 10 * 60 * 1000, disabled: false });
    });

    it("applies a per-surface override, leaving other surfaces untouched", () => {
      const value = {
        incidentMultiplier: 1,
        surfaces: { "checkout.anonymous-rail-capture": { max: 10 } },
      };
      expect(applyRateLimitPolicy(value, "checkout.anonymous-rail-capture", defaults)).toMatchObject({
        max: 10,
        windowMs: 10 * 60 * 1000,
      });
      expect(applyRateLimitPolicy(value, "discovery.product-alert.anonymous-capture", defaults)).toEqual({
        max: 30,
        windowMs: 10 * 60 * 1000,
        disabled: false,
      });
    });

    it("applies the global incident multiplier by dividing the effective max", () => {
      const value = { incidentMultiplier: 2, surfaces: {} };
      expect(
        applyRateLimitPolicy(value, "public-presence.waitlist.submit", { max: 20, windowMs: 60_000 }),
      ).toMatchObject({ max: 10 });
    });

    it("clamps the multiplier-tightened max to a minimum of 1", () => {
      const value = { incidentMultiplier: 10, surfaces: {} };
      expect(applyRateLimitPolicy(value, "test.surface", { max: 5, windowMs: 60_000 })).toMatchObject({ max: 1 });
    });

    it("applies the incident multiplier on top of a surface override's max", () => {
      const value = { incidentMultiplier: 2, surfaces: { "test.surface": { max: 40 } } };
      expect(applyRateLimitPolicy(value, "test.surface", { max: 30, windowMs: 60_000 })).toMatchObject({ max: 20 });
    });

    it("honors a per-surface kill switch independent of other surfaces", () => {
      const value = { incidentMultiplier: 1, surfaces: { "test.surface": { disabled: true } } };
      expect(applyRateLimitPolicy(value, "test.surface", defaults)).toMatchObject({ disabled: true });
      expect(applyRateLimitPolicy(value, "other.surface", defaults)).toMatchObject({ disabled: false });
    });
  });
});
