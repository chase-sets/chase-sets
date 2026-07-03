import type { PgQueryable } from "./types";

export type ListParams = Readonly<{
  search?: string;
  status?: string;
  limit?: unknown;
  offset?: unknown;
}>;

export type ListResult<T> = Readonly<{
  items: T[];
  total: number;
}>;

type CountRow = Readonly<{
  count: string | number | bigint;
}>;

const defaultListLimit = 50;
const maxListLimit = 500;
const maxListOffset = 10_000;

export type PaginationClause = Readonly<{
  sql: string;
  values: readonly [number, number];
}>;

export function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, "\\$&");
}

export function buildFilteredQuery(
  baseTable: string,
  params: ListParams,
  searchColumns: readonly string[],
  orderBy: string,
  extraConditions: readonly string[] = [],
  extraValues: readonly unknown[] = [],
): { countSql: string; listSql: string; values: unknown[]; countValues: unknown[]; listValues: unknown[] } {
  const conditions = [...extraConditions];
  const values = [...extraValues];
  let paramIndex = extraValues.length + 1;

  if (params.status) {
    conditions.push(`status = $${paramIndex}`);
    values.push(params.status);
    paramIndex++;
  }

  if (params.search) {
    const likeClauses = searchColumns.map((column) => `${column} ILIKE $${paramIndex} ESCAPE '\\'`);
    conditions.push(`(${likeClauses.join(" OR ")})`);
    values.push(`%${escapeLikePattern(params.search)}%`);
    paramIndex++;
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const pagination = buildPaginationClause(params, paramIndex);
  const listValues = [...values, ...pagination.values];

  return {
    countSql: `SELECT COUNT(*) as count FROM ${baseTable} ${where}`,
    listSql: `SELECT * FROM ${baseTable} ${where} ORDER BY ${orderBy} ${pagination.sql}`,
    values,
    countValues: values,
    listValues,
  };
}

export function buildPaginationClause(params: ListParams = {}, firstParamIndex = 1): PaginationClause {
  const limit = normalizePaginationInteger(params.limit, defaultListLimit, 1, maxListLimit);
  const offset = normalizePaginationInteger(params.offset, 0, 0, maxListOffset);

  return {
    sql: `LIMIT $${firstParamIndex} OFFSET $${firstParamIndex + 1}`,
    values: [limit, offset],
  };
}

export async function executeListQuery<T>(
  db: PgQueryable,
  countSql: string,
  listSql: string,
  values: readonly unknown[],
  listValues: readonly unknown[] = values,
): Promise<ListResult<T>> {
  const [countResult, listResult] = await Promise.all([
    db.query<CountRow>(countSql, values),
    db.query<T>(listSql, listValues),
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

function normalizePaginationInteger(value: unknown, defaultValue: number, min: number, max: number): number {
  const parsed =
    typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : NaN;

  if (!Number.isFinite(parsed)) {
    return defaultValue;
  }

  const integer = Math.trunc(parsed);
  return Math.max(min, Math.min(integer, max));
}
