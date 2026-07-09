import { createHash } from "node:crypto";
import { Hono, type Context } from "hono";
import {
  AGENT_OAUTH_SCOPE_FAMILIES,
  AGENT_OAUTH_SUPPORTED_SCOPES,
  isAgentOAuthScope,
  normalizeAgentOAuthScopes,
  resolveAgentOAuthScopedPermissions,
  type AgentOAuthScope,
} from "@chase-sets/auth-context";
import type { ResolvedActor } from "@chase-sets/platform-runtime/auth";
import {
  isAgentGrantRail,
  type AgentGrantConsentDirectory,
  type AgentSpendingMandate,
} from "@chase-sets/platform-runtime/agent-guardrails";
import { resolvePublicRequestOrigin } from "@chase-sets/platform-runtime/http";
import { createId } from "@chase-sets/primitives/typed-ids";
import type { AuthServices } from "../runtime-support/services";
import { generateAgentWebhookSigningSecret, previewAgentWebhookSigningSecret } from "./agent-webhooks/webhook-signing";
import { parseWebhookRegistration } from "./agent-webhooks/agent-webhook-registration";

export const authUcpOAuthSchemaSql = `
CREATE TABLE IF NOT EXISTS identity_ucp_oauth_clients (
  client_id text PRIMARY KEY,
  client_name text NULL,
  client_uri text NULL,
  platform_profile_url text NOT NULL,
  redirect_uris jsonb NOT NULL DEFAULT '[]'::jsonb,
  scopes jsonb NOT NULL DEFAULT '[]'::jsonb,
  grant_types jsonb NOT NULL DEFAULT '["authorization_code","refresh_token"]'::jsonb,
  response_types jsonb NOT NULL DEFAULT '["code"]'::jsonb,
  token_endpoint_auth_method text NOT NULL DEFAULT 'none',
  client_id_issued_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);

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
  fetchClientIdMetadata?: (url: string) => Promise<unknown>;
  // Per-grant spending mandates (agent consent state). Surfaced in introspection and the
  // connected-agents listing, and configured through the mandate endpoint.
  agentGrantConsent?: AgentGrantConsentDirectory;
}>;

const ACCESS_TOKEN_TTL_MS = 60 * 60 * 1000;
const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const AUTHORIZATION_CODE_TTL_MS = 5 * 60 * 1000;
const MAX_CLIENT_METADATA_URL_LENGTH = 2048;
const MAX_CLIENT_NAME_LENGTH = 120;
const MAX_REDIRECT_URIS = 10;
const UCP_OAUTH_DEFAULT_SCOPES = [
  "catalog:read",
  "checkout:read",
  "order:read",
] as const satisfies readonly AgentOAuthScope[];

export const UCP_OAUTH_SUPPORTED_SCOPES = AGENT_OAUTH_SUPPORTED_SCOPES;
export const UCP_OAUTH_SCOPE_FAMILIES = AGENT_OAUTH_SCOPE_FAMILIES;

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

type OAuthClientMetadata = Readonly<{
  clientId: string;
  clientName?: string | null;
  clientUri?: string | null;
  platformProfileUrl: string;
  redirectUris: readonly string[];
  scopes: readonly string[];
  grantTypes: readonly string[];
  responseTypes: readonly string[];
  tokenEndpointAuthMethod: "none";
}>;

type OAuthClientRow = Readonly<{
  client_id: string;
  client_name: string | null;
  client_uri: string | null;
  platform_profile_url: string;
  redirect_uris: readonly string[];
  scopes: readonly string[];
  grant_types: readonly string[];
  response_types: readonly string[];
  token_endpoint_auth_method: string;
}>;

export function resolveUcpScopedPermissions(
  scopes: readonly string[],
  membershipPermissions: readonly string[],
): readonly string[] {
  return resolveAgentOAuthScopedPermissions(scopes, membershipPermissions);
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
      registration_endpoint: `${origin}/ucp/oauth/register`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      scopes_supported: UCP_OAUTH_SUPPORTED_SCOPES,
      scope_families_supported: UCP_OAUTH_SCOPE_FAMILIES,
      token_endpoint_auth_methods_supported: ["none"],
      code_challenge_methods_supported: ["S256"],
    });
  });

  return app;
}

export function createUcpOAuthRoutes(options: UcpOAuthRoutesOptions) {
  const app = new Hono();

  app.post("/register", async (c) => {
    const contentType = c.req.raw.headers.get("content-type") ?? "";
    if (!contentType.includes("application/json")) {
      return c.json(
        {
          error: "invalid_request",
          error_description: "OAuth client registration requires application/json metadata.",
        },
        400,
      );
    }

    const body = readObject(await c.req.json().catch(() => null));
    if (!body) {
      return c.json({ error: "invalid_client_metadata", error_description: "Client metadata is required." }, 400);
    }

    const metadataResult = parseClientRegistrationMetadata(body);
    if (!metadataResult.ok) {
      return c.json({ error: "invalid_client_metadata", error_description: metadataResult.error }, 400);
    }

    const webhookResult = parseWebhookRegistration(body);
    if (!webhookResult.ok) {
      return c.json({ error: "invalid_client_metadata", error_description: webhookResult.error }, 400);
    }

    const clientId = createId("ocl");
    const issuedAt = new Date();
    const metadata = { ...metadataResult.metadata, clientId };
    // The signing secret is returned exactly once, here, and is otherwise only
    // ever read by the delivery dispatcher — never echoed in list/detail reads.
    const signingSecret = webhookResult.registration ? generateAgentWebhookSigningSecret() : null;
    await options.auth.db.query(
      `INSERT INTO identity_ucp_oauth_clients (
         client_id,
         client_name,
         client_uri,
         platform_profile_url,
         redirect_uris,
         scopes,
         grant_types,
         response_types,
         token_endpoint_auth_method,
         client_id_issued_at,
         webhook_callback_url,
         webhook_signing_secret,
         webhook_signing_secret_created_at
       ) VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7::jsonb, $8::jsonb, $9, $10::timestamptz, $11, $12, $13::timestamptz)`,
      [
        clientId,
        metadata.clientName ?? null,
        metadata.clientUri ?? null,
        metadata.platformProfileUrl,
        JSON.stringify(metadata.redirectUris),
        JSON.stringify(metadata.scopes),
        JSON.stringify(metadata.grantTypes),
        JSON.stringify(metadata.responseTypes),
        metadata.tokenEndpointAuthMethod,
        issuedAt.toISOString(),
        webhookResult.registration?.callbackUrl ?? null,
        signingSecret,
        signingSecret ? issuedAt.toISOString() : null,
      ],
    );

    return c.json(
      {
        client_id: clientId,
        client_id_issued_at: Math.floor(issuedAt.getTime() / 1000),
        client_name: metadata.clientName ?? undefined,
        client_uri: metadata.clientUri ?? undefined,
        platform_profile_url: metadata.platformProfileUrl,
        redirect_uris: metadata.redirectUris,
        scope: metadata.scopes.join(" "),
        grant_types: metadata.grantTypes,
        response_types: metadata.responseTypes,
        token_endpoint_auth_method: "none",
        webhook:
          webhookResult.registration && signingSecret
            ? {
                callback_url: webhookResult.registration.callbackUrl,
                signing_secret: signingSecret,
                signing_secret_preview: previewAgentWebhookSigningSecret(signingSecret),
              }
            : undefined,
      },
      201,
    );
  });

  app.get("/authorize", async (c) => {
    const url = new URL(c.req.url);
    const redirectUri = url.searchParams.get("redirect_uri")?.trim() ?? "";
    const clientId = url.searchParams.get("client_id")?.trim() ?? "";
    const responseType = url.searchParams.get("response_type")?.trim() ?? "";
    const state = url.searchParams.get("state")?.trim() ?? null;
    const scopes = normalizeRequestedScopes(url.searchParams.get("scope"));
    const codeChallenge = url.searchParams.get("code_challenge")?.trim() ?? "";
    const codeChallengeMethod = url.searchParams.get("code_challenge_method")?.trim() ?? "";

    if (!scopes) {
      return c.json({ error: "invalid_scope", error_description: "Requested scopes are not supported." }, 400);
    }

    if (
      responseType !== "code" ||
      !clientId ||
      !isTrustedHttpUrl(redirectUri) ||
      codeChallengeMethod !== "S256" ||
      !isPkceChallenge(codeChallenge)
    ) {
      return c.json(
        {
          error: "invalid_request",
          error_description: "response_type=code, client_id, trusted redirect_uri, and PKCE S256 are required.",
        },
        400,
      );
    }

    const client = await resolveOAuthClientMetadata(options, clientId);
    if (!client) {
      return c.json(
        {
          error: "invalid_client",
          error_description:
            "client_id must identify a registered public OAuth client or a trusted Client ID Metadata Document.",
        },
        400,
      );
    }
    if (!client.responseTypes.includes("code") || !client.grantTypes.includes("authorization_code")) {
      return c.json({ error: "unauthorized_client" }, 400);
    }
    if (!client.redirectUris.includes(redirectUri)) {
      return c.json(
        { error: "invalid_request", error_description: "redirect_uri is not registered for this client." },
        400,
      );
    }
    if (!isScopeSubset(scopes, client.scopes)) {
      return c.json(
        { error: "invalid_scope", error_description: "Requested scopes exceed the registered client metadata." },
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
        client.platformProfileUrl,
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
    const mandate = await options.agentGrantConsent?.resolveMandate(authorization.authorization_id);
    return c.json({
      active: true,
      client_id: authorization.client_id,
      username: authorization.user_id,
      sub: authorization.user_id,
      account_id: authorization.account_id,
      platform_profile_url: authorization.platform_profile_url,
      scope: scopes.join(" "),
      exp: Math.floor(new Date(authorization.access_token_expires_at).getTime() / 1000),
      ...(mandate ? { spending_mandate: mandateToJson(mandate) } : {}),
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
    const consent = options.agentGrantConsent;
    return c.json({
      authorizations: await Promise.all(
        authorizations.map(async (authorization) => {
          const [mandate, spend] = consent
            ? await Promise.all([
                consent.resolveMandate(authorization.authorization_id),
                consent.getSpendSummary(authorization.authorization_id),
              ])
            : [undefined, undefined];
          return {
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
            ...(mandate ? { spending_mandate: mandateToJson(mandate) } : {}),
            ...(spend ? { spend: { daily_cents: spend.dailyCents, monthly_cents: spend.monthlyCents } } : {}),
          };
        }),
      ),
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

  // Configure the spending mandate for a linked agent grant. This is the opt-in a person
  // makes (during consent or the connected-agents UI) to move off the conservative default.
  app.put("/authorizations/:id/mandate", async (c) => {
    if (!options.agentGrantConsent) {
      return c.json({ error: "unsupported", error_description: "Spending mandates are not configured." }, 404);
    }

    const actor = await options.resolveActor(c.req.raw);
    if (!actor) {
      return c.json({ error: "login_required" }, 401);
    }

    const authorizationId = c.req.param("id");
    const authorizations = await options.linkedPlatformAuthorizations.listForAccount(actor.accountId);
    if (!authorizations.some((authorization) => authorization.authorization_id === authorizationId)) {
      return c.json({ error: "not_found", error_description: "No linked agent grant matches this account." }, 404);
    }

    const body = readObject(await c.req.json().catch(() => null));
    const parsed = parseSpendingMandate(body);
    if (!parsed.ok) {
      return c.json({ error: "invalid_request", error_description: parsed.error }, 400);
    }

    await options.agentGrantConsent.setMandate({
      grantId: authorizationId,
      accountId: actor.accountId,
      mandate: parsed.mandate,
    });
    const mandate = await options.agentGrantConsent.resolveMandate(authorizationId);
    return c.json({ spending_mandate: mandateToJson(mandate) });
  });

  return app;
}

function mandateToJson(mandate: AgentSpendingMandate) {
  return {
    max_per_order_cents: mandate.maxPerOrderCents,
    daily_cap_cents: mandate.dailyCapCents,
    monthly_cap_cents: mandate.monthlyCapCents,
    human_present_required: mandate.humanPresentRequired,
    allowed_rails: mandate.allowedRails,
  };
}

function parseSpendingMandate(
  body: Readonly<Record<string, unknown>> | null,
): { ok: true; mandate: AgentSpendingMandate } | { ok: false; error: string } {
  if (!body) {
    return { ok: false, error: "A spending mandate body is required." };
  }

  const maxPerOrderCents = readCentsOrNull(body.max_per_order_cents);
  const dailyCapCents = readCentsOrNull(body.daily_cap_cents);
  const monthlyCapCents = readCentsOrNull(body.monthly_cap_cents);
  if (maxPerOrderCents === "invalid" || dailyCapCents === "invalid" || monthlyCapCents === "invalid") {
    return { ok: false, error: "Spending caps must be non-negative integer cent amounts or null." };
  }

  const rawRails = body.allowed_rails;
  if (!Array.isArray(rawRails) || rawRails.length === 0 || !rawRails.every(isAgentGrantRail)) {
    return { ok: false, error: "allowed_rails must list one or more supported payment rails." };
  }

  return {
    ok: true,
    mandate: {
      maxPerOrderCents,
      dailyCapCents,
      monthlyCapCents,
      humanPresentRequired: body.human_present_required !== false,
      allowedRails: [...new Set(rawRails)],
    },
  };
}

function readCentsOrNull(value: unknown): number | null | "invalid" {
  if (value === null || value === undefined) {
    return null;
  }
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : "invalid";
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
  return normalizeAgentOAuthScopes(value, UCP_OAUTH_DEFAULT_SCOPES);
}

function parseClientRegistrationMetadata(
  body: Readonly<Record<string, unknown>>,
): { ok: true; metadata: Omit<OAuthClientMetadata, "clientId"> } | { ok: false; error: string } {
  if (readString(body.client_secret) || readString(body.jwks_uri) || readObject(body.jwks)) {
    return { ok: false, error: "Confidential client credentials are not supported for agent-platform clients." };
  }

  const tokenEndpointAuthMethod = readString(body.token_endpoint_auth_method) ?? "none";
  if (tokenEndpointAuthMethod !== "none") {
    return { ok: false, error: "Only public clients using token_endpoint_auth_method=none are supported." };
  }

  const grantTypes = normalizeStringArray(body.grant_types, ["authorization_code", "refresh_token"]);
  if (!grantTypes.every((grantType) => grantType === "authorization_code" || grantType === "refresh_token")) {
    return { ok: false, error: "Only authorization_code and refresh_token grants are supported." };
  }
  if (!grantTypes.includes("authorization_code")) {
    return { ok: false, error: "authorization_code is required." };
  }

  const responseTypes = normalizeStringArray(body.response_types, ["code"]);
  if (responseTypes.length !== 1 || responseTypes[0] !== "code") {
    return { ok: false, error: "Only response_type code is supported." };
  }

  const redirectUris = normalizeStringArray(body.redirect_uris);
  if (redirectUris.length === 0) {
    return { ok: false, error: "At least one redirect_uri is required." };
  }
  if (redirectUris.length > MAX_REDIRECT_URIS) {
    return { ok: false, error: `No more than ${MAX_REDIRECT_URIS} redirect_uris are supported.` };
  }
  if (redirectUris.some((redirectUri) => redirectUri.length > MAX_CLIENT_METADATA_URL_LENGTH)) {
    return { ok: false, error: "redirect_uris are too long." };
  }
  if (!redirectUris.every(isTrustedHttpUrl)) {
    return { ok: false, error: "redirect_uris must be HTTPS URLs or localhost HTTP URLs." };
  }
  if (redirectUris.some((redirectUri) => new URL(redirectUri).hash)) {
    return { ok: false, error: "redirect_uris must not include fragments." };
  }

  const scopes = normalizeRequestedScopes(body.scope);
  if (!scopes) {
    return { ok: false, error: "scope contains unsupported OAuth scopes." };
  }

  const clientUri = readString(body.client_uri);
  const platformProfileUrl = readString(body.platform_profile_url) ?? clientUri;
  const clientName = readString(body.client_name);
  if (clientName && clientName.length > MAX_CLIENT_NAME_LENGTH) {
    return { ok: false, error: "client_name is too long." };
  }
  if (!platformProfileUrl || !isTrustedHttpUrl(platformProfileUrl)) {
    return { ok: false, error: "A trusted platform_profile_url or client_uri is required." };
  }
  if (
    platformProfileUrl.length > MAX_CLIENT_METADATA_URL_LENGTH ||
    (clientUri?.length ?? 0) > MAX_CLIENT_METADATA_URL_LENGTH
  ) {
    return { ok: false, error: "Client metadata URLs are too long." };
  }
  if (clientUri && !isTrustedHttpUrl(clientUri)) {
    return { ok: false, error: "client_uri must be an HTTPS URL or localhost HTTP URL." };
  }

  return {
    ok: true,
    metadata: {
      clientName: clientName ?? null,
      clientUri: clientUri ?? null,
      platformProfileUrl,
      redirectUris,
      scopes,
      grantTypes,
      responseTypes,
      tokenEndpointAuthMethod: "none",
    },
  };
}

async function resolveOAuthClientMetadata(options: UcpOAuthRoutesOptions, clientId: string) {
  const registered = await readRegisteredOAuthClient(options.auth, clientId);
  if (registered) {
    return registered;
  }
  if (!isTrustedHttpUrl(clientId)) {
    return null;
  }
  return readClientIdMetadataDocument(options, clientId);
}

async function readRegisteredOAuthClient(auth: AuthServices, clientId: string): Promise<OAuthClientMetadata | null> {
  const result = await auth.db.query<OAuthClientRow>(
    `SELECT client_id, client_name, client_uri, platform_profile_url, redirect_uris, scopes,
            grant_types, response_types, token_endpoint_auth_method
     FROM identity_ucp_oauth_clients
     WHERE client_id = $1
     LIMIT 1`,
    [clientId],
  );
  const row = result.rows[0];
  if (!row || row.token_endpoint_auth_method !== "none") {
    return null;
  }
  return {
    clientId: row.client_id,
    clientName: row.client_name,
    clientUri: row.client_uri,
    platformProfileUrl: row.platform_profile_url,
    redirectUris: normalizeStringArray(row.redirect_uris),
    scopes: normalizeStringArray(row.scopes),
    grantTypes: normalizeStringArray(row.grant_types),
    responseTypes: normalizeStringArray(row.response_types),
    tokenEndpointAuthMethod: "none",
  };
}

async function readClientIdMetadataDocument(
  options: UcpOAuthRoutesOptions,
  clientId: string,
): Promise<OAuthClientMetadata | null> {
  const fetchMetadata =
    options.fetchClientIdMetadata ??
    (async (url: string) => {
      const response = await fetch(url, { headers: { Accept: "application/json" }, redirect: "error" });
      if (!response.ok) {
        return null;
      }
      return response.json();
    });
  const body = readObject(await fetchMetadata(clientId).catch(() => null));
  if (!body) {
    return null;
  }
  const parsed = parseClientRegistrationMetadata(body);
  if (!parsed.ok) {
    return null;
  }
  const documentClientId = readString(body.client_id);
  if (documentClientId && documentClientId !== clientId) {
    return null;
  }
  return { ...parsed.metadata, clientId };
}

function normalizeRequestedScopes(value: unknown): readonly string[] | null {
  const raw = typeof value === "string" && value.trim().length > 0 ? value.split(/\s+/) : [];
  if (raw.length === 0) {
    return UCP_OAUTH_DEFAULT_SCOPES;
  }
  const requested = raw.map((entry) => entry.trim()).filter(Boolean);
  return requested.every(isAgentOAuthScope) ? normalizeAgentOAuthScopes(requested) : null;
}

function normalizeStringArray(value: unknown, fallback: readonly string[] = []): readonly string[] {
  if (!Array.isArray(value)) {
    return fallback;
  }
  return [...new Set(value.filter((entry): entry is string => typeof entry === "string").map((entry) => entry.trim()))]
    .filter(Boolean)
    .sort();
}

function isScopeSubset(requested: readonly string[], allowed: readonly string[]) {
  const allowedSet = new Set(allowed);
  return requested.every((scope) => allowedSet.has(scope));
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
