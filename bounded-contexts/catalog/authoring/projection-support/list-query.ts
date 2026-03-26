import type { PgQueryable } from "@chase-sets/event-core-postgres";

export type ListParams = {
  search?: string;
  status?: string;
  limit?: number;
  offset?: number;
};

export type ListResult<T> = {
  items: T[];
  total: number;
};

export function buildFilteredQuery(
  baseTable: string,
  params: ListParams,
  searchColumns: string[],
  orderBy: string,
  extraConditions: string[] = [],
  extraValues: unknown[] = [],
): { countSql: string; listSql: string; values: unknown[] } {
  const conditions = [...extraConditions];
  const values = [...extraValues];
  let paramIndex = extraValues.length + 1;

  if (params.status) {
    conditions.push(`status = $${paramIndex}`);
    values.push(params.status);
    paramIndex++;
  }

  if (params.search) {
    const likeClauses = searchColumns.map((column) => `${column} ILIKE $${paramIndex}`);
    conditions.push(`(${likeClauses.join(" OR ")})`);
    values.push(`%${params.search}%`);
    paramIndex++;
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const limit = params.limit ?? 50;
  const offset = params.offset ?? 0;

  return {
    countSql: `SELECT COUNT(*) as count FROM ${baseTable} ${where}`,
    listSql: `SELECT * FROM ${baseTable} ${where} ORDER BY ${orderBy} LIMIT ${limit} OFFSET ${offset}`,
    values,
  };
}

export async function executeListQuery<T>(
  db: PgQueryable,
  countSql: string,
  listSql: string,
  values: unknown[],
): Promise<ListResult<T>> {
  const [countResult, listResult] = await Promise.all([
    db.query<{ count: string }>(countSql, values),
    db.query<T>(listSql, values),
  ]);

  return {
    items: listResult.rows,
    total: Number.parseInt(countResult.rows[0].count, 10),
  };
}

