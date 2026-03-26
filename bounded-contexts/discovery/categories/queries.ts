import type { PgQueryable } from "@chase-sets/event-core/postgres/types";

export type DiscoveryCategoryRow = Readonly<{
  category_id: string;
  key: string;
  name: string;
  description: string;
  status: string;
  parent_category_id: string | null;
  parent_category: unknown;
  display_order: number;
  item_count: number;
  updated_at: string;
}>;

export async function listDiscoveryCategories(
  db: PgQueryable,
  params: { parentCategoryId?: string; status?: string } = {},
): Promise<DiscoveryCategoryRow[]> {
  const conditions: string[] = [];
  const values: unknown[] = [];
  let paramIndex = 1;

  const status = params.status ?? "active";
  conditions.push(`status = $${paramIndex}`);
  values.push(status);
  paramIndex++;

  if (params.parentCategoryId) {
    conditions.push(`parent_category_id = $${paramIndex}`);
    values.push(params.parentCategoryId);
    paramIndex++;
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  const result = await db.query<DiscoveryCategoryRow>(
    `SELECT * FROM discovery_categories ${where} ORDER BY display_order ASC`,
    values,
  );

  return result.rows;
}


