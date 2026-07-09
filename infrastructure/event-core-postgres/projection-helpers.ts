import { AsyncLocalStorage } from "node:async_hooks";

import type { PgQueryResult, PgQueryable } from "./types";
import { assertSqlIdentifier } from "./sql-identifier";

type NonEmptyArray<T> = readonly [T, ...T[]];

export type ProjectionRowValues<TColumns extends readonly string[]> = Readonly<{
  [Column in TColumns[number]]: unknown;
}>;

export type SqlValueCast = "bigint" | "boolean" | "integer" | "jsonb" | "numeric" | "text" | "timestamptz";

export type ProjectionValueCasts<TColumns extends readonly string[]> = Readonly<
  Partial<Record<TColumns[number], SqlValueCast>>
>;

export type ProjectionReturningRow<TColumns extends readonly string[]> = Readonly<{
  [Column in TColumns[number]]: unknown;
}>;

export type ProjectionWhere<TColumns extends NonEmptyArray<string>> = Readonly<{
  columns: TColumns;
  values: ProjectionRowValues<TColumns>;
  casts?: ProjectionValueCasts<TColumns>;
}>;

export type ProjectionCascadeColumnRef = Readonly<{
  tableAlias?: string;
  column: string;
}>;

export type ProjectionCascadeJoin = Readonly<{
  kind?: "inner" | "left";
  table: string;
  alias?: string;
  on: NonEmptyArray<
    Readonly<{
      left: ProjectionCascadeColumnRef;
      right: ProjectionCascadeColumnRef;
    }>
  >;
}>;

export type ProjectionCascadeWhere = Readonly<{
  column: string;
  tableAlias?: string;
  operator?: "=" | "@>";
  value: unknown;
  cast?: SqlValueCast;
}>;

export type ProjectionCascadeOrder = Readonly<{
  column: string;
  tableAlias?: string;
  direction?: "ASC" | "DESC";
}>;

export type JsonbArrayMatch =
  | Readonly<{
      kind: "all";
      matches: NonEmptyArray<JsonbArrayMatch>;
    }>
  | Readonly<{
      kind: "pathText";
      path: NonEmptyArray<string>;
      value: string;
    }>
  | Readonly<{
      kind: "value";
      value: unknown;
    }>;

export type JsonbArrayOrder =
  | Readonly<{
      kind: "pathText";
      path: NonEmptyArray<string>;
      direction?: "ASC" | "DESC";
    }>
  | Readonly<{
      kind: "text";
      direction?: "ASC" | "DESC";
    }>;

export async function upsertRow<
  const TInsertColumns extends NonEmptyArray<string>,
  const TConflictColumns extends NonEmptyArray<TInsertColumns[number]>,
  const TUpdateColumns extends readonly TInsertColumns[number][] = readonly TInsertColumns[number][],
  const TReturningColumns extends readonly string[] = readonly [],
>(
  db: PgQueryable,
  input: Readonly<{
    table: string;
    insertColumns: TInsertColumns;
    conflictColumns: TConflictColumns;
    values: ProjectionRowValues<TInsertColumns>;
    updateColumns?: TUpdateColumns;
    casts?: ProjectionValueCasts<TInsertColumns>;
    returning?: TReturningColumns;
  }>,
): Promise<PgQueryResult<ProjectionReturningRow<TReturningColumns>>> {
  const table = sqlIdentifier(input.table);
  const insertColumns = validateColumns(input.insertColumns, "insertColumns");
  const conflictColumns = validateColumns(input.conflictColumns, "conflictColumns");
  const updateColumns = validateColumns(
    (input.updateColumns ?? insertColumns.filter((column) => !conflictColumns.includes(column))) as readonly string[],
    "updateColumns",
    { allowEmpty: true },
  );
  const casts: Partial<Record<string, SqlValueCast>> = input.casts ?? {};
  const values = valuesForColumns(insertColumns, input.values, casts);
  const placeholders = insertColumns.map((column, index) => parameterExpression(index + 1, casts[column]));
  const conflict = conflictColumns.join(", ");
  const returning = returningClause(input.returning ?? []);
  const conflictAction =
    updateColumns.length === 0
      ? "DO NOTHING"
      : `DO UPDATE SET ${updateColumns.map((column) => `${column} = EXCLUDED.${column}`).join(", ")}`;

  ensureColumnsBelongToInsert(updateColumns, insertColumns, "updateColumns");
  ensureColumnsBelongToInsert(conflictColumns, insertColumns, "conflictColumns");

  return db.query<ProjectionReturningRow<TReturningColumns>>(
    `INSERT INTO ${table} (${insertColumns.join(", ")}) VALUES (${placeholders.join(", ")}) ON CONFLICT (${conflict}) ${conflictAction}${returning}`,
    values,
  );
}

export async function updateRow<
  const TSetColumns extends NonEmptyArray<string>,
  const TWhereColumns extends NonEmptyArray<string>,
  const TReturningColumns extends readonly string[] = readonly [],
>(
  db: PgQueryable,
  input: Readonly<{
    table: string;
    setColumns: TSetColumns;
    values: ProjectionRowValues<TSetColumns>;
    casts?: ProjectionValueCasts<TSetColumns>;
    where: ProjectionWhere<TWhereColumns>;
    returning?: TReturningColumns;
  }>,
): Promise<PgQueryResult<ProjectionReturningRow<TReturningColumns>>> {
  const table = sqlIdentifier(input.table);
  const setColumns = validateColumns(input.setColumns, "setColumns");
  const whereColumns = validateColumns(input.where.columns, "where.columns");
  const casts: Partial<Record<string, SqlValueCast>> = input.casts ?? {};
  const whereCasts: Partial<Record<string, SqlValueCast>> = input.where.casts ?? {};
  const setValues = valuesForColumns(setColumns, input.values, casts);
  const whereValues = valuesForColumns(whereColumns, input.where.values, whereCasts);
  const setAssignments = setColumns.map(
    (column, index) => `${column} = ${parameterExpression(index + 1, casts[column])}`,
  );
  const whereOffset = setColumns.length;
  const where = whereColumns
    .map((column, index) => `${column} = ${parameterExpression(whereOffset + index + 1, whereCasts[column])}`)
    .join(" AND ");
  const returning = returningClause(input.returning ?? []);

  return db.query<ProjectionReturningRow<TReturningColumns>>(
    `UPDATE ${table} SET ${setAssignments.join(", ")} WHERE ${where}${returning}`,
    [...setValues, ...whereValues],
  );
}

export async function refreshAffectedRows<const TIdColumn extends string>(
  db: PgQueryable,
  input: Readonly<{
    select: ProjectionCascadeColumnRef & Readonly<{ column: TIdColumn; distinct?: boolean }>;
    from: Readonly<{ table: string; alias?: string }>;
    joins?: readonly ProjectionCascadeJoin[];
    where?: readonly ProjectionCascadeWhere[];
    orderBy?: readonly ProjectionCascadeOrder[];
    idsFromRow?: (row: Readonly<Record<TIdColumn, unknown>>) => readonly string[];
    throwIfCancelled?: () => void;
    refresh: (id: string) => Promise<unknown>;
  }>,
): Promise<readonly string[]> {
  input.throwIfCancelled?.();
  const values: unknown[] = [];
  const selectColumn = columnRef(input.select);
  const select = `SELECT ${input.select.distinct ? "DISTINCT " : ""}${selectColumn} AS ${sqlIdentifier(input.select.column)}`;
  const from = `FROM ${sqlIdentifier(input.from.table)}${aliasClause(input.from.alias)}`;
  const joins = (input.joins ?? []).map(joinClause);
  const where = whereClause(input.where ?? [], values);
  const orderBy = orderByClause(input.orderBy ?? []);
  const result = await db.query<Record<TIdColumn, unknown>>(
    [select, from, ...joins, where, orderBy].filter(Boolean).join(" "),
    values,
  );
  const ids = input.idsFromRow
    ? result.rows.flatMap((row) => input.idsFromRow?.(row) ?? [])
    : result.rows.map((row) => {
        const id = row[input.select.column];
        if (typeof id !== "string") {
          throw new Error(`Projection cascade selected "${input.select.column}" as a non-string id.`);
        }

        return id;
      });

  for (const id of ids) {
    input.throwIfCancelled?.();
    await input.refresh(id);
  }
  input.throwIfCancelled?.();

  return ids;
}

export async function transitionStatus<const TReturningColumns extends readonly string[] = readonly []>(
  db: PgQueryable,
  input: Readonly<{
    table: string;
    idColumn: string;
    id: unknown;
    status: string;
    statusColumn?: string;
    updatedAtColumn?: string;
    updatedAt: string;
    returning?: TReturningColumns;
  }>,
): Promise<PgQueryResult<ProjectionReturningRow<TReturningColumns>>> {
  const statusColumn = input.statusColumn ?? "status";
  const updatedAtColumn = input.updatedAtColumn ?? "updated_at";

  return updateRow(db, {
    table: input.table,
    setColumns: [statusColumn, updatedAtColumn],
    values: {
      [statusColumn]: input.status,
      [updatedAtColumn]: input.updatedAt,
    },
    where: {
      columns: [input.idColumn],
      values: { [input.idColumn]: input.id },
    },
    returning: input.returning,
  });
}

export async function appendJsonbArrayElement<const TReturningColumns extends readonly string[] = readonly []>(
  db: PgQueryable,
  input: Readonly<{
    table: string;
    key: Readonly<{ column: string; value: unknown; cast?: SqlValueCast }>;
    column: string;
    element: unknown;
    unique?: boolean;
    orderBy?: readonly JsonbArrayOrder[];
    updatedAt?: Readonly<{ column?: string; value: string }>;
    returning?: TReturningColumns;
  }>,
): Promise<PgQueryResult<ProjectionReturningRow<TReturningColumns>>> {
  const table = sqlIdentifier(input.table);
  const keyColumn = sqlIdentifier(input.key.column);
  const column = sqlIdentifier(input.column);
  const values: unknown[] = [JSON.stringify(input.element)];
  const expression =
    input.unique || input.orderBy
      ? orderedJsonbArrayExpression(
          input.unique
            ? `SELECT candidate.value, MIN(candidate.ordinal) AS ordinal
               FROM jsonb_array_elements(${column} || jsonb_build_array($1::jsonb)) WITH ORDINALITY AS candidate(value, ordinal)
               GROUP BY candidate.value`
            : `SELECT candidate.value, candidate.ordinal
               FROM jsonb_array_elements(${column} || jsonb_build_array($1::jsonb)) WITH ORDINALITY AS candidate(value, ordinal)`,
          input.orderBy,
        )
      : `${column} || jsonb_build_array($1::jsonb)`;

  return runJsonbArrayUpdate(db, {
    table,
    keyColumn,
    keyValue: input.key.value,
    keyCast: input.key.cast,
    column,
    expression,
    values,
    updatedAt: input.updatedAt,
    returning: (input.returning ?? []) as TReturningColumns,
  });
}

export async function removeJsonbArrayElement<const TReturningColumns extends readonly string[] = readonly []>(
  db: PgQueryable,
  input: Readonly<{
    table: string;
    key: Readonly<{ column: string; value: unknown; cast?: SqlValueCast }>;
    column: string;
    match: JsonbArrayMatch;
    orderBy?: readonly JsonbArrayOrder[];
    updatedAt?: Readonly<{ column?: string; value: string }>;
    returning?: TReturningColumns;
  }>,
): Promise<PgQueryResult<ProjectionReturningRow<TReturningColumns>>> {
  const table = sqlIdentifier(input.table);
  const keyColumn = sqlIdentifier(input.key.column);
  const column = sqlIdentifier(input.column);
  const values: unknown[] = [];
  const match = jsonbArrayMatchExpression("candidate.value", input.match, values);
  const expression = orderedJsonbArrayExpression(
    `SELECT candidate.value, candidate.ordinal
     FROM jsonb_array_elements(${column}) WITH ORDINALITY AS candidate(value, ordinal)
     WHERE NOT (${match})`,
    input.orderBy,
  );

  return runJsonbArrayUpdate(db, {
    table,
    keyColumn,
    keyValue: input.key.value,
    keyCast: input.key.cast,
    column,
    expression,
    values,
    updatedAt: input.updatedAt,
    returning: (input.returning ?? []) as TReturningColumns,
  });
}

export async function replaceJsonbArrayElement<const TReturningColumns extends readonly string[] = readonly []>(
  db: PgQueryable,
  input: Readonly<{
    table: string;
    key: Readonly<{ column: string; value: unknown; cast?: SqlValueCast }>;
    column: string;
    match: JsonbArrayMatch;
    element: unknown;
    orderBy?: readonly JsonbArrayOrder[];
    updatedAt?: Readonly<{ column?: string; value: string }>;
    returning?: TReturningColumns;
  }>,
): Promise<PgQueryResult<ProjectionReturningRow<TReturningColumns>>> {
  const table = sqlIdentifier(input.table);
  const keyColumn = sqlIdentifier(input.key.column);
  const column = sqlIdentifier(input.column);
  const values: unknown[] = [];
  const match = jsonbArrayMatchExpression("candidate.value", input.match, values);
  values.push(JSON.stringify(input.element));
  const elementParameter = values.length;
  const expression = orderedJsonbArrayExpression(
    `SELECT candidate.value, candidate.ordinal
     FROM jsonb_array_elements(${column}) WITH ORDINALITY AS candidate(value, ordinal)
     WHERE NOT (${match})
     UNION ALL
     SELECT $${elementParameter}::jsonb AS value, 2147483647 AS ordinal`,
    input.orderBy,
  );

  return runJsonbArrayUpdate(db, {
    table,
    keyColumn,
    keyValue: input.key.value,
    keyCast: input.key.cast,
    column,
    expression,
    values,
    updatedAt: input.updatedAt,
    returning: (input.returning ?? []) as TReturningColumns,
  });
}

export async function patchJsonbArrayElement<const TReturningColumns extends readonly string[] = readonly []>(
  db: PgQueryable,
  input: Readonly<{
    table: string;
    key: Readonly<{ column: string; value: unknown; cast?: SqlValueCast }>;
    column: string;
    match: JsonbArrayMatch;
    patch: Readonly<Record<string, unknown>>;
    orderBy?: readonly JsonbArrayOrder[];
    updatedAt?: Readonly<{ column?: string; value: string }>;
    returning?: TReturningColumns;
  }>,
): Promise<PgQueryResult<ProjectionReturningRow<TReturningColumns>>> {
  const table = sqlIdentifier(input.table);
  const keyColumn = sqlIdentifier(input.key.column);
  const column = sqlIdentifier(input.column);
  const values: unknown[] = [];
  const match = jsonbArrayMatchExpression("candidate.value", input.match, values);
  values.push(JSON.stringify(input.patch));
  const patchParameter = values.length;
  const expression = orderedJsonbArrayExpression(
    `SELECT CASE
       WHEN ${match} THEN candidate.value || $${patchParameter}::jsonb
       ELSE candidate.value
     END AS value,
     candidate.ordinal
     FROM jsonb_array_elements(${column}) WITH ORDINALITY AS candidate(value, ordinal)`,
    input.orderBy,
  );

  return runJsonbArrayUpdate(db, {
    table,
    keyColumn,
    keyValue: input.key.value,
    keyCast: input.key.cast,
    column,
    expression,
    values,
    updatedAt: input.updatedAt,
    returning: (input.returning ?? []) as TReturningColumns,
  });
}

function runJsonbArrayUpdate<const TReturningColumns extends readonly string[]>(
  db: PgQueryable,
  input: Readonly<{
    table: string;
    keyColumn: string;
    keyValue: unknown;
    keyCast?: SqlValueCast;
    column: string;
    expression: string;
    values: readonly unknown[];
    updatedAt?: Readonly<{ column?: string; value: string }>;
    returning: TReturningColumns;
  }>,
): Promise<PgQueryResult<ProjectionReturningRow<TReturningColumns>>> {
  const values = [...input.values];
  const assignments = [`${input.column} = ${input.expression}`];

  if (input.updatedAt) {
    const updatedAtColumn = sqlIdentifier(input.updatedAt.column ?? "updated_at");
    values.push(input.updatedAt.value);
    assignments.push(`${updatedAtColumn} = $${values.length}`);
  }

  values.push(prepareColumnValue(input.keyValue, input.keyCast));
  const keyParameter = values.length;
  const returning = returningClause(input.returning);

  return db.query<ProjectionReturningRow<TReturningColumns>>(
    `UPDATE ${input.table} SET ${assignments.join(", ")} WHERE ${input.keyColumn} = ${parameterExpression(
      keyParameter,
      input.keyCast,
    )}${returning}`,
    values,
  );
}

function orderedJsonbArrayExpression(selectSql: string, orderBy: readonly JsonbArrayOrder[] | undefined): string {
  const order = orderBy?.length ? orderBy.map(jsonbArrayOrderExpression).join(", ") : "projected.ordinal";

  return `(SELECT COALESCE(jsonb_agg(projected.value ORDER BY ${order}), '[]'::jsonb) FROM (${selectSql}) AS projected(value, ordinal))`;
}

function joinClause(join: ProjectionCascadeJoin): string {
  const kind = join.kind === "left" ? "LEFT JOIN" : "INNER JOIN";
  const on = join.on.map((condition) => `${columnRef(condition.left)} = ${columnRef(condition.right)}`).join(" AND ");

  return `${kind} ${sqlIdentifier(join.table)}${aliasClause(join.alias)} ON ${on}`;
}

function whereClause(where: readonly ProjectionCascadeWhere[], values: unknown[]): string {
  if (where.length === 0) {
    return "";
  }

  return `WHERE ${where
    .map((condition) => {
      const operator = condition.operator ?? "=";
      values.push(prepareColumnValue(condition.value, condition.cast));

      return `${columnRef(condition)} ${operator} ${parameterExpression(values.length, condition.cast)}`;
    })
    .join(" AND ")}`;
}

function orderByClause(orderBy: readonly ProjectionCascadeOrder[]): string {
  if (orderBy.length === 0) {
    return "";
  }

  return `ORDER BY ${orderBy.map((order) => `${columnRef(order)} ${order.direction ?? "ASC"}`).join(", ")}`;
}

function columnRef(ref: ProjectionCascadeColumnRef): string {
  const column = sqlIdentifier(ref.column);

  return ref.tableAlias ? `${sqlIdentifier(ref.tableAlias)}.${column}` : column;
}

function aliasClause(alias: string | undefined): string {
  return alias ? ` AS ${sqlIdentifier(alias)}` : "";
}

function jsonbArrayMatchExpression(alias: string, match: JsonbArrayMatch, values: unknown[]): string {
  if (match.kind === "all") {
    return match.matches.map((candidate) => `(${jsonbArrayMatchExpression(alias, candidate, values)})`).join(" AND ");
  }

  if (match.kind === "value") {
    values.push(JSON.stringify(match.value));
    return `${alias} = $${values.length}::jsonb`;
  }

  values.push(match.value);
  return `${alias} #>> '${jsonbPathLiteral(match.path)}' = $${values.length}`;
}

function jsonbArrayOrderExpression(order: JsonbArrayOrder): string {
  const direction = order.direction ?? "ASC";

  if (order.kind === "text") {
    return `projected.value #>> '{}' ${direction}`;
  }

  return `projected.value #>> '${jsonbPathLiteral(order.path)}' ${direction}`;
}

function valuesForColumns<TColumns extends readonly string[]>(
  columns: readonly string[],
  values: ProjectionRowValues<TColumns>,
  casts: Partial<Record<string, SqlValueCast>>,
): unknown[] {
  return columns.map((column) => {
    if (!Object.prototype.hasOwnProperty.call(values, column)) {
      throw new Error(`Projection row values are missing column "${column}".`);
    }

    return prepareColumnValue(values[column as TColumns[number]], casts[column]);
  });
}

function prepareColumnValue(value: unknown, cast: SqlValueCast | undefined): unknown {
  return cast === "jsonb" ? JSON.stringify(value) : value;
}

function parameterExpression(index: number, cast: SqlValueCast | undefined): string {
  return cast ? `$${index}::${cast}` : `$${index}`;
}

function returningClause(columns: readonly string[]): string {
  if (columns.length === 0) {
    return "";
  }

  return ` RETURNING ${validateColumns(columns, "returning").join(", ")}`;
}

function validateColumns(
  columns: readonly string[],
  fieldName: string,
  options: Readonly<{ allowEmpty?: boolean }> = {},
): string[] {
  if (!options.allowEmpty && columns.length === 0) {
    throw new Error(`${fieldName} must include at least one SQL column.`);
  }

  return columns.map(sqlIdentifier);
}

function ensureColumnsBelongToInsert(columns: readonly string[], insertColumns: readonly string[], fieldName: string) {
  const insertColumnSet = new Set(insertColumns);
  const invalidColumn = columns.find((column) => !insertColumnSet.has(column));

  if (invalidColumn) {
    throw new Error(`${fieldName} includes "${invalidColumn}", which is not in insertColumns.`);
  }
}

function sqlIdentifier(identifier: string): string {
  return assertSqlIdentifier(identifier);
}

function jsonbPathLiteral(path: NonEmptyArray<string>): string {
  return `{${path.map(jsonbPathSegment).join(",")}}`;
}

function jsonbPathSegment(segment: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(segment)) {
    throw new Error(`Invalid JSONB path segment "${segment}". Use letters, numbers, underscores, or hyphens only.`);
  }

  return segment;
}

/**
 * Per-event cascade controller. A projection event whose handler fans out to a
 * large set of dependent rows must not refresh them all inside one event
 * transaction (the transaction budget cannot fit an unbounded fan-out). The
 * subscription runner installs a controller (via {@link runInProjectionCascadeContext})
 * for the current event; cascade choke points call {@link runBoundedProjectionCascade},
 * which processes a bounded slice per pass and records a durable per-site cursor so
 * the same event resumes where it left off on the next pass. The source checkpoint
 * only advances once every site reports complete (controller not exhausted), so a
 * partially-applied cascade is never observable as caught-up.
 */
export type ProjectionCascadeCursor = Readonly<{ cursorId: string | null; completed: boolean }>;

export type ProjectionCascadeController = Readonly<{
  /** Stable, monotonic ordinal for the current cascade site (one per bounded call). */
  nextOrdinal: () => number;
  /** Remaining per-pass refresh budget shared across all sites of this event. */
  budgetRemaining: () => number;
  /** Whether this pass has run out of budget and must resume on a later pass. */
  isExhausted: () => boolean;
  /** Record that `count` items were refreshed this pass. */
  consume: (count: number) => void;
  /** Mark this pass exhausted (a site could not finish within the budget). */
  markExhausted: () => void;
  loadCursor: (ordinal: number) => Promise<ProjectionCascadeCursor>;
  saveCursor: (ordinal: number, cursorId: string | null, completed: boolean) => Promise<void>;
}>;

const projectionCascadeContext = new AsyncLocalStorage<ProjectionCascadeController>();

export function runInProjectionCascadeContext<T>(controller: ProjectionCascadeController, work: () => T): T {
  return projectionCascadeContext.run(controller, work);
}

export function getProjectionCascadeController(): ProjectionCascadeController | undefined {
  return projectionCascadeContext.getStore();
}

/**
 * Refresh an affected-item set, bounded and resumable when a cascade controller is
 * active. Without a controller (rebuild/retry/tests) it processes the whole set in
 * one pass, preserving the previous behaviour. With a controller it processes ids in
 * deterministic ascending order, skips ids already covered by the durable cursor,
 * refreshes at most the remaining budget this pass, advances the cursor, and marks
 * either the site complete or the pass exhausted. Idempotent per-item refresh makes
 * re-running a partial pass or a completed site safe.
 */
export async function runBoundedProjectionCascade(
  ids: readonly string[],
  processSlice: (ids: readonly string[]) => Promise<void>,
): Promise<void> {
  const uniqueIds = [...new Set(ids)];
  const controller = getProjectionCascadeController();

  if (!controller) {
    if (uniqueIds.length > 0) {
      await processSlice(uniqueIds);
    }
    return;
  }

  const ordinal = controller.nextOrdinal();
  if (controller.isExhausted()) {
    // A prior site used up this pass; this site resumes on a later pass.
    return;
  }

  const cursor = await controller.loadCursor(ordinal);
  if (cursor.completed) {
    return;
  }

  const sortedIds = uniqueIds.slice().sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  const remainingIds = cursor.cursorId === null ? sortedIds : sortedIds.filter((id) => id > cursor.cursorId!);
  if (remainingIds.length === 0) {
    await controller.saveCursor(ordinal, cursor.cursorId, true);
    return;
  }

  const budget = controller.budgetRemaining();
  if (budget <= 0) {
    controller.markExhausted();
    return;
  }

  const slice = remainingIds.slice(0, budget);
  await processSlice(slice);
  controller.consume(slice.length);

  const lastId = slice[slice.length - 1]!;
  const completed = slice.length === remainingIds.length;
  await controller.saveCursor(ordinal, lastId, completed);
  if (!completed) {
    controller.markExhausted();
  }
}
