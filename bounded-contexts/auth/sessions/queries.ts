import type { PgQueryable } from "@chase-sets/event-core-postgres";

type ListParams = Readonly<{
  search?: string;
  status?: string;
  limit?: number;
  offset?: number;
}>;

type ListResult<T> = Readonly<{
  items: T[];
  total: number;
}>;

function buildFilteredQuery(
  baseTable: string,
  params: ListParams,
  searchColumns: readonly string[],
  orderBy: string,
) {
  const conditions: string[] = [];
  const values: unknown[] = [];
  let paramIndex = 1;

  if (params.status) {
    conditions.push(`status = $${paramIndex}`);
    values.push(params.status);
    paramIndex += 1;
  }

  if (params.search) {
    const clauses = searchColumns.map((column) => `${column} ILIKE $${paramIndex}`);
    conditions.push(`(${clauses.join(" OR ")})`);
    values.push(`%${params.search}%`);
    paramIndex += 1;
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const limit = params.limit ?? 50;
  const offset = params.offset ?? 0;

  return {
    countSql: `SELECT COUNT(*) AS count FROM ${baseTable} ${where}`,
    listSql: `SELECT * FROM ${baseTable} ${where} ORDER BY ${orderBy} LIMIT ${limit} OFFSET ${offset}`,
    values,
  };
}

async function executeListQuery<T>(
  db: PgQueryable,
  countSql: string,
  listSql: string,
  values: readonly unknown[],
): Promise<ListResult<T>> {
  const [countResult, listResult] = await Promise.all([
    db.query<{ count: string }>(countSql, values),
    db.query<T>(listSql, values),
  ]);

  return {
    items: listResult.rows,
    total: Number.parseInt(countResult.rows[0]?.count ?? "0", 10),
  };
}

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
