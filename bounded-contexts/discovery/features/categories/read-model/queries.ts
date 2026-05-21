import type { PgQueryable } from "@chase-sets/event-core-postgres";

export type DiscoveryCategoryRow = Readonly<{
  category_id: string;
  key: string;
  slug: string;
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

export async function getDiscoveryCategoryBySlug(db: PgQueryable, slug: string): Promise<DiscoveryCategoryRow | null> {
  const result = await db.query<DiscoveryCategoryRow>(
    `SELECT category.*
     FROM discovery_categories AS category
     LEFT JOIN discovery_slug_redirects AS redirect
       ON redirect.entity_kind = 'category'
      AND redirect.slug = $1
     WHERE category.slug = $1
        OR category.category_id = $1
        OR category.category_id = redirect.entity_id
        OR category.slug = redirect.target_slug
     ORDER BY
       (category.slug = $1) DESC,
       (category.category_id = $1) DESC
     LIMIT 1`,
    [slug],
  );

  return result.rows[0] ?? null;
}
