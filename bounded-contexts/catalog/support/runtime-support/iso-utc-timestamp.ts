/**
 * PostgreSQL read-model boundary contract for timestamps exposed as strings.
 * `timestamptz::text` depends on the connection session time zone; this does not.
 */
export function catalogIsoUtcTimestamp(column: string, alias = column): string {
  return `to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS ${alias}`;
}

export function catalogIsoUtcTimestampColumns(...columns: readonly string[]): string {
  return columns.map((column) => catalogIsoUtcTimestamp(column)).join(", ");
}

/** Adds explicit ISO-UTC timestamp projections to a generated `SELECT *` list query. */
export function catalogIsoUtcListSql(listSql: string, ...columns: readonly string[]): string {
  return listSql.replace("SELECT *", `SELECT *, ${catalogIsoUtcTimestampColumns(...columns)}`);
}
