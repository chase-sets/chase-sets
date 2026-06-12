import { executeListQuery, type ListParams, type PgQueryable } from "@chase-sets/event-core-postgres";

export type ApiKeyRow = Readonly<{
  api_key_id: string;
  user_id: string;
  user_display_name: string | null;
  user_primary_email: string | null;
  name: string;
  key_prefix: string;
  status: string;
  last_used_at: string | null;
  updated_at: string;
}>;

export async function listApiKeys(db: PgQueryable, params: ListParams = {}) {
  const conditions: string[] = [];
  const values: unknown[] = [];
  let paramIndex = 1;

  if (params.status) {
    conditions.push(`api_keys.status = $${paramIndex}`);
    values.push(params.status);
    paramIndex += 1;
  }

  if (params.search) {
    conditions.push(`(
      api_keys.name ILIKE $${paramIndex}
      OR api_keys.user_id ILIKE $${paramIndex}
      OR api_keys.key_prefix ILIKE $${paramIndex}
      OR users.display_name ILIKE $${paramIndex}
      OR users.primary_email ILIKE $${paramIndex}
    )`);
    values.push(`%${params.search}%`);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const from = `FROM identity_api_keys AS api_keys
     LEFT JOIN identity_users AS users ON users.user_id = api_keys.user_id`;
  const limit = params.limit ?? 50;
  const offset = params.offset ?? 0;

  return executeListQuery<ApiKeyRow>(
    db,
    `SELECT COUNT(*) AS count ${from} ${where}`,
    `SELECT api_keys.api_key_id,
            api_keys.user_id,
            users.display_name AS user_display_name,
            users.primary_email AS user_primary_email,
            api_keys.name,
            api_keys.key_prefix,
            api_keys.status,
            api_keys.last_used_at,
            api_keys.updated_at
     ${from}
     ${where}
     ORDER BY api_keys.updated_at DESC
     LIMIT ${limit} OFFSET ${offset}`,
    values,
  );
}

export async function getApiKey(db: PgQueryable, apiKeyId: string) {
  const result = await db.query<ApiKeyRow>(
    `SELECT api_keys.api_key_id,
            api_keys.user_id,
            users.display_name AS user_display_name,
            users.primary_email AS user_primary_email,
            api_keys.name,
            api_keys.key_prefix,
            api_keys.status,
            api_keys.last_used_at,
            api_keys.updated_at
     FROM identity_api_keys AS api_keys
     LEFT JOIN identity_users AS users ON users.user_id = api_keys.user_id
     WHERE api_keys.api_key_id = $1`,
    [apiKeyId],
  );
  return result.rows[0] ?? null;
}
