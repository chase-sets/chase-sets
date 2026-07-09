import { describe, expect, it } from "vitest";
import type { TransportEvent } from "@chase-sets/event-core/transport";
import type { PgQueryResult, PgQueryable } from "@chase-sets/event-core-postgres";
import { buildDiscoveryItemDetailProjectionHandlers } from "../features/item-detail/read-model/projection";

// Regression for issue #4751: a single catalog blueprint event used to rebuild
// every affected item-detail page one item at a time (~10 sequential queries
// per item: item select, lookup maps, a three-query product schema, page
// upsert). Cascading over an imported catalog that ran minutes inside ONE
// projection transaction, tripped the transaction cap, rolled back all
// progress, and the projection could never catch up. The cascade must batch:
// one chunked item select, set-based lookup maps, ONE product-schema build per
// blueprint per cascade, and one upsert per page.
class CascadeProjectionDb implements PgQueryable {
  public readonly queries: string[] = [];
  public readonly upsertedPageItemIds: string[] = [];
  private readonly itemIds: readonly string[];
  private readonly blueprintId: string;

  constructor(blueprintId: string, itemIds: readonly string[]) {
    this.blueprintId = blueprintId;
    this.itemIds = itemIds;
  }

  async query<Row = Record<string, unknown>>(
    sql: string,
    values: readonly unknown[] = [],
  ): Promise<PgQueryResult<Row>> {
    this.queries.push(sql);

    // Cascade id collection (refreshAffectedRows select).
    if (
      sql.includes("FROM discovery_item_detail_catalog_items") &&
      sql.includes("blueprint_id") &&
      !sql.startsWith("SELECT *")
    ) {
      return {
        rows: this.itemIds.map((catalog_item_id) => ({ catalog_item_id })) as Row[],
        rowCount: this.itemIds.length,
      };
    }

    // Chunked item load: must be set-based (ANY), never a per-item select.
    if (sql.includes("SELECT * FROM discovery_item_detail_catalog_items")) {
      expect(sql).toContain("= ANY($1)");
      const requested = values[0] as readonly string[];
      const known = requested.filter((itemId) => this.itemIds.includes(itemId));
      return {
        rows: known.map((catalog_item_id) => this.itemRow(catalog_item_id)) as Row[],
        rowCount: known.length,
      };
    }

    // Product schema build: blueprint row + dimensions + options.
    if (sql.includes("SELECT * FROM discovery_item_detail_catalog_blueprints")) {
      return {
        rows: [
          {
            blueprint_id: this.blueprintId,
            name: "Pokemon Card",
            dimension_rules: [{ dimensionId: "dim_language", required: true, allowedOptionIds: ["opt_en"] }],
            canonical_dimension_order: ["dim_language"],
          },
        ] as Row[],
        rowCount: 1,
      };
    }
    if (sql.includes("FROM discovery_item_detail_catalog_dimensions")) {
      return {
        rows: [{ dimension_id: "dim_language", name: "Language", value_kind: "unordered" }] as Row[],
        rowCount: 1,
      };
    }
    if (sql.includes("FROM discovery_item_detail_catalog_dimension_options")) {
      return {
        rows: [
          {
            option_id: "opt_en",
            code: "en",
            label_i18n: null,
            label: "English",
            display_order: 0,
            numeric_value: null,
          },
        ] as Row[],
        rowCount: 1,
      };
    }

    // Blueprint name map (batched lookup).
    if (sql.includes("FROM discovery_item_detail_catalog_blueprints WHERE blueprint_id = ANY($1)")) {
      return {
        rows: [{ id: this.blueprintId, name: "Pokemon Card" }] as Row[],
        rowCount: 1,
      };
    }

    if (sql.includes("INSERT INTO discovery_item_detail_pages")) {
      this.upsertedPageItemIds.push(String(values[0]));
      return { rows: [] as Row[], rowCount: 1 };
    }

    return { rows: [] as Row[], rowCount: 0 };
  }

  private itemRow(catalogItemId: string): Record<string, unknown> {
    return {
      catalog_item_id: catalogItemId,
      slug: `${catalogItemId}-slug`,
      language_code: "en",
      title_i18n: { en: catalogItemId },
      title: catalogItemId,
      subtitle_i18n: null,
      subtitle: null,
      description_i18n: { en: "description" },
      description: "description",
      blueprint_id: this.blueprintId,
      status: "active",
      field_values: [],
      category_ids: [],
      tags: [],
      image_urls: [],
      product_asset_sets: [],
      image_fallback: null,
      updated_at: "2026-07-09T12:00:00.000Z",
    };
  }
}

function blueprintPublishedEvent(blueprintId: string): TransportEvent {
  return {
    id: "evt_blueprint_published",
    type: "catalog.blueprint.published",
    streamId: `catalog.blueprint-${blueprintId}`,
    streamVersion: 3,
    globalPosition: "42" as never,
    data: {},
    metadata: {},
    timing: { recordedAt: "2026-07-09T12:00:00.000Z" },
  } as unknown as TransportEvent;
}

describe("discovery item-detail cascade batching (issue #4751)", () => {
  it("rebuilds a blueprint cascade with chunked lookups and one product schema build per blueprint", async () => {
    const itemIds = Array.from({ length: 350 }, (_, index) => `cat_${String(index).padStart(3, "0")}`);
    const db = new CascadeProjectionDb("bp_pokemon", itemIds);
    const handlers = buildDiscoveryItemDetailProjectionHandlers(db);

    await handlers["catalog.blueprint.published"]!(blueprintPublishedEvent("bp_pokemon"), {});

    // Every affected page rebuilt exactly once.
    expect(db.upsertedPageItemIds).toHaveLength(itemIds.length);
    expect(new Set(db.upsertedPageItemIds).size).toBe(itemIds.length);

    // The product schema (blueprint row + dimensions + options) is built once
    // per blueprint per cascade — never once per item.
    const schemaBuilds = db.queries.filter((sql) =>
      sql.includes("SELECT * FROM discovery_item_detail_catalog_blueprints"),
    );
    expect(schemaBuilds).toHaveLength(1);
    const dimensionLoads = db.queries.filter((sql) => sql.includes("FROM discovery_item_detail_catalog_dimensions"));
    expect(dimensionLoads).toHaveLength(1);

    // Items load in set-based chunks (350 ids @ chunk 200 = 2 selects), not
    // one select per item.
    const itemLoads = db.queries.filter((sql) => sql.includes("SELECT * FROM discovery_item_detail_catalog_items"));
    expect(itemLoads).toHaveLength(2);

    // Total query volume stays O(pages + chunks), a fraction of the old
    // ~10-queries-per-item cascade that blew the projection transaction cap.
    expect(db.queries.length).toBeLessThan(itemIds.length + 25);
  });

  it("keeps single-item refreshes cheap and deletes pages for missing items in one statement", async () => {
    const db = new CascadeProjectionDb("bp_pokemon", []);
    const handlers = buildDiscoveryItemDetailProjectionHandlers(db);

    // catalog-item events refresh exactly one page; a missing item prunes its
    // page with a single set-based delete.
    await handlers["catalog.catalog-item.published"]!(
      {
        id: "evt_item_published",
        type: "catalog.catalog-item.published",
        streamId: "catalog.item-cat_missing",
        streamVersion: 2,
        globalPosition: "43" as never,
        data: {},
        metadata: {},
        timing: { recordedAt: "2026-07-09T12:00:00.000Z" },
      } as unknown as TransportEvent,
      {},
    );

    const deletes = db.queries.filter((sql) => sql.includes("DELETE FROM discovery_item_detail_pages"));
    expect(deletes).toHaveLength(1);
    expect(deletes[0]).toContain("= ANY($1)");
  });
});
