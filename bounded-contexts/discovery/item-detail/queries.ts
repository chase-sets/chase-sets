import type { PgQueryable } from "../../../contracts/event-core/postgres/types";

export type DiscoveryItemDetailRow = Readonly<{
  item_id: string;
  title: string;
  subtitle: string | null;
  description: string;
  blueprint_id: string | null;
  blueprint: unknown;
  status: string;
  field_values: unknown;
  categories: unknown;
  tags: unknown;
  image_urls: unknown;
  version_schema: unknown;
  updated_at: string;
}>;

export async function getDiscoveryItemDetail(
  db: PgQueryable,
  itemId: string,
): Promise<DiscoveryItemDetailRow | null> {
  const result = await db.query<DiscoveryItemDetailRow>(
    `SELECT * FROM marketplace_item_detail_pages WHERE item_id = $1`,
    [itemId],
  );

  return result.rows[0] ?? null;
}
