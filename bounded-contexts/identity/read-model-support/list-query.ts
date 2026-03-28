import type { PgQueryable } from "@chase-sets/event-core-postgres";

export type ListParams = Readonly<{
  search?: string;
  status?: string;
  limit?: number;
  offset?: number;
}>;

export type ListResult<T> = Readonly<{
  items: T[];
  total: number;
}>;

export function buildFilteredQuery(
  baseTable: string,
  params: ListParams,
  searchColumns: readonly string[],
  orderBy: string,
  extraConditions: readonly string[] = [],
  extraValues: readonly unknown[] = [],
): Readonly<{
  countSql: string;
  listSql: string;
  values: readonly unknown[];
}> {
  const conditions = [...extraConditions];
  const values = [...extraValues];
  let paramIndex = extraValues.length + 1;

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

export async function executeListQuery<T>(
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
