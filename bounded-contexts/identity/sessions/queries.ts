import type { PgQueryable } from "@chase-sets/event-core-postgres";
import {
  buildFilteredQuery,
  executeListQuery,
  type ListParams,
} from "../read-model-support/list-query";

export type SessionRow = Readonly<{
  session_id: string;
  user_id: string;
  account_id: string;
  available_account_ids: readonly string[];
  authentication_method: string;
  status: string;
  expires_at: string;
  updated_at: string;
}>;

export async function listSessions(
  db: PgQueryable,
  params: ListParams = {},
) {
  const query = buildFilteredQuery(
    "identity_sessions",
    params,
    ["session_id", "user_id", "account_id", "authentication_method"],
    "updated_at DESC",
  );
  return executeListQuery<SessionRow>(db, query.countSql, query.listSql, query.values);
}

export async function getSession(db: PgQueryable, sessionId: string) {
  const result = await db.query<SessionRow>(
    `SELECT * FROM identity_sessions WHERE session_id = $1`,
    [sessionId],
  );
  return result.rows[0] ?? null;
}
