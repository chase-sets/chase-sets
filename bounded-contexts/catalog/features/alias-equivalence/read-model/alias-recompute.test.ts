import { describe, expect, it, vi } from "vitest";
import {
  enqueueAllCatalogItemAliasRecomputeWork,
  enqueueCatalogItemAliasRecomputeWork,
  getCatalogItemAliasRecomputeHealth,
  processCatalogItemAliasRecomputeBatch,
  purgeCompletedCatalogItemAliasRecomputeWork,
} from "./alias-recompute";

function commandHandler() {
  return vi.fn(async () => ({ state: null, version: 1, newEvents: [], storedEvents: [] }) as never);
}

function publishableRow(overrides: Record<string, unknown> = {}) {
  return {
    alias_hash: "hash-fr-1",
    catalog_item_id: "cat_1",
    target_field: "name",
    alias_text: "Dracaufeu",
    normalized_alias_text: "dracaufeu",
    alias_language_code: "fr",
    source_language_code: "en",
    alias_type: "official-equivalent",
    confidence: "high",
    review_status: "accepted",
    provider_key: "tcgdex",
    observation_id: "obs_1",
    source_category: "provider-same-id-localized-endpoint",
    source_profile_key: "pokemon-tcg",
    source_profile_version: "2026.06.03",
    mapping_fingerprint: "fp-1",
    evidence: {},
    last_actor: "usr_1",
    last_reason: null,
    policy_version: "alias-source-governance-v1",
    proposed_at: "2026-06-16T00:00:00.000Z",
    reviewed_at: "2026-06-16T00:00:00.000Z",
    updated_at: "2026-06-16T00:00:00.000Z",
    ...overrides,
  };
}

function recomputeDb(options: {
  workTargetId?: string | null;
  itemExists?: boolean;
  publishableRows?: Record<string, unknown>[];
  existingHash?: string | null;
  statusUpdates?: string[];
}) {
  const statusUpdates = options.statusUpdates ?? [];

  return {
    statusUpdates,
    async query<T>(sql: string, params?: readonly unknown[]): Promise<{ rows: T[]; rowCount?: number }> {
      if (sql.includes("FROM catalog_item_alias_recompute_work") && sql.includes("status = 'pending'")) {
        return {
          rows: (options.workTargetId === null ? [] : [{ catalog_item_id: options.workTargetId ?? "cat_1" }]) as T[],
        };
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
      if (sql.includes("SELECT language_code FROM catalog_items")) {
        return { rows: (options.itemExists === false ? [] : [{ language_code: "en" }]) as T[] };
      }
      if (sql.includes("COUNT(DISTINCT catalog_item_id)")) {
        return { rows: [{ count: "1" }] as T[] };
      }
      if (sql.includes("FROM catalog_item_aliases") && sql.includes("review_status = ANY")) {
        return { rows: (options.publishableRows ?? [publishableRow()]) as T[] };
      }
      if (sql.includes("SELECT alias_language_code, resolved_alias_hash")) {
        return {
          rows: (options.existingHash
            ? [{ alias_language_code: "fr", resolved_alias_hash: options.existingHash }]
            : []) as T[],
        };
      }
      if (sql.includes("INSERT INTO catalog_item_resolved_aliases")) {
        return { rows: [] };
      }
      return { rows: [] };
    },
  };
}

describe("resolved alias recompute work", () => {
  it("enqueues work idempotently by target id", async () => {
    const calls: Array<{ sql: string; params: readonly unknown[] }> = [];
    const db = {
      async query(sql: string, params?: readonly unknown[]) {
        calls.push({ sql, params: params ?? [] });
        return { rows: [], rowCount: 0 };
      },
    };

    const count = await enqueueCatalogItemAliasRecomputeWork(db, ["cat_1", "cat_1", " cat_2 ", ""], "alias-accepted");

    expect(count).toBe(2);
    expect(calls[0]?.sql).toContain("INSERT INTO catalog_item_alias_recompute_work");
    expect(calls[0]?.sql).toContain("ON CONFLICT (catalog_item_id) DO UPDATE");
    expect(calls[0]?.params[0]).toEqual(["cat_1", "cat_2"]);
  });

  it("resolves and publishes one aliases-resolved fact when the hash changes", async () => {
    const published = commandHandler();
    const db = recomputeDb({ existingHash: "old-hash" });

    const result = await processCatalogItemAliasRecomputeBatch(db, published, {} as never, { limit: 10 });

    expect(result).toMatchObject({ selected: 1, processed: 1, changed: 1, unchanged: 0, missing: 0, failed: 0 });
    expect(db.statusUpdates).toEqual(["running", "completed"]);
    expect(published).toHaveBeenCalledTimes(1);
    expect(published).toHaveBeenCalledWith(
      expect.objectContaining({
        streamId: "catalog.item-cat_1",
        command: expect.objectContaining({
          type: "RecordCatalogItemAliases",
          catalogItemId: "cat_1",
          aliasLanguageCode: "fr",
          aliases: [expect.objectContaining({ aliasHash: "hash-fr-1" })],
        }),
      }),
    );
  });

  it("does not publish when the resolved alias hash is unchanged", async () => {
    const firstPublished = commandHandler();
    const firstDb = recomputeDb({ existingHash: null });
    await processCatalogItemAliasRecomputeBatch(firstDb, firstPublished, {} as never);
    const firstCall = (firstPublished.mock.calls as unknown as Array<[{ command: { resolvedAliasHash: string } }]>)[0];
    const publishedCommand = firstCall[0].command;

    const published = commandHandler();
    const db = recomputeDb({ existingHash: publishedCommand.resolvedAliasHash });

    const result = await processCatalogItemAliasRecomputeBatch(db, published, {} as never);

    expect(result).toMatchObject({ processed: 1, changed: 0, unchanged: 1 });
    expect(published).not.toHaveBeenCalled();
  });

  it("publishes an empty (retracted) fact when the last publishable alias is gone", async () => {
    const published = commandHandler();
    const db = recomputeDb({ publishableRows: [], existingHash: "prior-non-empty-hash" });

    const result = await processCatalogItemAliasRecomputeBatch(db, published, {} as never);

    expect(result).toMatchObject({ processed: 1, changed: 1 });
    expect(published).toHaveBeenCalledWith(
      expect.objectContaining({
        command: expect.objectContaining({ type: "RecordCatalogItemAliases", aliases: [] }),
      }),
    );
  });

  it("counts a missing Catalog Item without publishing", async () => {
    const published = commandHandler();
    const db = recomputeDb({ itemExists: false });

    const result = await processCatalogItemAliasRecomputeBatch(db, published, {} as never);

    expect(result).toMatchObject({ selected: 1, processed: 0, missing: 1, changed: 0 });
    expect(published).not.toHaveBeenCalled();
  });

  it("backfill enqueues every Catalog Item that carries a published alias", async () => {
    const enqueued: Array<readonly unknown[]> = [];
    const db = {
      async query(sql: string, params?: readonly unknown[]) {
        if (sql.includes("SELECT DISTINCT catalog_item_id FROM catalog_item_aliases")) {
          return { rows: [{ catalog_item_id: "cat_a" }, { catalog_item_id: "cat_b" }] };
        }
        if (sql.includes("INSERT INTO catalog_item_alias_recompute_work")) {
          enqueued.push(params ?? []);
        }
        return { rows: [], rowCount: 0 };
      },
    };

    const count = await enqueueAllCatalogItemAliasRecomputeWork(db, "manual-backfill");

    expect(count).toBe(2);
    expect(enqueued[0]?.[0]).toEqual(["cat_a", "cat_b"]);
  });

  it("summarizes recompute health for operators", async () => {
    const db = {
      async query<T>(sql: string): Promise<{ rows: T[] }> {
        if (sql.includes("GROUP BY status")) {
          return {
            rows: [
              { status: "pending", count: "2" },
              { status: "completed", count: "5" },
            ] as T[],
          };
        }
        return {
          rows: [
            { pending_with_error: "1", oldest_pending_at: "2026-06-16T00:00:00.000Z", latest_failure_message: "boom" },
          ] as T[],
        };
      },
    };

    await expect(getCatalogItemAliasRecomputeHealth(db)).resolves.toEqual({
      pending: 2,
      running: 0,
      completed: 5,
      pendingWithError: 1,
      oldestPendingAt: "2026-06-16T00:00:00.000Z",
      latestFailureMessage: "boom",
    });
  });

  it("purges only completed recompute work older than the cutoff", async () => {
    const calls: Array<{ sql: string; params: readonly unknown[] }> = [];
    const db = {
      async query<T>(sql: string, params?: readonly unknown[]): Promise<{ rows: T[]; rowCount: number }> {
        calls.push({ sql, params: params ?? [] });
        return { rows: [], rowCount: 4 };
      },
    };

    await expect(
      purgeCompletedCatalogItemAliasRecomputeWork(db, { completedBefore: "2026-06-01T00:00:00.000Z" }),
    ).resolves.toBe(4);
    expect(calls[0]?.sql).toContain("status = 'completed'");
    expect(calls[0]?.sql).toContain("completed_at < $1");
    expect(calls[0]?.params).toEqual(["2026-06-01T00:00:00.000Z"]);
  });
});
