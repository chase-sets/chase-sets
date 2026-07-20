import { describe, expect, it, vi } from "vitest";
import type { TransportEvent } from "@chase-sets/event-core/transport";
import { buildTransportEvent } from "@chase-sets/event-core/test-support";
import type { PgQueryResult, PgQueryable } from "@chase-sets/event-core-postgres";
import { buildDiscoverySearchItemProjectionHandlers } from "../../../../discovery/features/search/read-model/projection";
import type { CatalogItemCommand } from "../domain/domain";
import {
  getCatalogItemDisplayIdentityRecomputeHealth,
  processCatalogItemDisplayIdentityRecomputeBatch,
  purgeCompletedCatalogItemDisplayIdentityRecomputeWork,
} from "./display-identity-recompute";

describe("display identity recomputation work", () => {
  it("persists changed identity and publishes one item-level fact", async () => {
    const published = commandHandler();
    const afterPersist = vi.fn(async () => undefined);
    const persistedWrites: unknown[][] = [];
    const publicationMarks: unknown[][] = [];
    const statusUpdates: string[] = [];
    const db = recomputeDb({ existingHash: "old-hash", persistedWrites, publicationMarks, statusUpdates });

    const result = await processCatalogItemDisplayIdentityRecomputeBatch(db, published, { actor: "test" } as never, {
      limit: 10,
      afterPersist,
    });

    expect(result).toMatchObject({
      selected: 1,
      processed: 1,
      changed: 1,
      unchanged: 0,
      missing: 0,
      failed: 0,
    });
    expect(persistedWrites).toHaveLength(1);
    expect(publicationMarks).toEqual([["cat_1", "en", persistedWrites[0]?.[7], expect.any(String)]]);
    expect(statusUpdates).toEqual(["running", "completed"]);
    expect(published).toHaveBeenCalledTimes(1);
    expect(afterPersist).toHaveBeenCalledWith("cat_1");
    expect(published).toHaveBeenCalledWith(
      expect.objectContaining({
        streamId: "catalog.item-cat_1",
        command: expect.objectContaining({
          type: "RecordCatalogItemDisplayIdentity",
          catalogItemId: "cat_1",
          title: "Pikachu 58/102",
          subtitle: "Base Set",
          displayTemplateKey: "pokemon-card",
          displayIdentityHash: persistedWrites[0]?.[7],
          resolverVersion: 3,
          resolutionStatus: "resolved",
          missingTokens: [],
        }),
      }),
    );
  });

  it("does not publish when the resolved hash is unchanged", async () => {
    const firstDb = recomputeDb({ existingHash: null });
    const first = await processCatalogItemDisplayIdentityRecomputeBatch(firstDb, commandHandler(), {} as never);
    const hash = firstDb.persistedWrites[0]?.[7] as string;

    const published = commandHandler();
    const db = recomputeDb({ existingHash: hash, lastPublishedHash: hash });

    const result = await processCatalogItemDisplayIdentityRecomputeBatch(db, published, {} as never);

    expect(result).toMatchObject({ selected: 1, processed: 1, changed: 0, unchanged: 1, failed: 0 });
    expect(published).not.toHaveBeenCalled();
  });

  it("publishes when admin projection already persisted the resolved hash before publication", async () => {
    const firstDb = recomputeDb({ existingHash: null });
    await processCatalogItemDisplayIdentityRecomputeBatch(firstDb, commandHandler(), {} as never);
    const hash = firstDb.persistedWrites[0]?.[7] as string;

    const published = commandHandler();
    const publicationMarks: unknown[][] = [];
    const db = recomputeDb({ existingHash: hash, lastPublishedHash: null, publicationMarks });

    const result = await processCatalogItemDisplayIdentityRecomputeBatch(db, published, {} as never);

    expect(result).toMatchObject({ selected: 1, processed: 1, changed: 1, unchanged: 0, failed: 0 });
    expect(published).toHaveBeenCalledTimes(1);
    expect(published).toHaveBeenCalledWith(
      expect.objectContaining({
        command: expect.objectContaining({
          type: "RecordCatalogItemDisplayIdentity",
          displayIdentityHash: hash,
        }),
      }),
    );
    expect(publicationMarks).toEqual([["cat_1", "en", hash, expect.any(String)]]);
  });

  it("propagates the template-resolved Catalog display identity into Discovery search rows", async () => {
    const publishedCommands: CatalogItemCommand[] = [];
    const published = vi.fn(async (input: { command: CatalogItemCommand }) => {
      publishedCommands.push(input.command);
      return { state: null, version: 1, newEvents: [], storedEvents: [] } as never;
    });
    const db = recomputeDb({ existingHash: null });

    const result = await processCatalogItemDisplayIdentityRecomputeBatch(db, published, {} as never);

    expect(result).toMatchObject({ processed: 1, changed: 1, failed: 0 });
    expect(publishedCommands).toHaveLength(1);
    const command = publishedCommands[0];
    expect(command).toMatchObject({
      type: "RecordCatalogItemDisplayIdentity",
      title: "Pikachu 58/102",
      subtitle: "Base Set",
      displayTemplateKey: "pokemon-card",
    });

    const discoveryDb = new DiscoverySearchProjectionDb();
    const handlers = buildDiscoverySearchItemProjectionHandlers(discoveryDb);
    await handlers["catalog.catalog-item.display-identity-resolved"]?.(displayIdentityEventFromCommand(command));

    expect(discoveryDb.searchCatalogItems.get("cat_1")).toMatchObject({
      title: "Pikachu 58/102",
      subtitle: "Base Set",
    });
    expect(discoveryDb.searchItems.get("cat_1")).toMatchObject({
      title: "Pikachu 58/102",
      subtitle: "Base Set",
      titleSearchText: "Pikachu 58/102",
      subtitleSearchText: "Base Set",
    });
  });

  it("summarizes recomputation health for operators", async () => {
    const db = {
      async query<T>(sql: string): Promise<{ rows: T[] }> {
        if (sql.includes("GROUP BY status")) {
          return {
            rows: [
              { status: "pending", count: "3" },
              { status: "running", count: "1" },
              { status: "completed", count: "8" },
            ] as T[],
          };
        }

        return {
          rows: [
            {
              pending_with_error: "2",
              oldest_pending_at: "2026-06-06T12:00:00.000Z",
              latest_failure_message: "resolver failed",
            },
          ] as T[],
        };
      },
    };

    await expect(getCatalogItemDisplayIdentityRecomputeHealth(db)).resolves.toEqual({
      pending: 3,
      running: 1,
      completed: 8,
      pendingWithError: 2,
      oldestPendingAt: "2026-06-06T12:00:00.000Z",
      latestFailureMessage: "resolver failed",
    });
  });

  it("purges only completed recomputation work older than the retention cutoff", async () => {
    const calls: Array<{ sql: string; params: readonly unknown[] }> = [];
    const db = {
      async query<T>(sql: string, params?: readonly unknown[]): Promise<{ rows: T[]; rowCount: number }> {
        calls.push({ sql, params: params ?? [] });
        return { rows: [], rowCount: 7 };
      },
    };

    await expect(
      purgeCompletedCatalogItemDisplayIdentityRecomputeWork(db, {
        completedBefore: "2026-06-01T00:00:00.000Z",
      }),
    ).resolves.toBe(7);

    expect(calls[0]?.sql).toContain("status = 'completed'");
    expect(calls[0]?.sql).toContain("completed_at < $1");
    expect(calls[0]?.sql).not.toContain("status IN");
    expect(calls[0]?.params).toEqual(["2026-06-01T00:00:00.000Z"]);
  });

  it("uses the claimed work state as a concurrency predicate for every terminal transition", async () => {
    const queries: string[] = [];
    const db = recomputeDb({ existingHash: null, queries });

    await processCatalogItemDisplayIdentityRecomputeBatch(db, commandHandler(), {} as never);

    expect(queries.find((sql) => sql.includes("SET status = 'running'"))).toContain("AND status = 'pending'");
    expect(queries.find((sql) => sql.includes("SET status = 'completed'"))).toContain("AND status = 'running'");
  });
});

function commandHandler() {
  return vi.fn(async () => ({ state: null, version: 1, newEvents: [], storedEvents: [] }) as never);
}

class DiscoverySearchProjectionDb implements PgQueryable {
  public readonly searchCatalogItems = new Map<string, Record<string, unknown>>([["cat_1", discoveryCatalogItemRow()]]);
  public readonly searchItems = new Map<string, Record<string, unknown>>();

  async query<Row = Record<string, unknown>>(
    sql: string,
    values: readonly unknown[] = [],
  ): Promise<PgQueryResult<Row>> {
    if (sql.includes("SELECT slug FROM discovery_search_catalog_items")) {
      const row = this.searchCatalogItems.get(String(values[0]));
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
        updated_at: values[7],
      });
      return { rows: [], rowCount: 1 };
    }

    if (sql.includes("INSERT INTO discovery_slug_redirects")) {
      return { rows: [], rowCount: 1 };
    }

    if (sql.includes("SELECT * FROM discovery_search_catalog_items")) {
      const row = this.searchCatalogItems.get(String(values[0]));
      return { rows: (row ? [row] : []) as Row[], rowCount: row ? 1 : 0 };
    }

    if (sql.includes("INSERT INTO discovery_search_items")) {
      this.searchItems.set(String(values[0]), {
        catalogItemId: values[0],
        slug: values[1],
        languageCode: values[2],
        title: values[4],
        subtitle: values[6],
        titleSearchText: values[25],
        subtitleSearchText: values[26],
      });
      return { rows: [], rowCount: 1 };
    }

    if (sql.includes("UPDATE discovery_search_product_contents")) {
      return { rows: [], rowCount: 0 };
    }

    if (sql.includes("discovery_search_product_contents") && sql.includes("SELECT")) {
      return { rows: [], rowCount: 0 };
    }

    if (sql.includes("DELETE FROM discovery_search_items")) {
      return { rows: [], rowCount: 0 };
    }

    if (
      sql.includes("discovery_search_catalog_categories") ||
      sql.includes("discovery_search_catalog_blueprints") ||
      sql.includes("discovery_search_catalog_fields") ||
      sql.includes("discovery_search_catalog_reference_records") ||
      sql.includes("discovery_search_catalog_blueprint_dimensions")
    ) {
      return { rows: [], rowCount: 0 };
    }

    throw new Error(`Unexpected query: ${sql}`);
  }
}

function discoveryCatalogItemRow(): Record<string, unknown> {
  return {
    catalog_item_id: "cat_1",
    slug: "old-title-cat-1",
    language_code: "en",
    title_i18n: { defaultLocale: "en", values: { en: "Old Title" } },
    title: "Old Title",
    subtitle_i18n: null,
    subtitle: null,
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
    resolved_aliases: {},
    updated_at: "2026-06-06T00:00:00.000Z",
  };
}

function displayIdentityEventFromCommand(command: CatalogItemCommand): TransportEvent {
  if (command.type !== "RecordCatalogItemDisplayIdentity") {
    throw new Error(`Expected display identity command, received ${command.type}`);
  }

  return buildTransportEvent(
    "catalog.catalog-item.display-identity-resolved",
    {
      catalogItemId: command.catalogItemId,
      languageCode: command.languageCode ?? "en",
      title: command.title,
      subtitle: command.subtitle ?? null,
      displayTemplateKey: command.displayTemplateKey ?? null,
      displayTemplateTargetKind: command.displayTemplateTargetKind ?? null,
      displayTemplateTargetId: command.displayTemplateTargetId ?? null,
      displayIdentityHash: command.displayIdentityHash,
      resolverVersion: command.resolverVersion,
      resolvedAt: command.resolvedAt,
    },
    {
      id: "evt_display_identity",
      streamId: `catalog.item-${command.catalogItemId}`,
      streamVersion: 2,
      globalPosition: "2",
      tenantId: "tnt_1",
      audit: { performedByUserId: "usr_1", forAccountId: "acc_1" },
      timing: { occurredAt: command.resolvedAt, recordedAt: command.resolvedAt },
    },
  );
}

function recomputeDb(options: {
  existingHash?: string | null;
  lastPublishedHash?: string | null;
  persistedWrites?: unknown[][];
  publicationMarks?: unknown[][];
  statusUpdates?: string[];
  queries?: string[];
}) {
  const persistedWrites = options.persistedWrites ?? [];
  const publicationMarks = options.publicationMarks ?? [];
  const statusUpdates = options.statusUpdates ?? [];

  return {
    persistedWrites,
    async query<T>(sql: string, params?: readonly unknown[]): Promise<{ rows: T[] }> {
      options.queries?.push(sql);
      if (sql.includes("FROM catalog_item_display_identity_recompute_work")) {
        return { rows: [{ catalog_item_id: "cat_1" }] as T[] };
      }

      if (sql.includes("SET status = 'running'")) {
        statusUpdates.push("running");
        return { rows: [] };
      }

      if (sql.includes("SET status = 'completed'")) {
        statusUpdates.push("completed");
        return { rows: [] };
      }

      if (sql.includes("SET status = 'pending'")) {
        statusUpdates.push("failed");
        return { rows: [] };
      }

      if (sql.includes("SELECT * FROM catalog_items WHERE catalog_item_id = $1")) {
        return {
          rows: [
            {
              catalog_item_id: params?.[0],
              language_code: "en",
              title: "Pikachu",
              subtitle: null,
              blueprint_id: "bpr_pokemon",
              category_ids: [],
              field_values: [
                { fieldId: "fld_name", value: "Pikachu" },
                { fieldId: "fld_number", value: "58" },
                { fieldId: "fld_expansion", value: { referenceId: "ref_base" } },
              ],
            },
          ] as T[],
        };
      }

      if (sql.includes("FROM catalog_item_display_identities")) {
        return options.existingHash
          ? {
              rows: [
                {
                  display_identity_hash: options.existingHash,
                  last_published_display_identity_hash: options.lastPublishedHash ?? null,
                },
              ] as T[],
            }
          : { rows: [] };
      }

      if (sql.includes("INSERT INTO catalog_item_display_identities")) {
        persistedWrites.push([...(params ?? [])]);
        return { rows: [] };
      }

      if (sql.includes("last_published_display_identity_hash")) {
        publicationMarks.push([...(params ?? [])]);
        return { rows: [] };
      }

      if (sql.includes("FROM catalog_fields")) {
        return {
          rows: [
            { field_id: "fld_name", key: "card-name" },
            { field_id: "fld_number", key: "card-number" },
            { field_id: "fld_expansion", key: "expansion" },
          ] as T[],
        };
      }

      if (sql.includes("FROM catalog_display_templates")) {
        return {
          rows: [
            {
              key: "pokemon-card",
              target_kind: "blueprint",
              target_id: "bpr_pokemon",
              priority: 10,
              title_template: "{field.card-name} {field.card-number}/102",
              subtitle_template: "{reference.expansion.name}",
              required_field_keys: ["card-name", "card-number", "expansion"],
            },
          ] as T[],
        };
      }

      if (sql.includes("FROM catalog_reference_records")) {
        return {
          rows: [
            {
              reference_record_id: "ref_base",
              type_key: "expansion",
              key: "base-set",
              name: "Base Set",
              attributes: {},
              relationships: [],
              status: "active",
            },
          ] as T[],
        };
      }

      return { rows: [] };
    },
  };
}
