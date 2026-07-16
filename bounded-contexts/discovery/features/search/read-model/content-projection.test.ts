import type { TransportEvent } from "@chase-sets/event-core/transport";
import { buildTransportEvent } from "@chase-sets/event-core/test-support";
import type { PgQueryResult, PgQueryable } from "@chase-sets/event-core-postgres";
import { describe, expect, it } from "vitest";
import { buildDiscoverySearchItemProjectionHandlers } from "./projection";

type CatalogItemRow = Record<string, unknown>;

type ContentRow = Readonly<{
  line_id: string;
  container_catalog_item_id: string;
  container_product_id: string | null;
  contained_catalog_item_id: string;
  contained_product_id: string | null;
  content_type_id: string;
  content_type_search_weight: number;
  content_search_text: string;
  content_search_text_simple: string;
  updated_at: string;
}>;

type ProductContentLine = Readonly<{
  lineId: string;
  containerCatalogItemId: string;
  containerProductId: string | null;
  containedCatalogItemId: string | null;
  containedProductId: string | null;
  contentTypeId: string;
  contentTypeDiscoverySearchWeight: number | null;
  resolutionStatus: "resolved" | "unresolved";
}>;

class ContentProjectionDb implements PgQueryable {
  public readonly items = new Map<string, CatalogItemRow>();
  public readonly contents = new Map<string, ContentRow>();

  constructor(items: readonly CatalogItemRow[]) {
    for (const item of items) {
      this.items.set(String(item.catalog_item_id), item);
    }
  }

  async query<Row = Record<string, unknown>>(
    sql: string,
    values: readonly unknown[] = [],
  ): Promise<PgQueryResult<Row>> {
    if (sql.includes("SELECT * FROM discovery_search_catalog_items")) {
      const row = this.items.get(String(values[0]));
      return { rows: (row ? [row] : []) as Row[], rowCount: row ? 1 : 0 };
    }

    if (sql.includes("SELECT slug FROM discovery_search_catalog_items")) {
      const row = this.items.get(String(values[0]));
      return { rows: (row ? [{ slug: row.slug }] : []) as Row[], rowCount: row ? 1 : 0 };
    }

    if (sql.includes("UPDATE discovery_search_catalog_items") && sql.includes("SET status = $1")) {
      const itemId = String(values[2]);
      const existing = this.items.get(itemId) ?? catalogItemRow(itemId, "");
      this.items.set(itemId, {
        ...existing,
        status: values[0],
        updated_at: values[1],
      });
      return { rows: [], rowCount: 1 };
    }

    if (sql.includes("UPDATE discovery_search_catalog_items") && sql.includes("SET slug = $2")) {
      const existing = this.items.get(String(values[0])) ?? catalogItemRow(String(values[0]), "");
      this.items.set(String(values[0]), {
        ...existing,
        slug: values[1],
        language_code: values[2],
        title_i18n: JSON.parse(String(values[3])),
        title: values[4],
        subtitle_i18n: values[5] === null ? null : JSON.parse(String(values[5])),
        subtitle: values[6],
        updated_at: values[7],
      });
      return { rows: [], rowCount: 1 };
    }

    if (
      sql.includes("SELECT DISTINCT container_catalog_item_id") &&
      sql.includes("discovery_search_product_contents")
    ) {
      const containers = new Set<string>();
      for (const row of this.contents.values()) {
        if (row.contained_catalog_item_id === values[0]) {
          containers.add(row.container_catalog_item_id);
        }
      }
      return {
        rows: [...containers].map((container_catalog_item_id) => ({ container_catalog_item_id })) as Row[],
        rowCount: containers.size,
      };
    }

    if (sql.includes("SELECT content_search_text") && sql.includes("discovery_search_product_contents")) {
      const rows = [...this.contents.values()].filter((row) => row.container_catalog_item_id === values[0]);
      return {
        rows: rows.map((row) => ({
          content_search_text: row.content_search_text,
          content_search_text_simple: row.content_search_text_simple,
        })) as Row[],
        rowCount: rows.length,
      };
    }

    if (sql.includes("DELETE FROM discovery_search_items")) {
      return { rows: [], rowCount: 0 };
    }

    if (sql.includes("DELETE FROM discovery_search_product_contents")) {
      for (const [lineId, row] of [...this.contents.entries()]) {
        if (row.container_catalog_item_id === values[0] && row.container_product_id === (values[1] ?? null)) {
          this.contents.delete(lineId);
        }
      }
      return { rows: [], rowCount: 0 };
    }

    if (sql.includes("INSERT INTO discovery_search_product_contents")) {
      const row: ContentRow = {
        line_id: String(values[0]),
        container_catalog_item_id: String(values[1]),
        container_product_id: typeof values[2] === "string" ? String(values[2]) : null,
        contained_catalog_item_id: String(values[3]),
        contained_product_id: typeof values[4] === "string" ? String(values[4]) : null,
        content_type_id: String(values[5]),
        content_type_search_weight: Number(values[6]),
        content_search_text: String(values[7]),
        content_search_text_simple: String(values[8]),
        updated_at: String(values[9]),
      };
      this.contents.set(row.line_id, row);
      return { rows: [], rowCount: 1 };
    }

    if (sql.includes("UPDATE discovery_search_product_contents")) {
      for (const [lineId, row] of [...this.contents.entries()]) {
        if (row.contained_catalog_item_id === values[0]) {
          this.contents.set(lineId, {
            ...row,
            content_search_text: String(values[1]),
            content_search_text_simple: String(values[2]),
            updated_at: String(values[3]),
          });
        }
      }
      return { rows: [], rowCount: 0 };
    }

    if (
      sql.includes("INSERT INTO discovery_search_items") ||
      sql.includes("INSERT INTO discovery_slug_redirects") ||
      sql.includes("discovery_search_catalog_categories") ||
      sql.includes("discovery_search_catalog_fields") ||
      sql.includes("discovery_search_catalog_blueprints")
    ) {
      return { rows: [], rowCount: 0 };
    }

    throw new Error(`Unexpected query: ${sql}`);
  }
}

describe("Discovery search Product Contents projection", () => {
  it("adds, updates, and removes direct content search rows from resolved Product Contents facts", async () => {
    const db = new ContentProjectionDb([
      catalogItemRow("cat_card", "Charizard", "Base Set"),
      catalogItemRow("cat_pack", "Pikachu", "Jungle"),
    ]);
    const handlers = buildDiscoverySearchItemProjectionHandlers(db);

    await handlers["catalog.product-contents.resolved"]?.(
      productContentsResolvedEvent({
        lines: [
          contentLine({
            lineId: "line_1",
            containedCatalogItemId: "cat_card",
            containedProductId: "cat_card::",
            contentTypeDiscoverySearchWeight: 0.4,
          }),
        ],
      }),
    );

    expect(db.contents.get("line_1")).toMatchObject({
      container_catalog_item_id: "cat_box",
      contained_catalog_item_id: "cat_card",
      content_type_search_weight: 0.4,
    });
    expect(db.contents.get("line_1")?.content_search_text).toContain("Charizard");

    await handlers["catalog.product-contents.resolved"]?.(
      productContentsResolvedEvent({
        lines: [
          contentLine({
            lineId: "line_2",
            containedCatalogItemId: "cat_pack",
            containedProductId: "cat_pack::",
          }),
        ],
      }),
    );

    expect(db.contents.has("line_1")).toBe(false);
    expect(db.contents.get("line_2")?.content_search_text).toContain("Pikachu");

    await handlers["catalog.product-contents.resolved"]?.(productContentsResolvedEvent({ lines: [] }));

    expect(db.contents.size).toBe(0);
  });

  it("refreshes container content search text when the contained item display identity changes", async () => {
    const db = new ContentProjectionDb([catalogItemRow("cat_card", "Charizard", "Base Set")]);
    const handlers = buildDiscoverySearchItemProjectionHandlers(db);

    await handlers["catalog.product-contents.resolved"]?.(
      productContentsResolvedEvent({
        lines: [contentLine({ lineId: "line_1", containedCatalogItemId: "cat_card" })],
      }),
    );
    expect(db.contents.get("line_1")?.content_search_text).toContain("Charizard");

    await handlers["catalog.catalog-item.display-identity-resolved"]?.(
      displayIdentityResolvedEvent({
        catalogItemId: "cat_card",
        title: "Radiant Charizard",
        subtitle: "Crown Zenith",
      }),
    );

    expect(db.contents.get("line_1")?.content_search_text).toContain("Radiant Charizard");
    expect(db.contents.get("line_1")?.content_search_text).not.toContain("Base Set");
  });

  it("does not fold draft contained item text until the contained item is published", async () => {
    const db = new ContentProjectionDb([catalogItemRow("cat_card", "Secret Prerelease Charizard", null, "draft")]);
    const handlers = buildDiscoverySearchItemProjectionHandlers(db);

    await handlers["catalog.product-contents.resolved"]?.(
      productContentsResolvedEvent({
        lines: [contentLine({ lineId: "line_1", containedCatalogItemId: "cat_card" })],
      }),
    );

    expect(db.contents.get("line_1")?.content_search_text).toBe("");

    await handlers["catalog.catalog-item.published"]?.(catalogItemPublishedEvent("cat_card"));

    expect(db.contents.get("line_1")?.content_search_text).toContain("Secret Prerelease Charizard");
  });
});

function catalogItemRow(
  catalogItemId: string,
  title: string,
  subtitle: string | null = null,
  status = "active",
): CatalogItemRow {
  return {
    catalog_item_id: catalogItemId,
    slug: `${catalogItemId}-slug`,
    language_code: "en",
    title_i18n: { defaultLocale: "en", values: { en: title } },
    title,
    subtitle_i18n: subtitle ? { defaultLocale: "en", values: { en: subtitle } } : null,
    subtitle,
    description_i18n: { defaultLocale: "en", values: {} },
    description: "",
    blueprint_id: null,
    status,
    field_values: [],
    category_ids: [],
    tags: [],
    image_urls: [],
    product_asset_sets: [],
    image_fallback: null,
    resolved_aliases: {},
    updated_at: "2026-07-02T00:00:00.000Z",
  };
}

function catalogItemPublishedEvent(catalogItemId: string): TransportEvent {
  return buildTransportEvent(
    "catalog.catalog-item.published",
    { blueprintId: "bpr_card" },
    {
      id: `evt_publish_${catalogItemId}`,
      streamId: `catalog.item-${catalogItemId}`,
      streamVersion: 2,
      globalPosition: "2",
      tenantId: "tnt_test",
      audit: { performedByUserId: "usr_test", forAccountId: "acc_test" },
      timing: { occurredAt: "2026-07-02T00:00:00.000Z", recordedAt: "2026-07-02T00:00:00.000Z" },
    },
  );
}

function productContentsResolvedEvent(input: { lines: readonly ProductContentLine[] }): TransportEvent {
  return buildTransportEvent(
    "catalog.product-contents.resolved",
    {
      containerCatalogItemId: "cat_box",
      containerProductId: "cat_box::",
      lines: input.lines,
      resolvedFactHash: "hash",
      resolverVersion: 1,
      resolvedAt: "2026-07-02T00:00:00.000Z",
    },
    {
      id: "evt_contents",
      streamId: "catalog.product-contents-cat_box",
      tenantId: "tnt_test",
      audit: { performedByUserId: "usr_test", forAccountId: "acc_test" },
      timing: { occurredAt: "2026-07-02T00:00:00.000Z", recordedAt: "2026-07-02T00:00:00.000Z" },
    },
  );
}

function contentLine(overrides: Partial<ProductContentLine> = {}): ProductContentLine {
  return {
    lineId: "line_1",
    containerCatalogItemId: "cat_box",
    containerProductId: "cat_box::",
    containedCatalogItemId: "cat_card",
    containedProductId: "cat_card::",
    contentTypeId: "pct_included_item",
    contentTypeDiscoverySearchWeight: null,
    resolutionStatus: "resolved",
    ...overrides,
  };
}

function displayIdentityResolvedEvent(input: {
  catalogItemId: string;
  title: string;
  subtitle: string | null;
}): TransportEvent {
  return buildTransportEvent(
    "catalog.catalog-item.display-identity-resolved",
    {
      catalogItemId: input.catalogItemId,
      languageCode: "en",
      title: input.title,
      subtitle: input.subtitle,
    },
    {
      id: "evt_identity",
      streamId: `catalog.item-${input.catalogItemId}`,
      streamVersion: 2,
      globalPosition: "2",
      tenantId: "tnt_test",
      audit: { performedByUserId: "usr_test", forAccountId: "acc_test" },
      timing: { occurredAt: "2026-07-02T00:00:00.000Z", recordedAt: "2026-07-02T00:00:00.000Z" },
    },
  );
}
