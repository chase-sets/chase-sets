import { describe, expect, it, vi } from "vitest";
import { buildCatalogAdminCatalogItemProjectionHandlers } from "./admin-projection";
import { buildCatalogItemProjectionHandlers } from "./projection";

function event() {
  return {
    streamId: "catalog.item-cat_1",
    data: {},
    timing: { recordedAt: "2026-05-17T00:00:00.000Z" },
  } as never;
}

function baseCatalogItemRow(catalogItemId: string) {
  return {
    catalog_item_id: catalogItemId,
    language_code: "en",
    title_i18n: { defaultLocale: "en", values: { en: "Pikachu" } },
    title: "Pikachu",
    subtitle_i18n: null,
    subtitle: null,
    description_i18n: { defaultLocale: "en", values: { en: "Mouse Pokemon" } },
    description: "Mouse Pokemon",
    blueprint_id: null,
    status: "draft",
    field_values: [],
    category_ids: [],
    tags: [],
    image_urls: [],
    product_asset_sets: [],
    image_fallback: null,
    updated_at: "2026-05-17T00:00:00.000Z",
  };
}

type CatalogItemTestRow = ReturnType<typeof baseCatalogItemRow>;

function parseLocalizedTextFixture(value: unknown, fallback: CatalogItemTestRow["title_i18n"]) {
  return typeof value === "string" ? (JSON.parse(value) as CatalogItemTestRow["title_i18n"]) : fallback;
}

function delayedAdminQuery(itemIds: readonly string[] = ["cat_1"]) {
  let activeQueries = 0;
  let maxActiveQueries = 0;

  const query = vi.fn(async (sql: string, params?: readonly unknown[]) => {
    activeQueries += 1;
    maxActiveQueries = Math.max(maxActiveQueries, activeQueries);

    await Promise.resolve();
    activeQueries -= 1;

    if (sql.includes("FROM catalog_items WHERE catalog_item_id = ANY($1)")) {
      const ids = Array.isArray(params?.[0]) ? (params[0] as string[]) : [];
      return { rows: ids.map(baseCatalogItemRow) };
    }

    if (sql.includes("FROM catalog_items WHERE category_ids")) {
      return { rows: itemIds.map((catalog_item_id) => ({ catalog_item_id })) };
    }

    return { rows: [] };
  });

  return {
    query,
    maxActiveQueries: () => maxActiveQueries,
  };
}

describe("Catalog Item projections", () => {
  it("deletes removed drafts from the base read model", async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    const handlers = buildCatalogItemProjectionHandlers({ query });

    await handlers["catalog.catalog-item.draft-removed"]?.(event());

    expect(query).toHaveBeenCalledWith("DELETE FROM catalog_items WHERE catalog_item_id = $1", ["cat_1"]);
  });

  it("keeps category assignment idempotent when an event is replayed", async () => {
    const query = vi.fn(async (_sql: string, _params?: readonly unknown[]) => ({ rows: [] }));
    const handlers = buildCatalogItemProjectionHandlers({ query });
    const assigned = {
      streamId: "catalog.item-cat_1",
      data: { categoryId: "category_1" },
      timing: { recordedAt: "2026-05-17T00:00:00.000Z" },
    } as never;

    await handlers["catalog.catalog-item.category-assigned"]?.(assigned);
    await handlers["catalog.catalog-item.category-assigned"]?.(assigned);

    expect(query).toHaveBeenCalledTimes(2);
    for (const [sql, params] of query.mock.calls) {
      expect(sql).toContain("WHEN category_ids @> $2::jsonb THEN category_ids");
      expect(params).toEqual(["cat_1", '["category_1"]', "2026-05-17T00:00:00.000Z"]);
    }
  });

  it("deletes removed drafts from admin list and detail pages", async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    const handlers = buildCatalogAdminCatalogItemProjectionHandlers({ query });

    await handlers["catalog.catalog-item.draft-removed"]?.(event());

    expect(query).toHaveBeenCalledWith("DELETE FROM catalog_admin_catalog_item_list_pages WHERE catalog_item_id = $1", [
      "cat_1",
    ]);
    expect(query).toHaveBeenCalledWith(
      "DELETE FROM catalog_admin_catalog_item_detail_pages WHERE catalog_item_id = $1",
      ["cat_1"],
    );
  });

  it("refreshes admin item pages with database backpressure", async () => {
    const { query, maxActiveQueries } = delayedAdminQuery();
    const handlers = buildCatalogAdminCatalogItemProjectionHandlers({ query });

    await handlers["catalog.catalog-item.field-value-set"]?.(event());

    expect(maxActiveQueries()).toBe(1);
  });

  it("batches dependent admin item page refreshes on one database connection", async () => {
    const { query, maxActiveQueries } = delayedAdminQuery(["cat_1", "cat_2"]);
    const handlers = buildCatalogAdminCatalogItemProjectionHandlers({ query });

    await handlers["catalog.category.published"]?.({
      streamId: "catalog.category-cat_category_1",
      data: {},
      timing: { recordedAt: "2026-05-17T00:00:00.000Z" },
    } as never);

    const itemLoads = query.mock.calls.filter(([sql]) =>
      String(sql).includes("FROM catalog_items WHERE catalog_item_id = ANY($1)"),
    );
    expect(itemLoads).toHaveLength(1);
    expect(itemLoads[0]?.[1]).toEqual([["cat_1", "cat_2"]]);
    expect(maxActiveQueries()).toBe(1);
  });

  it("upserts the catalog item parent before admin rows for replayed created events", async () => {
    const parents = new Map<string, CatalogItemTestRow>();
    const calls: string[] = [];
    const query = vi.fn(async (sql: string, params?: readonly unknown[]) => {
      calls.push(sql);

      if (sql.includes("INSERT INTO catalog_items")) {
        const baseRow = baseCatalogItemRow(String(params?.[0] ?? ""));
        const row: CatalogItemTestRow = {
          ...baseRow,
          language_code: String(params?.[1] ?? "en"),
          title_i18n: parseLocalizedTextFixture(params?.[2], baseRow.title_i18n),
          title: String(params?.[3] ?? ""),
          subtitle_i18n: null,
          subtitle: null,
          description_i18n: parseLocalizedTextFixture(params?.[6], baseRow.description_i18n),
          description: String(params?.[7] ?? ""),
          updated_at: String(params?.[8] ?? ""),
        };
        parents.set(row.catalog_item_id, row);
        return { rows: [] };
      }

      if (sql.includes("INSERT INTO catalog_item_display_identity_recompute_work")) {
        const itemIds = Array.isArray(params?.[0]) ? (params[0] as string[]) : [];
        for (const itemId of itemIds) {
          if (!parents.has(itemId)) {
            throw new Error("insert or update on table violates foreign key constraint");
          }
        }
        return { rows: [] };
      }

      if (sql.includes("FROM catalog_items WHERE catalog_item_id = ANY($1)")) {
        const ids = Array.isArray(params?.[0]) ? (params[0] as string[]) : [];
        return { rows: ids.flatMap((itemId) => parents.get(itemId) ?? []) };
      }

      return { rows: [] };
    });
    const handlers = buildCatalogAdminCatalogItemProjectionHandlers({ query });

    await expect(
      handlers["catalog.catalog-item.created"]?.({
        type: "catalog.catalog-item.created",
        streamId: "catalog.item-cat_replay",
        data: {
          itemId: "cat_replay",
          languageCode: "en",
          title: "Replay Parent",
          subtitle: null,
          description: "Created before admin retry.",
        },
        timing: { recordedAt: "2026-05-17T00:00:00.000Z" },
      } as never),
    ).resolves.toBeUndefined();

    expect(calls.findIndex((sql) => sql.includes("INSERT INTO catalog_items"))).toBeLessThan(
      calls.findIndex((sql) => sql.includes("INSERT INTO catalog_item_display_identity_recompute_work")),
    );
  });

  it("uses the complete item stream when admin and item projections interleave", async () => {
    const created = {
      type: "catalog.catalog-item.created",
      streamId: "catalog.item-cat_interleaved",
      data: {
        itemId: "cat_interleaved",
        languageCode: "en",
        title: "Before",
        subtitle: null,
        description: "Description",
      },
      timing: { recordedAt: "2026-05-17T00:00:00.000Z" },
    } as never;
    const revised = {
      type: "catalog.catalog-item.metadata-revised",
      streamId: "catalog.item-cat_interleaved",
      data: {
        languageCode: "en",
        title: "After",
        subtitle: null,
        description: "Updated description",
      },
      timing: { recordedAt: "2026-05-17T00:01:00.000Z" },
    } as never;

    for (const order of ["admin-before-item", "item-before-admin"] as const) {
      const calls: Array<readonly [string, readonly unknown[] | undefined]> = [];
      const query = vi.fn(async (sql: string, params?: readonly unknown[]) => {
        calls.push([sql, params]);
        return { rows: [] };
      });
      const adminHandlers = buildCatalogAdminCatalogItemProjectionHandlers({ query });
      const itemHandlers = buildCatalogItemProjectionHandlers({ query });
      const sourceContext = {
        readSourceStreamHistory: async () => [created, revised],
      };

      if (order === "admin-before-item") {
        await adminHandlers["catalog.catalog-item.metadata-revised"]?.(revised, sourceContext);
        await itemHandlers["catalog.catalog-item.metadata-revised"]?.(revised);
      } else {
        await itemHandlers["catalog.catalog-item.metadata-revised"]?.(revised);
        await adminHandlers["catalog.catalog-item.metadata-revised"]?.(revised, sourceContext);
      }

      const pageWrites = calls.filter(([sql]) => sql.includes("INSERT INTO catalog_admin_catalog_item_"));
      expect(pageWrites).toHaveLength(2);
      expect(pageWrites.every(([sql]) => sql.includes("updated_at <= EXCLUDED.updated_at"))).toBe(true);
      expect(pageWrites.every(([, params]) => (params?.[3] as readonly string[])[0] === "After")).toBe(true);
      expect(calls.some(([sql]) => sql.includes("SELECT * FROM catalog_items WHERE catalog_item_id = ANY($1)"))).toBe(
        false,
      );
    }
  });

  it("retries an admin refresh when a page is newer than its source item row", async () => {
    const query = vi.fn(async (sql: string, params?: readonly unknown[]) => {
      if (sql.includes("SELECT * FROM catalog_items WHERE catalog_item_id = ANY($1)")) {
        return { rows: [baseCatalogItemRow(String((params?.[0] as string[])[0]))] };
      }
      if (sql.includes("FROM catalog_admin_catalog_item_list_pages")) {
        return { rows: [{ catalog_item_id: "cat_1", updated_at: "2026-05-17T00:01:00.000Z" }] };
      }
      return { rows: [] };
    });
    const handlers = buildCatalogAdminCatalogItemProjectionHandlers({ query });

    await expect(handlers["catalog.catalog-item.field-value-set"]?.(event())).rejects.toThrow(
      "Catalog Item source projection is behind admin pages",
    );
    expect(
      query.mock.calls.some(([sql]) => String(sql).includes("INSERT INTO catalog_admin_catalog_item_list_pages")),
    ).toBe(false);
  });

  it("keeps display identity recomputation scoped to pre-existing item families", async () => {
    const created = {
      type: "catalog.catalog-item.created",
      streamId: "catalog.item-cat_family_scope",
      data: {
        itemId: "cat_family_scope",
        languageCode: "en",
        title: "Before",
        subtitle: null,
        description: "Description",
      },
      timing: { recordedAt: "2026-05-17T00:00:00.000Z" },
    } as never;
    const history = [
      created,
      {
        type: "catalog.catalog-item.tags-set",
        streamId: "catalog.item-cat_family_scope",
        data: { tags: ["rare"] },
        timing: { recordedAt: "2026-05-17T00:01:00.000Z" },
      },
    ] as never;
    const tagsQuery = vi.fn(async (_sql: string, _params?: readonly unknown[]) => ({ rows: [] }));
    const tagsHandlers = buildCatalogAdminCatalogItemProjectionHandlers({ query: tagsQuery });
    await tagsHandlers["catalog.catalog-item.tags-set"]?.(history[1], { readSourceStreamHistory: async () => history });
    expect(
      tagsQuery.mock.calls.some(([sql]) =>
        String(sql).includes("INSERT INTO catalog_item_display_identity_recompute_work"),
      ),
    ).toBe(false);

    const fieldQuery = vi.fn(async (_sql: string, _params?: readonly unknown[]) => ({ rows: [] }));
    const fieldHandlers = buildCatalogAdminCatalogItemProjectionHandlers({ query: fieldQuery });
    const fieldEvent = {
      type: "catalog.catalog-item.field-value-set",
      streamId: "catalog.item-cat_family_scope",
      data: { fieldId: "field_1", value: "value" },
      timing: { recordedAt: "2026-05-17T00:01:00.000Z" },
    } as never;
    await fieldHandlers["catalog.catalog-item.field-value-set"]?.(fieldEvent, {
      readSourceStreamHistory: async () => [created, fieldEvent] as never,
    });
    expect(
      fieldQuery.mock.calls.some(([sql]) =>
        String(sql).includes("INSERT INTO catalog_item_display_identity_recompute_work"),
      ),
    ).toBe(true);
  });

  it.each(["admin-before-item", "item-before-admin"] as const)(
    "converges dependent-name refreshes in the %s order",
    async (order) => {
      const calls: Array<readonly [string, readonly unknown[] | undefined]> = [];
      const query = vi.fn(async (sql: string, params?: readonly unknown[]) => {
        calls.push([sql, params]);
        if (sql.includes("SELECT catalog_item_id FROM catalog_items WHERE blueprint_id = $1")) {
          return { rows: [{ catalog_item_id: "cat_dependent_name" }] };
        }
        if (sql.includes("FROM catalog_items WHERE catalog_item_id = ANY($1)")) {
          return { rows: [{ ...baseCatalogItemRow("cat_dependent_name"), blueprint_id: "bpr_dependent_name" }] };
        }
        if (sql.includes("FROM catalog_blueprints")) {
          return { rows: [{ blueprint_id: "bpr_dependent_name", name: "New Blueprint" }] };
        }
        return { rows: [] };
      });
      const handlers = buildCatalogAdminCatalogItemProjectionHandlers({ query });
      const itemEvent = {
        type: "catalog.catalog-item.metadata-revised",
        streamId: "catalog.item-cat_dependent_name",
        data: { languageCode: "en", title: "Updated Item", subtitle: null, description: "Description" },
        timing: { recordedAt: "2026-05-17T00:01:00.000Z" },
      } as never;
      const blueprintEvent = {
        type: "catalog.blueprint.revised",
        streamId: "catalog.blueprint-bpr_dependent_name",
        data: {},
        timing: { recordedAt: "2026-05-17T00:02:00.000Z" },
      } as never;
      const history = [
        {
          type: "catalog.catalog-item.created",
          streamId: "catalog.item-cat_dependent_name",
          data: {
            itemId: "cat_dependent_name",
            languageCode: "en",
            title: "Before",
            subtitle: null,
            description: "Description",
          },
          timing: { recordedAt: "2026-05-17T00:00:00.000Z" },
        },
        itemEvent,
      ] as never;

      if (order === "admin-before-item") {
        await handlers["catalog.blueprint.revised"]?.(blueprintEvent);
        await handlers["catalog.catalog-item.metadata-revised"]?.(itemEvent, {
          readSourceStreamHistory: async () => history,
        });
      } else {
        await handlers["catalog.catalog-item.metadata-revised"]?.(itemEvent, {
          readSourceStreamHistory: async () => history,
        });
        await handlers["catalog.blueprint.revised"]?.(blueprintEvent);
      }

      const pageWrites = calls.filter(([sql]) => sql.includes("INSERT INTO catalog_admin_catalog_item_"));
      expect(pageWrites.length).toBeGreaterThanOrEqual(2);
      expect(pageWrites.every(([sql]) => sql.includes("updated_at <= EXCLUDED.updated_at"))).toBe(true);
    },
  );

  it("rejects an older page write after a newer write through the freshness predicate", async () => {
    const query = vi.fn(async (_sql: string, _params?: readonly unknown[]) => ({ rows: [] }));
    const handlers = buildCatalogAdminCatalogItemProjectionHandlers({ query });
    const current = {
      type: "catalog.catalog-item.metadata-revised",
      streamId: "catalog.item-cat_guard",
      data: { languageCode: "en", title: "Current", subtitle: null, description: "Current" },
      timing: { recordedAt: "2026-05-17T00:02:00.000Z" },
    } as never;
    await handlers["catalog.catalog-item.metadata-revised"]?.(current, {
      readSourceStreamHistory: async () =>
        [
          {
            type: "catalog.catalog-item.created",
            streamId: "catalog.item-cat_guard",
            data: { itemId: "cat_guard", languageCode: "en", title: "Old", subtitle: null, description: "Old" },
            timing: { recordedAt: "2026-05-17T00:00:00.000Z" },
          },
          current,
        ] as never,
    });
    const writes = query.mock.calls.filter(([sql]) => String(sql).includes("INSERT INTO catalog_admin_catalog_item_"));
    expect(writes).toHaveLength(2);
    expect(writes.every(([sql]) => String(sql).includes("updated_at <= EXCLUDED.updated_at"))).toBe(true);
  });

  it.each([
    ["catalog.catalog-item.field-value-set", { fieldId: "field_1", value: "value" }],
    ["catalog.catalog-item.category-assigned", { categoryId: "category_1" }],
    ["catalog.catalog-item.tags-set", { tags: ["rare"] }],
    ["catalog.catalog-item.image-fallback-set", { imageFallback: { url: "https://example.test/fallback" } }],
    [
      "catalog.catalog-item.external-product-reference-linked",
      { providerKey: "provider", externalKey: "product", selectedOptions: [] },
    ],
    ["catalog.catalog-item.published", { blueprintId: null }],
  ] as const)("rebuilds admin pages from source facts for %s", async (type, data) => {
    const calls: Array<readonly [string, readonly unknown[] | undefined]> = [];
    const query = vi.fn(async (sql: string, params?: readonly unknown[]) => {
      calls.push([sql, params]);
      return { rows: [] };
    });
    const handlers = buildCatalogAdminCatalogItemProjectionHandlers({ query });
    const created = {
      type: "catalog.catalog-item.created",
      streamId: "catalog.item-cat_family",
      data: { itemId: "cat_family", languageCode: "en", title: "Before", subtitle: null, description: "Description" },
      timing: { recordedAt: "2026-05-17T00:00:00.000Z" },
    } as never;
    const sourceEvent = {
      type,
      streamId: "catalog.item-cat_family",
      data,
      timing: { recordedAt: "2026-05-17T00:01:00.000Z" },
    } as never;
    const readSourceStreamHistory = vi.fn(async () => [created, sourceEvent]);

    await handlers[type]?.(sourceEvent, { readSourceStreamHistory });

    expect(readSourceStreamHistory).toHaveBeenCalledOnce();
    expect(calls.some(([sql]) => sql.includes("INSERT INTO catalog_admin_catalog_item_list_pages"))).toBe(true);
    expect(calls.some(([sql]) => sql.includes("INSERT INTO catalog_admin_catalog_item_detail_pages"))).toBe(true);
    const detailWrite = calls.find(([sql]) => sql.includes("INSERT INTO catalog_admin_catalog_item_detail_pages"));
    const detailParams = detailWrite?.[1] as readonly unknown[];
    if (type === "catalog.catalog-item.field-value-set") {
      expect(JSON.parse(String((detailParams[14] as readonly string[])[0]))).toEqual([
        { fieldId: "field_1", fieldName: "field_1", value: "value", reference: null },
      ]);
    }
    if (type === "catalog.catalog-item.category-assigned") {
      expect(JSON.parse(String((detailParams[15] as readonly string[])[0]))).toEqual([
        { categoryId: "category_1", name: "category_1" },
      ]);
    }
    if (type === "catalog.catalog-item.tags-set") {
      expect(JSON.parse(String((detailParams[18] as readonly string[])[0]))).toEqual(["rare"]);
    }
    if (type === "catalog.catalog-item.image-fallback-set") {
      expect(JSON.parse(String((detailParams[21] as readonly string[])[0]))).toEqual({
        url: "https://example.test/fallback",
      });
    }
    if (type === "catalog.catalog-item.external-product-reference-linked") {
      expect(JSON.parse(String((detailParams[17] as readonly string[])[0]))).toEqual([
        {
          providerKey: "provider",
          externalKey: "product",
          selectedOptions: [],
          updatedAt: "2026-05-17T00:01:00.000Z",
        },
      ]);
    }
    if (type === "catalog.catalog-item.published") {
      expect((detailParams[13] as readonly string[])[0]).toBe("active");
    }
  });

  it("batches multi-level reference graph fan-out by frontier", async () => {
    const relationshipFrontiers: string[][] = [];
    const itemReferenceFrontiers: string[][] = [];
    const itemLoadBatches: string[][] = [];
    const relatedRecordsByReference = new Map<string, string[]>([
      ["ref_manufacturer", ["ref_line_a", "ref_line_b"]],
      ["ref_line_a", ["ref_series_a"]],
      ["ref_line_b", ["ref_series_b"]],
      ["ref_series_a", ["ref_expansion_a"]],
      ["ref_series_b", ["ref_expansion_b"]],
    ]);
    const itemIdsByReference = new Map<string, string[]>([
      ["ref_expansion_a", ["cat_a", "cat_shared"]],
      ["ref_expansion_b", ["cat_b", "cat_shared"]],
    ]);
    const query = vi.fn(async (sql: string, params?: readonly unknown[]) => {
      if (sql.includes("jsonb_array_elements(record.relationships)")) {
        const frontier = Array.isArray(params?.[0]) ? (params[0] as string[]) : [];
        relationshipFrontiers.push(frontier);
        return {
          rows: frontier.flatMap((referenceId) =>
            (relatedRecordsByReference.get(referenceId) ?? []).map((reference_record_id) => ({
              reference_record_id,
            })),
          ),
        };
      }

      if (sql.includes("jsonb_array_elements(item.field_values)")) {
        const frontier = Array.isArray(params?.[0]) ? (params[0] as string[]) : [];
        itemReferenceFrontiers.push(frontier);
        return {
          rows: [...new Set(frontier.flatMap((referenceId) => itemIdsByReference.get(referenceId) ?? []))].map(
            (catalog_item_id) => ({ catalog_item_id }),
          ),
        };
      }

      if (sql.includes("FROM catalog_items WHERE catalog_item_id = ANY($1)")) {
        const ids = Array.isArray(params?.[0]) ? (params[0] as string[]) : [];
        itemLoadBatches.push(ids);
        return { rows: ids.map(baseCatalogItemRow) };
      }

      return { rows: [] };
    });
    const handlers = buildCatalogAdminCatalogItemProjectionHandlers({ query });

    await handlers["catalog.reference-record.revised"]?.({
      type: "catalog.reference-record.revised",
      streamId: "catalog.reference-record-ref_manufacturer",
      data: {},
      timing: { recordedAt: "2026-05-17T00:00:00.000Z" },
    } as never);

    expect(relationshipFrontiers).toEqual([
      ["ref_manufacturer"],
      ["ref_line_a", "ref_line_b"],
      ["ref_series_a", "ref_series_b"],
      ["ref_expansion_a", "ref_expansion_b"],
    ]);
    expect(itemReferenceFrontiers).toEqual([
      [
        "ref_manufacturer",
        "ref_line_a",
        "ref_line_b",
        "ref_series_a",
        "ref_series_b",
        "ref_expansion_a",
        "ref_expansion_b",
      ],
    ]);
    expect(itemLoadBatches).toEqual([["cat_a", "cat_shared", "cat_b"]]);
  });

  it("enqueues display template recomputation without inline item refresh", async () => {
    const query = vi.fn(async (sql: string, params?: readonly unknown[]) => {
      if (sql.includes("SELECT catalog_item_id FROM catalog_items ORDER BY catalog_item_id ASC")) {
        return { rows: [{ catalog_item_id: "cat_1" }, { catalog_item_id: "cat_2" }] };
      }

      return { rows: [] };
    });
    const handlers = buildCatalogAdminCatalogItemProjectionHandlers({ query });

    await handlers["catalog.display-template.revised"]?.({
      type: "catalog.display-template.revised",
      streamId: "catalog.display-template-dtp_1",
      data: {},
      timing: { recordedAt: "2026-05-17T00:00:00.000Z" },
    } as never);

    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO catalog_item_display_identity_recompute_work"),
      [
        ["cat_1", "cat_2"],
        "display-template-changed",
        "catalog.display-template.revised",
        "catalog.display-template-dtp_1",
        "2026-05-17T00:00:00.000Z",
      ],
    );
    expect(query).not.toHaveBeenCalledWith(expect.stringContaining("FROM catalog_items WHERE catalog_item_id = $1"), [
      expect.anything(),
    ]);
  });
});
