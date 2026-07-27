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

export type AdminProjectionDependencies = Readonly<{
  componentNames: ReadonlyMap<string, string>;
  fieldNames: ReadonlyMap<string, string>;
  dimensionNames: ReadonlyMap<string, string>;
  optionCodes: ReadonlyMap<
    string,
    Readonly<{ code: string; label: string; displayOrder: number; numericValue: number | null }>
  >;
}>;

export async function loadAdminProjectionDependencies(
  db: PgQueryable,
  ids: Readonly<{
    componentIds?: readonly string[];
    fieldIds?: readonly string[];
    dimensionIds?: readonly string[];
    optionIds?: readonly string[];
  }>,
): Promise<AdminProjectionDependencies> {
  // Projection handlers run inside one checked-out transaction client. One
  // statement preserves that transaction boundary without overlapping queries
  // on a client that cannot execute them concurrently.
  const result = await db.query<
    Readonly<{
      dependency_kind: "component" | "field" | "dimension" | "option";
      id: string;
      name: string;
      code: string | null;
      display_order: number | null;
      numeric_value: number | null;
    }>
  >(
    `SELECT 'component' AS dependency_kind,
            component_id AS id,
            name,
            NULL::text AS code,
            NULL::integer AS display_order,
            NULL::float8 AS numeric_value
     FROM catalog_components
     WHERE component_id = ANY($1::text[])
     UNION ALL
     SELECT 'field', field_id, name, NULL::text, NULL::integer, NULL::float8
     FROM catalog_fields
     WHERE field_id = ANY($2::text[])
     UNION ALL
     SELECT 'dimension', dimension_id, name, NULL::text, NULL::integer, NULL::float8
     FROM catalog_dimensions
     WHERE dimension_id = ANY($3::text[])
     UNION ALL
     SELECT 'option', option_id, label, code, display_order, numeric_value::float8
     FROM catalog_dimension_options
     WHERE option_id = ANY($4::text[])`,
    [ids.componentIds ?? [], ids.fieldIds ?? [], ids.dimensionIds ?? [], ids.optionIds ?? []],
  );

  const componentNames = new Map<string, string>();
  const fieldNames = new Map<string, string>();
  const dimensionNames = new Map<string, string>();
  const optionCodes = new Map<
    string,
    { code: string; label: string; displayOrder: number; numericValue: number | null }
  >();
  for (const row of result.rows) {
    if (row.dependency_kind === "component") {
      componentNames.set(row.id, row.name);
    } else if (row.dependency_kind === "field") {
      fieldNames.set(row.id, row.name);
    } else if (row.dependency_kind === "dimension") {
      dimensionNames.set(row.id, row.name);
    } else if (row.code !== null && row.display_order !== null) {
      optionCodes.set(row.id, {
        code: row.code,
        label: row.name,
        displayOrder: row.display_order,
        numericValue: row.numeric_value,
      });
    }
  }

  return { componentNames, fieldNames, dimensionNames, optionCodes };
}

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
