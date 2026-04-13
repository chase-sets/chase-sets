import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { uniqueStrings } from "../../../support/item-support/unique-strings";

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
  market_summary: Readonly<{
    lowest_price_amount: string | null;
    active_listing_count: number;
    total_visible_quantity: number;
  }> | null;
  market_listings: readonly Readonly<{
    listing_id: string;
    account_id: string;
    inventory_record_id: string;
    catalog_item_id: string;
    catalog_version_key: string;
    item_title: string | null;
    item_subtitle: string | null;
    version_selection: readonly { dimensionId: string; choiceId: string }[];
    version_summary: string | null;
    storage_location_name: string | null;
    ship_from_code: string | null;
    price_amount: string;
    quantity_cap: number;
    status: string;
    seller_display_name: string | null;
    visible_quantity: number;
    created_at: string;
    updated_at: string;
  }>[];
  updated_at: string;
}>;

type BaseDiscoveryItemDetailRow = Omit<
  DiscoveryItemDetailRow,
  "market_summary" | "market_listings"
>;

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

function normalizeCategoryRefs(value: unknown) {
  const categoryMap = new Map<string, { categoryId: string; name: string }>();

  for (const entry of asArray<unknown>(value)) {
    if (!entry || typeof entry !== "object") {
      continue;
    }

    const categoryId = String((entry as { categoryId?: unknown }).categoryId ?? "");

    if (!categoryId || categoryMap.has(categoryId)) {
      continue;
    }

    categoryMap.set(categoryId, {
      categoryId,
      name: String((entry as { name?: unknown }).name ?? categoryId),
    });
  }

  return [...categoryMap.values()];
}

function normalizeStringArray(value: unknown) {
  return uniqueStrings(
    asArray<unknown>(value).filter((entry): entry is string => typeof entry === "string"),
  );
}

export async function getDiscoveryItemDetail(
  db: PgQueryable,
  itemId: string,
): Promise<DiscoveryItemDetailRow | null> {
  const result = await db.query<BaseDiscoveryItemDetailRow>(
    `SELECT * FROM discovery_item_detail_pages WHERE item_id = $1`,
    [itemId],
  );

  const item = result.rows[0] ?? null;
  if (!item) {
    return null;
  }

  const summaryResult = await db.query<{
    lowest_price_amount: string | null;
    active_listing_count: number;
    total_visible_quantity: number;
  }>(
    `SELECT
       MIN(price_amount)::text AS lowest_price_amount,
       COUNT(*)::integer AS active_listing_count,
       COALESCE(SUM(quantity_cap), 0)::integer AS total_visible_quantity
     FROM discovery_market_listings
     WHERE catalog_item_id = $1
       AND status = 'active'`,
    [itemId],
  );

  const listingsResult = await db.query<
    Omit<DiscoveryItemDetailRow["market_listings"][number], "version_selection"> & {
      version_selection: unknown;
    }
  >(
    `SELECT
       listing.*,
       account.seller_display_name,
       listing.quantity_cap AS visible_quantity
     FROM discovery_market_listings AS listing
     LEFT JOIN discovery_market_accounts AS account
       ON account.account_id = listing.account_id
     WHERE listing.catalog_item_id = $1
       AND listing.status = 'active'
     ORDER BY listing.price_amount ASC, listing.updated_at DESC, listing.listing_id ASC`,
    [itemId],
  );

  const summaryRow = summaryResult.rows[0];
  const marketSummary =
    summaryRow && summaryRow.active_listing_count > 0
      ? {
          lowest_price_amount: summaryRow.lowest_price_amount,
          active_listing_count: summaryRow.active_listing_count,
          total_visible_quantity: summaryRow.total_visible_quantity,
        }
      : null;

  return {
    ...item,
    categories: normalizeCategoryRefs(item.categories),
    tags: normalizeStringArray(item.tags),
    image_urls: normalizeStringArray(item.image_urls),
    market_summary: marketSummary,
    market_listings: listingsResult.rows.map((row) => ({
      ...row,
      version_selection: Array.isArray(row.version_selection)
        ? row.version_selection
        : [],
    })),
  };
}


