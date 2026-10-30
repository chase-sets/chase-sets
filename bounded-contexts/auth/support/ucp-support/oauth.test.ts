import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import type { request } from "node:https";
import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import {
  authUcpOAuthSchemaSql,
  authUcpOAuthConsentSchemaMigrations,
  createUcpOAuthMetadataRoutes,
  createUcpOAuthRoutes,
  CIMD_RESPONSE_MAX_BYTES,
  UCP_OAUTH_SUPPORTED_SCOPES,
  type UcpOAuthRoutesOptions,
  resolveUcpScopedPermissions,
} from "./oauth";
import { authRetentionSweeps } from "../runtime-support/retention-policy";
import type { AgentGrantRevocations, RevocationState } from "@chase-sets/identity/server";

const actor = {
  sessionId: "sess_1",
  tenantId: "tenant_1",
  userId: "user_1",
  accountId: "account_1",
  membershipId: "member_1",
  roleKey: "owner",
  permissions: ["orders.view"],
};

const managementRoutes = [
  { method: "GET", path: "/authorizations" },
  { method: "GET", path: "/authorizations/lpa_managed" },
  { method: "GET", path: "/authorizations/lpa_managed/activity" },
  { method: "GET", path: "/authorizations/lpa_managed/webhook" },
  {
    method: "PUT",
    path: "/authorizations/lpa_managed/webhook",
    body: { callback_url: "https://agent.example/replacement" },
  },
  { method: "GET", path: "/authorizations/lpa_managed/webhook-deliveries" },
  { method: "POST", path: "/authorizations/lpa_managed/revoke" },
  {
    method: "PUT",
    path: "/authorizations/lpa_managed/mandate",
    body: { human_present_required: false, allowed_rails: ["handoff-only"], max_per_order_cents: 5000 },
  },
] as const;

describe("UCP OAuth routes", () => {
  it("buyer scopes use UCP capability tokens", () => {
    const permissions = ["orders.view", "orders.manage", "inventory.view", "inventory.manage"];
    expect(resolveUcpScopedPermissions(["dev.ucp.shopping.checkout:manage"], permissions)).toEqual([
      "orders.view",
      "orders.manage",
    ]);
    expect(resolveUcpScopedPermissions(["dev.ucp.shopping.order:read"], permissions)).toEqual(["orders.view"]);
    expect(resolveUcpScopedPermissions(["inventory:read", "inventory:write"], permissions)).toEqual([
      "inventory.view",
      "inventory.manage",
    ]);
  });

  it("metadata advertises only current UCP capability scopes", async () => {
    const app = new Hono().route("/.well-known", createUcpOAuthMetadataRoutes());
    const response = await app.request("/.well-known/oauth-authorization-server");
    const metadata = await response.json();
    expect(metadata.scopes_supported).toHaveLength(17);
    expect(metadata.scopes_supported.filter((scope: string) => /checkout|order/.test(scope))).toEqual([
      "dev.ucp.shopping.checkout:manage",
      "dev.ucp.shopping.order:read",
    ]);
  });

  it.each([
    // retired scope fixture: stored grants must never receive request defaults or aliases.
    { scopes: ["checkout:write", "order:read"], expected: [] },
    { scopes: ["checkout:write", "inventory:read"], expected: ["inventory:read"] },
    { scopes: [], expected: [] },
  ])("stored normalizeScopes never falls back to UCP_OAUTH_DEFAULT_SCOPES: $scopes", async ({ scopes, expected }) => {
    const options = createOAuthOptions();
    await options.linkedPlatformAuthorizations.grant({
      authorizationId: "lpa_retired",
      platformProfileUrl: "https://agent.example/.well-known/ucp",
      clientId: "ocl_retired",
      userId: actor.userId,
      accountId: actor.accountId,
      scopes,
      accessTokenHash: "hash:retired_access",
      refreshTokenHash: "hash:retired_refresh",
      accessTokenExpiresAt: "2099-01-01T00:00:00.000Z",
      refreshTokenExpiresAt: "2099-01-01T00:00:00.000Z",
      grantedAt: "2026-10-12T00:00:00.000Z",
    });
    const app = new Hono().route("/ucp/oauth", createUcpOAuthRoutes(options));
    const introspection = await app.request("/ucp/oauth/introspect", {
      method: "POST",
      body: new URLSearchParams({ token: "retired_access" }),
    });
    expect((await introspection.json()).scope).toBe(expected.join(" "));
    const grants = await app.request("/ucp/oauth/authorizations");
    expect(await grants.json()).toMatchObject({ authorizations: [expect.objectContaining({ scopes: expected })] });
    const refresh = await app.request("/ucp/oauth/token", {
      method: "POST",
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: "retired_refresh" }),
    });
    expect(refresh.status).toBe(expected.length === 0 ? 400 : 200);
    const body = await refresh.json();
    if (expected.length === 0) {
      expect(body).toMatchObject({ error: "invalid_grant" });
      expect(body.access_token).toBeUndefined();
    } else expect(body.scope).toBe("inventory:read");
  });

  it("omitted request scope defaults to catalog and order read without checkout authority", async () => {
    const app = new Hono().route("/ucp/oauth", createUcpOAuthRoutes(createOAuthOptions()));
    const registration = await registerClient(app, { redirect_uris: ["https://agent.example/callback"] });
    const client = await registration.json();
    expect(client.scope).toBe("catalog:read dev.ucp.shopping.order:read");
    const path = authorizeUrl({
      clientId: client.client_id,
      redirectUri: "https://agent.example/callback",
      scope: "",
      challenge: pkceChallenge("synthetic-verifier"),
    });
    const response = await app.request(path);
    const token = new URL(response.headers.get("location")!, "http://localhost").searchParams.get("consent_token")!;
    const consent = await app.request(`/ucp/oauth/consent?consent_token=${token}`);
    expect(await consent.json()).toMatchObject({
      consent: { scopes: ["catalog:read", "dev.ucp.shopping.order:read"] },
    });
  });

  describe("revocation receipt read", () => {
    const attemptId = "74220000-0000-4000-8000-000000000001";
    const path = `/authorizations/synthetic-grant/revocation/${attemptId}`;
    async function fixture() {
      const options = createOAuthOptions({
        revokeStoredPaymentMethodsForAgentGrant: async () => ({ detached: 0, alreadyRemoved: 0, instrumentIds: [] }),
      });
      await options.linkedPlatformAuthorizations.grant({
        authorizationId: "synthetic-grant",
        accountId: actor.accountId,
        userId: actor.userId,
        clientId: "synthetic-client",
        platformProfileUrl: "https://agent.example",
        scopes: ["dev.ucp.shopping.order:read"],
        accessTokenHash: "synthetic-token-hash",
        accessTokenExpiresAt: "2099-01-01T00:00:00.000Z",
        grantedAt: "2026-10-13T00:00:00.000Z",
      });
      return { options, app: createUcpOAuthRoutes(options) };
    }

    it.each([
      null,
      { ...actor, sessionId: "" },
      { ...actor, roleKey: "guest-buyer" },
      {
        ...actor,
        agentGrant: {
          grantId: "synthetic-grant",
          platformProfileUrl: "https://agent.example/.well-known/ucp",
          scopes: ["account:manage"] as const,
          rolePermissions: actor.permissions,
        },
      },
    ])("requires an interactive session before reading an attempt: %j", async (refusedActor) => {
      const { options, app } = await fixture();
      vi.spyOn(options, "resolveActor").mockResolvedValue(refusedActor);
      const read = vi.spyOn(options.agentGrantRevocations!, "read");
      const response = await app.request(path);
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ state: "reauth-required" });
      expect(read).not.toHaveBeenCalled();
    });

    it("denies a Grant outside the actor's Account before reading an attempt", async () => {
      const { options, app } = await fixture();
      vi.spyOn(options, "resolveActor").mockResolvedValue({ ...actor, accountId: "synthetic-foreign-account" });
      const read = vi.spyOn(options.agentGrantRevocations!, "read");
      const response = await app.request(path);
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ state: "route-denied" });
      expect(read).not.toHaveBeenCalled();
    });

    it("returns only the safe receipt fields for a recorded attempt", async () => {
      const { app } = await fixture();
      const write = await app.request("/authorizations/synthetic-grant/revoke", {
        method: "POST",
        headers: { "Idempotency-Key": attemptId },
      });
      expect(write.status).toBe(200);
      const response = await app.request(path);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        attempt_id: attemptId,
        operation_id: attemptId,
        phase: "completed",
        state: "succeeded",
      });
    });

    it("reports an unknown attempt as ambiguous without a write", async () => {
      const { options, app } = await fixture();
      const admit = vi.spyOn(options.agentGrantRevocations!, "admit");
      const response = await app.request(path);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ attempt_id: attemptId, state: "ambiguous" });
      expect(admit).not.toHaveBeenCalled();
    });

    it("reports a recorded attempt read from another session as conflict", async () => {
      const { options, app } = await fixture();
      expect(
        (
          await app.request("/authorizations/synthetic-grant/revoke", {
            method: "POST",
            headers: { "Idempotency-Key": attemptId },
          })
        ).status,
      ).toBe(200);
      vi.spyOn(options, "resolveActor").mockResolvedValue({ ...actor, sessionId: "synthetic-other-session" });
      const response = await app.request(path);
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({ state: "conflict" });
    });

    it.each(["revocation_conflict", "revocation_binding_invalid"])("maps %s to conflict", async (code) => {
      const { options, app } = await fixture();
      vi.spyOn(options.agentGrantRevocations!, "read").mockRejectedValue(new Error(code));
      const response = await app.request(path);
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({ state: "conflict" });
    });

    it.each([new Error("synthetic pool failure"), new Error("revocation_history_invalid"), "synthetic rejection"])(
      "keeps a non-binding owner failure resumable: %s",
      async (error) => {
        const { options, app } = await fixture();
        vi.spyOn(options.agentGrantRevocations!, "read").mockRejectedValue(error);
        const response = await app.request(path);
        expect(response.status).toBe(503);
        expect(await response.json()).toEqual({ state: "ambiguous" });
      },
    );

    it("reports an unavailable owner as ambiguous", async () => {
      const { options } = await fixture();
      const app = createUcpOAuthRoutes({ ...options, agentGrantRevocations: undefined });
      const response = await app.request(path);
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ state: "ambiguous" });
    });
  });

  it("revocation-floor preserves dormant token and Account revocation without activating receipts", async () => {
    const base = createOAuthOptions();
    const options: ReturnType<typeof createOAuthOptions> = {
      ...base,
      agentGrantRevocations: {
        ...base.agentGrantRevocations!,
        isActivated: async () => false,
        withMode: async (work) => work(false),
      },
    };
    const linked = options.linkedPlatformAuthorizations;
    await linked.grant({
      authorizationId: "dormant-token",
      accountId: actor.accountId,
      userId: actor.userId,
      clientId: "synthetic-client",
      platformProfileUrl: "https://agent.example",
      scopes: ["dev.ucp.shopping.order:read"],
      accessTokenHash: "hash:dormant-token",
      accessTokenExpiresAt: "2099-01-01T00:00:00.000Z",
      grantedAt: "2026-10-12T00:00:00.000Z",
    });
    await linked.grant({
      authorizationId: "dormant-account",
      accountId: actor.accountId,
      userId: actor.userId,
      clientId: "synthetic-client",
      platformProfileUrl: "https://agent.example",
      scopes: ["dev.ucp.shopping.order:read"],
      accessTokenHash: "hash:dormant-account",
      accessTokenExpiresAt: "2099-01-01T00:00:00.000Z",
      grantedAt: "2026-10-12T00:00:00.000Z",
    });
    const app = createUcpOAuthRoutes(options);
    const token = await app.request("/revoke", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: "dormant-token" }),
    });
    expect(token.status).toBe(200);
    const account = await app.request("/authorizations/dormant-account/revoke", { method: "POST" });
    expect(account.status).toBe(200);
    expect(await account.json()).toEqual({ revoked: true });
    expect((await linked.listForAccount(actor.accountId)).every((row) => row.status === "revoked")).toBe(true);
    const detail = await app.request("/authorizations/dormant-account");
    expect(await detail.json()).toMatchObject({ revocation_available: false, revocation_active: false });
  });
  it("agent-grant-revocation-authority refuses foreign Grants in a stale mixed Account list", async () => {
    const options = createOAuthOptions();
    await options.linkedPlatformAuthorizations.grant({
      authorizationId: "foreign_grant",
      accountId: "account_foreign",
      userId: "foreign_user",
      clientId: "foreign_client",
      platformProfileUrl: "https://foreign.example",
      scopes: ["dev.ucp.shopping.order:read"],
      accessTokenHash: "synthetic-foreign-token-hash",
      accessTokenExpiresAt: "2099-01-01T00:00:00.000Z",
      grantedAt: "2026-10-12T00:00:00.000Z",
    });
    const foreign = await options.linkedPlatformAuthorizations.listForAccount("account_foreign");
    vi.spyOn(options.linkedPlatformAuthorizations, "listForAccount").mockResolvedValue(foreign);
    const app = new Hono().route("/ucp/oauth", createUcpOAuthRoutes(options));
    const response = await app.request("/ucp/oauth/authorizations/foreign_grant");
    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain("account_foreign");
  });
  it("agent-grant-revocation-authority converges expired access, refresh and Account revokes", async () => {
    const cleanup = vi.fn(async () => ({ detached: 0, alreadyRemoved: 0, instrumentIds: [] }));
    const options = createOAuthOptions({ revokeStoredPaymentMethodsForAgentGrant: cleanup });
    await options.linkedPlatformAuthorizations.grant({
      authorizationId: "grant_a",
      accountId: actor.accountId,
      userId: actor.userId,
      clientId: "client_a",
      platformProfileUrl: "https://agent.example/profile",
      scopes: ["dev.ucp.shopping.order:read"],
      accessTokenHash: "hash:expired-access",
      refreshTokenHash: "hash:expired-refresh",
      accessTokenExpiresAt: "2020-01-01T00:00:00.000Z",
      grantedAt: "2020-01-01T00:00:00.000Z",
    });
    const app = new Hono().route("/ucp/oauth", createUcpOAuthRoutes(options));
    for (const token of ["expired-access", "expired-refresh"]) {
      expect(
        (
          await app.request("/ucp/oauth/revoke", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ token }),
          })
        ).status,
      ).toBe(200);
    }
    const replay = await app.request("/ucp/oauth/authorizations/grant_a/revoke", { method: "POST" });
    expect(await replay.json()).toMatchObject({ state: "already-revoked-cleanup-complete", phase: "completed" });
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect((await options.linkedPlatformAuthorizations.listForAccount(actor.accountId))[0].status).toBe("revoked");
  });
  it.each(["unknown", "", null, 1])(
    "agent-grant-revocation-authority keeps malformed or unknown present tokens private: %s",
    async (token) => {
      const options = createOAuthOptions();
      const admit = vi.spyOn(options.agentGrantRevocations!, "admit");
      const app = new Hono().route("/ucp/oauth", createUcpOAuthRoutes(options));
      const response = await app.request("/ucp/oauth/revoke", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      });
      expect(response.status).toBe(200);
      expect(await response.text()).toBe("");
      expect(admit).not.toHaveBeenCalled();
    },
  );
  describe.each([
    [
      "agent bearer",
      {
        ...actor,
        agentGrant: {
          grantId: "lpa_sibling",
          platformProfileUrl: "https://agent.example/.well-known/ucp",
          scopes: ["account:manage"] as const,
          rolePermissions: actor.permissions,
        },
      },
    ],
    ["guest checkout", { ...actor, roleKey: "guest-buyer" }],
    ["signed-out", null],
    ["sessionless", { ...actor, sessionId: "" }],
  ])("management routes refuse %s actors", (_kind, refusedActor) => {
    it.each(managementRoutes)("$method $path", async (route) => {
      const fixture = await managementFixture();
      const before = await fixture.snapshot();
      fixture.setActor(refusedActor);
      const response = await fixture.request(route);
      expect(response.status).toBe(401);
      await expect(response.json()).resolves.toEqual({ error: "login_required" });
      for (const port of fixture.dataPorts) expect(port).not.toHaveBeenCalled();
      expect(await fixture.snapshot()).toEqual(before);
    });

    it.each(managementRoutes)("$method $path refuses before optional-service availability", async (route) => {
      const fixture = await managementFixture(false);
      fixture.setActor(refusedActor);
      const response = await fixture.request(route);
      expect(response.status).toBe(401);
      await expect(response.json()).resolves.toEqual({ error: "login_required" });
      for (const port of fixture.dataPorts) expect(port).not.toHaveBeenCalled();
    });
  });

  it.each(managementRoutes)("management routes retain session access: $method $path", async (route) => {
    const fixture = await managementFixture();
    const response = await fixture.request(route);
    expect(response.status).toBe(200);
    expect(fixture.dataPorts.some((port) => port.mock.calls.length > 0)).toBe(true);
  });

  it("authorize GET never issues a code, including a one-click cross-site navigation (F4)", async () => {
    const fixture = await consentFixture();
    const response = await fixture.app.request(fixture.authorizePath, {
      headers: { "Sec-Fetch-Site": "cross-site", "Sec-Fetch-Mode": "navigate" },
    });
    expect(response.status).toBe(302);
    expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const destination = new URL(response.headers.get("location")!, "http://localhost");
    expect(destination.pathname).toBe("/account/agents/consent");
    expect(destination.searchParams.has("code")).toBe(false);
    expect(fixture.db.codes.size).toBe(0);
    expect(fixture.db.consents.size).toBe(1);
    const raw = destination.searchParams.get("consent_token")!;
    const stored = [...fixture.db.consents.values()][0]!;
    expect(stored.token_hash).toBe(fixture.options.auth.auth.hashSecret(raw));
    expect(JSON.stringify(stored)).not.toContain(raw);
    expect(new Date(String(stored.expires_at)).getTime() - Date.now()).toBeGreaterThan(599_000);
  });

  it("consent approve issues exactly one bound code and ignores injected authorization parameters", async () => {
    const fixture = await consentFixture();
    const token = await fixture.start();
    const display = await fixture.app.request(`/ucp/oauth/consent?consent_token=${token}`);
    expect(display.status).toBe(200);
    expect(display.headers.get("Referrer-Policy")).toBe("no-referrer");
    expect(display.headers.get("Cache-Control")).toBe("no-store");
    await expect(display.json()).resolves.toMatchObject({
      consent: {
        clientName: "Synthetic Agent",
        redirectOrigin: "https://agent.example",
        accountId: actor.accountId,
        scopes: ["account:manage", "payouts:request"],
      },
    });
    const response = await fixture.decide(
      token,
      "approve",
      {},
      {
        redirect_uri: "https://attacker.example/callback",
        scope: "catalog:read",
        account_id: "other-account",
        client_id: "other-client",
        state: "injected",
        code_challenge: "injected",
      },
    );
    expect(response.status).toBe(302);
    expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const destination = new URL(response.headers.get("location")!);
    expect(destination.origin).toBe("https://agent.example");
    expect(destination.searchParams.get("state")).toBe("synthetic-state");
    expect(fixture.db.codes.size).toBe(1);
    expect([...fixture.db.codes.values()][0]).toMatchObject({
      client_id: fixture.clientId,
      user_id: actor.userId,
      account_id: actor.accountId,
      redirect_uri: "https://agent.example/callback",
      scopes: ["account:manage", "payouts:request"],
      code_challenge: pkceChallenge("synthetic-verifier"),
      code_challenge_method: "S256",
    });
    const replay = await fixture.decide(token);
    expect(replay.status).toBe(400);
    expect(replay.headers.has("location")).toBe(false);
    expect(fixture.db.codes.size).toBe(1);
  });

  it.each([
    "session",
    "user",
    "account",
    "redirect",
    "scopes",
    "expired",
    "missing",
    "unknown",
    "origin",
    "missing-origin",
    "null-origin",
    "fetch-site",
  ])("consent rejects only the governing %s mismatch without consuming or redirecting", async (governing) => {
    const fixture = await consentFixture();
    let token = await fixture.start();
    const row = [...fixture.db.consents.values()][0]!;
    const client = fixture.db.clients.get(fixture.clientId)!;
    const headers: Record<string, string> = {};
    if (governing === "session") fixture.setActor({ ...actor, sessionId: "other-session" });
    if (governing === "user") fixture.setActor({ ...actor, userId: "other-user" });
    if (governing === "account") fixture.setActor({ ...actor, accountId: "other-account" });
    if (governing === "redirect") client.redirect_uris = ["https://other.example/callback"];
    if (governing === "scopes") client.scopes = ["account:manage"];
    if (governing === "expired") row.expires_at = new Date(Date.now() - 1_000).toISOString();
    if (governing === "missing") token = "";
    if (governing === "unknown") token = "synthetic-unknown";
    if (governing === "origin") headers.Origin = "https://attacker.example";
    if (governing === "missing-origin") headers.Origin = "";
    if (governing === "null-origin") headers.Origin = "null";
    if (governing === "fetch-site") headers["Sec-Fetch-Site"] = "cross-site";
    const response = await fixture.decide(token, "approve", headers);
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.headers.has("location")).toBe(false);
    expect(fixture.db.codes.size).toBe(0);
    expect(row.consumed_at).toBeNull();
  });

  it("concurrent consent approve has one winner", async () => {
    const fixture = await consentFixture();
    const token = await fixture.start();
    const responses = await Promise.all([fixture.decide(token), fixture.decide(token)]);
    expect(responses.map((response) => response.status).sort()).toEqual([302, 400]);
    expect(fixture.db.codes.size).toBe(1);
    expect(responses.find((response) => response.status === 400)!.headers.has("location")).toBe(false);
  });

  it("consent refuses expiry between validation and atomic consumption", async () => {
    const fixture = await consentFixture();
    const token = await fixture.start();
    const row = [...fixture.db.consents.values()][0]!;
    fixture.db.beforeConsume(() => {
      row.expires_at = new Date(Date.now() - 1_000).toISOString();
    });
    const response = await fixture.decide(token);
    expect(response.status).toBe(400);
    expect(response.headers.has("location")).toBe(false);
    expect(fixture.db.codes.size).toBe(0);
    expect(row.consumed_at).toBeNull();
  });

  it("consent deny preserves state, consumes the request, and prevents later approve", async () => {
    const fixture = await consentFixture();
    const token = await fixture.start();
    const response = await fixture.decide(token, "deny");
    expect(response.status).toBe(302);
    const destination = new URL(response.headers.get("location")!);
    expect(destination.searchParams.get("error")).toBe("access_denied");
    expect(destination.searchParams.get("state")).toBe("synthetic-state");
    expect(destination.searchParams.has("code")).toBe(false);
    expect((await fixture.decide(token)).status).toBe(400);
    expect(fixture.db.codes.size).toBe(0);
  });

  it("consent deny never echoes a code embedded in a registered callback query", async () => {
    const fixture = await consentFixture("https://agent.example/callback?code=synthetic-old-code");
    const token = await fixture.start();
    const response = await fixture.decide(token, "deny");
    const destination = new URL(response.headers.get("location")!);
    expect(destination.searchParams.get("error")).toBe("access_denied");
    expect(destination.searchParams.has("code")).toBe(false);
    expect(fixture.db.codes.size).toBe(0);
  });

  it("signed-out authorize returns through sign-in and account switch binds fresh consent", async () => {
    const fixture = await consentFixture();
    fixture.setActor(null);
    const response = await fixture.app.request(fixture.authorizePath);
    const signIn = new URL(response.headers.get("location")!, "http://localhost");
    expect(signIn.pathname).toBe("/sign-in");
    expect(signIn.searchParams.get("returnTo")).toBe(fixture.authorizePath);
    expect(fixture.db.consents.size).toBe(0);
    fixture.setActor(actor);
    const first = await fixture.start();
    fixture.setActor({ ...actor, accountId: "other-account" });
    expect((await fixture.decide(first)).status).toBe(400);
    const second = await fixture.start();
    expect((await fixture.decide(second)).status).toBe(302);
    expect([...fixture.db.codes.values()][0]).toMatchObject({ account_id: "other-account" });
  });

  it.each(["bearer", "guest"])(
    "consent refuses %s actors on GET, read and otherwise valid approve (F7)",
    async (kind) => {
      const fixture = await consentFixture();
      const token = await fixture.start();
      const grant = {
        grantId: "synthetic-grant",
        platformProfileUrl: "https://agent.example/.well-known/ucp",
        scopes: ["catalog:read"] as const,
        rolePermissions: actor.permissions,
      };
      fixture.setActor(kind === "bearer" ? { ...actor, agentGrant: grant } : { ...actor, roleKey: "guest-buyer" });
      const response = await fixture.app.request(fixture.authorizePath, {
        headers: kind === "bearer" ? { Authorization: "Bearer ucp_synthetic" } : { Cookie: "guest_checkout=synthetic" },
      });
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toMatch(/^\/sign-in\?/);
      expect(fixture.db.consents.size).toBe(1);
      expect((await fixture.app.request(`/ucp/oauth/consent?consent_token=${token}`)).status).toBe(401);
      const approve = await fixture.decide(token);
      expect(approve.status).toBe(401);
      expect(approve.headers.has("location")).toBe(false);
      expect(fixture.db.codes.size).toBe(0);
    },
  );

  it("consent schema and indexed expiry sweep cover the stored single-use requests", () => {
    expect(authUcpOAuthSchemaSql).toContain("CREATE TABLE IF NOT EXISTS identity_ucp_oauth_consent_requests");
    expect(authUcpOAuthSchemaSql).toContain("token_hash text PRIMARY KEY");
    expect(authUcpOAuthSchemaSql).toContain("ON identity_ucp_oauth_consent_requests (expires_at)");
    expect(authRetentionSweeps).toContainEqual(
      expect.objectContaining({ tableName: "identity_ucp_oauth_consent_requests", batchLimit: 500 }),
    );
    expect(authUcpOAuthConsentSchemaMigrations).toHaveLength(1);
    expect(
      authUcpOAuthConsentSchemaMigrations[0]!.statements.every((statement) =>
        authUcpOAuthSchemaSql.includes(statement),
      ),
    ).toBe(true);
  });

  it("advertises Authorization Code with PKCE, refresh, introspection, and revocation support", async () => {
    const app = new Hono().route("/.well-known", createUcpOAuthMetadataRoutes());

    const response = await app.request("https://marketplace.example/.well-known/oauth-authorization-server");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      authorization_endpoint: "https://marketplace.example/ucp/oauth/authorize",
      token_endpoint: "https://marketplace.example/ucp/oauth/token",
      introspection_endpoint: "https://marketplace.example/ucp/oauth/introspect",
      revocation_endpoint: "https://marketplace.example/ucp/oauth/revoke",
      registration_endpoint: "https://marketplace.example/ucp/oauth/register",
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      scopes_supported: expect.arrayContaining(["catalog:read", "listings:write", "payouts:request", "account:read"]),
      scope_families_supported: expect.arrayContaining([
        expect.objectContaining({
          family: "listings",
          label: "Listings",
          scopes: expect.arrayContaining([
            expect.objectContaining({
              scope: "listings:write",
              label: "Manage your listings",
            }),
          ]),
        }),
        expect.objectContaining({
          family: "payouts",
          scopes: expect.arrayContaining([
            expect.objectContaining({
              scope: "payouts:request",
              label: "Request payouts",
            }),
          ]),
        }),
      ]),
    });
  });

  it("rejects confidential or over-scoped dynamic client registrations", async () => {
    const app = new Hono().route("/ucp/oauth", createUcpOAuthRoutes(createOAuthOptions()));

    const confidential = await app.request("/ucp/oauth/register", {
      method: "POST",
      body: JSON.stringify({
        redirect_uris: ["https://agent.example/callback"],
        client_uri: "https://agent.example/.well-known/ucp",
        token_endpoint_auth_method: "client_secret_basic",
      }),
      headers: { "Content-Type": "application/json" },
    });
    const overScoped = await app.request("/ucp/oauth/register", {
      method: "POST",
      body: JSON.stringify({
        redirect_uris: ["https://agent.example/callback"],
        client_uri: "https://agent.example/.well-known/ucp",
        scope: "catalog:read admin:write",
      }),
      headers: { "Content-Type": "application/json" },
    });
    const untrustedRedirect = await app.request("/ucp/oauth/register", {
      method: "POST",
      body: JSON.stringify({
        redirect_uris: ["http://agent.example/callback"],
        client_uri: "https://agent.example/.well-known/ucp",
      }),
      headers: { "Content-Type": "application/json" },
    });

    expect(confidential.status).toBe(400);
    expect(overScoped.status).toBe(400);
    expect(untrustedRedirect.status).toBe(400);
  });

  it("registers a client without client_uri from its redirect origin", async () => {
    const app = new Hono().route("/ucp/oauth", createUcpOAuthRoutes(createOAuthOptions()));

    // Synthetic replay of the Codex CLI 0.162.1 registration body shape captured by #9232: a public native client
    // with one loopback redirect and neither client_uri nor platform_profile_url. Port and callback id are synthetic.
    const codex = await registerClient(app, {
      client_name: "Codex",
      redirect_uris: ["http://127.0.0.1:49152/callback/synthetic-callback-id"],
      grant_types: ["authorization_code", "refresh_token"],
      token_endpoint_auth_method: "none",
      response_types: ["code"],
      scope: UCP_OAUTH_SUPPORTED_SCOPES.join(" "),
      application_type: "native",
    });
    const twoRedirects = await registerClient(app, {
      redirect_uris: ["http://localhost:49153/callback", "http://127.0.0.1:49154/callback"],
    });
    const codexBody = (await codex.json()) as Record<string, unknown>;

    expect(codex.status).toBe(201);
    expect(codexBody).toMatchObject({
      platform_profile_url: "http://127.0.0.1:49152",
      scope: [...UCP_OAUTH_SUPPORTED_SCOPES].sort().join(" "),
      token_endpoint_auth_method: "none",
    });
    expect(codexBody).not.toHaveProperty("client_uri");
    expect(twoRedirects.status).toBe(201);
    await expect(twoRedirects.json()).resolves.toMatchObject({ platform_profile_url: "http://127.0.0.1:49154" });
  });

  it("keeps explicit profile URLs and untrusted redirects on their existing registration rules", async () => {
    const app = new Hono().route("/ucp/oauth", createUcpOAuthRoutes(createOAuthOptions()));
    const redirect_uris = ["http://127.0.0.1:49155/callback"];

    const explicitProfile = await registerClient(app, {
      redirect_uris,
      platform_profile_url: "https://agent.example/.well-known/ucp",
      client_uri: "https://agent.example",
    });
    const explicitClientUri = await registerClient(app, {
      redirect_uris,
      client_uri: "https://agent.example/.well-known/ucp",
    });
    const untrustedProfile = await registerClient(app, {
      redirect_uris,
      platform_profile_url: "http://agent.example/.well-known/ucp",
    });
    const untrustedClientUri = await registerClient(app, {
      redirect_uris,
      client_uri: "http://agent.example/.well-known/ucp",
    });
    const blankProfile = await registerClient(app, { redirect_uris, platform_profile_url: " " });
    const nullClientUri = await registerClient(app, { redirect_uris, client_uri: null });
    const untrustedRedirect = await registerClient(app, { redirect_uris: ["http://agent.example/callback"] });

    expect(explicitProfile.status).toBe(201);
    await expect(explicitProfile.json()).resolves.toMatchObject({
      client_uri: "https://agent.example",
      platform_profile_url: "https://agent.example/.well-known/ucp",
    });
    expect(explicitClientUri.status).toBe(201);
    await expect(explicitClientUri.json()).resolves.toMatchObject({
      client_uri: "https://agent.example/.well-known/ucp",
      platform_profile_url: "https://agent.example/.well-known/ucp",
    });
    for (const [response, error_description] of [
      [untrustedProfile, "A trusted platform_profile_url or client_uri is required."],
      [untrustedClientUri, "A trusted platform_profile_url or client_uri is required."],
      [blankProfile, "A trusted platform_profile_url or client_uri is required."],
      [nullClientUri, "A trusted platform_profile_url or client_uri is required."],
      [untrustedRedirect, "redirect_uris must be HTTPS URLs or localhost HTTP URLs."],
    ] as const) {
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({ error: "invalid_client_metadata", error_description });
    }
  });

  it("registers a webhook callback and returns a signing secret exactly once", async () => {
    const options = createOAuthOptions();
    const app = new Hono().route("/ucp/oauth", createUcpOAuthRoutes(options));

    const registration = await app.request("/ucp/oauth/register", {
      method: "POST",
      body: JSON.stringify({
        client_name: "Agent Platform",
        client_uri: "https://agent.example/.well-known/ucp",
        redirect_uris: ["https://agent.example/callback"],
        scope: "dev.ucp.shopping.order:read",
        webhook_callback_url: "https://agent.example/hooks",
      }),
      headers: { "Content-Type": "application/json" },
    });

    expect(registration.status).toBe(201);
    const body = (await registration.json()) as {
      webhook?: { callback_url: string; signing_secret: string; signing_secret_preview: string };
    };
    expect(body.webhook?.callback_url).toBe("https://agent.example/hooks");
    expect(body.webhook?.signing_secret).toMatch(/^whsec_/);
    expect(body.webhook?.signing_secret_preview).toContain("…");
    expect(body.webhook?.signing_secret_preview).not.toBe(body.webhook?.signing_secret);
  });

  it("rejects an untrusted webhook callback URL", async () => {
    const options = createOAuthOptions();
    const app = new Hono().route("/ucp/oauth", createUcpOAuthRoutes(options));

    const registration = await app.request("/ucp/oauth/register", {
      method: "POST",
      body: JSON.stringify({
        redirect_uris: ["https://agent.example/callback"],
        client_uri: "https://agent.example/.well-known/ucp",
        webhook_callback_url: "http://agent.example/hooks",
      }),
      headers: { "Content-Type": "application/json" },
    });

    expect(registration.status).toBe(400);
  });

  it("omits the webhook block when no callback is registered", async () => {
    const options = createOAuthOptions();
    const app = new Hono().route("/ucp/oauth", createUcpOAuthRoutes(options));

    const registration = await app.request("/ucp/oauth/register", {
      method: "POST",
      body: JSON.stringify({
        redirect_uris: ["https://agent.example/callback"],
        client_uri: "https://agent.example/.well-known/ucp",
        scope: "dev.ucp.shopping.order:read",
      }),
      headers: { "Content-Type": "application/json" },
    });

    const body = (await registration.json()) as { webhook?: unknown };
    expect(body.webhook).toBeUndefined();
  });

  it("lets the owning account replace or disable a webhook and only returns a replacement secret once", async () => {
    const options = createOAuthOptions();
    const app = new Hono().route("/ucp/oauth", createUcpOAuthRoutes(options));
    const registration = await app.request("/ucp/oauth/register", {
      method: "POST",
      body: JSON.stringify({
        client_name: "Agent Platform",
        client_uri: "https://agent.example/.well-known/ucp",
        redirect_uris: ["https://agent.example/callback"],
        scope: "dev.ucp.shopping.order:read",
        webhook_callback_url: "https://agent.example/hooks",
      }),
      headers: { "Content-Type": "application/json" },
    });
    const clientId = ((await registration.json()) as { client_id: string }).client_id;
    await options.linkedPlatformAuthorizations.grant({
      authorizationId: "lpa_webhook",
      platformProfileUrl: "https://agent.example/.well-known/ucp",
      clientId,
      userId: actor.userId,
      accountId: actor.accountId,
      scopes: ["dev.ucp.shopping.order:read"],
      accessTokenHash: "hash:access",
      accessTokenExpiresAt: "2026-07-13T00:00:00.000Z",
      grantedAt: "2026-07-12T00:00:00.000Z",
    });

    const read = await app.request("/ucp/oauth/authorizations/lpa_webhook/webhook");
    expect(read.status).toBe(200);
    await expect(read.json()).resolves.toMatchObject({
      webhook: {
        callback_url: "https://agent.example/hooks",
        signing_secret_preview: expect.stringContaining("…"),
      },
    });

    const replace = await app.request("/ucp/oauth/authorizations/lpa_webhook/webhook", {
      method: "PUT",
      body: JSON.stringify({ callback_url: "https://agent.example/new-hooks" }),
      headers: { "Content-Type": "application/json" },
    });
    expect(replace.status).toBe(200);
    const replacementBody = (await replace.json()) as { webhook: { signing_secret: string } };
    expect(replacementBody.webhook.signing_secret).toMatch(/^whsec_/);

    const disable = await app.request("/ucp/oauth/authorizations/lpa_webhook/webhook", {
      method: "PUT",
      body: JSON.stringify({ callback_url: null }),
      headers: { "Content-Type": "application/json" },
    });
    await expect(disable.json()).resolves.toEqual({ webhook: null });

    const afterDisable = await app.request("/ucp/oauth/authorizations/lpa_webhook/webhook");
    await expect(afterDisable.json()).resolves.toEqual({ webhook: null });
  });

  it("exposes only account-owned webhook delivery summaries, including dead letters", async () => {
    const options = createOAuthOptions({
      agentWebhookOutbox: {
        listForClient: async () => [
          {
            deliveryId: "d1",
            clientId: "ocl_1",
            accountId: actor.accountId,
            callbackUrl: "https://agent.example/hooks",
            sourceEventId: "evt_1",
            eventType: "ordering.order.created",
            orderId: "ord_1",
            orderStatus: "created",
            status: "failed",
            attemptCount: 8,
            maxAttempts: 8,
            nextAttemptAt: "2026-07-12T00:00:00.000Z",
            lastError: "callback responded 500",
            lastResponseStatus: 500,
            createdAt: "2026-07-12T00:00:00.000Z",
            updatedAt: "2026-07-12T00:01:00.000Z",
            deliveredAt: null,
          },
          {
            deliveryId: "other-account",
            clientId: "ocl_1",
            accountId: "account_other",
            callbackUrl: "https://agent.example/hooks",
            sourceEventId: "evt_2",
            eventType: "ordering.order.created",
            orderId: "ord_2",
            orderStatus: "created",
            status: "failed",
            attemptCount: 8,
            maxAttempts: 8,
            nextAttemptAt: "2026-07-12T00:00:00.000Z",
            lastError: "callback responded 500",
            lastResponseStatus: 500,
            createdAt: "2026-07-12T00:00:00.000Z",
            updatedAt: "2026-07-12T00:01:00.000Z",
            deliveredAt: null,
          },
        ],
      } as never,
    });
    const app = new Hono().route("/ucp/oauth", createUcpOAuthRoutes(options));
    await options.linkedPlatformAuthorizations.grant({
      authorizationId: "lpa_delivery",
      platformProfileUrl: "https://agent.example/.well-known/ucp",
      clientId: "ocl_1",
      userId: actor.userId,
      accountId: actor.accountId,
      scopes: ["dev.ucp.shopping.order:read"],
      accessTokenHash: "hash:access",
      accessTokenExpiresAt: "2026-07-13T00:00:00.000Z",
      grantedAt: "2026-07-12T00:00:00.000Z",
    });

    const response = await app.request("/ucp/oauth/authorizations/lpa_delivery/webhook-deliveries?status=dead-letter");
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ deliveries: [{ deliveryId: "d1", status: "failed" }] });
  });

  it("registers public OAuth clients without secrets and enforces registered redirect URIs and scopes", async () => {
    const options = createOAuthOptions();
    const app = new Hono().route("/ucp/oauth", createUcpOAuthRoutes(options));
    const registration = await app.request("/ucp/oauth/register", {
      method: "POST",
      body: JSON.stringify({
        client_name: "Agent Platform",
        client_uri: "https://agent.example/.well-known/ucp",
        redirect_uris: ["https://agent.example/callback"],
        scope: "dev.ucp.shopping.checkout:manage dev.ucp.shopping.order:read",
      }),
      headers: { "Content-Type": "application/json" },
    });
    const registrationBody = (await registration.json()) as {
      client_id: string;
      client_secret?: string;
      redirect_uris: readonly string[];
      scope: string;
    };

    expect(registration.status).toBe(201);
    expect(registrationBody.client_id).toMatch(/^ocl_/);
    expect(registrationBody.client_secret).toBeUndefined();
    expect(registrationBody.redirect_uris).toEqual(["https://agent.example/callback"]);
    expect(registrationBody.scope).toBe("dev.ucp.shopping.checkout:manage dev.ucp.shopping.order:read");

    const verifier = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~";
    const challenge = pkceChallenge(verifier);

    const wrongRedirects = await Promise.all(
      [
        "https://evil.example/callback",
        "https://agent.example/callbackX",
        "https://agent.example/other",
        "https://agent.example/callback?x=1",
      ].map((redirectUri) =>
        app.request(
          authorizeUrl({
            clientId: registrationBody.client_id,
            redirectUri,
            scope: "dev.ucp.shopping.checkout:manage dev.ucp.shopping.order:read",
            challenge,
          }),
        ),
      ),
    );
    const wrongScope = await app.request(
      authorizeUrl({
        clientId: registrationBody.client_id,
        redirectUri: "https://agent.example/callback",
        scope: "dev.ucp.shopping.checkout:manage catalog:read",
        challenge,
      }),
    );
    const authorize = await authorizeWithConsent(
      app,
      authorizeUrl({
        clientId: registrationBody.client_id,
        redirectUri: "https://agent.example/callback",
        scope: "dev.ucp.shopping.checkout:manage dev.ucp.shopping.order:read",
        challenge,
        state: "state_1",
      }),
    );
    const redirect = new URL(authorize.headers.get("location") ?? "");
    const code = redirect.searchParams.get("code") ?? "";

    for (const wrongRedirect of wrongRedirects) {
      expect(wrongRedirect.status).toBe(400);
      await expect(wrongRedirect.json()).resolves.toMatchObject({ error: "invalid_request" });
    }
    expect(wrongScope.status).toBe(400);
    await expect(wrongScope.json()).resolves.toMatchObject({ error: "invalid_scope" });
    expect(authorize.status).toBe(302);
    expect(redirect.searchParams.get("state")).toBe("state_1");

    const token = await app.request("/ucp/oauth/token", {
      method: "POST",
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: "https://agent.example/callback",
        code_verifier: verifier,
      }),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    });
    const tokenBody = (await token.json()) as {
      access_token: string;
      refresh_token: string;
      scope: string;
    };

    expect(token.status).toBe(200);
    expect(tokenBody.scope).toBe("dev.ucp.shopping.checkout:manage dev.ucp.shopping.order:read");

    const replay = await app.request("/ucp/oauth/token", {
      method: "POST",
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: "https://agent.example/callback",
        code_verifier: verifier,
      }),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    });
    expect(replay.status).toBe(400);
    await expect(replay.json()).resolves.toMatchObject({ error: "invalid_grant" });

    const introspection = await app.request("/ucp/oauth/introspect", {
      method: "POST",
      body: new URLSearchParams({ token: tokenBody.access_token }),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    });
    await expect(introspection.json()).resolves.toMatchObject({
      active: true,
      client_id: registrationBody.client_id,
      account_id: "account_1",
      scope: "dev.ucp.shopping.checkout:manage dev.ucp.shopping.order:read",
    });

    const refresh = await app.request("/ucp/oauth/token", {
      method: "POST",
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: tokenBody.refresh_token,
      }),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    });
    const refreshBody = (await refresh.json()) as { refresh_token: string };
    expect(refresh.status).toBe(200);
    expect(refreshBody.refresh_token).not.toBe(tokenBody.refresh_token);

    const oldRefresh = await app.request("/ucp/oauth/token", {
      method: "POST",
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: tokenBody.refresh_token,
      }),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    });
    expect(oldRefresh.status).toBe(400);
  });

  it("rejects a token exchange with the wrong PKCE code_verifier without burning the code", async () => {
    const options = createOAuthOptions();
    const app = new Hono().route("/ucp/oauth", createUcpOAuthRoutes(options));
    const registration = await app.request("/ucp/oauth/register", {
      method: "POST",
      body: JSON.stringify({
        client_name: "Agent Platform",
        client_uri: "https://agent.example/.well-known/ucp",
        redirect_uris: ["https://agent.example/callback"],
        scope: "dev.ucp.shopping.order:read",
      }),
      headers: { "Content-Type": "application/json" },
    });
    const registrationBody = (await registration.json()) as { client_id: string };
    const verifier = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~";
    const wrongVerifier = "zyxwvutsrqponmlkjihgfedcbaZYXWVUTSRQPONMLKJIHGFEDCBA9876543210-._~";
    const challenge = pkceChallenge(verifier);

    const authorize = await authorizeWithConsent(
      app,
      authorizeUrl({
        clientId: registrationBody.client_id,
        redirectUri: "https://agent.example/callback",
        scope: "dev.ucp.shopping.order:read",
        challenge,
      }),
    );
    const redirect = new URL(authorize.headers.get("location") ?? "");
    const code = redirect.searchParams.get("code") ?? "";

    const wrongVerifierExchange = await app.request("/ucp/oauth/token", {
      method: "POST",
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: "https://agent.example/callback",
        code_verifier: wrongVerifier,
      }),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    });

    expect(wrongVerifierExchange.status).toBe(400);
    await expect(wrongVerifierExchange.json()).resolves.toMatchObject({ error: "invalid_grant" });

    const correctVerifierExchange = await app.request("/ucp/oauth/token", {
      method: "POST",
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: "https://agent.example/callback",
        code_verifier: verifier,
      }),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    });

    expect(correctVerifierExchange.status).toBe(200);
    const tokenBody = (await correctVerifierExchange.json()) as { access_token: string };
    expect(tokenBody.access_token).toMatch(/^ucp_at_/);
  });

  it("rejects an unknown opaque client before creating consent or authorization code state", async () => {
    const db = createAuthorizationCodeDb();
    const base = createOAuthOptions();
    const options = createOAuthOptions({ auth: { ...base.auth, db } });
    const app = new Hono().route("/ucp/oauth", createUcpOAuthRoutes(options));

    const response = await app.request(
      authorizeUrl({
        clientId: "ocl_never_registered",
        redirectUri: "https://agent.example/callback",
        scope: "catalog:read",
        challenge: pkceChallenge("synthetic-verifier"),
      }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "invalid_client" });
    expect(response.headers.get("location")).toBeNull();
    expect(db.consents.size).toBe(0);
    expect(db.codes.size).toBe(0);
  });

  it("rejects a Client ID Metadata Document that cannot be fetched before creating consent or authorization code state", async () => {
    const db = createAuthorizationCodeDb();
    const base = createOAuthOptions();
    const options = createOAuthOptions({
      auth: { ...base.auth, db },
      fetchClientIdMetadata: async () => null,
    });
    const app = new Hono().route("/ucp/oauth", createUcpOAuthRoutes(options));

    const response = await app.request(
      authorizeUrl({
        clientId: "https://agent.example/missing-client.json",
        redirectUri: "https://agent.example/callback",
        scope: "catalog:read",
        challenge: pkceChallenge("synthetic-verifier"),
      }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "invalid_client" });
    expect(response.headers.get("location")).toBeNull();
    expect(db.consents.size).toBe(0);
    expect(db.codes.size).toBe(0);
  });

  it("supports HTTPS Client ID Metadata Documents for public agent clients", async () => {
    const options = createOAuthOptions({
      fetchClientIdMetadata: async (url) => {
        expect(url).toBe("https://agent.example/oauth-client.json");
        return {
          client_id: "https://agent.example/oauth-client.json",
          client_name: "Agent Metadata Client",
          client_uri: "https://agent.example/.well-known/ucp",
          redirect_uris: ["https://agent.example/callback"],
          scope: "catalog:read dev.ucp.shopping.order:read",
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
          token_endpoint_auth_method: "none",
        };
      },
    });
    const app = new Hono().route("/ucp/oauth", createUcpOAuthRoutes(options));
    const verifier = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~";
    const challenge = pkceChallenge(verifier);

    const authorize = await authorizeWithConsent(
      app,
      authorizeUrl({
        clientId: "https://agent.example/oauth-client.json",
        redirectUri: "https://agent.example/callback",
        scope: "catalog:read dev.ucp.shopping.order:read",
        challenge,
      }),
    );
    const redirect = new URL(authorize.headers.get("location") ?? "");
    const code = redirect.searchParams.get("code") ?? "";

    expect(authorize.status).toBe(302);

    const token = await app.request("/ucp/oauth/token", {
      method: "POST",
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: "https://agent.example/callback",
        code_verifier: verifier,
      }),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    });
    const tokenBody = (await token.json()) as { access_token: string; scope: string };
    expect(token.status).toBe(200);
    expect(tokenBody.scope).toBe("catalog:read dev.ucp.shopping.order:read");

    const introspection = await app.request("/ucp/oauth/introspect", {
      method: "POST",
      body: new URLSearchParams({ token: tokenBody.access_token }),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    });
    await expect(introspection.json()).resolves.toMatchObject({
      active: true,
      client_id: "https://agent.example/oauth-client.json",
      platform_profile_url: "https://agent.example/.well-known/ucp",
    });
  });

  it("CIMD without a profile URL stays refused", async () => {
    const fetchClientIdMetadata = vi.fn(async (url: string) => ({
      client_id: url,
      client_name: "Synthetic Metadata Client",
      redirect_uris: ["https://agent.example/callback"],
      scope: "catalog:read",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }));
    const app = new Hono().route("/ucp/oauth", createUcpOAuthRoutes(createOAuthOptions({ fetchClientIdMetadata })));

    const authorize = await app.request(
      authorizeUrl({
        clientId: "https://agent.example/oauth-client.json",
        redirectUri: "https://agent.example/callback",
        scope: "catalog:read",
        challenge: pkceChallenge("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~"),
      }),
    );

    expect(fetchClientIdMetadata).toHaveBeenCalledWith("https://agent.example/oauth-client.json");
    expect(authorize.status).toBe(400);
    await expect(authorize.json()).resolves.toMatchObject({ error: "invalid_client" });
  });

  it.each([
    ["https://127.0.0.1/oauth-client.json", undefined],
    ["https://[::1]/oauth-client.json", undefined],
    ["http://localhost/oauth-client.json", undefined],
    ["https://localhost/oauth-client.json", undefined],
    ["https://agent.localhost/oauth-client.json", undefined],
    ["https://private.example/oauth-client.json", [{ address: "10.0.0.8", family: 4 }]],
    ["https://link-local.example/oauth-client.json", [{ address: "169.254.10.8", family: 4 }]],
    ["https://multicast.example/oauth-client.json", [{ address: "224.0.0.8", family: 4 }]],
    ["https://unspecified.example/oauth-client.json", [{ address: "0.0.0.0", family: 4 }]],
    ["https://unique-local-v6.example/oauth-client.json", [{ address: "fc00::1", family: 6 }]],
    ["https://link-local-v6.example/oauth-client.json", [{ address: "fe80::1", family: 6 }]],
    ["https://multicast-v6.example/oauth-client.json", [{ address: "ff02::1", family: 6 }]],
    ["https://unspecified-v6.example/oauth-client.json", [{ address: "::", family: 6 }]],
    ["https://mapped-private-v6.example/oauth-client.json", [{ address: "::ffff:10.0.0.1", family: 6 }]],
    ["https://nat64-private-v6.example/oauth-client.json", [{ address: "64:ff9b::a00:1", family: 6 }]],
    [
      "https://mixed-answers.example/oauth-client.json",
      [
        { address: "8.8.8.8", family: 4 },
        { address: "10.0.0.1", family: 4 },
      ],
    ],
  ] as const)("refuses a non-public CIMD destination before connecting: %s", async (clientId, answers) => {
    const lookupClientIdMetadata = vi.fn(async () => answers ?? []);
    const requestClientIdMetadata = vi.fn<NonNullable<UcpOAuthRoutesOptions["requestClientIdMetadata"]>>(() => {
      throw new Error("the refused destination must not connect");
    });
    const options = createOAuthOptions({ lookupClientIdMetadata, requestClientIdMetadata });
    const db = options.auth.db as unknown as { consents: Map<string, unknown>; codes: Map<string, unknown> };
    const app = new Hono().route("/ucp/oauth", createUcpOAuthRoutes(options));

    const response = await app.request(
      authorizeUrl({
        clientId,
        redirectUri: "https://agent.example/callback",
        scope: "catalog:read",
        challenge: pkceChallenge("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~"),
      }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "invalid_client" });
    expect(requestClientIdMetadata).not.toHaveBeenCalled();
    expect(db.consents.size).toBe(0);
    expect(db.codes.size).toBe(0);
    if (answers) expect(lookupClientIdMetadata).toHaveBeenCalledTimes(1);
    else expect(lookupClientIdMetadata).not.toHaveBeenCalled();
  });

  it("pins the first public DNS answer and does not follow a rebinding answer", async () => {
    const lookupClientIdMetadata = vi
      .fn<NonNullable<UcpOAuthRoutesOptions["lookupClientIdMetadata"]>>()
      .mockResolvedValueOnce([{ address: "8.8.8.8", family: 4 }])
      .mockResolvedValueOnce([{ address: "10.0.0.8", family: 4 }]);
    const contacted: string[] = [];
    const requestClientIdMetadata = vi.fn<NonNullable<UcpOAuthRoutesOptions["requestClientIdMetadata"]>>(
      (url, requestOptions, callback) => {
        expect(String(url)).toBe("https://agent.example/oauth-client.json");
        expect(requestOptions.servername).toBe("agent.example");
        expect(requestOptions.headers).toMatchObject({ Host: "agent.example" });
        const client = new EventEmitter() as ReturnType<typeof request>;
        client.destroy = vi.fn(() => client);
        client.end = vi.fn(() => {
          requestOptions.lookup?.("agent.example", { all: false }, (_error, address) => {
            contacted.push(String(address));
          });
          const response = Readable.from([
            Buffer.from(
              JSON.stringify({
                client_id: "https://agent.example/oauth-client.json",
                client_name: "Pinned Metadata Client",
                client_uri: "https://agent.example/.well-known/ucp",
                redirect_uris: ["https://agent.example/callback"],
                scope: "catalog:read",
                grant_types: ["authorization_code", "refresh_token"],
                response_types: ["code"],
                token_endpoint_auth_method: "none",
              }),
            ),
          ]);
          callback?.(Object.assign(response, { statusCode: 200, headers: {} }) as never);
          return client;
        });
        return client;
      },
    );
    const options = createOAuthOptions({ lookupClientIdMetadata, requestClientIdMetadata });
    const db = options.auth.db as unknown as { consents: Map<string, unknown> };
    const app = new Hono().route("/ucp/oauth", createUcpOAuthRoutes(options));

    const response = await app.request(
      authorizeUrl({
        clientId: "https://agent.example/oauth-client.json",
        redirectUri: "https://agent.example/callback",
        scope: "catalog:read",
        challenge: pkceChallenge("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~"),
      }),
    );

    expect(response.status).toBe(302);
    expect(lookupClientIdMetadata).toHaveBeenCalledTimes(1);
    expect(requestClientIdMetadata).toHaveBeenCalledTimes(1);
    expect(contacted).toEqual(["8.8.8.8"]);
    expect(db.consents.size).toBe(1);
  });

  it("refuses production redirects without contacting the redirect target", async () => {
    let requests = 0;
    const requestClientIdMetadata = vi.fn<NonNullable<UcpOAuthRoutesOptions["requestClientIdMetadata"]>>(
      (_url, _requestOptions, callback) => {
        requests += 1;
        const client = new EventEmitter() as ReturnType<typeof request>;
        client.destroy = vi.fn(() => client);
        client.end = vi.fn(() => {
          const response = Readable.from([]);
          callback?.(
            Object.assign(response, { statusCode: 302, headers: { location: "https://other.example" } }) as never,
          );
          return client;
        });
        return client;
      },
    );
    const options = createOAuthOptions({
      lookupClientIdMetadata: async () => [{ address: "8.8.8.8", family: 4 }],
      requestClientIdMetadata,
    });
    const db = options.auth.db as unknown as { consents: Map<string, unknown>; codes: Map<string, unknown> };
    const app = new Hono().route("/ucp/oauth", createUcpOAuthRoutes(options));
    const response = await app.request(
      authorizeUrl({
        clientId: "https://agent.example/oauth-client.json",
        redirectUri: "https://agent.example/callback",
        scope: "catalog:read",
        challenge: pkceChallenge("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~"),
      }),
    );
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "invalid_client" });
    expect(requests).toBe(1);
    expect(db.consents.size).toBe(0);
    expect(db.codes.size).toBe(0);
  });

  it("collapses injected transport errors and malformed bodies without exposing the error", async () => {
    const secret = "synthetic-secret-marker";
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const fetchClientIdMetadata = vi
        .fn<(url: string) => Promise<unknown>>()
        .mockRejectedValueOnce(new Error(secret))
        .mockResolvedValueOnce("{");
      const options = createOAuthOptions({ fetchClientIdMetadata });
      const db = options.auth.db as unknown as { consents: Map<string, unknown>; codes: Map<string, unknown> };
      const app = new Hono().route("/ucp/oauth", createUcpOAuthRoutes(options));
      for (let index = 0; index < 2; index += 1) {
        const response = await app.request(
          authorizeUrl({
            clientId: "https://agent.example/oauth-client.json",
            redirectUri: "https://agent.example/callback",
            scope: "catalog:read",
            challenge: pkceChallenge("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~"),
          }),
        );
        expect(response.status).toBe(400);
        await expect(response.json()).resolves.toMatchObject({ error: "invalid_client" });
      }
      expect(JSON.stringify(error.mock.calls)).not.toContain(secret);
      expect(db.consents.size).toBe(0);
      expect(db.codes.size).toBe(0);
    } finally {
      error.mockRestore();
    }
  });

  it("enforces the response cap on injected CIMD fixtures without retaining a body", async () => {
    const fetchClientIdMetadata = vi.fn(async (url: string) => ({
      client_id: url,
      client_name: "Synthetic Metadata Client",
      client_uri: "https://agent.example/.well-known/ucp",
      redirect_uris: ["https://agent.example/callback"],
      scope: "catalog:read",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      harmless: "x".repeat(CIMD_RESPONSE_MAX_BYTES),
    }));
    const options = createOAuthOptions({ fetchClientIdMetadata });
    const db = options.auth.db as unknown as { consents: Map<string, unknown>; codes: Map<string, unknown> };
    const app = new Hono().route("/ucp/oauth", createUcpOAuthRoutes(options));

    const response = await app.request(
      authorizeUrl({
        clientId: "https://agent.example/oauth-client.json",
        redirectUri: "https://agent.example/callback",
        scope: "catalog:read",
        challenge: pkceChallenge("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~"),
      }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "invalid_client" });
    expect(db.consents.size).toBe(0);
    expect(db.codes.size).toBe(0);
  });

  it("derives and accepts the 27,303-byte largest-valid CIMD, then refuses cap+1", async () => {
    const { clientId, redirectUris, body } = largestValidClientIdMetadata();
    expect(Buffer.byteLength(JSON.stringify(body), "utf8")).toBe(27_303);
    const capPlusOnePadding = 32_769 - Buffer.byteLength(JSON.stringify({ ...body, padding: "" }), "utf8");
    const capPlusOne = { ...body, padding: " ".repeat(capPlusOnePadding) };
    expect(Buffer.byteLength(JSON.stringify(capPlusOne), "utf8")).toBe(CIMD_RESPONSE_MAX_BYTES + 1);

    const run = async (metadata: unknown) => {
      const options = createOAuthOptions({ fetchClientIdMetadata: async () => metadata });
      const db = options.auth.db as unknown as { consents: Map<string, unknown>; codes: Map<string, unknown> };
      const app = new Hono().route("/ucp/oauth", createUcpOAuthRoutes(options));
      const response = await app.request(
        authorizeUrl({
          clientId,
          redirectUri: redirectUris[0]!,
          scope: "catalog:read",
          challenge: pkceChallenge("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~"),
        }),
      );
      return { response, db };
    };

    const accepted = await run(body);
    expect(accepted.response.status).toBe(302);
    expect(accepted.db.consents.size).toBe(1);
    const refused = await run(capPlusOne);
    expect(refused.response.status).toBe(400);
    await expect(refused.response.json()).resolves.toMatchObject({ error: "invalid_client" });
    expect(refused.db.consents.size).toBe(0);
    expect(refused.db.codes.size).toBe(0);
  });

  it("enforces the response cap on the production CIMD byte stream", async () => {
    const { clientId, redirectUris, body } = largestValidClientIdMetadata();
    const document = Buffer.from(JSON.stringify(body), "utf8");
    const paddedTo = (total: number) => Buffer.concat([document, Buffer.alloc(total - document.byteLength, " ")]);
    function* inChunks(bytes: Buffer) {
      for (let offset = 0; offset < bytes.byteLength; offset += 1024) yield bytes.subarray(offset, offset + 1024);
    }
    const run = async (chunks: () => Iterable<Buffer>) => {
      const requestClientIdMetadata = vi.fn<NonNullable<UcpOAuthRoutesOptions["requestClientIdMetadata"]>>(
        (_url, _requestOptions, callback) => {
          const client = new EventEmitter() as ReturnType<typeof request>;
          client.destroy = vi.fn(() => client);
          client.end = vi.fn(() => {
            const response = Readable.from(chunks(), { highWaterMark: 1 });
            callback?.(Object.assign(response, { statusCode: 200, headers: {} }) as never);
            return client;
          });
          return client;
        },
      );
      const options = createOAuthOptions({
        lookupClientIdMetadata: async () => [{ address: "8.8.8.8", family: 4 }],
        requestClientIdMetadata,
      });
      const db = options.auth.db as unknown as { consents: Map<string, unknown>; codes: Map<string, unknown> };
      const app = new Hono().route("/ucp/oauth", createUcpOAuthRoutes(options));
      const response = await app.request(
        authorizeUrl({
          clientId,
          redirectUri: redirectUris[0]!,
          scope: "catalog:read",
          challenge: pkceChallenge("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~"),
        }),
      );
      return { response, db };
    };

    const accepted = await run(() => inChunks(paddedTo(CIMD_RESPONSE_MAX_BYTES)));
    expect(accepted.response.status).toBe(302);
    expect(accepted.db.consents.size).toBe(1);

    const refused = await run(() => inChunks(paddedTo(CIMD_RESPONSE_MAX_BYTES + 1)));
    expect(refused.response.status).toBe(400);
    await expect(refused.response.json()).resolves.toMatchObject({ error: "invalid_client" });
    expect(refused.db.consents.size).toBe(0);
    expect(refused.db.codes.size).toBe(0);

    // The stream stops at 64 times the cap only so a missing cap fails here instead of exhausting the worker.
    let pulled = 0;
    const endless = await run(function* () {
      while (pulled < CIMD_RESPONSE_MAX_BYTES * 64) {
        pulled += 1024;
        yield Buffer.alloc(1024, " ");
      }
    });
    expect(endless.response.status).toBe(400);
    await expect(endless.response.json()).resolves.toMatchObject({ error: "invalid_client" });
    expect(endless.db.consents.size).toBe(0);
    expect(endless.db.codes.size).toBe(0);
    expect(pulled).toBeLessThanOrEqual(CIMD_RESPONSE_MAX_BYTES + 2 * 1024);
  });

  it.each(["delayed headers", "never-ending body"] as const)(
    "aborts the production CIMD transport at the same deadline for %s",
    async (mode) => {
      vi.useFakeTimers();
      try {
        let stream: Readable | undefined;
        const requestClientIdMetadata = vi.fn<NonNullable<UcpOAuthRoutesOptions["requestClientIdMetadata"]>>(
          (_url, _requestOptions, callback) => {
            const client = new EventEmitter() as ReturnType<typeof request>;
            client.destroy = vi.fn(() => {
              stream?.destroy();
              return client;
            });
            client.end = vi.fn(() => {
              if (mode === "never-ending body") {
                let sent = false;
                stream = new Readable({
                  read() {
                    if (!sent) {
                      sent = true;
                      this.push(Buffer.from("{"));
                    }
                  },
                });
                callback?.(Object.assign(stream, { statusCode: 200, headers: {} }) as never);
              }
              return client;
            });
            return client;
          },
        );
        const options = createOAuthOptions({
          lookupClientIdMetadata: async () => [{ address: "8.8.8.8", family: 4 }],
          requestClientIdMetadata,
        });
        const app = new Hono().route("/ucp/oauth", createUcpOAuthRoutes(options));
        const pending = app.request(
          authorizeUrl({
            clientId: "https://agent.example/oauth-client.json",
            redirectUri: "https://agent.example/callback",
            scope: "catalog:read",
            challenge: pkceChallenge("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~"),
          }),
        );
        let settled = false;
        void Promise.resolve(pending).then(() => {
          settled = true;
        });
        await vi.advanceTimersByTimeAsync(4_999);
        expect(settled).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        const response = await pending;
        expect(response.status).toBe(400);
        await expect(response.json()).resolves.toMatchObject({ error: "invalid_client" });
        expect(requestClientIdMetadata.mock.results[0]?.value.destroy).toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it("lists and revokes linked platform authorizations for the current account", async () => {
    const revokeStoredPaymentMethodsForAgentGrant = vi.fn(async () => ({
      detached: 0,
      alreadyRemoved: 0,
      instrumentIds: ["sci_1"],
    }));
    const options = createOAuthOptions({ revokeStoredPaymentMethodsForAgentGrant });
    const app = new Hono().route("/ucp/oauth", createUcpOAuthRoutes(options));
    await options.linkedPlatformAuthorizations.grant({
      authorizationId: "lpa_1",
      platformProfileUrl: "https://agent.example/.well-known/ucp",
      clientId: "agent-client",
      userId: "user_1",
      accountId: "account_1",
      scopes: ["catalog:read"],
      accessTokenHash: "hash:access",
      refreshTokenHash: "hash:refresh",
      accessTokenExpiresAt: "2026-05-16T20:00:00.000Z",
      refreshTokenExpiresAt: "2026-06-16T20:00:00.000Z",
      grantedAt: "2026-05-16T19:00:00.000Z",
    });

    const list = await app.request("/ucp/oauth/authorizations");
    await expect(list.json()).resolves.toMatchObject({
      authorizations: [
        {
          id: "lpa_1",
          platform_profile_url: "https://agent.example/.well-known/ucp",
          status: "active",
        },
      ],
    });

    const revoke = await app.request("/ucp/oauth/authorizations/lpa_1/revoke", { method: "POST" });
    await expect(revoke.json()).resolves.toMatchObject({ revoked: true, state: "succeeded", phase: "completed" });
    expect(revokeStoredPaymentMethodsForAgentGrant).toHaveBeenCalledWith(
      {
        accountId: "account_1",
        agentGrantId: "lpa_1",
        revokedAt: expect.any(String),
        operationId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      },
      {
        tenantId: actor.tenantId,
        audit: {
          performedByUserId: actor.userId,
          forAccountId: "account_1",
        },
      },
    );

    const replay = await app.request("/ucp/oauth/authorizations/lpa_1/revoke", { method: "POST" });
    await expect(replay.json()).resolves.toMatchObject({
      revoked: true,
      state: "already-revoked-cleanup-complete",
      phase: "completed",
    });
    expect(revokeStoredPaymentMethodsForAgentGrant).toHaveBeenCalledTimes(1);

    const after = await app.request("/ucp/oauth/authorizations");
    await expect(after.json()).resolves.toMatchObject({
      authorizations: [{ id: "lpa_1", status: "revoked" }],
    });
  });

  it("surfaces and configures the per-grant spending mandate for the connected agent", async () => {
    const agentGrantConsent = createInMemoryConsentDirectory();
    const options = createOAuthOptions({ agentGrantConsent });
    const app = new Hono().route("/ucp/oauth", createUcpOAuthRoutes(options));
    await options.linkedPlatformAuthorizations.grant({
      authorizationId: "lpa_1",
      platformProfileUrl: "https://agent.example/.well-known/ucp",
      clientId: "agent-client",
      userId: "user_1",
      accountId: "account_1",
      scopes: ["catalog:read"],
      accessTokenHash: "hash:access",
      refreshTokenHash: "hash:refresh",
      accessTokenExpiresAt: "2026-05-16T20:00:00.000Z",
      refreshTokenExpiresAt: "2026-06-16T20:00:00.000Z",
      grantedAt: "2026-05-16T19:00:00.000Z",
    });

    // Defaults to the conservative handoff-only mandate before any opt-in.
    const before = await app.request("/ucp/oauth/authorizations");
    await expect(before.json()).resolves.toMatchObject({
      authorizations: [
        {
          id: "lpa_1",
          spending_mandate: { human_present_required: true, allowed_rails: ["handoff-only"] },
          spend: { daily_cents: 0, monthly_cents: 0 },
        },
      ],
    });

    const configured = await app.request("/ucp/oauth/authorizations/lpa_1/mandate", {
      method: "PUT",
      body: JSON.stringify({
        max_per_order_cents: 4_000,
        daily_cap_cents: 5_000,
        monthly_cap_cents: 20_000,
        human_present_required: false,
        allowed_rails: ["stored-pm"],
      }),
      headers: { "Content-Type": "application/json" },
    });
    expect(configured.status).toBe(200);
    await expect(configured.json()).resolves.toEqual({
      spending_mandate: {
        max_per_order_cents: 4_000,
        daily_cap_cents: 5_000,
        monthly_cap_cents: 20_000,
        human_present_required: false,
        allowed_rails: ["stored-pm"],
      },
    });

    // Rejects an invalid rail and the retired ap2 rail, alone or beside a supported one.
    for (const allowedRails of [["wire-transfer"], ["ap2"], ["stored-pm", "ap2"]]) {
      const rejected = await app.request("/ucp/oauth/authorizations/lpa_1/mandate", {
        method: "PUT",
        body: JSON.stringify({ allowed_rails: allowedRails }),
        headers: { "Content-Type": "application/json" },
      });
      expect(rejected.status, allowedRails.join(",")).toBe(400);
    }

    // Rejects configuring a grant that does not belong to the account.
    const foreign = await app.request("/ucp/oauth/authorizations/lpa_unknown/mandate", {
      method: "PUT",
      body: JSON.stringify({ allowed_rails: ["stored-pm"] }),
      headers: { "Content-Type": "application/json" },
    });
    expect(foreign.status).toBe(404);
  });

  it("joins registered client display info onto the list and single-grant detail read", async () => {
    const options = createOAuthOptions();
    const app = new Hono().route("/ucp/oauth", createUcpOAuthRoutes(options));

    const registration = await app.request("/ucp/oauth/register", {
      method: "POST",
      body: JSON.stringify({
        client_name: "Agent Platform",
        client_uri: "https://agent.example/.well-known/ucp",
        redirect_uris: ["https://agent.example/callback"],
        scope: "catalog:read",
      }),
      headers: { "Content-Type": "application/json" },
    });
    const { client_id: clientId } = (await registration.json()) as { client_id: string };

    await options.linkedPlatformAuthorizations.grant({
      authorizationId: "lpa_1",
      platformProfileUrl: "https://agent.example/.well-known/ucp",
      clientId,
      userId: "user_1",
      accountId: "account_1",
      scopes: ["catalog:read"],
      accessTokenHash: "hash:access",
      accessTokenExpiresAt: "2026-05-16T20:00:00.000Z",
      grantedAt: "2026-05-16T19:00:00.000Z",
    });

    const list = await app.request("/ucp/oauth/authorizations");
    await expect(list.json()).resolves.toMatchObject({
      authorizations: [{ id: "lpa_1", client_id: clientId, client_name: "Agent Platform" }],
    });

    const detail = await app.request("/ucp/oauth/authorizations/lpa_1");
    expect(detail.status).toBe(200);
    await expect(detail.json()).resolves.toMatchObject({
      authorization: {
        id: "lpa_1",
        client_name: "Agent Platform",
        client_uri: "https://agent.example/.well-known/ucp",
      },
    });

    const missing = await app.request("/ucp/oauth/authorizations/lpa_unknown");
    expect(missing.status).toBe(404);
  });

  it("serves per-grant activity from the audit-log read model, scoped to the account", async () => {
    const listForGrant = vi.fn(async () => ({
      items: [
        {
          id: "mal_1",
          occurredAt: "2026-07-10T10:05:00.000Z",
          outcome: "denied" as const,
          method: "tools/call",
          toolName: "request_payout",
          resourceUri: null,
          auditEventName: "payout.requested",
          targetType: "payout",
          reason: "Missing scope payouts:request.",
          limitKind: null,
        },
      ],
      total: 1,
    }));
    const options = createOAuthOptions({ agentGrantActivity: { listForGrant } });
    const app = new Hono().route("/ucp/oauth", createUcpOAuthRoutes(options));
    await options.linkedPlatformAuthorizations.grant({
      authorizationId: "lpa_1",
      platformProfileUrl: "https://agent.example/.well-known/ucp",
      clientId: "agent-client",
      userId: "user_1",
      accountId: "account_1",
      scopes: ["catalog:read"],
      accessTokenHash: "hash:access",
      accessTokenExpiresAt: "2026-05-16T20:00:00.000Z",
      grantedAt: "2026-05-16T19:00:00.000Z",
    });

    const activity = await app.request("/ucp/oauth/authorizations/lpa_1/activity?limit=10&offset=0");
    expect(activity.status).toBe(200);
    await expect(activity.json()).resolves.toEqual({
      activity: [
        {
          id: "mal_1",
          occurred_at: "2026-07-10T10:05:00.000Z",
          outcome: "denied",
          method: "tools/call",
          tool_name: "request_payout",
          resource_uri: null,
          audit_event_name: "payout.requested",
          target_type: "payout",
          reason: "Missing scope payouts:request.",
          limit_kind: null,
        },
      ],
      total: 1,
    });
    expect(listForGrant).toHaveBeenCalledWith({ accountId: "account_1", grantId: "lpa_1", limit: 10, offset: 0 });

    const foreignGrant = await app.request("/ucp/oauth/authorizations/lpa_unknown/activity");
    expect(foreignGrant.status).toBe(404);

    const unconfigured = new Hono().route("/ucp/oauth", createUcpOAuthRoutes(createOAuthOptions()));
    const notConfigured = await unconfigured.request("/ucp/oauth/authorizations/lpa_1/activity");
    expect(notConfigured.status).toBe(404);
  });
});

describe("operator scopes refused until the sign-in gate", () => {
  const redirectUri = "https://agent.example/callback";
  const challenge = pkceChallenge("synthetic-verifier");
  const operatorFixture = (
    requestActor: typeof actor,
    operatorAuthority?: (requestActor: typeof actor) => Promise<unknown>,
  ) => {
    const resolveActor = vi.fn(async () => requestActor);
    const options = createOAuthOptions({ resolveActor });
    if (operatorAuthority) {
      (options.auth as unknown as { identity: unknown }).identity = { operatorAuthority };
    }
    const db = options.auth.db as unknown as ReturnType<typeof createAuthorizationCodeDb>;
    return { resolveActor, db, app: new Hono().route("/ucp/oauth", createUcpOAuthRoutes(options)) };
  };

  it.each([
    { label: "owner", requestActor: actor },
    { label: "platform-admin", requestActor: { ...actor, roleKey: "platform-admin" } },
  ])("refuses authorize naming operations:* with invalid_scope before consent for $label", async ({ requestActor }) => {
    const { app, db, resolveActor } = operatorFixture(requestActor);
    const registration = await registerClient(app, {
      redirect_uris: [redirectUri],
      scope: "catalog:read operations:read operations:write",
    });
    expect(registration.status).toBe(201);
    const client = (await registration.json()) as { client_id: string; scope: string };
    expect(client.scope).toBe("catalog:read operations:read operations:write");

    for (const scope of ["operations:read", "catalog:read operations:read", "operations:write"]) {
      const response = await app.request(authorizeUrl({ clientId: client.client_id, redirectUri, scope, challenge }));
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({ error: "invalid_scope" });
      expect(response.headers.get("location")).toBeNull();
    }
    expect(resolveActor).not.toHaveBeenCalled();
    expect(db.consents.size).toBe(0);
    expect(db.codes.size).toBe(0);

    const commerce = await app.request(
      authorizeUrl({ clientId: client.client_id, redirectUri, scope: "catalog:read", challenge }),
    );
    expect(commerce.status).toBe(302);
    expect(commerce.headers.get("location")).toContain("/account/agents/consent?consent_token=");
  });

  it("accepts operator scopes in a Client ID Metadata Document and still refuses to authorize them", async () => {
    const clientId = "https://agent.example/operator-client.json";
    const options = createOAuthOptions({
      fetchClientIdMetadata: async () => ({
        client_id: clientId,
        client_uri: "https://agent.example/.well-known/ucp",
        redirect_uris: [redirectUri],
        scope: "catalog:read operations:write",
        token_endpoint_auth_method: "none",
      }),
    });
    const app = new Hono().route("/ucp/oauth", createUcpOAuthRoutes(options));

    const commerce = await app.request(authorizeUrl({ clientId, redirectUri, scope: "catalog:read", challenge }));
    expect(commerce.status).toBe(302);
    const operator = await app.request(authorizeUrl({ clientId, redirectUri, scope: "operations:write", challenge }));
    expect(operator.status).toBe(400);
    await expect(operator.json()).resolves.toMatchObject({ error: "invalid_scope" });
  });

  it("never reads or approves a consent request that names an operator scope", async () => {
    const { app, db } = operatorFixture(actor);
    const registration = await registerClient(app, {
      redirect_uris: [redirectUri],
      scope: "account:manage operations:write",
    });
    const { client_id: clientId } = (await registration.json()) as { client_id: string };
    const started = await app.request(authorizeUrl({ clientId, redirectUri, scope: "account:manage", challenge }));
    const token = new URL(started.headers.get("location")!, "http://localhost").searchParams.get("consent_token")!;
    // GET refuses operator scopes, so this row is unreachable; it pins the consent-time refusal on its own.
    const [row] = [...db.consents.values()];
    row!.scopes = ["account:manage", "operations:write"];

    const read = await app.request(`/ucp/oauth/consent?consent_token=${token}`);
    expect(read.status).toBe(400);
    const approve = await app.request("/ucp/oauth/authorize", {
      method: "POST",
      body: new URLSearchParams({ consent_token: token, decision: "approve" }),
      headers: { Origin: "http://localhost", "Sec-Fetch-Site": "same-origin" },
    });
    expect(approve.status).toBe(400);
    expect(approve.headers.get("location")).toBeNull();
    expect(db.codes.size).toBe(0);
  });

  it("never advertises operator scopes in authorization-server metadata while registration accepts them", async () => {
    const metadataApp = new Hono().route("/.well-known", createUcpOAuthMetadataRoutes());
    const metadata = (await (await metadataApp.request("/.well-known/oauth-authorization-server")).json()) as {
      scopes_supported: string[];
      scope_families_supported: Array<{ family: string }>;
    };
    expect(JSON.stringify(metadata)).not.toContain("operations");
    expect(metadata.scopes_supported).toEqual([...UCP_OAUTH_SUPPORTED_SCOPES]);
    expect(UCP_OAUTH_SUPPORTED_SCOPES).toHaveLength(17);

    const { app } = operatorFixture(actor);
    const registration = await registerClient(app, { redirect_uris: [redirectUri], scope: "operations:read" });
    expect(registration.status).toBe(201);
  });

  it("admits a recently authenticated platform-admin through consent and issues an operator code", async () => {
    const freshActor = { ...actor, roleKey: "platform-admin", authenticatedAt: new Date().toISOString() };
    const options = createOAuthOptions({ resolveActor: async () => freshActor });
    (options.auth as unknown as { identity: unknown }).identity = {
      operatorAuthority: async () => ({
        kind: "granted" as const,
        membershipId: "member_1",
        roleKey: "platform-admin" as const,
        rolePermissions: [],
      }),
    };
    const app = new Hono().route("/ucp/oauth", createUcpOAuthRoutes(options));
    const registration = await registerClient(app, {
      redirect_uris: [redirectUri],
      scope: "operations:write",
    });
    const { client_id: clientId } = (await registration.json()) as { client_id: string };
    const started = await app.request(authorizeUrl({ clientId, redirectUri, scope: "operations:write", challenge }));
    expect(started.status).toBe(302);
    const consentToken = new URL(started.headers.get("location")!, "http://localhost").searchParams.get(
      "consent_token",
    )!;
    const consent = await app.request(`/ucp/oauth/consent?consent_token=${consentToken}`);
    expect(consent.status).toBe(200);
    await expect(consent.json()).resolves.toMatchObject({
      consent: { scopes: ["operations:write"], operatorGrantExpiresAt: expect.any(String) },
    });

    const approved = await app.request("/ucp/oauth/authorize", {
      method: "POST",
      body: new URLSearchParams({ consent_token: consentToken, decision: "approve" }),
      headers: { Origin: "http://localhost", "Sec-Fetch-Site": "same-origin" },
    });
    expect(approved.status).toBe(302);
    const code = new URL(approved.headers.get("location")!, "http://localhost").searchParams.get("code");
    expect(code).toBeTruthy();

    const token = await app.request("/ucp/oauth/token", {
      method: "POST",
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: code!,
        redirect_uri: redirectUri,
        code_verifier: "synthetic-verifier",
      }),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    });
    expect(token.status).toBe(200);
    await expect(token.json()).resolves.toMatchObject({
      token_type: "Bearer",
      scope: "operations:write",
      access_token: expect.stringMatching(/^ucp_at_/),
      refresh_token: expect.stringMatching(/^ucp_rt_/),
    });
  });

  it("rechecks a configured authority denial at authorize, consent read, and consent POST", async () => {
    const freshActor = { ...actor, roleKey: "platform-admin", authenticatedAt: new Date().toISOString() };
    let state: "granted" | "denied" = "denied";
    const authority = vi.fn(async () =>
      state === "granted"
        ? {
            kind: "granted" as const,
            membershipId: "member_1",
            roleKey: "platform-admin" as const,
            rolePermissions: [],
          }
        : { kind: "denied" as const, reason: "inactive" as const },
    );
    const options = createOAuthOptions({ resolveActor: async () => freshActor });
    (options.auth as unknown as { identity: unknown }).identity = { operatorAuthority: authority };
    const app = new Hono().route("/ucp/oauth", createUcpOAuthRoutes(options));
    const registration = await registerClient(app, { redirect_uris: [redirectUri], scope: "operations:write" });
    const { client_id: clientId } = (await registration.json()) as { client_id: string };

    const refusedAtAuthorize = await app.request(
      authorizeUrl({ clientId, redirectUri, scope: "operations:write", challenge }),
    );
    expect(refusedAtAuthorize.status).toBe(400);
    await expect(refusedAtAuthorize.json()).resolves.toMatchObject({ error: "invalid_scope" });

    state = "granted";
    const started = await app.request(authorizeUrl({ clientId, redirectUri, scope: "operations:write", challenge }));
    expect(started.status).toBe(302);
    const consentToken = new URL(started.headers.get("location")!, "http://localhost").searchParams.get(
      "consent_token",
    )!;

    state = "denied";
    const read = await app.request(`/ucp/oauth/consent?consent_token=${consentToken}`);
    expect(read.status).toBe(400);
    await expect(read.json()).resolves.toMatchObject({ error: "invalid_scope" });
    const approved = await app.request("/ucp/oauth/authorize", {
      method: "POST",
      body: new URLSearchParams({ consent_token: consentToken, decision: "approve" }),
      headers: { Origin: "http://localhost", "Sec-Fetch-Site": "same-origin" },
    });
    expect(approved.status).toBe(400);
    await expect(approved.json()).resolves.toMatchObject({ error: "invalid_scope" });
    expect(authority.mock.calls.length).toBeGreaterThanOrEqual(4);
  });

  it("fails closed when a configured operator authority throws", async () => {
    const freshActor = { ...actor, roleKey: "platform-admin", authenticatedAt: new Date().toISOString() };
    const authority = vi.fn(async () => {
      throw new Error("synthetic authority failure");
    });
    const { app, db } = operatorFixture(freshActor, authority);
    const registration = await registerClient(app, { redirect_uris: [redirectUri], scope: "operations:write" });
    const { client_id: clientId } = (await registration.json()) as { client_id: string };
    const response = await app.request(authorizeUrl({ clientId, redirectUri, scope: "operations:write", challenge }));
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "invalid_scope" });
    expect(db.consents.size).toBe(0);
    expect(authority).toHaveBeenCalledOnce();
  });

  it("requires recent interactive authentication for configured operator authority", async () => {
    const staleActor = {
      ...actor,
      roleKey: "platform-admin",
      authenticatedAt: new Date(Date.now() - 11 * 60 * 1_000).toISOString(),
    };
    const authority = vi.fn(async () => ({
      kind: "granted" as const,
      membershipId: "member_1",
      roleKey: "platform-admin" as const,
      rolePermissions: [],
    }));
    const { app, db } = operatorFixture(staleActor, authority);
    const registration = await registerClient(app, { redirect_uris: [redirectUri], scope: "operations:write" });
    const { client_id: clientId } = (await registration.json()) as { client_id: string };
    const response = await app.request(authorizeUrl({ clientId, redirectUri, scope: "operations:write", challenge }));
    expect(response.status).toBe(302);
    expect(new URL(response.headers.get("location")!, "http://localhost").pathname).toBe("/sign-in");
    expect(db.consents.size).toBe(0);
    expect(authority).toHaveBeenCalledOnce();
  });

  it("caps mixed-scope refresh lifetime and rejects rotation and bearer use at the seven-day boundary", async () => {
    vi.useFakeTimers();
    try {
      const baseline = new Date("2026-01-01T00:00:00.000Z");
      vi.setSystemTime(baseline);
      const freshActor = { ...actor, roleKey: "platform-admin", authenticatedAt: baseline.toISOString() };
      const authority = async () => ({
        kind: "granted" as const,
        membershipId: "member_1",
        roleKey: "platform-admin" as const,
        rolePermissions: [],
      });
      const linkedPlatformAuthorizations = createLinkedStore({ enforceExpiry: true });
      const options = createOAuthOptions({
        linkedPlatformAuthorizations: linkedPlatformAuthorizations as unknown as Parameters<
          typeof createUcpOAuthRoutes
        >[0]["linkedPlatformAuthorizations"],
        resolveActor: async () => freshActor,
      });
      (options.auth as unknown as { identity: unknown }).identity = { operatorAuthority: authority };
      const app = new Hono().route("/ucp/oauth", createUcpOAuthRoutes(options));
      const registration = await registerClient(app, {
        redirect_uris: [redirectUri],
        scope: "catalog:read operations:write",
      });
      const { client_id: clientId } = (await registration.json()) as { client_id: string };
      const started = await app.request(
        authorizeUrl({
          clientId,
          redirectUri,
          scope: "catalog:read operations:write",
          challenge,
        }),
      );
      const consentToken = new URL(started.headers.get("location")!, "http://localhost").searchParams.get(
        "consent_token",
      )!;
      const approved = await app.request("/ucp/oauth/authorize", {
        method: "POST",
        body: new URLSearchParams({ consent_token: consentToken, decision: "approve" }),
        headers: { Origin: "http://localhost", "Sec-Fetch-Site": "same-origin" },
      });
      const code = new URL(approved.headers.get("location")!, "http://localhost").searchParams.get("code")!;
      const tokenResponse = await app.request("/ucp/oauth/token", {
        method: "POST",
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          redirect_uri: redirectUri,
          code_verifier: "synthetic-verifier",
        }),
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
      });
      const tokenBody = (await tokenResponse.json()) as { access_token: string; refresh_token: string };
      expect(tokenResponse.status).toBe(200);
      const [initial] = await linkedPlatformAuthorizations.listForAccount(actor.accountId);
      expect(initial).toMatchObject({
        scopes: ["catalog:read", "operations:write"],
        access_token_expires_at: "2026-01-01T01:00:00.000Z",
        refresh_token_expires_at: "2026-01-08T00:00:00.000Z",
        absolute_expires_at: "2026-01-08T00:00:00.000Z",
      });

      vi.setSystemTime(new Date("2026-01-07T00:00:00.000Z"));
      const rotatedResponse = await app.request("/ucp/oauth/token", {
        method: "POST",
        body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: tokenBody.refresh_token }),
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
      });
      const rotatedBody = (await rotatedResponse.json()) as { access_token: string; refresh_token: string };
      expect(rotatedResponse.status).toBe(200);
      expect(rotatedBody.refresh_token).not.toBe(tokenBody.refresh_token);
      const [rotated] = await linkedPlatformAuthorizations.listForAccount(actor.accountId);
      expect(rotated).toMatchObject({
        access_token_expires_at: "2026-01-07T01:00:00.000Z",
        refresh_token_expires_at: "2026-01-08T00:00:00.000Z",
      });

      vi.setSystemTime(new Date("2026-01-08T00:00:00.001Z"));
      const expiredRefresh = await app.request("/ucp/oauth/token", {
        method: "POST",
        body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: rotatedBody.refresh_token }),
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
      });
      expect(expiredRefresh.status).toBe(400);
      await expect(expiredRefresh.json()).resolves.toMatchObject({ error: "invalid_grant" });
      const introspection = await app.request("/ucp/oauth/introspect", {
        method: "POST",
        body: new URLSearchParams({ token: rotatedBody.access_token }),
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
      });
      await expect(introspection.json()).resolves.toEqual({ active: false });
    } finally {
      vi.useRealTimers();
    }
  });
});

async function managementFixture(configured = true) {
  const db = createAuthorizationCodeDb();
  const consent = createInMemoryConsentDirectory();
  const activity = { listForGrant: vi.fn(async () => ({ items: [], total: 0 })) };
  const outbox = {
    excludeRevokedGrant: vi.fn(async () => true),
    enqueueDelivery: vi.fn(async () => {}),
    claimPendingDeliveries: vi.fn(async () => []),
    renewClaim: vi.fn(async () => true),
    markDelivered: vi.fn(async () => {}),
    markFailed: vi.fn(async () => {}),
    listForClient: vi.fn(async () => []),
    listDeadLettered: vi.fn(async () => []),
  } satisfies NonNullable<Parameters<typeof createUcpOAuthRoutes>[0]["agentWebhookOutbox"]>;
  const revokePayments = vi.fn(async () => ({ detached: 0, alreadyRemoved: 0, instrumentIds: [] }));
  const base = createOAuthOptions();
  let currentActor: Awaited<ReturnType<typeof base.resolveActor>> = actor;
  const options = createOAuthOptions({
    auth: { ...base.auth, db },
    resolveActor: async () => currentActor,
    revokeStoredPaymentMethodsForAgentGrant: revokePayments,
    ...(configured
      ? {
          agentGrantConsent: consent,
          agentGrantActivity: activity,
          agentWebhookOutbox: outbox,
        }
      : {}),
  });
  const linked = options.linkedPlatformAuthorizations;
  const app = new Hono().route("/ucp/oauth", createUcpOAuthRoutes(options));
  const registration = await registerClient(app, {
    redirect_uris: ["https://agent.example/callback"],
    scope: "account:manage",
    webhook_callback_url: "https://agent.example/hooks",
  });
  const { client_id: clientId } = (await registration.json()) as { client_id: string };
  const grants = await Promise.all(
    ["lpa_managed", "lpa_sibling"].map((authorizationId) =>
      linked.grant({
        authorizationId,
        platformProfileUrl: "https://agent.example/.well-known/ucp",
        clientId,
        userId: actor.userId,
        accountId: actor.accountId,
        scopes: ["account:manage"],
        accessTokenHash: `hash:${authorizationId}`,
        accessTokenExpiresAt: "2099-01-02T00:00:00.000Z",
        grantedAt: "2026-10-12T00:00:00.000Z",
      }),
    ),
  );
  const resolveMandate = consent.resolveMandate.bind(consent);
  const dataPorts = [
    vi.spyOn(db, "query"),
    ...(["listForAccount", "grant", "resolveToken", "resolveRevocationToken", "rotateRefreshToken"] as const).map(
      (name) => vi.spyOn(linked, name),
    ),
    vi.spyOn(consent, "resolveMandate"),
    vi.spyOn(consent, "setMandate"),
    vi.spyOn(consent, "getSpendSummary"),
    activity.listForGrant,
    ...Object.values(outbox),
    revokePayments,
  ];
  return {
    dataPorts,
    setActor: (value: typeof currentActor) => {
      currentActor = value;
    },
    snapshot: async () =>
      structuredClone({ grants, clients: [...db.clients.values()], mandate: await resolveMandate("lpa_managed") }),
    request: (route: (typeof managementRoutes)[number]) =>
      app.request(`/ucp/oauth${route.path}`, {
        method: route.method,
        ...("body" in route
          ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(route.body) }
          : {}),
      }),
  };
}

function createInMemoryConsentDirectory() {
  const mandates = new Map<string, unknown>();
  const HANDOFF_ONLY = {
    maxPerOrderCents: 0,
    dailyCapCents: 0,
    monthlyCapCents: 0,
    humanPresentRequired: true,
    allowedRails: ["handoff-only"],
  };
  return {
    resolveMandate: async (grantId: string) => mandates.get(grantId) ?? HANDOFF_ONLY,
    setMandate: async ({ grantId, mandate }: { grantId: string; mandate: unknown }) => {
      mandates.set(grantId, mandate);
    },
    getSpendSummary: async () => ({ dailyCents: 0, monthlyCents: 0 }),
  } as unknown as NonNullable<Parameters<typeof createUcpOAuthRoutes>[0]["agentGrantConsent"]>;
}

function createOAuthOptions(overrides: Partial<Parameters<typeof createUcpOAuthRoutes>[0]> = {}) {
  const db = createAuthorizationCodeDb();
  const linkedPlatformAuthorizations = createLinkedStore();
  const operations = new Map<string, RevocationState>();
  const attempts = new Map<string, string>();
  const phases = ["admitted", "identity-terminal", "payments-terminal", "webhook-excluded", "completed"] as const;
  const agentGrantRevocations: AgentGrantRevocations = {
    isActiveGrant: async (accountId, grantId) =>
      (await linkedPlatformAuthorizations.listForAccount(accountId)).some(
        (row) => row.authorization_id === grantId && row.status === "active",
      ),
    withActiveGrant: async (accountId, grantId, work) =>
      (await linkedPlatformAuthorizations.listForAccount(accountId)).some(
        (row) => row.authorization_id === grantId && row.status === "active",
      )
        ? work()
        : null,
    isActivated: async () => true,
    withMode: async (work) => work(true),
    readProgress: async (_accountId, grantId) => operations.get(grantId)?.phase ?? null,
    activate: async () => {},
    activationProof: async () => undefined,
    pending: async () => [],
    withActiveGrants: async (_accountId, _clientId, ids, work) => work(ids),
    admit: async (binding, context) => {
      const row = (await linkedPlatformAuthorizations.listForAccount(binding.accountId)).find(
        (value) => value.authorization_id === binding.grantId,
      );
      if (!row) return null;
      const bound = JSON.stringify(binding);
      if (attempts.has(binding.attemptId) && attempts.get(binding.attemptId) !== bound)
        throw new Error("revocation_conflict");
      attempts.set(binding.attemptId, bound);
      let state = operations.get(binding.grantId);
      if (!state) {
        state = {
          operationId: binding.attemptId,
          accountId: binding.accountId,
          grantId: binding.grantId,
          revokedAt: String(row.revoked_at ?? new Date().toISOString()),
          reason: binding.reason,
          provenance: binding.provenance,
          phase: "admitted",
          version: 1,
          effectContext: context,
        };
        operations.set(binding.grantId, state);
      }
      return state;
    },
    read: async (binding) => {
      if (!attempts.has(binding.attemptId)) return null;
      if (attempts.get(binding.attemptId) !== JSON.stringify(binding)) throw new Error("revocation_conflict");
      return operations.get(binding.grantId) ?? null;
    },
    advance: async (state) => {
      if (state.phase === "admitted")
        await linkedPlatformAuthorizations.revokeAuthorization({
          authorizationId: state.grantId,
          accountId: state.accountId,
          revokedAt: state.revokedAt,
        });
      const next = { ...state, phase: phases[state.version], version: state.version + 1 };
      operations.set(state.grantId, next);
      return next;
    },
  };
  let sequence = 0;
  return {
    auth: {
      db,
      auth: {
        issueOpaqueToken: (prefix: string) => `${prefix}_${++sequence}`,
        hashSecret: (secret: string) => `hash:${secret}`,
      },
    },
    linkedPlatformAuthorizations,
    agentGrantRevocations,
    agentWebhookOutbox: { excludeRevokedGrant: async () => true },
    resolveActor: async () => actor,
    ...overrides,
  } as unknown as Parameters<typeof createUcpOAuthRoutes>[0];
}

function createAuthorizationCodeDb() {
  const codes = new Map<string, Record<string, unknown>>();
  const clients = new Map<string, Record<string, unknown>>();
  const consents = new Map<string, Record<string, unknown>>();
  let consumeHook: (() => void) | undefined;
  return {
    codes,
    clients,
    consents,
    beforeConsume: (hook: () => void) => {
      consumeHook = hook;
    },
    async query<Row = Record<string, unknown>>(text: string, values: readonly unknown[] = []) {
      if (text.includes("FROM auth_identity_user_memberships")) {
        return { rows: [{ accountId: actor.accountId, accountName: "Synthetic Account" }] as Row[], rowCount: 1 };
      }
      if (text.includes("INSERT INTO identity_ucp_oauth_consent_requests")) {
        const row = {
          token_hash: values[0],
          session_id: values[1],
          user_id: values[2],
          account_id: values[3],
          client_id: values[4],
          redirect_uri: values[5],
          scopes: JSON.parse(String(values[6])),
          state: values[7],
          code_challenge: values[8],
          code_challenge_method: values[9],
          expires_at: values[10],
          consumed_at: null,
        };
        consents.set(String(row.token_hash), row);
        return { rows: [], rowCount: 1 };
      }
      if (text.includes("identity_ucp_oauth_consent_requests")) {
        if (text.includes("UPDATE")) consumeHook?.();
        const row = text.includes("token_hash = $1") ? consents.get(String(values[0])) : [...consents.values()][0];
        const matches =
          row &&
          (!text.includes("session_id = $2") || row.session_id === values[1]) &&
          (!text.includes("user_id = $3") || row.user_id === values[2]) &&
          (!text.includes("account_id = $4") || row.account_id === values[3]) &&
          (!text.includes("consumed_at IS NULL") || row.consumed_at === null) &&
          (!text.includes("expires_at > now()") || new Date(String(row.expires_at)).getTime() > Date.now());
        if (!matches) return { rows: [], rowCount: 0 };
        if (text.includes("UPDATE")) row.consumed_at = new Date().toISOString();
        return { rows: [{ ...row } as Row], rowCount: 1 };
      }
      if (text.includes("INSERT INTO identity_ucp_oauth_clients")) {
        const row = {
          client_id: values[0],
          client_name: values[1],
          client_uri: values[2],
          platform_profile_url: values[3],
          redirect_uris: JSON.parse(String(values[4])) as readonly string[],
          scopes: JSON.parse(String(values[5])) as readonly string[],
          grant_types: JSON.parse(String(values[6])) as readonly string[],
          response_types: JSON.parse(String(values[7])) as readonly string[],
          token_endpoint_auth_method: values[8],
          client_id_issued_at: values[9],
          webhook_callback_url: values[10] ?? null,
          webhook_signing_secret: values[11] ?? null,
          webhook_signing_secret_created_at: values[12] ?? null,
        };
        clients.set(String(row.client_id), row);
        return { rows: [], rowCount: 1 };
      }

      if (text.includes("client_id = ANY")) {
        const ids = values[0] as readonly string[];
        const rows = ids.map((id) => clients.get(id)).filter((row): row is Record<string, unknown> => Boolean(row));
        return { rows: rows as Row[], rowCount: rows.length };
      }

      if (text.includes("FROM identity_ucp_oauth_clients")) {
        const row = clients.get(String(values[0]));
        return { rows: row ? [row as Row] : [], rowCount: row ? 1 : 0 };
      }

      if (text.includes("UPDATE identity_ucp_oauth_clients")) {
        const row = clients.get(String(values[3]));
        if (!row) {
          return { rows: [], rowCount: 0 };
        }
        row.webhook_callback_url = values[0];
        row.webhook_signing_secret = values[1];
        row.webhook_signing_secret_created_at = values[2];
        return { rows: [row as Row], rowCount: 1 };
      }

      if (text.includes("INSERT INTO identity_ucp_oauth_authorization_codes")) {
        const row = {
          code_id: values[0],
          code_hash: values[1],
          client_id: values[2],
          platform_profile_url: values[3],
          redirect_uri: values[4],
          user_id: values[5],
          account_id: values[6],
          scopes: JSON.parse(String(values[7])) as readonly string[],
          state: values[8],
          code_challenge: values[9],
          code_challenge_method: values[10],
          expires_at: values[11],
          consumed_at: null,
        };
        codes.set(String(row.code_id), row);
        return { rows: [], rowCount: 1 };
      }

      if (text.includes("SELECT code_id")) {
        const row = [...codes.values()].find(
          (entry) =>
            entry.code_hash === values[0] &&
            entry.consumed_at === null &&
            (values[1] === null || entry.redirect_uri === values[1]),
        );
        return { rows: row ? [row as Row] : [], rowCount: row ? 1 : 0 };
      }

      if (text.includes("UPDATE identity_ucp_oauth_authorization_codes")) {
        const row = codes.get(String(values[0]));
        if (!row || row.consumed_at) {
          return { rows: [], rowCount: 0 };
        }
        row.consumed_at = new Date().toISOString();
        return { rows: [row as Row], rowCount: 1 };
      }

      throw new Error(`Unexpected query: ${text}`);
    },
  };
}

function createLinkedStore({ enforceExpiry = false }: { enforceExpiry?: boolean } = {}) {
  const rows = new Map<string, Record<string, unknown>>();
  const capAtAbsoluteExpiry = (candidate: string, absolute: unknown) => {
    if (typeof absolute !== "string") return candidate;
    return Date.parse(candidate) <= Date.parse(absolute) ? candidate : absolute;
  };
  const isUsable = (row: Record<string, unknown>, field: "access_token_expires_at" | "refresh_token_expires_at") =>
    !enforceExpiry || (typeof row[field] === "string" && Date.parse(row[field] as string) > Date.now());
  return {
    grant: async (params: {
      authorizationId: string;
      platformProfileUrl: string;
      clientId: string;
      userId: string;
      accountId: string;
      scopes: readonly string[];
      accessTokenHash: string;
      refreshTokenHash?: string | null;
      accessTokenExpiresAt: string;
      refreshTokenExpiresAt?: string | null;
      absoluteExpiresAt?: string | null;
      grantedAt: string;
    }) => {
      const absoluteExpiresAt = params.absoluteExpiresAt ?? null;
      const row = {
        authorization_id: params.authorizationId,
        platform_profile_url: params.platformProfileUrl,
        client_id: params.clientId,
        user_id: params.userId,
        account_id: params.accountId,
        scopes: params.scopes,
        status: "active",
        access_token_hash: params.accessTokenHash,
        refresh_token_hash: params.refreshTokenHash ?? null,
        access_token_expires_at: capAtAbsoluteExpiry(params.accessTokenExpiresAt, absoluteExpiresAt),
        refresh_token_expires_at: params.refreshTokenExpiresAt
          ? capAtAbsoluteExpiry(params.refreshTokenExpiresAt, absoluteExpiresAt)
          : null,
        absolute_expires_at: absoluteExpiresAt,
        granted_at: params.grantedAt,
        last_refreshed_at: null,
        refresh_token_rotated_at: null,
        revoked_at: null,
        revocation_reason: null,
        updated_at: params.grantedAt,
      };
      rows.set(params.authorizationId, row);
      return row;
    },
    resolveToken: async (tokenHash: string) =>
      [...rows.values()].find(
        (row) =>
          row.status === "active" &&
          ((row.access_token_hash === tokenHash && isUsable(row, "access_token_expires_at")) ||
            (row.refresh_token_hash === tokenHash && isUsable(row, "refresh_token_expires_at"))),
      ) ?? null,
    resolveAccessToken: async (tokenHash: string) =>
      [...rows.values()].find(
        (row) =>
          row.status === "active" && row.access_token_hash === tokenHash && isUsable(row, "access_token_expires_at"),
      ) ?? null,
    resolveRevocationToken: async (tokenHash: string) =>
      [...rows.values()].find((row) => row.access_token_hash === tokenHash || row.refresh_token_hash === tokenHash) ??
      null,
    rotateRefreshToken: async (params: {
      refreshTokenHash: string;
      newAccessTokenHash: string;
      newRefreshTokenHash: string;
      accessTokenExpiresAt: string;
      refreshTokenExpiresAt: string;
      refreshedAt: string;
    }) => {
      const row = [...rows.values()].find(
        (entry) =>
          entry.status === "active" &&
          entry.refresh_token_hash === params.refreshTokenHash &&
          isUsable(entry, "refresh_token_expires_at"),
      );
      if (!row) {
        return null;
      }
      row.access_token_hash = params.newAccessTokenHash;
      row.refresh_token_hash = params.newRefreshTokenHash;
      row.access_token_expires_at = capAtAbsoluteExpiry(params.accessTokenExpiresAt, row.absolute_expires_at);
      row.refresh_token_expires_at = capAtAbsoluteExpiry(params.refreshTokenExpiresAt, row.absolute_expires_at);
      row.last_refreshed_at = params.refreshedAt;
      row.refresh_token_rotated_at = params.refreshedAt;
      row.updated_at = params.refreshedAt;
      return row;
    },
    revokeToken: async (tokenHash: string, revokedAt: string) => {
      const row = [...rows.values()].find(
        (entry) =>
          entry.status === "active" &&
          (entry.access_token_hash === tokenHash || entry.refresh_token_hash === tokenHash),
      );
      if (!row) {
        return false;
      }
      row.status = "revoked";
      row.revoked_at = revokedAt;
      row.revocation_reason = "token_revocation";
      return true;
    },
    revokeAuthorization: async (params: { authorizationId: string; accountId: string; revokedAt: string }) => {
      const row = rows.get(params.authorizationId);
      if (!row || row.account_id !== params.accountId || row.status !== "active") {
        return false;
      }
      row.status = "revoked";
      row.revoked_at = params.revokedAt;
      row.revocation_reason = "account_consent_revoked";
      return true;
    },
    listForAccount: async (accountId: string) => [...rows.values()].filter((row) => row.account_id === accountId),
  };
}

function pkceChallenge(verifier: string) {
  return createHash("sha256").update(verifier).digest("base64url");
}

function largestValidClientIdMetadata() {
  const paddedUrl = (suffix: string) => {
    const prefix = "https://a.example/";
    return `${prefix}${"x".repeat(2048 - prefix.length - suffix.length)}${suffix}`;
  };
  const clientId = paddedUrl("client-id");
  const redirectUris = Array.from({ length: 10 }, (_, index) => paddedUrl(`redirect-${index}`));
  const body = {
    client_id: clientId,
    client_name: "x".repeat(120),
    client_uri: paddedUrl("client-uri"),
    platform_profile_url: paddedUrl("profile-url"),
    redirect_uris: redirectUris,
    scope: [...UCP_OAUTH_SUPPORTED_SCOPES, "operations:read", "operations:write"].join(" "),
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
  };
  return { clientId, redirectUris, body };
}

async function consentFixture(redirectUri = "https://agent.example/callback") {
  const db = createAuthorizationCodeDb();
  const base = createOAuthOptions();
  let currentActor: Awaited<ReturnType<typeof base.resolveActor>> = actor;
  const options = createOAuthOptions({
    auth: {
      ...base.auth,
      db,
      auth: { ...base.auth.auth, hashSecret: (value) => createHash("sha256").update(value).digest("hex") },
    },
    resolveActor: async () => currentActor,
  });
  const app = new Hono().route("/ucp/oauth", createUcpOAuthRoutes(options));
  const registration = await registerClient(app, {
    client_name: "Synthetic Agent",
    redirect_uris: [redirectUri],
    scope: "account:manage payouts:request",
  });
  const { client_id: clientId } = (await registration.json()) as { client_id: string };
  const authorizePath = authorizeUrl({
    clientId,
    redirectUri,
    scope: "account:manage payouts:request",
    challenge: pkceChallenge("synthetic-verifier"),
    state: "synthetic-state",
  });
  return {
    db,
    options,
    app,
    clientId,
    authorizePath,
    setActor: (value: typeof currentActor) => {
      currentActor = value;
    },
    start: async () => {
      const response = await app.request(authorizePath);
      return new URL(response.headers.get("location")!, "http://localhost").searchParams.get("consent_token")!;
    },
    decide: (
      token: string,
      decision = "approve",
      headers: Record<string, string> = {},
      extra: Record<string, string> = {},
    ) => {
      const body = new URLSearchParams({ consent_token: token, decision, ...extra });
      if (!token) body.delete("consent_token");
      const requestHeaders = new Headers({ Origin: "http://localhost", "Sec-Fetch-Site": "same-origin" });
      for (const [name, value] of Object.entries(headers)) {
        if (value === "") requestHeaders.delete(name);
        else requestHeaders.set(name, value);
      }
      return app.request("/ucp/oauth/authorize", {
        method: "POST",
        body,
        headers: requestHeaders,
      });
    },
  };
}

function registerClient(app: Hono, metadata: Readonly<Record<string, unknown>>) {
  return app.request("/ucp/oauth/register", {
    method: "POST",
    body: JSON.stringify(metadata),
    headers: { "Content-Type": "application/json" },
  });
}

async function authorizeWithConsent(app: Hono, path: string) {
  const response = await app.request(path);
  const token = new URL(response.headers.get("location")!, "http://localhost").searchParams.get("consent_token")!;
  return app.request("/ucp/oauth/authorize", {
    method: "POST",
    body: new URLSearchParams({ consent_token: token, decision: "approve" }),
    headers: { Origin: "http://localhost", "Sec-Fetch-Site": "same-origin" },
  });
}

function authorizeUrl(input: {
  clientId: string;
  redirectUri: string;
  scope: string;
  challenge: string;
  state?: string;
}) {
  const query = new URLSearchParams({
    response_type: "code",
    client_id: input.clientId,
    redirect_uri: input.redirectUri,
    scope: input.scope,
    code_challenge: input.challenge,
    code_challenge_method: "S256",
  });
  if (input.state) {
    query.set("state", input.state);
  }
  return `/ucp/oauth/authorize?${query.toString()}`;
}
