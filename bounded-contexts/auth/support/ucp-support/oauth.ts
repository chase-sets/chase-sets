import { createHash } from "node:crypto";
import { Hono, type Context } from "hono";
import type { ResolvedActor } from "@chase-sets/platform-runtime/auth";
import { resolvePublicRequestOrigin } from "@chase-sets/platform-runtime/http";
import { createId } from "@chase-sets/primitives/typed-ids";
import type { AuthServices } from "../runtime-support/services";

export const authUcpOAuthSchemaSql = `
CREATE TABLE IF NOT EXISTS identity_ucp_oauth_authorization_codes (
  code_id text PRIMARY KEY,
  code_hash text NOT NULL UNIQUE,
  client_id text NOT NULL,
  platform_profile_url text NOT NULL,
  redirect_uri text NOT NULL,
  user_id text NOT NULL,
  account_id text NOT NULL,
  scopes jsonb NOT NULL DEFAULT '[]'::jsonb,
  state text NULL,
  code_challenge text NOT NULL DEFAULT '',
  code_challenge_method text NOT NULL DEFAULT 'S256',
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE identity_ucp_oauth_authorization_codes
  ADD COLUMN IF NOT EXISTS code_challenge text NOT NULL DEFAULT '';

ALTER TABLE identity_ucp_oauth_authorization_codes
  ADD COLUMN IF NOT EXISTS code_challenge_method text NOT NULL DEFAULT 'S256';

CREATE INDEX IF NOT EXISTS identity_ucp_oauth_authorization_codes_expires_at_idx
  ON identity_ucp_oauth_authorization_codes (expires_at);
`;

export type UcpOAuthRoutesOptions = Readonly<{
  auth: AuthServices;
  linkedPlatformAuthorizations: Readonly<{
    grant: (
      params: Readonly<{
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
      }>,
    ) => Promise<unknown>;
    resolveToken: (tokenHash: string) => Promise<{
      authorization_id: string;
      platform_profile_url: string;
      client_id: string;
      user_id: string;
      account_id: string;
      scopes: readonly string[];
      access_token_expires_at: string;
      refresh_token_expires_at: string | null;
    } | null>;
    rotateRefreshToken: (
      params: Readonly<{
        refreshTokenHash: string;
        newAccessTokenHash: string;
        newRefreshTokenHash: string;
        accessTokenExpiresAt: string;
        refreshTokenExpiresAt: string;
        refreshedAt: string;
      }>,
    ) => Promise<{
      platform_profile_url: string;
      client_id: string;
      user_id: string;
      account_id: string;
      scopes: readonly string[];
    } | null>;
    revokeToken: (tokenHash: string, revokedAt: string) => Promise<boolean>;
    revokeAuthorization: (
      params: Readonly<{
        authorizationId: string;
        accountId: string;
        revokedAt: string;
        reason?: string | null;
      }>,
    ) => Promise<boolean>;
    listForAccount: (accountId: string) => Promise<
      readonly {
        authorization_id: string;
        platform_profile_url: string;
        client_id: string;
        user_id: string;
        account_id: string;
        scopes: readonly string[];
        status: string;
        access_token_expires_at: string;
        refresh_token_expires_at: string | null;
        granted_at: string;
        last_refreshed_at: string | null;
        revoked_at: string | null;
        revocation_reason: string | null;
        updated_at: string;
      }[]
    >;
  }>;
  resolveActor: (request: Request) => Promise<ResolvedActor | null>;
}>;

const ACCESS_TOKEN_TTL_MS = 60 * 60 * 1000;
const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const AUTHORIZATION_CODE_TTL_MS = 5 * 60 * 1000;

export const UCP_OAUTH_SUPPORTED_SCOPES = ["catalog:read", "checkout:read", "checkout:write", "order:read"] as const;

type AuthorizationCodeRow = Readonly<{
  code_id: string;
  client_id: string;
  platform_profile_url: string;
  redirect_uri: string;
  user_id: string;
  account_id: string;
  scopes: readonly string[];
  state: string | null;
  code_challenge: string;
  code_challenge_method: string;
  expires_at: string;
}>;

export function resolveUcpScopedPermissions(
  scopes: readonly string[],
  membershipPermissions: readonly string[],
): readonly string[] {
  const allowed = new Set<string>();
  if (scopes.includes("catalog:read")) {
    allowed.add("catalog.view");
    allowed.add("listings.view");
  }
  if (scopes.includes("checkout:read") || scopes.includes("order:read")) {
    allowed.add("orders.view");
  }
  if (scopes.includes("checkout:write")) {
    allowed.add("orders.manage");
  }

  return membershipPermissions.filter((permission) => allowed.has(permission));
}

export function createUcpOAuthMetadataRoutes() {
  const app = new Hono();

  app.get("/oauth-authorization-server", (c) => {
    const origin = requestOrigin(c.req.raw);
    return c.json({
      issuer: origin,
      authorization_endpoint: `${origin}/ucp/oauth/authorize`,
      token_endpoint: `${origin}/ucp/oauth/token`,
      introspection_endpoint: `${origin}/ucp/oauth/introspect`,
      revocation_endpoint: `${origin}/ucp/oauth/revoke`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      scopes_supported: UCP_OAUTH_SUPPORTED_SCOPES,
      token_endpoint_auth_methods_supported: ["none"],
      code_challenge_methods_supported: ["S256"],
    });
  });

  return app;
}

export function createUcpOAuthRoutes(options: UcpOAuthRoutesOptions) {
  const app = new Hono();

  app.get("/authorize", async (c) => {
    const url = new URL(c.req.url);
    const redirectUri = url.searchParams.get("redirect_uri")?.trim() ?? "";
    const clientId = url.searchParams.get("client_id")?.trim() ?? "";
    const responseType = url.searchParams.get("response_type")?.trim() ?? "";
    const state = url.searchParams.get("state")?.trim() ?? null;
    const scopes = normalizeScopes(url.searchParams.get("scope"));
    const codeChallenge = url.searchParams.get("code_challenge")?.trim() ?? "";
    const codeChallengeMethod = url.searchParams.get("code_challenge_method")?.trim() ?? "";
    const platformProfileUrl =
      url.searchParams.get("platform_profile_url")?.trim() ?? (isTrustedHttpUrl(clientId) ? clientId : "");

    if (
      responseType !== "code" ||
      !clientId ||
      !isTrustedHttpUrl(redirectUri) ||
      !isTrustedHttpUrl(platformProfileUrl) ||
      codeChallengeMethod !== "S256" ||
      !isPkceChallenge(codeChallenge)
    ) {
      return c.json(
        {
          error: "invalid_request",
          error_description:
            "response_type=code, client_id, trusted redirect_uri, trusted platform_profile_url, and PKCE S256 are required.",
        },
        400,
      );
    }

    const actor = await options.resolveActor(c.req.raw);
    if (!actor) {
      return c.json(
        {
          error: "login_required",
          error_description: "Sign in before linking this platform to a marketplace account.",
        },
        401,
      );
    }

    const code = options.auth.auth.issueOpaqueToken("ucp_code");
    const expiresAt = new Date(Date.now() + AUTHORIZATION_CODE_TTL_MS).toISOString();
    await options.auth.db.query(
      `INSERT INTO identity_ucp_oauth_authorization_codes (
         code_id,
         code_hash,
         client_id,
         platform_profile_url,
         redirect_uri,
         user_id,
         account_id,
         scopes,
         state,
         code_challenge,
         code_challenge_method,
         expires_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11, $12::timestamptz)`,
      [
        createId("cmd"),
        options.auth.auth.hashSecret(code),
        clientId,
        platformProfileUrl,
        redirectUri,
        actor.userId,
        actor.accountId,
        JSON.stringify(scopes),
        state,
        codeChallenge,
        codeChallengeMethod,
        expiresAt,
      ],
    );

    const redirect = new URL(redirectUri);
    redirect.searchParams.set("code", code);
    if (state) {
      redirect.searchParams.set("state", state);
    }
    return c.redirect(redirect.toString(), 302);
  });

  app.post("/token", async (c) => {
    const body = await readFormOrJson(c.req.raw);
    const grantType = readString(body.grant_type);
    if (grantType === "refresh_token") {
      return refreshAccessToken(c, options, body);
    }
    if (grantType !== "authorization_code") {
      return c.json(
        {
          error: "unsupported_grant_type",
          error_description: "UCP identity linking supports authorization_code and refresh_token.",
        },
        400,
      );
    }

    const code = readString(body.code);
    const redirectUri = readString(body.redirect_uri);
    const codeVerifier = readString(body.code_verifier);
    if (!code) {
      return c.json({ error: "invalid_request", error_description: "code is required." }, 400);
    }
    if (!codeVerifier) {
      return c.json({ error: "invalid_request", error_description: "code_verifier is required." }, 400);
    }

    const codeRow = await consumeAuthorizationCode(
      options.auth,
      options.auth.auth.hashSecret(code),
      redirectUri,
      codeVerifier,
    );
    if (!codeRow) {
      return c.json({ error: "invalid_grant", error_description: "Authorization code is invalid or expired." }, 400);
    }

    const accessToken = options.auth.auth.issueOpaqueToken("ucp_at");
    const refreshToken = options.auth.auth.issueOpaqueToken("ucp_rt");
    const now = new Date();
    const accessTokenExpiresAt = new Date(now.getTime() + ACCESS_TOKEN_TTL_MS).toISOString();
    const refreshTokenExpiresAt = new Date(now.getTime() + REFRESH_TOKEN_TTL_MS).toISOString();
    await options.linkedPlatformAuthorizations.grant({
      authorizationId: createId("lpa"),
      platformProfileUrl: codeRow.platform_profile_url,
      clientId: codeRow.client_id,
      userId: codeRow.user_id,
      accountId: codeRow.account_id,
      scopes: normalizeScopes(codeRow.scopes),
      accessTokenHash: options.auth.auth.hashSecret(accessToken),
      refreshTokenHash: options.auth.auth.hashSecret(refreshToken),
      accessTokenExpiresAt,
      refreshTokenExpiresAt,
      grantedAt: now.toISOString(),
    });

    return c.json({
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: Math.floor(ACCESS_TOKEN_TTL_MS / 1000),
      refresh_token: refreshToken,
      scope: normalizeScopes(codeRow.scopes).join(" "),
    });
  });

  app.post("/introspect", async (c) => {
    const body = await readFormOrJson(c.req.raw);
    const token = readString(body.token);
    if (!token) {
      return c.json({ active: false });
    }

    const authorization = await options.linkedPlatformAuthorizations.resolveToken(options.auth.auth.hashSecret(token));
    if (!authorization) {
      return c.json({ active: false });
    }

    const scopes = normalizeScopes(authorization.scopes);
    return c.json({
      active: true,
      client_id: authorization.client_id,
      username: authorization.user_id,
      sub: authorization.user_id,
      account_id: authorization.account_id,
      platform_profile_url: authorization.platform_profile_url,
      scope: scopes.join(" "),
      exp: Math.floor(new Date(authorization.access_token_expires_at).getTime() / 1000),
    });
  });

  app.post("/revoke", async (c) => {
    const body = await readFormOrJson(c.req.raw);
    const token = readString(body.token);
    if (!token) {
      return c.json({ error: "invalid_request", error_description: "token is required." }, 400);
    }

    await options.linkedPlatformAuthorizations.revokeToken(
      options.auth.auth.hashSecret(token),
      new Date().toISOString(),
    );
    return c.body(null, 200);
  });

  app.get("/authorizations", async (c) => {
    const actor = await options.resolveActor(c.req.raw);
    if (!actor) {
      return c.json({ error: "login_required" }, 401);
    }

    const authorizations = await options.linkedPlatformAuthorizations.listForAccount(actor.accountId);
    return c.json({
      authorizations: authorizations.map((authorization) => ({
        id: authorization.authorization_id,
        platform_profile_url: authorization.platform_profile_url,
        client_id: authorization.client_id,
        scopes: normalizeScopes(authorization.scopes),
        status: authorization.status,
        access_token_expires_at: authorization.access_token_expires_at,
        refresh_token_expires_at: authorization.refresh_token_expires_at,
        granted_at: authorization.granted_at,
        last_refreshed_at: authorization.last_refreshed_at,
        revoked_at: authorization.revoked_at,
        revocation_reason: authorization.revocation_reason,
        updated_at: authorization.updated_at,
      })),
    });
  });

  app.post("/authorizations/:id/revoke", async (c) => {
    const actor = await options.resolveActor(c.req.raw);
    if (!actor) {
      return c.json({ error: "login_required" }, 401);
    }

    const revoked = await options.linkedPlatformAuthorizations.revokeAuthorization({
      authorizationId: c.req.param("id"),
      accountId: actor.accountId,
      revokedAt: new Date().toISOString(),
      reason: "account_consent_revoked",
    });
    return c.json({ revoked });
  });

  return app;
}

async function refreshAccessToken(c: Context, options: UcpOAuthRoutesOptions, body: Readonly<Record<string, unknown>>) {
  const refreshToken = readString(body.refresh_token);
  if (!refreshToken) {
    return c.json({ error: "invalid_request", error_description: "refresh_token is required." }, 400);
  }

  const accessToken = options.auth.auth.issueOpaqueToken("ucp_at");
  const newRefreshToken = options.auth.auth.issueOpaqueToken("ucp_rt");
  const now = new Date();
  const accessTokenExpiresAt = new Date(now.getTime() + ACCESS_TOKEN_TTL_MS).toISOString();
  const refreshTokenExpiresAt = new Date(now.getTime() + REFRESH_TOKEN_TTL_MS).toISOString();
  const authorization = await options.linkedPlatformAuthorizations.rotateRefreshToken({
    refreshTokenHash: options.auth.auth.hashSecret(refreshToken),
    newAccessTokenHash: options.auth.auth.hashSecret(accessToken),
    newRefreshTokenHash: options.auth.auth.hashSecret(newRefreshToken),
    accessTokenExpiresAt,
    refreshTokenExpiresAt,
    refreshedAt: now.toISOString(),
  });

  if (!authorization) {
    return c.json({ error: "invalid_grant", error_description: "Refresh token is invalid or expired." }, 400);
  }

  return c.json({
    access_token: accessToken,
    token_type: "Bearer",
    expires_in: Math.floor(ACCESS_TOKEN_TTL_MS / 1000),
    refresh_token: newRefreshToken,
    scope: normalizeScopes(authorization.scopes).join(" "),
  });
}

async function consumeAuthorizationCode(
  auth: AuthServices,
  codeHash: string,
  redirectUri: string | undefined,
  codeVerifier: string,
) {
  const result = await auth.db.query<AuthorizationCodeRow>(
    `SELECT code_id, client_id, platform_profile_url, redirect_uri, user_id,
            account_id, scopes, state, code_challenge, code_challenge_method, expires_at
     FROM identity_ucp_oauth_authorization_codes
     WHERE code_hash = $1
       AND consumed_at IS NULL
       AND expires_at > now()
       AND ($2::text IS NULL OR redirect_uri = $2)
     LIMIT 1`,
    [codeHash, redirectUri ?? null],
  );
  const row = result.rows[0];
  if (!row || row.code_challenge_method !== "S256" || pkceS256(codeVerifier) !== row.code_challenge) {
    return null;
  }

  const consumed = await auth.db.query<AuthorizationCodeRow>(
    `UPDATE identity_ucp_oauth_authorization_codes
     SET consumed_at = now()
     WHERE code_id = $1
       AND consumed_at IS NULL
     RETURNING code_id, client_id, platform_profile_url, redirect_uri, user_id,
               account_id, scopes, state, code_challenge, code_challenge_method, expires_at`,
    [row.code_id],
  );
  const consumedRow = consumed.rows[0];
  return consumedRow ? { ...consumedRow, scopes: Array.isArray(consumedRow.scopes) ? consumedRow.scopes : [] } : null;
}

async function readFormOrJson(request: Request) {
  const contentType = request.headers.get("content-type") ?? "";
  if (contentType.includes("application/x-www-form-urlencoded")) {
    const form = await request.formData();
    return Object.fromEntries([...form.entries()].map(([key, value]) => [key, String(value)]));
  }
  const value = await request.json().catch(() => ({}));
  return readObject(value) ?? {};
}

function normalizeScopes(value: unknown): readonly string[] {
  const raw = Array.isArray(value) ? value : typeof value === "string" ? value.split(/\s+/) : [];
  const supported = new Set<string>(UCP_OAUTH_SUPPORTED_SCOPES);
  const scopes = raw
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter((entry) => supported.has(entry));
  return scopes.length > 0 ? [...new Set(scopes)].sort() : ["catalog:read", "checkout:read", "order:read"];
}

function readObject(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : null;
}

function readString(value: unknown) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function isTrustedHttpUrl(value: string) {
  try {
    const url = new URL(value);
    if (url.protocol === "https:") {
      return true;
    }
    return url.protocol === "http:" && isLocalHost(url.hostname);
  } catch {
    return false;
  }
}

function isLocalHost(hostname: string) {
  const value = hostname.toLowerCase();
  return value === "localhost" || value === "127.0.0.1" || value === "::1" || value.endsWith(".localhost");
}

function isPkceChallenge(value: string) {
  return /^[A-Za-z0-9._~-]{43,128}$/.test(value);
}

function pkceS256(verifier: string) {
  return createHash("sha256").update(verifier).digest("base64url");
}

function requestOrigin(request: Request) {
  return resolvePublicRequestOrigin(request);
}
