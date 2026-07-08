import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { createUcpOAuthMetadataRoutes, createUcpOAuthRoutes } from "./oauth";

const actor = {
  sessionId: "sess_1",
  tenantId: "tenant_1",
  userId: "user_1",
  accountId: "account_1",
  membershipId: "member_1",
  roleKey: "owner",
  permissions: ["orders.view"],
};

describe("UCP OAuth routes", () => {
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
    const authorize = await app.request(
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

    const authorize = await app.request(
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

  it("lists and revokes linked platform authorizations for the current account", async () => {
    const options = createOAuthOptions();
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

    const after = await app.request("/ucp/oauth/authorizations");
    await expect(after.json()).resolves.toMatchObject({
      authorizations: [{ id: "lpa_1", status: "revoked" }],
    });
  });
});

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
  return {
    async query<Row = Record<string, unknown>>(text: string, values: readonly unknown[] = []) {
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
        };
        clients.set(String(row.client_id), row);
        return { rows: [], rowCount: 1 };
      }

      if (text.includes("FROM identity_ucp_oauth_clients")) {
        const row = clients.get(String(values[0]));
        return { rows: row ? [row as Row] : [], rowCount: row ? 1 : 0 };
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
