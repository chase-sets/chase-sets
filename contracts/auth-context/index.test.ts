import { describe, expect, it } from "vitest";
import {
  AGENT_OAUTH_COMMERCE_SCOPE_FAMILIES,
  AGENT_OAUTH_COMMERCE_SCOPES,
  AGENT_OAUTH_KNOWN_SCOPE_FAMILIES,
  AGENT_OAUTH_OPERATOR_SCOPES,
  createAuthBootstrapContext,
  isAgentOAuthOperatorScope,
  isAgentOAuthScope,
  normalizeAgentOAuthScopes,
  parseCookieHeader,
  readAuthSessionToken,
  resolveRecentAuthenticationStatus,
  agentOAuthScopesForPermissions,
  resolveAgentOAuthScopedPermissions,
} from "./index";

describe("auth request context helpers", () => {
  it("maps capability scopes without widening role permissions or native read-tool visibility", () => {
    expect(agentOAuthScopesForPermissions(["orders.view"])).toEqual([
      "dev.ucp.shopping.checkout:manage",
      "dev.ucp.shopping.order:read",
    ]);
    expect(agentOAuthScopesForPermissions(["orders.manage"])).toEqual(["dev.ucp.shopping.checkout:manage"]);
    expect(resolveAgentOAuthScopedPermissions(["dev.ucp.shopping.checkout:manage"], ["orders.view"])).toEqual([
      "orders.view",
    ]);
  });

  it("recognizes operator scopes without granting a permission or entering the commerce list", () => {
    const everyPermission = [
      ...new Set(
        AGENT_OAUTH_COMMERCE_SCOPE_FAMILIES.flatMap((family) => family.scopes.flatMap((scope) => scope.permissions)),
      ),
      "insights-dashboards.view",
      "projection-operations.rebuild",
      "catalog.manage",
    ];
    expect(AGENT_OAUTH_OPERATOR_SCOPES).toEqual(["operations:read", "operations:write"]);
    for (const scope of AGENT_OAUTH_OPERATOR_SCOPES) {
      expect(isAgentOAuthScope(scope)).toBe(true);
      expect(isAgentOAuthOperatorScope(scope)).toBe(true);
      expect(AGENT_OAUTH_COMMERCE_SCOPES).not.toContain(scope);
      expect(JSON.stringify(AGENT_OAUTH_COMMERCE_SCOPE_FAMILIES)).not.toContain(scope);
      expect(resolveAgentOAuthScopedPermissions([scope], everyPermission)).toEqual([]);
    }
    expect(normalizeAgentOAuthScopes("operations:write catalog:read operations:read")).toEqual([
      "catalog:read",
      "operations:read",
      "operations:write",
    ]);
    expect(resolveAgentOAuthScopedPermissions(["operations:write", "catalog:read"], everyPermission)).toEqual([
      "catalog.view",
    ]);
    expect(agentOAuthScopesForPermissions(everyPermission).filter(isAgentOAuthOperatorScope)).toEqual([]);
    expect(AGENT_OAUTH_COMMERCE_SCOPES.some(isAgentOAuthOperatorScope)).toBe(false);
    expect(AGENT_OAUTH_KNOWN_SCOPE_FAMILIES.map((family) => family.family)).toContain("operations");
  });

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
