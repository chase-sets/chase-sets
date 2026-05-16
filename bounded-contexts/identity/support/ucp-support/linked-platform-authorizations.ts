import type { PgQueryable } from "@chase-sets/event-core-postgres";

export const identityLinkedPlatformAuthorizationSchemaSql = `
CREATE TABLE IF NOT EXISTS identity_linked_platform_authorizations (
  authorization_id text PRIMARY KEY,
  platform_profile_url text NOT NULL,
  client_id text NOT NULL,
  user_id text NOT NULL,
  account_id text NOT NULL,
  scopes jsonb NOT NULL DEFAULT '[]'::jsonb,
  status text NOT NULL,
  access_token_hash text NOT NULL UNIQUE,
  refresh_token_hash text NULL UNIQUE,
  access_token_expires_at timestamptz NOT NULL,
  refresh_token_expires_at timestamptz NULL,
  granted_at timestamptz NOT NULL,
  last_refreshed_at timestamptz NULL,
  refresh_token_rotated_at timestamptz NULL,
  revoked_at timestamptz NULL,
  revocation_reason text NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE identity_linked_platform_authorizations
  ADD COLUMN IF NOT EXISTS last_refreshed_at timestamptz NULL;

ALTER TABLE identity_linked_platform_authorizations
  ADD COLUMN IF NOT EXISTS refresh_token_rotated_at timestamptz NULL;

ALTER TABLE identity_linked_platform_authorizations
  ADD COLUMN IF NOT EXISTS revocation_reason text NULL;

CREATE INDEX IF NOT EXISTS identity_linked_platform_authorizations_access_token_idx
  ON identity_linked_platform_authorizations (access_token_hash)
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS identity_linked_platform_authorizations_account_idx
  ON identity_linked_platform_authorizations (account_id, status);
`;

export type LinkedPlatformAuthorizationRow = Readonly<{
  authorization_id: string;
  platform_profile_url: string;
  client_id: string;
  user_id: string;
  account_id: string;
  scopes: readonly string[];
  status: string;
  access_token_hash: string;
  refresh_token_hash: string | null;
  access_token_expires_at: string;
  refresh_token_expires_at: string | null;
  granted_at: string;
  last_refreshed_at: string | null;
  refresh_token_rotated_at: string | null;
  revoked_at: string | null;
  revocation_reason: string | null;
  updated_at: string;
}>;

export type LinkedPlatformAuthorizationStore = Readonly<{
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
  }>) => Promise<LinkedPlatformAuthorizationRow>;
  resolveAccessToken: (
    accessTokenHash: string,
  ) => Promise<LinkedPlatformAuthorizationRow | null>;
  resolveToken: (tokenHash: string) => Promise<LinkedPlatformAuthorizationRow | null>;
  rotateRefreshToken: (params: Readonly<{
    refreshTokenHash: string;
    newAccessTokenHash: string;
    newRefreshTokenHash: string;
    accessTokenExpiresAt: string;
    refreshTokenExpiresAt: string;
    refreshedAt: string;
  }>) => Promise<LinkedPlatformAuthorizationRow | null>;
  revokeToken: (tokenHash: string, revokedAt: string) => Promise<boolean>;
  revokeAuthorization: (params: Readonly<{
    authorizationId: string;
    accountId: string;
    revokedAt: string;
    reason?: string | null;
  }>) => Promise<boolean>;
  listForAccount: (accountId: string) => Promise<readonly LinkedPlatformAuthorizationRow[]>;
}>;

export function createLinkedPlatformAuthorizationStore(
  db: PgQueryable,
): LinkedPlatformAuthorizationStore {
  return {
    grant: async (params) => {
      const result = await db.query<LinkedPlatformAuthorizationRow>(
        `INSERT INTO identity_linked_platform_authorizations (
           authorization_id,
           platform_profile_url,
           client_id,
           user_id,
           account_id,
           scopes,
           status,
           access_token_hash,
           refresh_token_hash,
           access_token_expires_at,
           refresh_token_expires_at,
           granted_at,
           updated_at
         ) VALUES (
           $1,
           $2,
           $3,
           $4,
           $5,
           $6::jsonb,
           'active',
           $7,
           $8,
           $9::timestamptz,
           $10::timestamptz,
           $11::timestamptz,
           now()
         )
         RETURNING *`,
        [
          params.authorizationId,
          params.platformProfileUrl,
          params.clientId,
          params.userId,
          params.accountId,
          JSON.stringify([...new Set(params.scopes)].sort()),
          params.accessTokenHash,
          params.refreshTokenHash ?? null,
          params.accessTokenExpiresAt,
          params.refreshTokenExpiresAt ?? null,
          params.grantedAt,
        ],
      );
      return mapLinkedPlatformAuthorizationRow(result.rows[0]);
    },
    resolveAccessToken: async (accessTokenHash) => {
      const result = await db.query<LinkedPlatformAuthorizationRow>(
        `SELECT *
         FROM identity_linked_platform_authorizations
         WHERE access_token_hash = $1
           AND status = 'active'
           AND access_token_expires_at > now()
         LIMIT 1`,
        [accessTokenHash],
      );
      return result.rows[0]
        ? mapLinkedPlatformAuthorizationRow(result.rows[0])
        : null;
    },
    resolveToken: async (tokenHash) => {
      const result = await db.query<LinkedPlatformAuthorizationRow>(
        `SELECT *
         FROM identity_linked_platform_authorizations
         WHERE status = 'active'
           AND (
             (access_token_hash = $1 AND access_token_expires_at > now())
             OR
             (refresh_token_hash = $1 AND refresh_token_expires_at IS NOT NULL AND refresh_token_expires_at > now())
           )
         LIMIT 1`,
        [tokenHash],
      );
      return result.rows[0]
        ? mapLinkedPlatformAuthorizationRow(result.rows[0])
        : null;
    },
    rotateRefreshToken: async (params) => {
      const result = await db.query<LinkedPlatformAuthorizationRow>(
        `UPDATE identity_linked_platform_authorizations
         SET access_token_hash = $2,
             refresh_token_hash = $3,
             access_token_expires_at = $4::timestamptz,
             refresh_token_expires_at = $5::timestamptz,
             last_refreshed_at = $6::timestamptz,
             refresh_token_rotated_at = $6::timestamptz,
             updated_at = now()
         WHERE refresh_token_hash = $1
           AND status = 'active'
           AND refresh_token_expires_at IS NOT NULL
           AND refresh_token_expires_at > now()
         RETURNING *`,
        [
          params.refreshTokenHash,
          params.newAccessTokenHash,
          params.newRefreshTokenHash,
          params.accessTokenExpiresAt,
          params.refreshTokenExpiresAt,
          params.refreshedAt,
        ],
      );
      return result.rows[0]
        ? mapLinkedPlatformAuthorizationRow(result.rows[0])
        : null;
    },
    revokeToken: async (tokenHash, revokedAt) => {
      const result = await db.query(
        `UPDATE identity_linked_platform_authorizations
         SET status = 'revoked',
             revoked_at = $2::timestamptz,
             revocation_reason = COALESCE(revocation_reason, 'token_revocation'),
             updated_at = now()
         WHERE status = 'active'
           AND (access_token_hash = $1 OR refresh_token_hash = $1)`,
        [tokenHash, revokedAt],
      );
      return (result.rowCount ?? 0) > 0;
    },
    revokeAuthorization: async (params) => {
      const result = await db.query(
        `UPDATE identity_linked_platform_authorizations
         SET status = 'revoked',
             revoked_at = $3::timestamptz,
             revocation_reason = $4,
             updated_at = now()
         WHERE authorization_id = $1
           AND account_id = $2
           AND status = 'active'`,
        [
          params.authorizationId,
          params.accountId,
          params.revokedAt,
          params.reason ?? "account_consent_revoked",
        ],
      );
      return (result.rowCount ?? 0) > 0;
    },
    listForAccount: async (accountId) => {
      const result = await db.query<LinkedPlatformAuthorizationRow>(
        `SELECT *
         FROM identity_linked_platform_authorizations
         WHERE account_id = $1
         ORDER BY granted_at DESC, authorization_id DESC`,
        [accountId],
      );
      return result.rows.map(mapLinkedPlatformAuthorizationRow);
    },
  };
}

function mapLinkedPlatformAuthorizationRow(
  row: LinkedPlatformAuthorizationRow,
): LinkedPlatformAuthorizationRow {
  return {
    ...row,
    scopes: Array.isArray(row.scopes) ? row.scopes : [],
  };
}
