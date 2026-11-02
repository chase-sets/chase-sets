import { describe, expect, it, vi } from "vitest";
import { isTransientProjectionError } from "@chase-sets/event-core/projector";
import { buildTransportEvent } from "@chase-sets/event-core/test-support";
import type { TransportEvent } from "@chase-sets/event-core/transport";
import { buildCatalogAdminCatalogItemProjectionHandlers } from "../features/catalog-items/read-model/admin-projection";
import { buildCatalogItemProjectionHandlers } from "../features/catalog-items/read-model/projection";
import { resolveCatalogProductSelection } from "../support/request-support/product-selection";

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
  it("keeps a seeded Catalog Item resolvable when its projections drain on one pool connection", async () => {
    // Bootstrap seeds run on a one-connection pool and drain the item, then the admin, projection locally
    // (createSeedCommandPools, drainCatalogItemPublicationInputs). While an application holds that connection, a
    // reader that asks the pool for another one gets pg-pool's connect timeout; the strict-per-stream runner
    // records that as poison and defers the stream's later events, including publication.
    const itemId = "cat_single_connection";
    const streamId = `catalog.item-${itemId}`;
    const blueprintId = "bpr_single_connection";
    const selectedOptions = [{ dimensionId: "dim_single_connection_form", optionId: "chc_single_connection_raw" }];
    type Page = { status: string; blueprint_id: string | null; updated_at: string };
    type MutableCatalogItemRow = Omit<CatalogItemTestRow, "blueprint_id" | "tags" | "image_fallback"> & {
      blueprint_id: string | null;
      tags: unknown;
      image_fallback: unknown;
    };
    const pageParamIndexes = {
      list: { blueprintId: 9, status: 11, updatedAt: 13 },
      detail: { blueprintId: 11, status: 13, updatedAt: 22 },
    } as const;
    const facts: TransportEvent[] = [];
    const items = new Map<string, MutableCatalogItemRow>();
    const pages = { list: new Map<string, Page>(), detail: new Map<string, Page>() };
    let projectionConnectionHeld = false;
    let secondConnectionRequests = 0;
    const updateItem = (id: unknown, patch: Partial<MutableCatalogItemRow>) => {
      const item = items.get(String(id));
      if (item) items.set(item.catalog_item_id, { ...item, ...patch });
    };
    const query = vi.fn(async (sql: string, params?: readonly unknown[]) => {
      if (sql.includes("FROM event_store_events")) return { rows: sourceHistoryRows(facts, params) };
      if (sql.includes("INSERT INTO catalog_items")) {
        if (!sql.includes("DO NOTHING") || !items.has(String(params?.[0]))) {
          const base = baseCatalogItemRow(String(params?.[0]));
          items.set(base.catalog_item_id, {
            ...base,
            ...items.get(base.catalog_item_id),
            title_i18n: parseLocalizedTextFixture(params?.[2], base.title_i18n),
            title: String(params?.[3]),
            description_i18n: parseLocalizedTextFixture(params?.[6], base.description_i18n),
            description: String(params?.[7]),
            updated_at: String(params?.[8]),
          });
        }
        return { rows: [] };
      }
      if (sql.includes("UPDATE catalog_items SET blueprint_id")) {
        updateItem(params?.[0], { blueprint_id: String(params?.[1]), updated_at: String(params?.[2]) });
      } else if (sql.includes("UPDATE catalog_items SET tags")) {
        updateItem(params?.[0], { tags: JSON.parse(String(params?.[1])), updated_at: String(params?.[2]) });
      } else if (sql.includes("UPDATE catalog_items SET image_fallback = $2")) {
        updateItem(params?.[0], { image_fallback: JSON.parse(String(params?.[1])), updated_at: String(params?.[2]) });
      } else if (sql.includes("UPDATE catalog_items SET status = 'active'")) {
        updateItem(params?.[0], { status: "active", updated_at: String(params?.[1]) });
      } else if (sql.includes("UPDATE catalog_items SET updated_at = GREATEST")) {
        const item = items.get(String(params?.[0]));
        if (item && Date.parse(String(params?.[1])) > Date.parse(item.updated_at)) {
          updateItem(params?.[0], { updated_at: String(params?.[1]) });
        }
      }
      if (sql.includes("FROM catalog_items WHERE catalog_item_id = ANY($1)")) {
        const ids = (params?.[0] as readonly string[] | undefined) ?? [];
        return { rows: ids.flatMap((id) => (items.has(id) ? [items.get(id)!] : [])) };
      }
      if (sql.includes("UNION ALL") && sql.includes("catalog_admin_catalog_item_list_pages")) {
        const ids = (params?.[0] as readonly string[] | undefined) ?? [];
        return {
          rows: ids.flatMap((id) =>
            [pages.list.get(id), pages.detail.get(id)].flatMap((page) =>
              page ? [{ catalog_item_id: id, updated_at: page.updated_at }] : [],
            ),
          ),
        };
      }
      if (sql.includes("INSERT INTO catalog_admin_catalog_item_")) {
        const kind = sql.includes("_detail_pages") ? "detail" : "list";
        const column = (name: keyof (typeof pageParamIndexes)[typeof kind]) =>
          (params?.[pageParamIndexes[kind][name]] as readonly (string | null)[])[0] ?? null;
        const existing = pages[kind].get(itemId);
        const updatedAt = String(column("updatedAt"));
        if (!existing || Date.parse(existing.updated_at) <= Date.parse(updatedAt)) {
          pages[kind].set(itemId, {
            status: String(column("status")),
            blueprint_id: column("blueprintId"),
            updated_at: updatedAt,
          });
        }
        return { rows: [] };
      }
      if (sql.trimStart().startsWith("SELECT *") && sql.includes("FROM catalog_admin_catalog_item_detail_pages")) {
        const page = pages.detail.get(String(params?.[0]));
        return { rows: page ? [{ catalog_item_id: params?.[0], ...page }] : [] };
      }
      if (sql.includes("SELECT dimension_rules, canonical_dimension_order FROM catalog_blueprints")) {
        return {
          rows: [
            {
              dimension_rules: [
                {
                  dimensionId: selectedOptions[0]!.dimensionId,
                  required: true,
                  allowedOptionIds: [selectedOptions[0]!.optionId],
                },
              ],
              canonical_dimension_order: [selectedOptions[0]!.dimensionId],
            },
          ],
        };
      }
      return { rows: [] };
    });
    const projections = [
      { name: "catalog-item-projection", handlers: buildCatalogItemProjectionHandlers({ query }) },
      {
        name: "catalog-admin-catalog-item-projection",
        handlers: buildCatalogAdminCatalogItemProjectionHandlers({ query }),
      },
    ];
    // The runtime source-history reader reads through the source pool, so it needs a second connection.
    const poolHistoryReader = (trigger: TransportEvent) => async () => {
      secondConnectionRequests += 1;
      if (projectionConnectionHeld) throw new Error("timeout exceeded when trying to connect");
      return facts.filter((fact) => fact.streamId === trigger.streamId && fact.streamVersion <= trigger.streamVersion);
    };
    const blockedStreams = new Set<string>();
    const drain = async (pending: readonly TransportEvent[]) => {
      for (const projection of projections) {
        for (const fact of pending) {
          const blockKey = `${projection.name}:${fact.streamId}`;
          if (blockedStreams.has(blockKey)) continue;
          projectionConnectionHeld = true;
          try {
            await projection.handlers[fact.type]?.(fact, { readSourceStreamHistory: poolHistoryReader(fact) });
          } catch (error) {
            if (isTransientProjectionError(error)) throw error;
            blockedStreams.add(blockKey);
          } finally {
            projectionConnectionHeld = false;
          }
        }
      }
    };
    const append = (type: string, data: Record<string, unknown>, minute: number) => {
      const fact = sourceFact(type, data, {
        streamId,
        streamVersion: facts.length + 1,
        recordedAt: `2026-05-17T00:0${minute}:00.000Z`,
      });
      facts.push(fact);
      return fact;
    };

    await drain([
      append(
        "catalog.catalog-item.created",
        { itemId, languageCode: "en", title: "Charizard", subtitle: null, description: "Base Set" },
        0,
      ),
      append("catalog.catalog-item.blueprint-assigned", { blueprintId }, 1),
      append("catalog.catalog-item.tags-set", { tags: ["base-set"] }, 2),
      append("catalog.catalog-item.image-fallback-set", { imageFallback: { url: "https://example.test/back" } }, 3),
      append(
        "catalog.catalog-item.external-product-reference-linked",
        { providerKey: "synthetic-provider", externalKey: "synthetic-sku", selectedOptions },
        4,
      ),
    ]);
    await drain([append("catalog.catalog-item.published", { blueprintId }, 5)]);

    await expect(
      resolveCatalogProductSelection(
        { query },
        {
          catalogItemId: itemId as never,
          productId: `${itemId}::` as never,
          selectedOptions,
        },
      ),
    ).resolves.toMatchObject({ availability: "active", product: { catalogItemId: itemId, selectedOptions } });
    expect([...blockedStreams]).toEqual([]);
    expect(secondConnectionRequests).toBe(0);
  });
});
