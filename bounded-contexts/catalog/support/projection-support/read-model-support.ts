import type { PgQueryable } from "@chase-sets/event-core-postgres";

export type FieldRule = Readonly<{ fieldId: string; required: boolean }>;

export type DimensionRule = Readonly<{
  dimensionId: string;
  required: boolean;
  allowedOptionIds?: string[];
  appliesWhen?: ApplicabilityClause[];
}>;

export type ApplicabilityClause = Readonly<{
  dimensionId: string;
  optionIds?: string[];
}>;

export type FieldValue = Readonly<{ fieldId: string; value: unknown }>;

export function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

export function asStringArray(value: unknown): string[] {
  return asArray<unknown>(value).filter((entry): entry is string => typeof entry === "string");
}

export async function loadNameMap(
  db: PgQueryable,
  table: string,
  idColumn: string,
  nameColumn: string,
  ids: readonly string[],
): Promise<Map<string, string>> {
  if (ids.length === 0) {
    return new Map();
  }

  const result = await db.query<Record<string, string>>(
    `SELECT ${idColumn} AS id, ${nameColumn} AS name FROM ${table} WHERE ${idColumn} = ANY($1)`,
    [ids],
  );

  return new Map(result.rows.map((row) => [row.id, row.name]));
}

export async function loadChoiceCodeMap(
  db: PgQueryable,
  ids: readonly string[],
): Promise<Map<string, { code: string; displayOrder: number; numericValue: number | null }>> {
  if (ids.length === 0) {
    return new Map();
  }

  const result = await db.query<{
    option_id: string;
    code: string;
    display_order: number;
    numeric_value: number | null;
  }>(
    `SELECT option_id, code, display_order, numeric_value::float8 AS numeric_value FROM catalog_dimension_options WHERE option_id = ANY($1)`,
    [ids],
  );

  return new Map(
    result.rows.map((row) => [
      row.option_id,
      {
        code: row.code,
        displayOrder: row.display_order,
        numericValue: row.numeric_value,
      },
    ]),
  );
}
