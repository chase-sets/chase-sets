import { describe, expect, it } from "vitest";
import {
  AUTH_SECURITY_LIFETIME_BOUNDS_MS,
  DEFAULT_AUTH_SECURITY_LIFETIMES_MS,
  authSecurityLifetimesOf,
  resolveAuthSecurityLifetimesMs,
  type AuthSecurityLifetimesMs,
} from "./auth-flow";

describe("auth security lifetimes (issue #4292)", () => {
  it("resolves to the compiled defaults with no overrides", () => {
    expect(resolveAuthSecurityLifetimesMs()).toEqual(DEFAULT_AUTH_SECURITY_LIFETIMES_MS);
  });

  it("merges a partial override onto the compiled defaults", () => {
    const resolved = resolveAuthSecurityLifetimesMs({ sessionTtlMs: 2 * 60 * 60 * 1000 });

    expect(resolved).toEqual({
      ...DEFAULT_AUTH_SECURITY_LIFETIMES_MS,
      sessionTtlMs: 2 * 60 * 60 * 1000,
    });
  });

  it("has every default value within its own declared bounds", () => {
    for (const key of Object.keys(AUTH_SECURITY_LIFETIME_BOUNDS_MS) as (keyof AuthSecurityLifetimesMs)[]) {
      const bounds = AUTH_SECURITY_LIFETIME_BOUNDS_MS[key];
      const value = DEFAULT_AUTH_SECURITY_LIFETIMES_MS[key];
      expect(value).toBeGreaterThanOrEqual(bounds.minMs);
      expect(value).toBeLessThanOrEqual(bounds.maxMs);
    }
  });

  it("fails closed at boot when an override is below its bound", () => {
    expect(() => resolveAuthSecurityLifetimesMs({ magicLinkTtlMs: 60_000 })).toThrow(
      'Auth security lifetime "magicLinkTtlMs" (60000ms) must be between 300000ms and 3600000ms.',
    );
  });

  it("fails closed at boot when an override is above its bound", () => {
    expect(() => resolveAuthSecurityLifetimesMs({ sessionTtlMs: 60 * 24 * 60 * 60 * 1000 })).toThrow(
      /Auth security lifetime "sessionTtlMs".*must be between/,
    );
  });

  it("fails closed at boot when an override is not a positive number", () => {
    expect(() => resolveAuthSecurityLifetimesMs({ challengeTtlMs: 0 })).toThrow(
      'Auth security lifetime "challengeTtlMs" must be a positive number of milliseconds.',
    );
  });

  it("falls back to compiled defaults for services-shaped doubles missing securityLifetimes", () => {
    expect(authSecurityLifetimesOf({})).toEqual(DEFAULT_AUTH_SECURITY_LIFETIMES_MS);
  });

  it("returns the services-provided securityLifetimes when present", () => {
    const overridden = resolveAuthSecurityLifetimesMs({ guestCheckoutTtlMs: 12 * 60 * 60 * 1000 });

    expect(authSecurityLifetimesOf({ securityLifetimes: overridden })).toEqual(overridden);
  });
});
