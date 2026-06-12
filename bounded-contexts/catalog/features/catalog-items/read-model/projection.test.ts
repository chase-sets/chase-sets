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

function delayedAdminQuery(itemIds: readonly string[] = ["cat_1"]) {
  let activeQueries = 0;
  let maxActiveQueries = 0;

  const query = vi.fn(async (sql: string, params?: readonly unknown[]) => {
    activeQueries += 1;
    maxActiveQueries = Math.max(maxActiveQueries, activeQueries);

    await new Promise((resolve) => setTimeout(resolve, 1));
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
