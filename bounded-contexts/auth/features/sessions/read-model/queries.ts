import {
  buildPaginationClause,
  escapeLikePattern,
  executeListQuery,
  type ListParams,
  type PgQueryable,
} from "@chase-sets/event-core-postgres";

export type SessionRow = Readonly<{
  session_id: string;
  user_id: string;
  user_display_name: string | null;
  user_primary_email: string | null;
  account_id: string;
  account_display_name: string | null;
  account_name: string | null;
  available_account_ids: readonly string[];
  authentication_method: string;
  status: string;
  expires_at: string;
  /**
   * The session's own moment-of-authentication, set once and never
   * overwritten by later account-switch/revoke/expire mutations. Optional at
   * the type level only so callers that construct a `SessionRow` without
   * this column (older fixtures, the in-memory rehydration fallback) still
   * type-check; every real query below selects it, and recent-auth checks
   * (`resolveRecentAuthenticationStatus`) fail closed when it is absent.
   */
  started_at?: string;
  updated_at: string;
}>;

export async function listSessions(db: PgQueryable, params: ListParams = {}) {
  const conditions: string[] = [];
  const values: unknown[] = [];
  let paramIndex = 1;

  if (params.status) {
    conditions.push(`sessions.status = $${paramIndex}`);
    values.push(params.status);
    paramIndex += 1;
  }

  if (params.search) {
    conditions.push(`(
      sessions.session_id ILIKE $${paramIndex} ESCAPE '\\'
      OR sessions.user_id ILIKE $${paramIndex} ESCAPE '\\'
      OR users.display_name ILIKE $${paramIndex} ESCAPE '\\'
      OR users.primary_email ILIKE $${paramIndex} ESCAPE '\\'
      OR sessions.account_id ILIKE $${paramIndex} ESCAPE '\\'
      OR accounts.display_name ILIKE $${paramIndex} ESCAPE '\\'
      OR accounts.name ILIKE $${paramIndex} ESCAPE '\\'
      OR sessions.authentication_method ILIKE $${paramIndex} ESCAPE '\\'
    )`);
    values.push(`%${escapeLikePattern(params.search)}%`);
    paramIndex += 1;
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const from = `FROM identity_sessions AS sessions
     LEFT JOIN auth_identity_users AS users ON users.user_id = sessions.user_id
     LEFT JOIN auth_identity_accounts AS accounts ON accounts.account_id = sessions.account_id`;
  const pagination = buildPaginationClause(params, paramIndex);

  return executeListQuery<SessionRow>(
    db,
    `SELECT COUNT(*) AS count ${from} ${where}`,
    `SELECT sessions.session_id,
            sessions.user_id,
            users.display_name AS user_display_name,
            users.primary_email AS user_primary_email,
            sessions.account_id,
            accounts.display_name AS account_display_name,
            accounts.name AS account_name,
            sessions.available_account_ids,
            sessions.authentication_method,
            sessions.status,
            sessions.expires_at,
            sessions.started_at,
            sessions.updated_at
     ${from}
     ${where}
     ORDER BY sessions.updated_at DESC
     ${pagination.sql}`,
    values,
    [...values, ...pagination.values],
  );
}

export async function getSession(db: PgQueryable, sessionId: string) {
  const result = await db.query<SessionRow>(
    `SELECT sessions.session_id,
            sessions.user_id,
            users.display_name AS user_display_name,
            users.primary_email AS user_primary_email,
            sessions.account_id,
            accounts.display_name AS account_display_name,
            accounts.name AS account_name,
            sessions.available_account_ids,
            sessions.authentication_method,
            sessions.status,
            sessions.expires_at,
            sessions.started_at,
            sessions.updated_at
     FROM identity_sessions AS sessions
     LEFT JOIN auth_identity_users AS users ON users.user_id = sessions.user_id
     LEFT JOIN auth_identity_accounts AS accounts ON accounts.account_id = sessions.account_id
     WHERE sessions.session_id = $1`,
    [sessionId],
  );
  return result.rows[0] ?? null;
}
