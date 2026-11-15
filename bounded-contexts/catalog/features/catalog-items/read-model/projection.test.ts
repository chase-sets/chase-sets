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
    source_stream_version: 1,
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

type WorldItemRow = Omit<CatalogItemTestRow, "blueprint_id" | "tags"> & {
  blueprint_id: string | null;
  tags: unknown;
};
type WorldPage = {
  updated_at: string;
  source_stream_version: number;
  title: string;
  blueprint: string | null;
  tags: string;
};
type PageKind = "list" | "detail";

const worldPageParamIndexes = {
  list: { catalogItemId: 0, title: 3, blueprint: 10, tags: 12, updatedAt: 13, sourceStreamVersion: 14 },
  detail: { catalogItemId: 0, title: 3, blueprint: 12, tags: 18, updatedAt: 22, sourceStreamVersion: 23 },
} as const;

function worldPageParam(
  kind: PageKind,
  params: readonly unknown[] | undefined,
  name: keyof (typeof worldPageParamIndexes)[PageKind],
) {
  return (params?.[worldPageParamIndexes[kind][name]] as readonly unknown[] | undefined)?.[0];
}

// Applies the WHERE clause the page upsert actually carries: the stream-version guard, the retired clock
// guard, or an unconditional overwrite when the guard is missing or mutated.
function worldPageGuardAdmits(kind: PageKind, sql: string, existing: WorldPage | undefined, incoming: WorldPage) {
  if (!existing) return true;
  const normalizedSql = sql.replace(/\s+/g, " ").trim();
  const table = `catalog_admin_catalog_item_${kind}_pages`;
  if (normalizedSql.endsWith(`WHERE ${table}.source_stream_version <= EXCLUDED.source_stream_version`)) {
    return existing.source_stream_version <= incoming.source_stream_version;
  }
  if (normalizedSql.endsWith(`WHERE ${table}.updated_at <= EXCLUDED.updated_at`)) {
    return Date.parse(existing.updated_at) <= Date.parse(incoming.updated_at);
  }
  return true;
}

// One stateful catalog_items + admin page store shared by the item and admin projectors.
function makeCatalogItemWorld(
  sourceFacts: readonly TransportEvent[],
  blueprints: ReadonlyMap<string, string> = new Map(),
) {
  const items = new Map<string, WorldItemRow>();
  const pages: Record<PageKind, Map<string, WorldPage>> = { list: new Map(), detail: new Map() };
  const blueprintNames = new Map(blueprints);
  const externalProductReferences: Array<Record<string, unknown>> = [];
  const calls: Array<readonly [string, readonly unknown[] | undefined]> = [];
  const updateItem = (id: unknown, patch: Partial<WorldItemRow>) => {
    const item = items.get(String(id));
    if (item) items.set(item.catalog_item_id, { ...item, ...patch });
  };
  const query = vi.fn(async (sql: string, params?: readonly unknown[]) => {
    calls.push([sql, params]);
    if (sql.includes("FROM event_store_events")) {
      return { rows: sourceHistoryRows(sourceFacts, params) };
    }
    if (sql.includes("FROM catalog_items WHERE catalog_item_id = ANY($1)")) {
      const ids = (params?.[0] as readonly string[] | undefined) ?? [];
      // pg returns bigint columns as strings.
      return {
        rows: ids.flatMap((id) => {
          const item = items.get(id);
          return item ? [{ ...item, source_stream_version: String(item.source_stream_version) }] : [];
        }),
      };
    }
    if (sql.includes("SELECT catalog_item_id FROM catalog_items WHERE blueprint_id = $1")) {
      return {
        rows: [...items.values()]
          .filter((item) => item.blueprint_id === params?.[0])
          .map((item) => ({ catalog_item_id: item.catalog_item_id })),
      };
    }
    if (sql.includes("UNION ALL") && sql.includes("catalog_admin_catalog_item_list_pages")) {
      // Both freshness columns are served so the code under test alone decides which one it compares.
      const ids = (params?.[0] as readonly string[] | undefined) ?? [];
      return {
        rows: ids.flatMap((id) =>
          [pages.list.get(id), pages.detail.get(id)].flatMap((page) =>
            page
              ? [
                  {
                    catalog_item_id: id,
                    updated_at: page.updated_at,
                    source_stream_version: String(page.source_stream_version),
                  },
                ]
              : [],
          ),
        ),
      };
    }
    if (sql.includes("FROM catalog_blueprints")) {
      const ids = (params?.[0] as readonly string[] | undefined) ?? [];
      return { rows: ids.flatMap((id) => (blueprintNames.has(id) ? [{ id, name: blueprintNames.get(id)! }] : [])) };
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
    if (sql.includes("catalog_external_product_references")) {
      return {
        rows: externalProductReferences.filter((row) =>
          (params?.[0] as readonly string[] | undefined)?.includes(String(row.catalog_item_id)),
        ),
      };
    }
    if (sql.includes("INSERT INTO catalog_items")) {
      const id = String(params?.[0]);
      if (!sql.includes("DO NOTHING") || !items.has(id)) {
        const base = baseCatalogItemRow(id);
        items.set(id, {
          ...base,
          ...items.get(id),
          language_code: String(params?.[1]),
          title_i18n: parseLocalizedTextFixture(params?.[2], base.title_i18n),
          title: String(params?.[3]),
          description_i18n: parseLocalizedTextFixture(params?.[6], base.description_i18n),
          description: String(params?.[7]),
          updated_at: String(params?.[8]),
          source_stream_version: Number(params?.[9]),
        });
      }
      return { rows: [] };
    }
    if (sql.includes("UPDATE catalog_items SET blueprint_id")) {
      updateItem(params?.[0], {
        blueprint_id: String(params?.[1]),
        updated_at: String(params?.[2]),
        source_stream_version: Number(params?.[3]),
      });
      return { rows: [] };
    }
    if (sql.includes("UPDATE catalog_items SET tags")) {
      updateItem(params?.[0], {
        tags: JSON.parse(String(params?.[1])),
        updated_at: String(params?.[2]),
        source_stream_version: Number(params?.[3]),
      });
      return { rows: [] };
    }
    if (sql.includes("UPDATE catalog_items") && sql.includes("SET language_code = $2")) {
      const base = baseCatalogItemRow(String(params?.[0]));
      updateItem(params?.[0], {
        language_code: String(params?.[1]),
        title_i18n: parseLocalizedTextFixture(params?.[2], base.title_i18n),
        title: String(params?.[3]),
        description_i18n: parseLocalizedTextFixture(params?.[6], base.description_i18n),
        description: String(params?.[7]),
        updated_at: String(params?.[8]),
        source_stream_version: Number(params?.[9]),
      });
      return { rows: [] };
    }
    if (sql.includes("GREATEST(updated_at, $2)")) {
      const item = items.get(String(params?.[0]));
      if (item) {
        updateItem(item.catalog_item_id, {
          updated_at:
            Date.parse(String(params?.[1])) > Date.parse(item.updated_at) ? String(params?.[1]) : item.updated_at,
          source_stream_version: Math.max(item.source_stream_version, Number(params?.[2])),
        });
      }
      return { rows: [] };
    }
    const pageWrite = /INSERT INTO catalog_admin_catalog_item_(list|detail)_pages/.exec(sql);
    if (pageWrite) {
      const kind = pageWrite[1] as PageKind;
      const id = String(worldPageParam(kind, params, "catalogItemId"));
      const incoming: WorldPage = {
        updated_at: String(worldPageParam(kind, params, "updatedAt")),
        source_stream_version: Number(worldPageParam(kind, params, "sourceStreamVersion")),
        title: String(worldPageParam(kind, params, "title") ?? ""),
        blueprint: (worldPageParam(kind, params, "blueprint") as string | null | undefined) ?? null,
        tags: String(worldPageParam(kind, params, "tags") ?? "[]"),
      };
      if (worldPageGuardAdmits(kind, sql, pages[kind].get(id), incoming)) pages[kind].set(id, incoming);
      return { rows: [] };
    }
    return { rows: [] };
  });
  return {
    admin: buildCatalogAdminCatalogItemProjectionHandlers({ query }),
    item: buildCatalogItemProjectionHandlers({ query }),
    query,
    calls,
    items,
    listPages: pages.list,
    detailPages: pages.detail,
    pages,
    blueprintNames,
  };
}

function renderedBlueprintName(page: WorldPage | undefined) {
  return page?.blueprint ? (JSON.parse(page.blueprint) as { name: string }).name : null;
}

async function rejectsAsTransient(run: Promise<unknown> | undefined) {
  try {
    await run;
    return false;
  } catch (error) {
    if (!isTransientProjectionError(error)) throw error;
    return true;
  }
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
      streamVersion: 2,
      data: { categoryId: "category_1" },
      timing: { recordedAt: "2026-05-17T00:00:00.000Z" },
    } as never;

    await handlers["catalog.catalog-item.category-assigned"]?.(assigned);
    await handlers["catalog.catalog-item.category-assigned"]?.(assigned);

    expect(query).toHaveBeenCalledTimes(2);
    for (const [sql, params] of query.mock.calls) {
      expect(sql).toContain("WHEN category_ids @> $2::jsonb THEN category_ids");
      expect(params).toEqual(["cat_1", '["category_1"]', "2026-05-17T00:00:00.000Z", 2]);
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
      expect(pageWrites.every(([sql]) => sql.includes("source_stream_version <= EXCLUDED.source_stream_version"))).toBe(
        true,
      );
      expect(pageWrites.every(([, params]) => (params?.[3] as readonly string[])[0] === "After")).toBe(true);
      expect(calls.some(([sql]) => sql.includes("SELECT * FROM catalog_items WHERE catalog_item_id = ANY($1)"))).toBe(
        false,
      );
    }
  });

  it("retries an admin refresh when a page is at a later stream version than its source item row", async () => {
    const query = vi.fn(async (sql: string, params?: readonly unknown[]) => {
      if (sql.includes("SELECT * FROM catalog_items WHERE catalog_item_id = ANY($1)")) {
        return { rows: [baseCatalogItemRow(String((params?.[0] as string[])[0]))] };
      }
      if (sql.includes("FROM catalog_admin_catalog_item_list_pages")) {
        // Same recorded clock as the item row; only the stream version shows the item projection is behind.
        return {
          rows: [{ catalog_item_id: "cat_1", updated_at: "2026-05-17T00:00:00.000Z", source_stream_version: "2" }],
        };
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

    const makeWorld = (sourceFacts: readonly TransportEvent[]) =>
      makeCatalogItemWorld(sourceFacts, new Map([[blueprintId, "Old Blueprint"]]));

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
      expect(renderedBlueprintName(world.listPages.get(itemId))).toBe("New Blueprint");
      expect(renderedBlueprintName(world.detailPages.get(itemId))).toBe("New Blueprint");
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
      expect(renderedBlueprintName(world.listPages.get(itemId))).toBe("New Blueprint");
      expect(renderedBlueprintName(world.detailPages.get(itemId))).toBe("New Blueprint");
    }
  });

  it("rejects an older-version page write after a newer one even when the older carries the later clock", async () => {
    const itemId = "cat_guard";
    const streamId = `catalog.item-${itemId}`;
    const created = sourceFact(
      "catalog.catalog-item.created",
      { itemId, languageCode: "en", title: "Old", subtitle: null, description: "Old" },
      { streamId, streamVersion: 1, recordedAt: "2026-05-17T00:00:00.000Z" },
    );
    // Version 2 was recorded a minute after version 3: only the stream version orders them.
    const older = sourceFact(
      "catalog.catalog-item.metadata-revised",
      { languageCode: "en", title: "Older", subtitle: null, description: "Older" },
      { streamId, streamVersion: 2, recordedAt: "2026-05-17T00:03:00.000Z" },
    );
    const current = sourceFact(
      "catalog.catalog-item.metadata-revised",
      { languageCode: "en", title: "Newer", subtitle: null, description: "Newer" },
      { streamId, streamVersion: 3, recordedAt: "2026-05-17T00:02:00.000Z" },
    );
    const world = makeCatalogItemWorld([created, older, current]);

    await world.admin[current.type]?.(current);
    await world.admin[older.type]?.(older);

    for (const kind of ["list", "detail"] as const) {
      const writes = world.calls.filter(([sql]) =>
        sql.includes(`INSERT INTO catalog_admin_catalog_item_${kind}_pages`),
      );
      expect(writes).toHaveLength(2);
      for (const [sql] of writes) {
        const normalizedSql = sql.replace(/\s+/g, " ").trim();
        expect(normalizedSql).toMatch(
          new RegExp(
            `WHERE catalog_admin_catalog_item_${kind}_pages\\.source_stream_version <= EXCLUDED\\.source_stream_version$`,
          ),
        );
        expect(normalizedSql).not.toContain("updated_at <=");
      }
      expect(world.pages[kind].get(itemId)).toMatchObject({
        title: "Newer",
        source_stream_version: 3,
        updated_at: "2026-05-17T00:02:00.000Z",
      });
    }
  });

  it("compares stream versions, not recorded clocks, in the stale-source check", async () => {
    const itemId = "cat_stale_check_sql";
    const streamId = `catalog.item-${itemId}`;
    const created = sourceFact(
      "catalog.catalog-item.created",
      { itemId, languageCode: "en", title: "Item", subtitle: null, description: "Item" },
      { streamId, streamVersion: 1, recordedAt: "2026-05-17T00:00:00.000Z" },
    );
    const world = makeCatalogItemWorld([created]);
    await world.item[created.type]?.(created);
    await world.admin[created.type]?.(created);

    const staleChecks = world.calls
      .filter(([sql]) => sql.includes("UNION ALL") && sql.includes("catalog_admin_catalog_item_list_pages"))
      .map(([sql]) => sql.replace(/\s+/g, " ").trim());
    expect(staleChecks).toEqual([
      "SELECT catalog_item_id, source_stream_version FROM catalog_admin_catalog_item_list_pages WHERE catalog_item_id = ANY($1) UNION ALL SELECT catalog_item_id, source_stream_version FROM catalog_admin_catalog_item_detail_pages WHERE catalog_item_id = ANY($1)",
    ]);
  });

  it("converges a backwards recorded clock inside one item stream under either projector order", async () => {
    const itemId = "cat_clock_regression";
    const streamId = `catalog.item-${itemId}`;
    const blueprintId = "bpr_clock_regression";
    const at = (streamVersion: number, recordedAt: string) => ({ streamId, streamVersion, recordedAt });
    const created = sourceFact(
      "catalog.catalog-item.created",
      { itemId, languageCode: "en", title: "Created", subtitle: null, description: "Created" },
      at(1, "2026-05-17T00:00:00.000Z"),
    );
    const assigned = sourceFact(
      "catalog.catalog-item.blueprint-assigned",
      { blueprintId },
      at(2, "2026-05-17T00:01:00.000Z"),
    );
    // The app clock went backwards between appends: version 4 is recorded a minute before version 3.
    const versionThree = sourceFact(
      "catalog.catalog-item.metadata-revised",
      { languageCode: "en", title: "Version Three", subtitle: null, description: "Version Three" },
      at(3, "2026-05-17T00:03:00.000Z"),
    );
    const versionFour = sourceFact(
      "catalog.catalog-item.metadata-revised",
      { languageCode: "en", title: "Version Four", subtitle: null, description: "Version Four" },
      at(4, "2026-05-17T00:02:00.000Z"),
    );
    const rename = sourceFact(
      "catalog.blueprint.revised",
      {},
      { streamId: `catalog.blueprint-${blueprintId}`, streamVersion: 2, recordedAt: "2026-05-17T00:04:00.000Z" },
    );
    const facts = [created, assigned, versionThree, versionFour];
    const expectPages = (world: ReturnType<typeof makeCatalogItemWorld>, blueprintName: string) => {
      for (const kind of ["list", "detail"] as const) {
        const page = world.pages[kind].get(itemId);
        expect(page).toMatchObject({ title: "Version Four", source_stream_version: 4 });
        expect(renderedBlueprintName(page)).toBe(blueprintName);
      }
    };

    for (const order of ["item-before-admin", "admin-before-item"] as const) {
      const world = makeCatalogItemWorld(facts, new Map([[blueprintId, "Old Blueprint"]]));
      for (const fact of facts) {
        for (const handlers of order === "item-before-admin" ? [world.item, world.admin] : [world.admin, world.item]) {
          await handlers[fact.type]?.(fact);
        }
      }
      expect(world.items.get(itemId)).toMatchObject({ title: "Version Four", source_stream_version: 4 });
      expectPages(world, "Old Blueprint");

      world.blueprintNames.set(blueprintId, "New Blueprint");
      await world.admin[rename.type]?.(rename);
      expectPages(world, "New Blueprint");
    }

    // With the admin projection ahead, the rename waits until the item projection applies version 4.
    const world = makeCatalogItemWorld(facts, new Map([[blueprintId, "Old Blueprint"]]));
    for (const fact of facts) await world.admin[fact.type]?.(fact);
    for (const fact of [created, assigned, versionThree]) await world.item[fact.type]?.(fact);
    world.blueprintNames.set(blueprintId, "New Blueprint");
    expect(await rejectsAsTransient(world.admin[rename.type]?.(rename))).toBe(true);
    expectPages(world, "Old Blueprint");
    await world.item[versionFour.type]?.(versionFour);
    await world.admin[rename.type]?.(rename);
    expectPages(world, "New Blueprint");
  });

  it("retries a dependent refresh while the item projection lags behind an equal-stamp admin write", async () => {
    const itemId = "cat_equal_stamp";
    const streamId = `catalog.item-${itemId}`;
    const blueprintId = "bpr_equal_stamp";
    const sharedStamp = "2026-05-17T00:02:00.000Z";
    const at = (streamVersion: number, recordedAt: string) => ({ streamId, streamVersion, recordedAt });
    const created = sourceFact(
      "catalog.catalog-item.created",
      { itemId, languageCode: "en", title: "Created", subtitle: null, description: "Created" },
      at(1, "2026-05-17T00:00:00.000Z"),
    );
    const assigned = sourceFact(
      "catalog.catalog-item.blueprint-assigned",
      { blueprintId },
      at(2, "2026-05-17T00:01:00.000Z"),
    );
    // One append can stamp several events with the same recordedAt.
    const tagged = sourceFact("catalog.catalog-item.tags-set", { tags: ["first-value"] }, at(3, sharedStamp));
    const revised = sourceFact(
      "catalog.catalog-item.metadata-revised",
      { languageCode: "en", title: "Second Value", subtitle: null, description: "Second Value" },
      at(4, sharedStamp),
    );
    const rename = sourceFact(
      "catalog.blueprint.revised",
      {},
      { streamId: `catalog.blueprint-${blueprintId}`, streamVersion: 2, recordedAt: "2026-05-17T00:03:00.000Z" },
    );
    const facts = [created, assigned, tagged, revised];
    const world = makeCatalogItemWorld(facts, new Map([[blueprintId, "Old Blueprint"]]));

    for (const fact of facts) await world.admin[fact.type]?.(fact);
    for (const fact of [created, assigned, tagged]) await world.item[fact.type]?.(fact);
    expect(world.items.get(itemId)).toMatchObject({ updated_at: sharedStamp, source_stream_version: 3 });
    expect(world.listPages.get(itemId)).toMatchObject({ updated_at: sharedStamp, source_stream_version: 4 });

    world.blueprintNames.set(blueprintId, "New Blueprint");
    expect(await rejectsAsTransient(world.admin[rename.type]?.(rename))).toBe(true);
    expect(await rejectsAsTransient(world.admin[rename.type]?.(rename))).toBe(true);

    await world.item[revised.type]?.(revised);
    await world.admin[rename.type]?.(rename);
    for (const kind of ["list", "detail"] as const) {
      const page = world.pages[kind].get(itemId);
      expect(page).toMatchObject({ title: "Second Value", tags: '["first-value"]', source_stream_version: 4 });
      expect(renderedBlueprintName(page)).toBe("New Blueprint");
    }
  });

  it("converges version-0 pre-migration rows on the next event without a backfill", async () => {
    const itemId = "cat_pre_migration";
    const streamId = `catalog.item-${itemId}`;
    const blueprintId = "bpr_pre_migration";
    const at = (streamVersion: number, recordedAt: string) => ({ streamId, streamVersion, recordedAt });
    const created = sourceFact(
      "catalog.catalog-item.created",
      { itemId, languageCode: "en", title: "Legacy", subtitle: null, description: "Legacy" },
      at(1, "2026-05-17T00:00:00.000Z"),
    );
    const assigned = sourceFact(
      "catalog.catalog-item.blueprint-assigned",
      { blueprintId },
      at(2, "2026-05-17T00:01:00.000Z"),
    );
    const tagged = sourceFact(
      "catalog.catalog-item.tags-set",
      { tags: ["post-migration"] },
      at(3, "2026-05-17T00:02:00.000Z"),
    );
    const renameAt = (streamVersion: number) =>
      sourceFact(
        "catalog.blueprint.revised",
        {},
        { streamId: `catalog.blueprint-${blueprintId}`, streamVersion, recordedAt: "2026-05-17T00:03:00.000Z" },
      );
    const facts = [created, assigned, tagged];
    // Rows written before the migration read source_stream_version 0 through the column default.
    const preMigrationWorld = () => makeCatalogItemWorld(facts, new Map([[blueprintId, "Old Blueprint"]]));
    const seedPreMigrationRows = async (world: ReturnType<typeof makeCatalogItemWorld>) => {
      for (const fact of [created, assigned]) {
        await world.item[fact.type]?.(fact);
        await world.admin[fact.type]?.(fact);
      }
      world.items.set(itemId, { ...world.items.get(itemId)!, source_stream_version: 0 });
      for (const kind of ["list", "detail"] as const) {
        world.pages[kind].set(itemId, { ...world.pages[kind].get(itemId)!, source_stream_version: 0 });
      }
    };

    // Both rows at 0: a dependent refresh is not a stale retry and rewrites the page at 0.
    const unversioned = preMigrationWorld();
    await seedPreMigrationRows(unversioned);
    unversioned.blueprintNames.set(blueprintId, "Renamed Once");
    await unversioned.admin["catalog.blueprint.revised"]?.(renameAt(2));
    expect(renderedBlueprintName(unversioned.listPages.get(itemId))).toBe("Renamed Once");
    expect(unversioned.detailPages.get(itemId)?.source_stream_version).toBe(0);

    // A 0-version page and a catalog_items row versioned by the next event: the refresh converges the page.
    const itemFirst = preMigrationWorld();
    await seedPreMigrationRows(itemFirst);
    await itemFirst.item[tagged.type]?.(tagged);
    itemFirst.blueprintNames.set(blueprintId, "Renamed Twice");
    await itemFirst.admin["catalog.blueprint.revised"]?.(renameAt(3));
    for (const kind of ["list", "detail"] as const) {
      const page = itemFirst.pages[kind].get(itemId);
      expect(page).toMatchObject({ tags: '["post-migration"]', source_stream_version: 3 });
      expect(renderedBlueprintName(page)).toBe("Renamed Twice");
    }

    // The admin projection's own history write for the next event also lands on the 0-version page.
    const adminFirst = preMigrationWorld();
    await seedPreMigrationRows(adminFirst);
    await adminFirst.admin[tagged.type]?.(tagged);
    for (const kind of ["list", "detail"] as const) {
      expect(adminFirst.pages[kind].get(itemId)).toMatchObject({
        tags: '["post-migration"]',
        source_stream_version: 3,
      });
    }
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
