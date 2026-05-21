import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { buildFilteredQuery, executeListQuery, type ListParams } from "../../../support/read-model-support/list-query";

export type ApiKeyRow = Readonly<{
  api_key_id: string;
  user_id: string;
  name: string;
  key_prefix: string;
  status: string;
  last_used_at: string | null;
  updated_at: string;
}>;

export async function listApiKeys(db: PgQueryable, params: ListParams = {}) {
  const query = buildFilteredQuery("identity_api_keys", params, ["name", "user_id", "key_prefix"], "updated_at DESC");
  return executeListQuery<ApiKeyRow>(db, query.countSql, query.listSql, query.values);
}

export async function getApiKey(db: PgQueryable, apiKeyId: string) {
  const result = await db.query<ApiKeyRow>(`SELECT * FROM identity_api_keys WHERE api_key_id = $1`, [apiKeyId]);
  return result.rows[0] ?? null;
}
