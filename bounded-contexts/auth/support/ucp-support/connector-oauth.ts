import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { CHANNEL_CONNECTOR_SCOPE_FAMILY, type ResolvedActor } from "@chase-sets/auth-context";
import { withPgTransaction, type PgQueryable } from "@chase-sets/event-core-postgres";
import type { AuthServices } from "../runtime-support/services";
import { resolveActorFromRequest } from "../runtime-support/runtime";
import { authSecurityLifetimesOf } from "../../features/sessions/domain/auth-flow";

export class ConnectorOAuthError extends Error {
  constructor(readonly code: "invalid-request" | "invalid-credential" | "authorization-refused" | "unavailable") {
    super(code);
  }
}

export type ConnectorGrant = Readonly<{
  grantId: string;
  connectionId: string;
  accountId: string;
  pairingId: string;
  userId: string;
  clientId: string;
  revision: number;
  expiresAt: string;
  valid: boolean;
}>;
export type ConnectorGrantBinding = Pick<ConnectorGrant, "connectionId" | "accountId" | "pairingId" | "userId">;
type GrantRow = {
  grant_id: string;
  connection_id: string;
  account_id: string;
  pairing_id: string;
  user_id: string;
  client_id: string;
  revision: number;
  expires_at: Date | string;
  revoked_at: Date | string | null;
  code_hash: string | null;
  code_challenge: string;
  code_expires_at: Date | string;
  access_hash: string | null;
  access_expires_at: Date | string | null;
  refresh_hash: string | null;
};

export function connectorSecretDigest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function compareConnectorSecret(value: string, digest: string): boolean {
  const expected = /^[a-f0-9]{64}$/.test(digest) ? digest : "0".repeat(64);
  return timingSafeEqual(Buffer.from(connectorSecretDigest(value), "hex"), Buffer.from(expected, "hex"));
}

export function connectorRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !keys.includes(key))
  )
    throw new ConnectorOAuthError("invalid-request");
  return Object.fromEntries(Object.entries(value));
}
export function connectorString(value: unknown, max = 512): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max || /[\s\x00-\x1f\x7f]/.test(value))
    throw new ConnectorOAuthError("invalid-request");
  return value;
}
function pkce(value: unknown): string {
  const result = connectorString(value, 128);
  if (!/^[A-Za-z0-9._~-]{43,128}$/.test(result)) throw new ConnectorOAuthError("invalid-request");
  return result;
}
function redirect(value: unknown): string {
  const result = connectorString(value, 2048);
  let url: URL;
  try {
    url = new URL(result);
  } catch {
    throw new ConnectorOAuthError("invalid-request");
  }
  if (
    url.username ||
    url.password ||
    url.hash ||
    (url.protocol !== "https:" &&
      !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))
  )
    throw new ConnectorOAuthError("invalid-request");
  return result;
}

export function createConnectorOAuthService(getAuth: () => AuthServices, now = () => new Date()) {
  function grant(row: GrantRow): ConnectorGrant {
    return {
      grantId: row.grant_id,
      connectionId: row.connection_id,
      accountId: row.account_id,
      pairingId: row.pairing_id,
      userId: row.user_id,
      clientId: row.client_id,
      revision: row.revision,
      expiresAt: new Date(row.expires_at).toISOString(),
      valid: row.revoked_at === null && new Date(row.expires_at).getTime() > now().getTime(),
    };
  }
  async function readGrant(grantId: string): Promise<ConnectorGrant | null> {
    connectorString(grantId);
    const db: PgQueryable = getAuth().db;
    const result = await db.query<GrantRow>("SELECT * FROM auth_connector_grants WHERE grant_id = $1", [grantId]);
    return result.rows[0] ? grant(result.rows[0]) : null;
  }
  async function resolveToken(token: string, kind: "access" | "refresh" = "access"): Promise<ConnectorGrant | null> {
    if (typeof token !== "string" || token.length > 512 || !token.startsWith(kind === "access" ? "cc_at_" : "cc_rt_"))
      return null;
    const column = kind === "access" ? "access_hash" : "refresh_hash";
    const db: PgQueryable = getAuth().db;
    const result = await db.query<GrantRow>(`SELECT * FROM auth_connector_grants WHERE ${column} = $1`, [
      connectorSecretDigest(token),
    ]);
    const row = result.rows[0];
    if (
      !compareConnectorSecret(token, row?.[column] ?? "0".repeat(64)) ||
      !row ||
      !grant(row).valid ||
      (kind === "access" && (!row.access_expires_at || new Date(row.access_expires_at).getTime() <= now().getTime()))
    )
      return null;
    return grant(row);
  }
  return {
    readGrant,
    resolveToken,
    async resolveSeller(request: Request): Promise<ResolvedActor | null> {
      const actor = await resolveActorFromRequest(getAuth(), request);
      if (!actor || actor.agentGrant || actor.roleKey === "guest-buyer") return null;
      return actor;
    },
    async hasMembership(userId: string, accountId: string): Promise<boolean> {
      const membership = await getAuth().identity.getActiveMembershipForUserAccount(userId, accountId);
      return membership !== null;
    },
    async register(input: unknown) {
      const body = connectorRecord(input, ["redirect_uri", "scope", "token_endpoint_auth_method"]);
      const redirectUri = redirect(body.redirect_uri);
      if (body.scope !== CHANNEL_CONNECTOR_SCOPE_FAMILY.scopes.join(" ") || body.token_endpoint_auth_method !== "none")
        throw new ConnectorOAuthError("invalid-request");
      const clientId = `cc_client_${randomUUID()}`;
      const db: PgQueryable = getAuth().db;
      await db.query("INSERT INTO auth_connector_clients (client_id, redirect_uri, created_at) VALUES ($1, $2, $3)", [
        clientId,
        redirectUri,
        now().toISOString(),
      ]);
      return {
        client_id: clientId,
        redirect_uri: redirectUri,
        scope: body.scope,
        token_endpoint_auth_method: "none" as const,
      };
    },
    async authorize(input: unknown, binding: ConnectorGrantBinding) {
      const body = connectorRecord(input, ["client_id", "redirect_uri", "code_challenge", "code_challenge_method"]);
      const clientId = connectorString(body.client_id);
      const redirectUri = redirect(body.redirect_uri);
      const challenge = connectorString(body.code_challenge, 43);
      if (!/^[A-Za-z0-9_-]{43}$/.test(challenge)) throw new ConnectorOAuthError("invalid-request");
      if (body.code_challenge_method !== "S256") throw new ConnectorOAuthError("invalid-request");
      const checked = connectorRecord(binding, ["connectionId", "accountId", "pairingId", "userId"]);
      for (const key of ["connectionId", "accountId", "pairingId", "userId"]) connectorString(checked[key]);
      const auth = getAuth();
      const clients = await auth.db.query<{ redirect_uri: string }>(
        "SELECT redirect_uri FROM auth_connector_clients WHERE client_id = $1",
        [clientId],
      );
      if (clients.rows[0]?.redirect_uri !== redirectUri) throw new ConnectorOAuthError("invalid-credential");
      const code = auth.auth.issueOpaqueToken("cc_code");
      const grantId = `cc_grant_${randomUUID()}`;
      const at = now();
      const lifetimes = authSecurityLifetimesOf(auth);
      const inserted = await auth.db.query(
        `INSERT INTO auth_connector_grants
        (grant_id, connection_id, account_id, pairing_id, user_id, client_id, revision, expires_at,
         code_hash, code_challenge, code_expires_at, created_at)
        VALUES ($1,$2,$3,$4,$5,$6,1,$7,$8,$9,$10,$11)
        ON CONFLICT DO NOTHING RETURNING grant_id`,
        [
          grantId,
          binding.connectionId,
          binding.accountId,
          binding.pairingId,
          binding.userId,
          clientId,
          new Date(at.getTime() + lifetimes.ucpRefreshTokenTtlMs).toISOString(),
          connectorSecretDigest(code),
          challenge,
          new Date(at.getTime() + lifetimes.ucpAuthorizationCodeTtlMs).toISOString(),
          at.toISOString(),
        ],
      );
      if (inserted.rows.length !== 1) throw new ConnectorOAuthError("invalid-credential");
      return { grantId, code };
    },
    async exchange(input: unknown) {
      const body = connectorRecord(input, [
        "grant_type",
        "client_id",
        "redirect_uri",
        "code",
        "code_verifier",
        "refresh_token",
      ]);
      const clientId = connectorString(body.client_id);
      const refreshing = body.grant_type === "refresh_token";
      if (!refreshing && body.grant_type !== "authorization_code") throw new ConnectorOAuthError("invalid-request");
      if (refreshing && [body.code, body.code_verifier, body.redirect_uri].some((value) => value !== undefined))
        throw new ConnectorOAuthError("invalid-request");
      if (!refreshing && body.refresh_token !== undefined) throw new ConnectorOAuthError("invalid-request");
      const secret = connectorString(refreshing ? body.refresh_token : body.code);
      const verifier = refreshing ? null : pkce(body.code_verifier);
      const redirectUri = refreshing ? null : redirect(body.redirect_uri);
      const auth = getAuth();
      const lifetimes = authSecurityLifetimesOf(auth);
      return withPgTransaction(auth.pool, async (db: PgQueryable) => {
        const column = refreshing ? "refresh_hash" : "code_hash";
        const result = await db.query<GrantRow>(`SELECT * FROM auth_connector_grants WHERE ${column} = $1 FOR UPDATE`, [
          connectorSecretDigest(secret),
        ]);
        const row = result.rows[0];
        if (
          !compareConnectorSecret(secret, row?.[column] ?? "0".repeat(64)) ||
          !row ||
          !grant(row).valid ||
          row.client_id !== clientId
        )
          throw new ConnectorOAuthError("invalid-credential");
        if (!refreshing) {
          const clients = await db.query<{ redirect_uri: string }>(
            "SELECT redirect_uri FROM auth_connector_clients WHERE client_id = $1",
            [clientId],
          );
          const challenge = createHash("sha256")
            .update(verifier ?? "")
            .digest("base64url");
          if (
            clients.rows[0]?.redirect_uri !== redirectUri ||
            new Date(row.code_expires_at).getTime() <= now().getTime() ||
            !compareConnectorSecret(challenge, connectorSecretDigest(row.code_challenge))
          )
            throw new ConnectorOAuthError("invalid-credential");
        }
        const accessToken = auth.auth.issueOpaqueToken("cc_at");
        const refreshToken = auth.auth.issueOpaqueToken("cc_rt");
        const at = now().getTime();
        const updated = await db.query(
          `UPDATE auth_connector_grants SET code_hash = NULL, access_hash = $1,
          access_expires_at = $2, refresh_hash = $3, expires_at = $4, revision = revision + 1
          WHERE grant_id = $5 AND revision = $6 AND revoked_at IS NULL RETURNING grant_id`,
          [
            connectorSecretDigest(accessToken),
            new Date(at + lifetimes.ucpAccessTokenTtlMs).toISOString(),
            connectorSecretDigest(refreshToken),
            new Date(at + lifetimes.ucpRefreshTokenTtlMs).toISOString(),
            row.grant_id,
            row.revision,
          ],
        );
        if (updated.rows.length !== 1) throw new ConnectorOAuthError("invalid-credential");
        return {
          grant: grant(row),
          tokens: {
            access_token: accessToken,
            refresh_token: refreshToken,
            token_type: "Bearer" as const,
            expires_in: lifetimes.ucpAccessTokenTtlMs / 1000,
            scope: CHANNEL_CONNECTOR_SCOPE_FAMILY.scopes.join(" "),
          },
        };
      });
    },
    async revoke(grantId: string): Promise<void> {
      connectorString(grantId);
      const db: PgQueryable = getAuth().db;
      await db.query(
        `UPDATE auth_connector_grants SET revoked_at = $2, revision = revision + 1,
        code_hash = NULL, access_hash = NULL, refresh_hash = NULL
        WHERE grant_id = $1 AND revoked_at IS NULL`,
        [grantId, now().toISOString()],
      );
    },
    async revokePairing(binding: ConnectorGrantBinding): Promise<void> {
      const checked = connectorRecord(binding, ["connectionId", "accountId", "pairingId", "userId"]);
      for (const key of ["connectionId", "accountId", "pairingId", "userId"]) connectorString(checked[key]);
      const db: PgQueryable = getAuth().db;
      await db.query(
        `UPDATE auth_connector_grants SET revoked_at = $5, revision = revision + 1,
        code_hash = NULL, access_hash = NULL, refresh_hash = NULL
        WHERE connection_id = $1 AND account_id = $2 AND pairing_id = $3 AND user_id = $4 AND revoked_at IS NULL`,
        [binding.connectionId, binding.accountId, binding.pairingId, binding.userId, now().toISOString()],
      );
    },
  };
}
export type ConnectorOAuthService = ReturnType<typeof createConnectorOAuthService>;
