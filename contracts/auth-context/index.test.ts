import { describe, expect, it } from "vitest";
import {
  createAuthBootstrapContext,
  parseCookieHeader,
  readAuthSessionToken,
  resolveRecentAuthenticationStatus,
} from "./index";

describe("auth request context helpers", () => {
  it("parses cookie headers with empty and encoded values", () => {
    expect([...parseCookieHeader(" chase_sets_session=tok%201 ; flag ; empty= ").entries()]).toEqual([
      ["chase_sets_session", "tok 1"],
      ["flag", ""],
      ["empty", ""],
    ]);
  });

  it("prefers the auth session cookie over bearer authorization", () => {
    const request = new Request("https://chase-sets.local", {
      headers: {
        cookie: "chase_sets_session=cookie-token",
        authorization: "Bearer bearer-token",
      },
    });

    expect(readAuthSessionToken(request)).toBe("cookie-token");
  });

  it("falls back to bearer authorization when the auth session cookie is absent", () => {
    const request = new Request("https://chase-sets.local", {
      headers: {
        authorization: "Bearer bearer-token ",
      },
    });

    expect(readAuthSessionToken(request)).toBe("bearer-token");
  });

  it("creates the identity bootstrap event context", () => {
    expect(
      createAuthBootstrapContext({
        identity: {
          bootstrapTenantId: "tnt_identity",
        },
      }),
    ).toEqual({
      tenantId: "tnt_identity",
      audit: {
        performedByUserId: "usr_identity_system",
        forAccountId: "acc_identity_system",
      },
      trace: {},
    });
  });
});

describe("resolveRecentAuthenticationStatus", () => {
  const now = new Date("2026-07-13T12:00:00.000Z");

  it("fails closed when the actor carries no authentication moment", () => {
    expect(resolveRecentAuthenticationStatus({ authenticatedAt: undefined }, { maxAgeMinutes: 15, now })).toEqual({
      recentlyAuthenticated: false,
      authenticatedAt: null,
    });
    expect(resolveRecentAuthenticationStatus({ authenticatedAt: null }, { maxAgeMinutes: 15, now })).toEqual({
      recentlyAuthenticated: false,
      authenticatedAt: null,
    });
  });

  it("fails closed on an unparsable authentication moment", () => {
    expect(
      resolveRecentAuthenticationStatus({ authenticatedAt: "not-a-timestamp" }, { maxAgeMinutes: 15, now }),
    ).toEqual({ recentlyAuthenticated: false, authenticatedAt: null });
  });

  it("fails closed when the policy window is zero or negative", () => {
    const authenticatedAt = now.toISOString();
    expect(resolveRecentAuthenticationStatus({ authenticatedAt }, { maxAgeMinutes: 0, now })).toMatchObject({
      recentlyAuthenticated: false,
    });
    expect(resolveRecentAuthenticationStatus({ authenticatedAt }, { maxAgeMinutes: -5, now })).toMatchObject({
      recentlyAuthenticated: false,
    });
  });

  it("treats an authentication moment strictly below the window as recent", () => {
    const authenticatedAt = new Date(now.getTime() - 14 * 60_000).toISOString();
    expect(resolveRecentAuthenticationStatus({ authenticatedAt }, { maxAgeMinutes: 15, now })).toEqual({
      recentlyAuthenticated: true,
      authenticatedAt,
    });
  });

  it("treats an authentication moment exactly at the window boundary as recent", () => {
    const authenticatedAt = new Date(now.getTime() - 15 * 60_000).toISOString();
    expect(resolveRecentAuthenticationStatus({ authenticatedAt }, { maxAgeMinutes: 15, now })).toEqual({
      recentlyAuthenticated: true,
      authenticatedAt,
    });
  });

  it("treats an authentication moment just above the window as stale", () => {
    const authenticatedAt = new Date(now.getTime() - 15 * 60_000 - 1).toISOString();
    expect(resolveRecentAuthenticationStatus({ authenticatedAt }, { maxAgeMinutes: 15, now })).toEqual({
      recentlyAuthenticated: false,
      authenticatedAt,
    });
  });

  it("fails closed on a future authentication moment rather than treating clock skew as fresh", () => {
    const authenticatedAt = new Date(now.getTime() + 60_000).toISOString();
    expect(resolveRecentAuthenticationStatus({ authenticatedAt }, { maxAgeMinutes: 15, now })).toEqual({
      recentlyAuthenticated: false,
      authenticatedAt,
    });
  });
});
