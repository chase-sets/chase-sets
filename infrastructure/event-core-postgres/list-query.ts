import type { PgQueryable } from "./types";

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

type CountRow = Readonly<{
  count: string | number | bigint;
}>;

export function buildFilteredQuery(
  baseTable: string,
  params: ListParams,
  searchColumns: readonly string[],
  orderBy: string,
  extraConditions: readonly string[] = [],
  extraValues: readonly unknown[] = [],
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
  values: readonly unknown[],
): Promise<ListResult<T>> {
  const [countResult, listResult] = await Promise.all([
    db.query<CountRow>(countSql, values),
    db.query<T>(listSql, values),
  ]);

  return {
    items: listResult.rows,
    total: coerceListCount(countResult.rows[0]?.count),
  };
}

function coerceListCount(value: string | number | bigint | undefined): number {
  if (value === undefined) {
    throw new Error("List query count result did not include a count row.");
  }

  const parsed = typeof value === "bigint" ? Number(value) : typeof value === "string" ? Number(value) : value;

  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error("List query count must be a non-negative safe integer.");
  }

  return parsed;
}
