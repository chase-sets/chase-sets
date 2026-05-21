import type { PgQueryable } from "@chase-sets/event-core-postgres";

export async function upsertApiKeySecret(
  db: PgQueryable,
  params: Readonly<{
    apiKeyId: string;
    userId: string;
    keyPrefix: string;
    secretHash: string;
  }>,
) {
  await db.query(
    `INSERT INTO identity_api_key_secrets (
       api_key_id,
       user_id,
       key_prefix,
       secret_hash,
       created_at,
       updated_at
     )
     VALUES ($1, $2, $3, $4, now(), now())
     ON CONFLICT (api_key_id) DO UPDATE
     SET user_id = $2,
         key_prefix = $3,
         secret_hash = $4,
         updated_at = now()`,
    [params.apiKeyId, params.userId, params.keyPrefix, params.secretHash],
  );
}

export async function getApiKeySecretByPrefix(db: PgQueryable, keyPrefix: string) {
  const result = await db.query<{
    api_key_id: string;
    user_id: string;
    key_prefix: string;
    secret_hash: string;
  }>(
    `SELECT api_key_id, user_id, key_prefix, secret_hash
     FROM identity_api_key_secrets
     WHERE key_prefix = $1`,
    [keyPrefix],
  );

  return result.rows[0] ?? null;
}
