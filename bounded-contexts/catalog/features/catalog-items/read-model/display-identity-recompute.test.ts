import { describe, expect, it, vi } from "vitest";
import {
  getCatalogItemDisplayIdentityRecomputeHealth,
  processCatalogItemDisplayIdentityRecomputeBatch,
} from "./display-identity-recompute";

describe("display identity recomputation work", () => {
  it("persists changed identity and publishes one item-level fact", async () => {
    const published = commandHandler();
    const afterPersist = vi.fn(async () => undefined);
    const persistedWrites: unknown[][] = [];
    const statusUpdates: string[] = [];
    const db = recomputeDb({ existingHash: "old-hash", persistedWrites, statusUpdates });

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
          resolverVersion: 1,
        }),
      }),
    );
  });

  it("does not publish when the resolved hash is unchanged", async () => {
    const firstDb = recomputeDb({ existingHash: null });
    const first = await processCatalogItemDisplayIdentityRecomputeBatch(firstDb, commandHandler(), {} as never);
    const hash = firstDb.persistedWrites[0]?.[7] as string;

    const published = commandHandler();
    const db = recomputeDb({ existingHash: hash });

    const result = await processCatalogItemDisplayIdentityRecomputeBatch(db, published, {} as never);

    expect(result).toMatchObject({ selected: 1, processed: 1, changed: 0, unchanged: 1, failed: 0 });
    expect(published).not.toHaveBeenCalled();
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
});

function commandHandler() {
  return vi.fn(async () => ({ state: null, version: 1, newEvents: [], storedEvents: [] }) as never);
}

function recomputeDb(options: {
  existingHash?: string | null;
  persistedWrites?: unknown[][];
  statusUpdates?: string[];
}) {
  const persistedWrites = options.persistedWrites ?? [];
  const statusUpdates = options.statusUpdates ?? [];

  return {
    persistedWrites,
    async query<T>(sql: string, params?: readonly unknown[]): Promise<{ rows: T[] }> {
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
        return options.existingHash ? { rows: [{ display_identity_hash: options.existingHash }] as T[] } : { rows: [] };
      }

      if (sql.includes("INSERT INTO catalog_item_display_identities")) {
        persistedWrites.push([...(params ?? [])]);
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
