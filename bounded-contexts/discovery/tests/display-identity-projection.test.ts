import { describe, expect, it } from "vitest";
import type { TransportEvent } from "@chase-sets/event-core/transport";
import type { PgQueryResult, PgQueryable } from "@chase-sets/event-core-postgres";
import { buildDiscoveryItemDetailProjectionHandlers } from "../features/item-detail/read-model/projection";
import {
  buildDiscoverySearchItemProjectionHandlers,
  rebuildDiscoverySearchIndex,
} from "../features/search/read-model/projection";

class DiscoveryProjectionDb implements PgQueryable {
  public readonly searchCatalogItems = new Map<string, Record<string, unknown>>();
  public readonly detailCatalogItems = new Map<string, Record<string, unknown>>();
  public readonly redirectWrites: unknown[][] = [];
  public readonly derivedWrites: string[] = [];
  public readonly searchDisplayBadges: unknown[][] = [];
  public readonly detailDisplayBadges: unknown[][] = [];
  public readonly queries: string[] = [];

  constructor() {
    this.searchCatalogItems.set("cat_1", catalogItemRow("old-title-cat-1"));
    this.detailCatalogItems.set("cat_1", catalogItemRow("old-title-cat-1"));
  }

  async query<Row = Record<string, unknown>>(
    sql: string,
    values: readonly unknown[] = [],
  ): Promise<PgQueryResult<Row>> {
    this.queries.push(sql);

    if (sql.includes("SELECT slug FROM discovery_search_catalog_items")) {
      const row = this.searchCatalogItems.get(String(values[0]));
      return { rows: (row ? [{ slug: row.slug }] : []) as Row[], rowCount: row ? 1 : 0 };
    }

    if (sql.includes("SELECT slug FROM discovery_item_detail_catalog_items")) {
      const row = this.detailCatalogItems.get(String(values[0]));
      return { rows: (row ? [{ slug: row.slug }] : []) as Row[], rowCount: row ? 1 : 0 };
    }

    if (sql.includes("UPDATE discovery_search_catalog_items") && sql.includes("title = $5")) {
      this.searchCatalogItems.set(String(values[0]), {
        ...this.searchCatalogItems.get(String(values[0])),
        slug: values[1],
        language_code: values[2],
        title_i18n: JSON.parse(String(values[3])),
        title: values[4],
        subtitle_i18n: values[5] === null ? null : JSON.parse(String(values[5])),
        subtitle: values[6],
        display_badges: JSON.parse(String(values[7])),
        updated_at: values[8],
      });
      return { rows: [], rowCount: 1 };
    }

    if (sql.includes("UPDATE discovery_search_catalog_items") && sql.includes("description_i18n = $2")) {
      this.searchCatalogItems.set(String(values[0]), {
        ...this.searchCatalogItems.get(String(values[0])),
        description_i18n: JSON.parse(String(values[1])),
        description: values[2],
        updated_at: values[3],
      });
      return { rows: [], rowCount: 1 };
    }

    if (sql.includes("UPDATE discovery_search_catalog_items") && sql.includes("description_i18n = $1::jsonb")) {
      this.searchCatalogItems.set(String(values[3]), {
        ...this.searchCatalogItems.get(String(values[3])),
        description_i18n: JSON.parse(String(values[0])),
        description: values[1],
        updated_at: values[2],
      });
      return { rows: [], rowCount: 1 };
    }

    if (sql.includes("UPDATE discovery_item_detail_catalog_items") && sql.includes("title = $5")) {
      this.detailCatalogItems.set(String(values[0]), {
        ...this.detailCatalogItems.get(String(values[0])),
        slug: values[1],
        language_code: values[2],
        title_i18n: JSON.parse(String(values[3])),
        title: values[4],
        subtitle_i18n: values[5] === null ? null : JSON.parse(String(values[5])),
        subtitle: values[6],
        display_badges: JSON.parse(String(values[7])),
        updated_at: values[8],
      });
      return { rows: [], rowCount: 1 };
    }

    if (sql.includes("UPDATE discovery_item_detail_catalog_items") && sql.includes("description_i18n = $2")) {
      this.detailCatalogItems.set(String(values[0]), {
        ...this.detailCatalogItems.get(String(values[0])),
        description_i18n: JSON.parse(String(values[1])),
        description: values[2],
        updated_at: values[3],
      });
      return { rows: [], rowCount: 1 };
    }

    if (sql.includes("UPDATE discovery_item_detail_catalog_items") && sql.includes("description_i18n = $1::jsonb")) {
      this.detailCatalogItems.set(String(values[3]), {
        ...this.detailCatalogItems.get(String(values[3])),
        description_i18n: JSON.parse(String(values[0])),
        description: values[1],
        updated_at: values[2],
      });
      return { rows: [], rowCount: 1 };
    }

    if (
      sql.includes("UPDATE discovery_search_catalog_dimension_options") ||
      sql.includes("UPDATE discovery_item_detail_catalog_dimension_options")
    ) {
      return { rows: [], rowCount: 1 };
    }

    if (sql.includes("TRUNCATE discovery_search_items")) {
      return { rows: [], rowCount: 0 };
    }

    if (
      sql.includes("SELECT catalog_item_id") &&
      sql.includes("FROM discovery_search_catalog_items") &&
      sql.includes("ORDER BY catalog_item_id")
    ) {
      return { rows: [{ catalog_item_id: "cat_1" }] as Row[], rowCount: 1 };
    }

    if (
      sql.includes("SELECT catalog_item_id") &&
      (sql.includes("discovery_search_catalog_items") || sql.includes("discovery_item_detail_catalog_items"))
    ) {
      return { rows: [], rowCount: 0 };
    }

    if (
      sql.includes("SELECT DISTINCT item.catalog_item_id") &&
      (sql.includes("discovery_search_catalog_items") || sql.includes("discovery_item_detail_catalog_items"))
    ) {
      return { rows: [], rowCount: 0 };
    }

    if (sql.includes("INSERT INTO discovery_slug_redirects")) {
      this.redirectWrites.push([...values]);
      return { rows: [], rowCount: 1 };
    }

    if (sql.includes("SELECT * FROM discovery_search_catalog_items")) {
      const row = this.searchCatalogItems.get(String(values[0]));
      return { rows: (row ? [row] : []) as Row[], rowCount: row ? 1 : 0 };
    }

    if (sql.includes("SELECT * FROM discovery_item_detail_catalog_items")) {
      const row = this.detailCatalogItems.get(String(values[0]));
      return { rows: (row ? [row] : []) as Row[], rowCount: row ? 1 : 0 };
    }

    if (sql.includes("INSERT INTO discovery_search_items")) {
      this.derivedWrites.push("search");
      this.searchDisplayBadges.push(JSON.parse(String(values[7])) as unknown[]);
      return { rows: [], rowCount: 1 };
    }

    if (sql.includes("UPDATE discovery_search_product_contents")) {
      return { rows: [], rowCount: 0 };
    }

    if (sql.includes("INSERT INTO discovery_item_detail_pages")) {
      this.derivedWrites.push("detail");
      this.detailDisplayBadges.push(JSON.parse(String(values[7])) as unknown[]);
      return { rows: [], rowCount: 1 };
    }

    if (
      sql.includes("discovery_search_catalog_categories") ||
      sql.includes("discovery_item_detail_catalog_categories") ||
      sql.includes("discovery_search_catalog_fields") ||
      sql.includes("discovery_item_detail_catalog_fields")
    ) {
      return { rows: [], rowCount: 0 };
    }

    throw new Error(`Unexpected query: ${sql}`);
  }
}

function withQueryConcurrencyProbe(db: PgQueryable): { db: PgQueryable; getMaxActiveQueryCount: () => number } {
  let activeQueryCount = 0;
  let maxActiveQueryCount = 0;

  return {
    db: {
      query: (async (sql: string, values?: readonly unknown[]) => {
        activeQueryCount += 1;
        maxActiveQueryCount = Math.max(maxActiveQueryCount, activeQueryCount);
        try {
          await Promise.resolve();
          return await db.query(sql, values);
        } finally {
          activeQueryCount -= 1;
        }
      }) as PgQueryable["query"],
    },
    getMaxActiveQueryCount: () => maxActiveQueryCount,
  };
}

function catalogItemRow(slug: string): Record<string, unknown> {
  return {
    catalog_item_id: "cat_1",
    slug,
    language_code: "en",
    title_i18n: { defaultLocale: "en", values: { en: "Old Title" } },
    title: "Old Title",
    subtitle_i18n: null,
    subtitle: null,
    display_badges: [],
    description_i18n: { defaultLocale: "en", values: { en: "Description" } },
    description: "Description",
    blueprint_id: null,
    status: "active",
    field_values: [],
    category_ids: [],
    tags: [],
    image_urls: [],
    product_asset_sets: [],
    image_fallback: null,
    updated_at: "2026-05-09T00:00:00.000Z",
  };
}

function displayIdentityEvent(): TransportEvent {
  return {
    id: "evt_1" as never,
    type: "catalog.catalog-item.display-identity-resolved",
    streamId: "catalog.item-cat_1" as never,
    streamVersion: 2 as never,
    globalPosition: 2 as never,
    tenantId: "tnt_1" as never,
    data: {
      catalogItemId: "cat_1",
      languageCode: "en",
      title: "Charizard 4/102",
      subtitle: "Base Set Rare Holo",
      badges: [
        { kind: "set-code", label: "BS" },
        { kind: "number", label: "4/102" },
        { kind: "rarity", label: "Rare Holo" },
      ],
    } as never,
    metadata: {},
    audit: {
      performedByUserId: "usr_1" as never,
      forAccountId: "acc_1" as never,
    },
    trace: {},
    timing: {
      occurredAt: "2026-06-06T22:00:00.000Z" as never,
      recordedAt: "2026-06-06T22:00:00.000Z" as never,
    },
  };
}

function metadataRevisionEvent(): TransportEvent {
  return {
    id: "evt_2" as never,
    type: "catalog.catalog-item.metadata-revised",
    streamId: "catalog.item-cat_1" as never,
    streamVersion: 3 as never,
    globalPosition: 3 as never,
    tenantId: "tnt_1" as never,
    data: {
      languageCode: "en",
      title: { defaultLocale: "en", values: { en: "Fallback Title" } },
      subtitle: { defaultLocale: "en", values: { en: "Fallback Subtitle" } },
      description: { defaultLocale: "en", values: { en: "Revised description" } },
    } as never,
    metadata: {},
    audit: {
      performedByUserId: "usr_1" as never,
      forAccountId: "acc_1" as never,
    },
    trace: {},
    timing: {
      occurredAt: "2026-06-06T23:00:00.000Z" as never,
      recordedAt: "2026-06-06T23:00:00.000Z" as never,
    },
  };
}

function dimensionOptionsReorderedEvent(): TransportEvent {
  return {
    id: "evt_dimension_options" as never,
    type: "catalog.dimension.options-reordered",
    streamId: "catalog.dimension-dim_condition" as never,
    streamVersion: 4 as never,
    globalPosition: 4 as never,
    tenantId: "tnt_1" as never,
    data: { optionIds: ["opt_lp", "opt_nm"] } as never,
    metadata: {},
    audit: {
      performedByUserId: "usr_1" as never,
      forAccountId: "acc_1" as never,
    },
    trace: {},
    timing: {
      occurredAt: "2026-06-06T23:30:00.000Z" as never,
      recordedAt: "2026-06-06T23:30:00.000Z" as never,
    },
  };
}

describe("Discovery display identity projection", () => {
  it("updates search source and derived rows from Catalog display identity facts", async () => {
    const db = new DiscoveryProjectionDb();
    const handlers = buildDiscoverySearchItemProjectionHandlers(db);

    await handlers["catalog.catalog-item.display-identity-resolved"]?.(displayIdentityEvent());

    expect(db.searchCatalogItems.get("cat_1")).toMatchObject({
      language_code: "en",
      title: "Charizard 4/102",
      subtitle: "Base Set Rare Holo",
      display_badges: [
        { kind: "set-code", label: "BS" },
        { kind: "number", label: "4/102" },
        { kind: "rarity", label: "Rare Holo" },
      ],
    });
    expect(db.redirectWrites[0]?.slice(0, 3)).toEqual(["item", "old-title-cat-1", "cat_1"]);
    expect(db.derivedWrites).toContain("search");
    expect(db.searchDisplayBadges.at(-1)).toEqual([
      { kind: "set-code", label: "BS" },
      { kind: "number", label: "4/102" },
      { kind: "rarity", label: "Rare Holo" },
    ]);

    await rebuildDiscoverySearchIndex(db);
    expect(db.searchDisplayBadges.at(-1)).toEqual([
      { kind: "set-code", label: "BS" },
      { kind: "number", label: "4/102" },
      { kind: "rarity", label: "Rare Holo" },
    ]);
  });

  it("updates item detail source and derived rows from Catalog display identity facts", async () => {
    const db = new DiscoveryProjectionDb();
    const handlers = buildDiscoveryItemDetailProjectionHandlers(db);

    await handlers["catalog.catalog-item.display-identity-resolved"]?.(displayIdentityEvent());

    expect(db.detailCatalogItems.get("cat_1")).toMatchObject({
      language_code: "en",
      title: "Charizard 4/102",
      subtitle: "Base Set Rare Holo",
      display_badges: [
        { kind: "set-code", label: "BS" },
        { kind: "number", label: "4/102" },
        { kind: "rarity", label: "Rare Holo" },
      ],
    });
    expect(db.redirectWrites[0]?.slice(0, 3)).toEqual(["item", "old-title-cat-1", "cat_1"]);
    expect(db.derivedWrites).toContain("detail");
    expect(db.detailDisplayBadges.at(-1)).toEqual([
      { kind: "set-code", label: "BS" },
      { kind: "number", label: "4/102" },
      { kind: "rarity", label: "Rare Holo" },
    ]);
  });

  it("keeps search display labels and slug stable when fallback metadata is revised", async () => {
    const db = new DiscoveryProjectionDb();
    const handlers = buildDiscoverySearchItemProjectionHandlers(db);

    await handlers["catalog.catalog-item.metadata-revised"]?.(metadataRevisionEvent());

    expect(db.searchCatalogItems.get("cat_1")).toMatchObject({
      slug: "old-title-cat-1",
      title: "Old Title",
      subtitle: null,
      description: "Revised description",
    });
    expect(db.redirectWrites).toHaveLength(0);
    expect(db.derivedWrites).toContain("search");
  });

  it("keeps item detail display labels and slug stable when fallback metadata is revised", async () => {
    const db = new DiscoveryProjectionDb();
    const handlers = buildDiscoveryItemDetailProjectionHandlers(db);

    await handlers["catalog.catalog-item.metadata-revised"]?.(metadataRevisionEvent());

    expect(db.detailCatalogItems.get("cat_1")).toMatchObject({
      slug: "old-title-cat-1",
      title: "Old Title",
      subtitle: null,
      description: "Revised description",
    });
    expect(db.redirectWrites).toHaveLength(0);
    expect(db.derivedWrites).toContain("detail");
  });

  it("serializes search projection same-client dimension option updates", async () => {
    const probe = withQueryConcurrencyProbe(new DiscoveryProjectionDb());
    const handlers = buildDiscoverySearchItemProjectionHandlers(probe.db);

    await handlers["catalog.dimension.options-reordered"]?.(dimensionOptionsReorderedEvent());

    expect(probe.getMaxActiveQueryCount()).toBe(1);
  });

  it("serializes item detail projection same-client dimension option updates", async () => {
    const rawDb = new DiscoveryProjectionDb();
    const probe = withQueryConcurrencyProbe(rawDb);
    const handlers = buildDiscoveryItemDetailProjectionHandlers(probe.db);

    await handlers["catalog.dimension.options-reordered"]?.(dimensionOptionsReorderedEvent());

    expect(probe.getMaxActiveQueryCount()).toBe(1);
    expect(rawDb.queries.some((query) => query.includes("discovery_item_detail_catalog_blueprints"))).toBe(true);
  });
});
