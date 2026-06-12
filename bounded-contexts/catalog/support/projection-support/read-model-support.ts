import type { PgQueryable } from "@chase-sets/event-core-postgres";

export { asArray, asStringArray, loadNameMap } from "@chase-sets/event-core-postgres";

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

export async function loadChoiceCodeMap(
  db: PgQueryable,
  ids: readonly string[],
): Promise<Map<string, { code: string; label: string; displayOrder: number; numericValue: number | null }>> {
  if (ids.length === 0) {
    return new Map();
  }

  const result = await db.query<{
    option_id: string;
    code: string;
    label: string;
    display_order: number;
    numeric_value: number | null;
  }>(
    `SELECT option_id, code, label, display_order, numeric_value::float8 AS numeric_value FROM catalog_dimension_options WHERE option_id = ANY($1)`,
    [ids],
  );

  return new Map(
    result.rows.map((row) => [
      row.option_id,
      {
        code: row.code,
        label: row.label,
        displayOrder: row.display_order,
        numericValue: row.numeric_value,
      },
    ]),
  );
}
