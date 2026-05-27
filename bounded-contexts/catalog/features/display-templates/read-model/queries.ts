import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type { ListParams, ListResult } from "../../../support/projection-support/list-query";

export type DisplayTemplateListParams = ListParams & {
  targetKind?: string;
  status?: string;
};

export type DisplayTemplateRow = Readonly<{
  display_template_id: string;
  key: string;
  name_i18n: unknown;
  name: string;
  description_i18n: unknown;
  description: string;
  target_kind: string;
  target_id: string | null;
  priority: number;
  title_template: string;
  subtitle_template: string | null;
  required_field_keys: unknown;
  status: string;
  updated_at: string;
}>;

export async function listDisplayTemplates(
  db: PgQueryable,
  params: DisplayTemplateListParams = {},
): Promise<ListResult<DisplayTemplateRow>> {
  const { where, values } = displayTemplateConditions(params);
  const limit = params.limit ?? 50;
  const offset = params.offset ?? 0;

  const countResult = await db.query<{ count: string }>(
    `SELECT COUNT(*) AS count FROM catalog_display_templates ${where}`,
    values,
  );
  const result = await db.query<DisplayTemplateRow>(
    `SELECT *
     FROM catalog_display_templates
     ${where}
     ORDER BY target_kind ASC, priority DESC, name ASC
     LIMIT ${limit} OFFSET ${offset}`,
    values,
  );

  return {
    items: result.rows,
    total: Number.parseInt(countResult.rows[0].count, 10),
  };
}

export async function getDisplayTemplateDetail(db: PgQueryable, displayTemplateId: string) {
  const result = await db.query<DisplayTemplateRow>(
    `SELECT * FROM catalog_display_templates WHERE display_template_id = $1`,
    [displayTemplateId],
  );

  return result.rows[0] ?? null;
}

function displayTemplateConditions(params: DisplayTemplateListParams): { where: string; values: unknown[] } {
  const conditions: string[] = [];
  const values: unknown[] = [];
  let paramIndex = 1;

  if (params.status) {
    conditions.push(`status = $${paramIndex}`);
    values.push(params.status);
    paramIndex++;
  }

  if (params.targetKind) {
    conditions.push(`target_kind = $${paramIndex}`);
    values.push(params.targetKind);
    paramIndex++;
  }

  if (params.search) {
    conditions.push(
      `(name ILIKE $${paramIndex} OR key ILIKE $${paramIndex} OR title_template ILIKE $${paramIndex} OR COALESCE(subtitle_template, '') ILIKE $${paramIndex})`,
    );
    values.push(`%${params.search}%`);
  }

  return {
    where: conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "",
    values,
  };
}
