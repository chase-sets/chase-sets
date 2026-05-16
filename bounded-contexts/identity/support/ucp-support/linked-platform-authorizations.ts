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
  revoked_at timestamptz NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

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
  revoked_at: string | null;
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
  revokeToken: (tokenHash: string, revokedAt: string) => Promise<boolean>;
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
    revokeToken: async (tokenHash, revokedAt) => {
      const result = await db.query(
        `UPDATE identity_linked_platform_authorizations
         SET status = 'revoked',
             revoked_at = $2::timestamptz,
             updated_at = now()
         WHERE status = 'active'
           AND (access_token_hash = $1 OR refresh_token_hash = $1)`,
        [tokenHash, revokedAt],
      );
      return (result.rowCount ?? 0) > 0;
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
