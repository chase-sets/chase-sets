import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import {
  authUcpOAuthSchemaSql,
  authUcpOAuthConsentSchemaMigrations,
  createUcpOAuthMetadataRoutes,
  createUcpOAuthRoutes,
  UCP_OAUTH_SUPPORTED_SCOPES,
} from "./oauth";
import { authRetentionSweeps } from "../runtime-support/retention-policy";

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
  describe.each([
    [
      "agent bearer",
      {
        ...actor,
        agentGrant: {
          grantId: "lpa_sibling",
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
        scope: "order:read",
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
        scope: "order:read",
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
        scope: "order:read",
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
      scopes: ["order:read"],
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
      scopes: ["order:read"],
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
        scope: "checkout:write order:read",
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
    expect(registrationBody.scope).toBe("checkout:write order:read");

    const verifier = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~";
    const challenge = pkceChallenge(verifier);

    const wrongRedirect = await app.request(
      authorizeUrl({
        clientId: registrationBody.client_id,
        redirectUri: "https://evil.example/callback",
        scope: "checkout:write order:read",
        challenge,
      }),
    );
    const wrongScope = await app.request(
      authorizeUrl({
        clientId: registrationBody.client_id,
        redirectUri: "https://agent.example/callback",
        scope: "checkout:write catalog:read",
        challenge,
      }),
    );
    const authorize = await authorizeWithConsent(
      app,
      authorizeUrl({
        clientId: registrationBody.client_id,
        redirectUri: "https://agent.example/callback",
        scope: "checkout:write order:read",
        challenge,
        state: "state_1",
      }),
    );
    const redirect = new URL(authorize.headers.get("location") ?? "");
    const code = redirect.searchParams.get("code") ?? "";

    expect(wrongRedirect.status).toBe(400);
    await expect(wrongRedirect.json()).resolves.toMatchObject({ error: "invalid_request" });
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
    expect(tokenBody.scope).toBe("checkout:write order:read");

    const introspection = await app.request("/ucp/oauth/introspect", {
      method: "POST",
      body: new URLSearchParams({ token: tokenBody.access_token }),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    });
    await expect(introspection.json()).resolves.toMatchObject({
      active: true,
      client_id: registrationBody.client_id,
      account_id: "account_1",
      scope: "checkout:write order:read",
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
        scope: "order:read",
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
        scope: "order:read",
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

  it("supports HTTPS Client ID Metadata Documents for public agent clients", async () => {
    const options = createOAuthOptions({
      fetchClientIdMetadata: async (url) => {
        expect(url).toBe("https://agent.example/oauth-client.json");
        return {
          client_id: "https://agent.example/oauth-client.json",
          client_name: "Agent Metadata Client",
          client_uri: "https://agent.example/.well-known/ucp",
          redirect_uris: ["https://agent.example/callback"],
          scope: "catalog:read order:read",
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
        scope: "catalog:read order:read",
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
    expect(tokenBody.scope).toBe("catalog:read order:read");

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

  it("lists and revokes linked platform authorizations for the current account", async () => {
    const revokeStoredPaymentMethodsForAgentGrant = vi.fn(async () => ({
      detached: 1,
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
    await expect(revoke.json()).resolves.toEqual({ revoked: true });
    expect(revokeStoredPaymentMethodsForAgentGrant).toHaveBeenCalledWith(
      {
        accountId: "account_1",
        agentGrantId: "lpa_1",
        revokedAt: expect.any(String),
      },
      {
        tenantId: "tnt_identity",
        audit: {
          performedByUserId: "usr_identity_system",
          forAccountId: "account_1",
        },
      },
    );

    const replay = await app.request("/ucp/oauth/authorizations/lpa_1/revoke", { method: "POST" });
    await expect(replay.json()).resolves.toEqual({ revoked: false });
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
        allowed_rails: ["ap2"],
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
        allowed_rails: ["ap2"],
      },
    });

    // Rejects an invalid rail.
    const rejected = await app.request("/ucp/oauth/authorizations/lpa_1/mandate", {
      method: "PUT",
      body: JSON.stringify({ allowed_rails: ["wire-transfer"] }),
      headers: { "Content-Type": "application/json" },
    });
    expect(rejected.status).toBe(400);

    // Rejects configuring a grant that does not belong to the account.
    const foreign = await app.request("/ucp/oauth/authorizations/lpa_unknown/mandate", {
      method: "PUT",
      body: JSON.stringify({ allowed_rails: ["ap2"] }),
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

async function managementFixture(configured = true) {
  const db = createAuthorizationCodeDb();
  const linked = createLinkedStore();
  const consent = createInMemoryConsentDirectory();
  const activity = { listForGrant: vi.fn(async () => ({ items: [], total: 0 })) };
  const outbox = {
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
    linkedPlatformAuthorizations: linked,
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
    ...(
      ["listForAccount", "grant", "resolveToken", "rotateRefreshToken", "revokeToken", "revokeAuthorization"] as const
    ).map((name) => vi.spyOn(linked, name)),
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

function createLinkedStore() {
  const rows = new Map<string, Record<string, unknown>>();
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
      grantedAt: string;
    }) => {
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
        access_token_expires_at: params.accessTokenExpiresAt,
        refresh_token_expires_at: params.refreshTokenExpiresAt ?? null,
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
          row.status === "active" && (row.access_token_hash === tokenHash || row.refresh_token_hash === tokenHash),
      ) ?? null,
    rotateRefreshToken: async (params: {
      refreshTokenHash: string;
      newAccessTokenHash: string;
      newRefreshTokenHash: string;
      accessTokenExpiresAt: string;
      refreshTokenExpiresAt: string;
      refreshedAt: string;
    }) => {
      const row = [...rows.values()].find(
        (entry) => entry.status === "active" && entry.refresh_token_hash === params.refreshTokenHash,
      );
      if (!row) {
        return null;
      }
      row.access_token_hash = params.newAccessTokenHash;
      row.refresh_token_hash = params.newRefreshTokenHash;
      row.access_token_expires_at = params.accessTokenExpiresAt;
      row.refresh_token_expires_at = params.refreshTokenExpiresAt;
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
