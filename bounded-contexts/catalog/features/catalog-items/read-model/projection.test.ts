import { describe, expect, it, vi } from "vitest";
import { isTransientProjectionError } from "@chase-sets/event-core/projector";
import { buildTransportEvent } from "@chase-sets/event-core/test-support";
import type { TransportEvent } from "@chase-sets/event-core/transport";
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

function delayedAdminQuery(itemIds: readonly string[] = ["cat_1"], facts: readonly TransportEvent[] = []) {
  let activeQueries = 0;
  let maxActiveQueries = 0;

  const query = vi.fn(async (sql: string, params?: readonly unknown[]) => {
    activeQueries += 1;
    maxActiveQueries = Math.max(maxActiveQueries, activeQueries);

    await Promise.resolve();
    activeQueries -= 1;

    if (sql.includes("FROM event_store_events")) {
      return { rows: sourceHistoryRows(facts, params) };
    }

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

function sourceFact(
  type: string,
  data: Record<string, unknown>,
  position: Readonly<{ streamId: string; streamVersion: number; recordedAt: string }>,
): TransportEvent {
  return buildTransportEvent(type, data, {
    id: `evt_${position.streamId}_${position.streamVersion}`,
    streamId: position.streamId,
    streamVersion: position.streamVersion,
    globalPosition: String(position.streamVersion),
    tenantId: "tnt_catalog_projection",
    metadata: {},
    audit: { performedByUserId: "usr_catalog_projection", forAccountId: "acc_catalog_projection" },
    trace: {},
    timing: { occurredAt: position.recordedAt, recordedAt: position.recordedAt },
  });
}

// Serves the admin projection's bounded item stream prefix read from in-memory source facts.
function sourceHistoryRows(facts: readonly TransportEvent[], params: readonly unknown[] | undefined) {
  return facts
    .filter((fact) => fact.streamId === params?.[0] && fact.streamVersion <= Number(params?.[1]))
    .map((fact) => ({
      event_id: fact.id,
      event_type: fact.type,
      payload: fact.data,
      stream_version: fact.streamVersion,
    }));
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
    const position = { streamId: "catalog.item-cat_1", recordedAt: "2026-05-17T00:00:00.000Z" };
    const created = sourceFact(
      "catalog.catalog-item.created",
      { itemId: "cat_1", languageCode: "en", title: "Pikachu", subtitle: null, description: "Mouse Pokemon" },
      { ...position, streamVersion: 1 },
    );
    const fieldValueSet = sourceFact(
      "catalog.catalog-item.field-value-set",
      { fieldId: "field_1", value: "value" },
      { ...position, streamVersion: 2 },
    );
    const { query, maxActiveQueries } = delayedAdminQuery(["cat_1"], [created, fieldValueSet]);
    const handlers = buildCatalogAdminCatalogItemProjectionHandlers({ query });

    await handlers["catalog.catalog-item.field-value-set"]?.(fieldValueSet);

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
    const created = sourceFact(
      "catalog.catalog-item.created",
      {
        itemId: "cat_interleaved",
        languageCode: "en",
        title: "Before",
        subtitle: null,
        description: "Description",
      },
      { streamId: "catalog.item-cat_interleaved", streamVersion: 1, recordedAt: "2026-05-17T00:00:00.000Z" },
    );
    const revised = sourceFact(
      "catalog.catalog-item.metadata-revised",
      {
        languageCode: "en",
        title: "After",
        subtitle: null,
        description: "Updated description",
      },
      { streamId: "catalog.item-cat_interleaved", streamVersion: 2, recordedAt: "2026-05-17T00:01:00.000Z" },
    );

    for (const order of ["admin-before-item", "item-before-admin"] as const) {
      const calls: Array<readonly [string, readonly unknown[] | undefined]> = [];
      const query = vi.fn(async (sql: string, params?: readonly unknown[]) => {
        calls.push([sql, params]);
        return { rows: sql.includes("FROM event_store_events") ? sourceHistoryRows([created, revised], params) : [] };
      });
      const adminHandlers = buildCatalogAdminCatalogItemProjectionHandlers({ query });
      const itemHandlers = buildCatalogItemProjectionHandlers({ query });

      if (order === "admin-before-item") {
        await adminHandlers["catalog.catalog-item.metadata-revised"]?.(revised);
        await itemHandlers["catalog.catalog-item.metadata-revised"]?.(revised);
      } else {
        await itemHandlers["catalog.catalog-item.metadata-revised"]?.(revised);
        await adminHandlers["catalog.catalog-item.metadata-revised"]?.(revised);
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

    await expect(handlers["catalog.catalog-item.aliases-resolved"]?.(event())).rejects.toThrow(
      "Catalog Item source projection is behind admin pages",
    );
    expect(
      query.mock.calls.some(([sql]) => String(sql).includes("INSERT INTO catalog_admin_catalog_item_list_pages")),
    ).toBe(false);
  });

  it("keeps display identity recomputation scoped to pre-existing item families", async () => {
    const streamId = "catalog.item-cat_family_scope";
    const created = sourceFact(
      "catalog.catalog-item.created",
      {
        itemId: "cat_family_scope",
        languageCode: "en",
        title: "Before",
        subtitle: null,
        description: "Description",
      },
      { streamId, streamVersion: 1, recordedAt: "2026-05-17T00:00:00.000Z" },
    );
    const tags = sourceFact(
      "catalog.catalog-item.tags-set",
      { tags: ["rare"] },
      { streamId, streamVersion: 2, recordedAt: "2026-05-17T00:01:00.000Z" },
    );
    const tagsQuery = vi.fn(async (sql: string, params?: readonly unknown[]) => ({
      rows: sql.includes("FROM event_store_events") ? sourceHistoryRows([created, tags], params) : [],
    }));
    const tagsHandlers = buildCatalogAdminCatalogItemProjectionHandlers({ query: tagsQuery });
    await tagsHandlers["catalog.catalog-item.tags-set"]?.(tags);
    expect(
      tagsQuery.mock.calls.some(([sql]) =>
        String(sql).includes("INSERT INTO catalog_item_display_identity_recompute_work"),
      ),
    ).toBe(false);

    const fieldEvent = sourceFact(
      "catalog.catalog-item.field-value-set",
      { fieldId: "field_1", value: "value" },
      { streamId, streamVersion: 2, recordedAt: "2026-05-17T00:01:00.000Z" },
    );
    const fieldQuery = vi.fn(async (sql: string, params?: readonly unknown[]) => ({
      rows: sql.includes("FROM event_store_events") ? sourceHistoryRows([created, fieldEvent], params) : [],
    }));
    const fieldHandlers = buildCatalogAdminCatalogItemProjectionHandlers({ query: fieldQuery });
    await fieldHandlers["catalog.catalog-item.field-value-set"]?.(fieldEvent);
    expect(
      fieldQuery.mock.calls.some(([sql]) =>
        String(sql).includes("INSERT INTO catalog_item_display_identity_recompute_work"),
      ),
    ).toBe(true);
  });

  it("converges dependent-name refreshes across item projector order and lag for list and detail pages", async () => {
    const itemId = "cat_dependent_name";
    const blueprintId = "bpr_dependent_name";
    const T0 = "2026-05-17T00:00:00.000Z";
    const T1 = "2026-05-17T00:01:00.000Z";
    const T2 = "2026-05-17T00:02:00.000Z";
    const T3 = "2026-05-17T00:03:00.000Z";

    type Page = { updated_at: string; blueprint: string | null; title: string; tags: string };
    type MutableCatalogItemRow = Omit<CatalogItemTestRow, "blueprint_id" | "tags"> & {
      blueprint_id: string | null;
      tags: unknown;
    };
    const pageParamIndexes = {
      list: { blueprint: 10, tags: 12, updatedAt: 13 },
      detail: { blueprint: 12, tags: 18, updatedAt: 22 },
    } as const;
    const pageParam = (
      kind: keyof typeof pageParamIndexes,
      params: readonly unknown[] | undefined,
      name: keyof (typeof pageParamIndexes)[typeof kind],
    ) => (params?.[pageParamIndexes[kind][name]] as readonly unknown[] | undefined)?.[0];

    const makeWorld = (sourceFacts: readonly TransportEvent[]) => {
      const items = new Map<string, MutableCatalogItemRow>();
      const listPages = new Map<string, Page>();
      const detailPages = new Map<string, Page>();
      const blueprintNames = new Map([[blueprintId, "Old Blueprint"]]);
      const externalProductReferences: Array<Record<string, unknown>> = [];
      const calls: Array<readonly [string, readonly unknown[] | undefined]> = [];
      const query = vi.fn(async (sql: string, params?: readonly unknown[]) => {
        calls.push([sql, params]);
        if (sql.includes("FROM event_store_events")) {
          return { rows: sourceHistoryRows(sourceFacts, params) };
        }
        if (sql.includes("FROM catalog_items WHERE catalog_item_id = ANY($1)")) {
          const ids = (params?.[0] as readonly string[] | undefined) ?? [];
          return { rows: ids.flatMap((id) => (items.has(id) ? [items.get(id)!] : [])) };
        }
        if (sql.includes("SELECT catalog_item_id FROM catalog_items WHERE blueprint_id = $1")) {
          return {
            rows: [...items.values()]
              .filter((item) => item.blueprint_id === params?.[0])
              .map((item) => ({ catalog_item_id: item.catalog_item_id })),
          };
        }
        if (sql.includes("UNION ALL") && sql.includes("catalog_admin_catalog_item_list_pages")) {
          const ids = (params?.[0] as readonly string[] | undefined) ?? [];
          return {
            rows: ids.flatMap((id) =>
              [listPages.get(id), detailPages.get(id)]
                .filter(Boolean)
                .map((page) => ({ catalog_item_id: id, updated_at: page!.updated_at })),
            ),
          };
        }
        if (sql.includes("FROM catalog_blueprints")) {
          const ids = (params?.[0] as readonly string[] | undefined) ?? [];
          return { rows: ids.flatMap((id) => (blueprintNames.has(id) ? [{ id, name: blueprintNames.get(id)! }] : [])) };
        }
        if (sql.includes("catalog_external_product_references")) {
          return {
            rows: externalProductReferences.filter((row) =>
              (params?.[0] as readonly string[] | undefined)?.includes(String(row.catalog_item_id)),
            ),
          };
        }
        if (sql.includes("INSERT INTO catalog_items")) {
          const base = baseCatalogItemRow(String(params?.[0]));
          items.set(base.catalog_item_id, {
            ...base,
            language_code: String(params?.[1]),
            title: String(params?.[3]),
            title_i18n: parseLocalizedTextFixture(params?.[2], base.title_i18n),
            description: String(params?.[7]),
            description_i18n: parseLocalizedTextFixture(params?.[6], base.description_i18n),
            updated_at: String(params?.[8]),
          });
          return { rows: [] };
        }
        if (sql.includes("UPDATE catalog_items SET blueprint_id")) {
          const item = items.get(String(params?.[0]));
          if (item)
            items.set(item.catalog_item_id, {
              ...item,
              blueprint_id: String(params?.[1]),
              updated_at: String(params?.[2]),
            });
          return { rows: [] };
        }
        if (sql.includes("UPDATE catalog_items SET tags")) {
          const item = items.get(String(params?.[0]));
          if (item)
            items.set(item.catalog_item_id, {
              ...item,
              tags: JSON.parse(String(params?.[1])),
              updated_at: String(params?.[2]),
            });
          return { rows: [] };
        }
        if (sql.includes("UPDATE catalog_items SET updated_at = GREATEST")) {
          const item = items.get(String(params?.[0]));
          if (item && Date.parse(String(params?.[1])) > Date.parse(item.updated_at))
            items.set(item.catalog_item_id, { ...item, updated_at: String(params?.[1]) });
          return { rows: [] };
        }
        if (sql.includes("INSERT INTO catalog_external_product_references")) {
          externalProductReferences.push({
            catalog_item_id: params?.[2],
            provider_key: params?.[0],
            external_key: params?.[1],
            selected_options: JSON.parse(String(params?.[3])),
            updated_at: params?.[4],
          });
          return { rows: [] };
        }
        if (
          sql.includes("INSERT INTO catalog_admin_catalog_item_list_pages") ||
          sql.includes("INSERT INTO catalog_admin_catalog_item_detail_pages")
        ) {
          const kind = sql.includes("_detail_pages") ? "detail" : "list";
          const updatedAt = String(pageParam(kind, params, "updatedAt"));
          const page: Page = {
            updated_at: updatedAt,
            blueprint: (pageParam(kind, params, "blueprint") as string | null) ?? null,
            title: String((params?.[3] as readonly unknown[] | undefined)?.[0] ?? ""),
            tags: String(pageParam(kind, params, "tags") ?? "[]"),
          };
          const pages = kind === "detail" ? detailPages : listPages;
          const existing = pages.get(itemId);
          const normalizedSql = sql.replace(/\s+/g, " ").trim();
          const exactGuard = normalizedSql.endsWith(
            `WHERE catalog_admin_catalog_item_${kind}_pages.updated_at <= EXCLUDED.updated_at`,
          );
          if (!existing || !exactGuard || Date.parse(existing.updated_at) <= Date.parse(updatedAt))
            pages.set(itemId, page);
          return { rows: [] };
        }
        return { rows: [] };
      });
      const admin = buildCatalogAdminCatalogItemProjectionHandlers({ query });
      const item = buildCatalogItemProjectionHandlers({ query });
      const renderedName = (pages: Map<string, Page>) => {
        const blueprint = pages.get(itemId)?.blueprint;
        return blueprint ? (JSON.parse(blueprint) as { name: string }).name : null;
      };
      return { admin, item, query, items, listPages, detailPages, blueprintNames, renderedName, calls };
    };

    type SourcePosition = Readonly<{
      id: string;
      streamId: string;
      streamVersion: number;
      globalPosition: number;
      recordedAt: string;
    }>;
    const sourceEvent = (type: string, data: Record<string, unknown>, position: SourcePosition): TransportEvent =>
      buildTransportEvent(type, data, {
        id: position.id,
        streamId: position.streamId,
        streamVersion: position.streamVersion,
        globalPosition: String(position.globalPosition),
        tenantId: "tnt_dependent_name",
        metadata: {},
        audit: { performedByUserId: "usr_dependent_name", forAccountId: "acc_dependent_name" },
        trace: {},
        timing: { occurredAt: position.recordedAt, recordedAt: position.recordedAt },
      });
    const itemStreamId = `catalog.item-${itemId}`;
    const created = sourceEvent(
      "catalog.catalog-item.created",
      { itemId, languageCode: "en", title: "Before", subtitle: null, description: "Description" },
      { id: "evt_dependent_name_created", streamId: itemStreamId, streamVersion: 1, globalPosition: 1, recordedAt: T0 },
    );
    const assigned = sourceEvent(
      "catalog.catalog-item.blueprint-assigned",
      { blueprintId },
      {
        id: "evt_dependent_name_assigned",
        streamId: itemStreamId,
        streamVersion: 2,
        globalPosition: 2,
        recordedAt: T1,
      },
    );
    // `linked` and `tags` are alternative third item events: each scenario's item history holds only one of them.
    const linked = sourceEvent(
      "catalog.catalog-item.external-product-reference-linked",
      { providerKey: "synthetic-provider", externalKey: "synthetic-product", selectedOptions: [] },
      { id: "evt_dependent_name_linked", streamId: itemStreamId, streamVersion: 3, globalPosition: 3, recordedAt: T2 },
    );
    const tags = sourceEvent(
      "catalog.catalog-item.tags-set",
      { tags: ["rare"] },
      { id: "evt_dependent_name_tags", streamId: itemStreamId, streamVersion: 3, globalPosition: 3, recordedAt: T2 },
    );
    const rename = sourceEvent(
      "catalog.blueprint.revised",
      {},
      {
        id: "evt_dependent_name_rename",
        streamId: `catalog.blueprint-${blueprintId}`,
        streamVersion: 2,
        globalPosition: 4,
        recordedAt: T3,
      },
    );

    for (const order of ["item-before-admin", "admin-before-item"] as const) {
      const world = makeWorld([created, assigned, linked]);
      await world.item["catalog.catalog-item.created"]?.(created);
      await world.item["catalog.catalog-item.blueprint-assigned"]?.(assigned);
      await world.admin["catalog.catalog-item.blueprint-assigned"]?.(assigned);
      if (order === "item-before-admin") {
        await world.item["catalog.catalog-item.external-product-reference-linked"]?.(linked);
        await world.admin["catalog.catalog-item.external-product-reference-linked"]?.(linked);
      } else {
        await world.admin["catalog.catalog-item.external-product-reference-linked"]?.(linked);
        await world.item["catalog.catalog-item.external-product-reference-linked"]?.(linked);
      }
      world.blueprintNames.set(blueprintId, "New Blueprint");
      await world.admin["catalog.blueprint.revised"]?.(rename);
      expect(world.renderedName(world.listPages)).toBe("New Blueprint");
      expect(world.renderedName(world.detailPages)).toBe("New Blueprint");
    }

    for (const event of [tags, linked]) {
      const world = makeWorld([created, assigned, event]);
      await world.item["catalog.catalog-item.created"]?.(created);
      await world.item["catalog.catalog-item.blueprint-assigned"]?.(assigned);
      await world.admin["catalog.catalog-item.blueprint-assigned"]?.(assigned);
      await world.admin[event.type]?.(event);
      world.blueprintNames.set(blueprintId, "New Blueprint");
      let transient = false;
      try {
        await world.admin["catalog.blueprint.revised"]?.(rename);
      } catch (error) {
        transient = isTransientProjectionError(error);
      }
      expect(transient).toBe(true);
      await world.item[event.type]?.(event);
      await world.admin["catalog.blueprint.revised"]?.(rename);
      expect(world.renderedName(world.listPages)).toBe("New Blueprint");
      expect(world.renderedName(world.detailPages)).toBe("New Blueprint");
    }
  });

  it("rejects an older page write after a newer write through the freshness predicate", async () => {
    let pageUpdatedAt: string | null = null;
    let detailUpdatedAt: string | null = null;
    const pageParamIndexes = {
      list: { updatedAt: 13 },
      detail: { updatedAt: 22 },
    } as const;
    const streamId = "catalog.item-cat_guard";
    const created = sourceFact(
      "catalog.catalog-item.created",
      { itemId: "cat_guard", languageCode: "en", title: "Old", subtitle: null, description: "Old" },
      { streamId, streamVersion: 1, recordedAt: "2026-05-17T00:00:00.000Z" },
    );
    const older = sourceFact(
      "catalog.catalog-item.metadata-revised",
      { languageCode: "en", title: "Older", subtitle: null, description: "Older" },
      { streamId, streamVersion: 2, recordedAt: "2026-05-17T00:01:00.000Z" },
    );
    const current = sourceFact(
      "catalog.catalog-item.metadata-revised",
      { languageCode: "en", title: "Newer", subtitle: null, description: "Newer" },
      { streamId, streamVersion: 3, recordedAt: "2026-05-17T00:02:00.000Z" },
    );
    const query = vi.fn(async (sql: string, params?: readonly unknown[]) => {
      if (sql.includes("FROM event_store_events")) {
        return { rows: sourceHistoryRows([created, older, current], params) };
      }
      const kind = sql.includes("_detail_pages") ? "detail" : sql.includes("_list_pages") ? "list" : null;
      if (kind) {
        const excludedUpdatedAt = String((params?.[pageParamIndexes[kind].updatedAt] as readonly string[])[0]);
        const normalizedSql = sql.replace(/\s+/g, " ").trim();
        const exactGuard = normalizedSql.endsWith(
          `WHERE catalog_admin_catalog_item_${kind}_pages.updated_at <= EXCLUDED.updated_at`,
        );
        if (!exactGuard) throw new Error(`unexpected ${kind} freshness predicate`);
        const current = kind === "detail" ? detailUpdatedAt : pageUpdatedAt;
        if (!current || Date.parse(current) <= Date.parse(excludedUpdatedAt)) {
          if (kind === "detail") detailUpdatedAt = excludedUpdatedAt;
          else pageUpdatedAt = excludedUpdatedAt;
        }
      }
      return { rows: [] };
    });
    const handlers = buildCatalogAdminCatalogItemProjectionHandlers({ query });
    await handlers["catalog.catalog-item.metadata-revised"]?.(current);
    await handlers["catalog.catalog-item.metadata-revised"]?.(older);
    const writes = query.mock.calls.filter(([sql]) => String(sql).includes("INSERT INTO catalog_admin_catalog_item_"));
    expect(writes).toHaveLength(4);
    expect(writes).toHaveLength(4);
    expect(writes.filter(([sql]) => String(sql).includes("_list_pages"))).toHaveLength(2);
    expect(writes.filter(([sql]) => String(sql).includes("_detail_pages"))).toHaveLength(2);
    expect(pageUpdatedAt).toBe("2026-05-17T00:02:00.000Z");
    expect(detailUpdatedAt).toBe("2026-05-17T00:02:00.000Z");
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
    const streamId = "catalog.item-cat_family";
    const created = sourceFact(
      "catalog.catalog-item.created",
      { itemId: "cat_family", languageCode: "en", title: "Before", subtitle: null, description: "Description" },
      { streamId, streamVersion: 1, recordedAt: "2026-05-17T00:00:00.000Z" },
    );
    const sourceEvent = sourceFact(type, data, { streamId, streamVersion: 2, recordedAt: "2026-05-17T00:01:00.000Z" });
    const calls: Array<readonly [string, readonly unknown[] | undefined]> = [];
    const query = vi.fn(async (sql: string, params?: readonly unknown[]) => {
      calls.push([sql, params]);
      return { rows: sql.includes("FROM event_store_events") ? sourceHistoryRows([created, sourceEvent], params) : [] };
    });
    const handlers = buildCatalogAdminCatalogItemProjectionHandlers({ query });
    const readSourceStreamHistory = vi.fn(async () => [created, sourceEvent]);

    await handlers[type]?.(sourceEvent, { readSourceStreamHistory });

    // The prefix is read on the projection's own connection, never through a second pool checkout.
    expect(readSourceStreamHistory).not.toHaveBeenCalled();
    expect(calls.filter(([sql]) => sql.includes("FROM event_store_events")).map(([, params]) => params)).toEqual([
      [streamId, 2],
    ]);
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
