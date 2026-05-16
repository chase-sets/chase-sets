import { Hono } from "hono";
import type { ResolvedActor } from "@chase-sets/platform-runtime/auth";
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
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS identity_ucp_oauth_authorization_codes_expires_at_idx
  ON identity_ucp_oauth_authorization_codes (expires_at);
`;

export type UcpOAuthRoutesOptions = Readonly<{
  auth: AuthServices;
  linkedPlatformAuthorizations: Readonly<{
    grant: (params: Readonly<{
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
    }>) => Promise<unknown>;
    revokeToken: (tokenHash: string, revokedAt: string) => Promise<boolean>;
  }>;
  resolveActor: (request: Request) => Promise<ResolvedActor | null>;
}>;

const ACCESS_TOKEN_TTL_MS = 60 * 60 * 1000;
const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const AUTHORIZATION_CODE_TTL_MS = 5 * 60 * 1000;

const SUPPORTED_SCOPES = [
  "catalog:read",
  "checkout:read",
  "checkout:write",
  "order:read",
] as const;

type AuthorizationCodeRow = Readonly<{
  code_id: string;
  client_id: string;
  platform_profile_url: string;
  redirect_uri: string;
  user_id: string;
  account_id: string;
  scopes: readonly string[];
  expires_at: string;
}>;

export function createUcpOAuthMetadataRoutes() {
  const app = new Hono();

  app.get("/oauth-authorization-server", (c) => {
    const origin = requestOrigin(c.req.raw);
    return c.json({
      issuer: origin,
      authorization_endpoint: `${origin}/ucp/oauth/authorize`,
      token_endpoint: `${origin}/ucp/oauth/token`,
      revocation_endpoint: `${origin}/ucp/oauth/revoke`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code"],
      scopes_supported: SUPPORTED_SCOPES,
      token_endpoint_auth_methods_supported: ["none"],
      code_challenge_methods_supported: [],
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
    const platformProfileUrl =
      url.searchParams.get("platform_profile_url")?.trim() ??
      (isHttpUrl(clientId) ? clientId : "");

    if (responseType !== "code" || !clientId || !isHttpUrl(redirectUri) || !isHttpUrl(platformProfileUrl)) {
      return c.json({
        error: "invalid_request",
        error_description: "response_type=code, client_id, redirect_uri, and platform_profile_url are required.",
      }, 400);
    }

    const actor = await options.resolveActor(c.req.raw);
    if (!actor) {
      return c.json({
        error: "login_required",
        error_description: "Sign in before linking this platform to a marketplace account.",
      }, 401);
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
         expires_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10::timestamptz)`,
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
    if (readString(body.grant_type) !== "authorization_code") {
      return c.json({
        error: "unsupported_grant_type",
        error_description: "UCP identity linking currently supports authorization_code.",
      }, 400);
    }

    const code = readString(body.code);
    const redirectUri = readString(body.redirect_uri);
    if (!code) {
      return c.json({ error: "invalid_request", error_description: "code is required." }, 400);
    }

    const codeRow = await consumeAuthorizationCode(
      options.auth,
      options.auth.auth.hashSecret(code),
      redirectUri,
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

  return app;
}

async function consumeAuthorizationCode(
  auth: AuthServices,
  codeHash: string,
  redirectUri: string | undefined,
) {
  const result = await auth.db.query<AuthorizationCodeRow>(
    `UPDATE identity_ucp_oauth_authorization_codes
     SET consumed_at = now()
     WHERE code_hash = $1
       AND consumed_at IS NULL
       AND expires_at > now()
       AND ($2::text IS NULL OR redirect_uri = $2)
     RETURNING code_id, client_id, platform_profile_url, redirect_uri, user_id,
               account_id, scopes, expires_at`,
    [codeHash, redirectUri ?? null],
  );
  const row = result.rows[0];
  return row
    ? { ...row, scopes: Array.isArray(row.scopes) ? row.scopes : [] }
    : null;
}

async function readFormOrJson(request: Request) {
  const contentType = request.headers.get("content-type") ?? "";
  if (contentType.includes("application/x-www-form-urlencoded")) {
    const form = await request.formData();
    return Object.fromEntries(
      [...form.entries()].map(([key, value]) => [key, String(value)]),
    );
  }
  const value = await request.json().catch(() => ({}));
  return readObject(value) ?? {};
}

function normalizeScopes(value: unknown): readonly string[] {
  const raw = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(/\s+/)
      : [];
  const supported = new Set<string>(SUPPORTED_SCOPES);
  const scopes = raw
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter((entry) => supported.has(entry));
  return scopes.length > 0 ? [...new Set(scopes)].sort() : ["catalog:read", "checkout:read", "order:read"];
}

function readObject(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : null;
}

function readString(value: unknown) {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function isHttpUrl(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

function requestOrigin(request: Request) {
  const url = new URL(request.url);
  const forwardedProto = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim();
  const forwardedHost = request.headers.get("x-forwarded-host")?.split(",")[0]?.trim();
  return `${forwardedProto || url.protocol.slice(0, -1)}://${forwardedHost || request.headers.get("host") || url.host}`;
}
