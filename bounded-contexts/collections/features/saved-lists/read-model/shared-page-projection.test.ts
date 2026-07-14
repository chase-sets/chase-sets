import { describe, expect, it, vi } from "vitest";
import { buildSavedListSharedPageProjectionHandlers } from "./shared-page-projection";
import { savedListSharedPageSchemaSql } from "./shared-page-schema";

describe("Saved List shared-page projection", () => {
  it("projects only viewer-safe line fields even when source events carry private metadata", async () => {
    const queries: { sql: string; values: readonly unknown[] }[] = [];
    const db = {
      query: vi.fn(async (sql: string, values: readonly unknown[] = []) => {
        queries.push({ sql, values });
        return { rows: [] };
      }),
    };
    const handlers = buildSavedListSharedPageProjectionHandlers(db as never);
    await handlers["collections.saved-list.line-added"]?.({
      streamVersion: 2,
      data: {
        listId: "svl_one",
        lineId: "sll_one",
        product: { catalogItemId: "cat_one", productId: "product_one", selectedOptions: [] },
        trackedQuantity: 2,
        privateNotes: "never project this note",
        privateTags: ["never-project-this-tag"],
        addedAt: "2026-07-13T12:00:00.000Z",
      },
    } as never);

    const serialized = JSON.stringify(queries);
    expect(serialized).not.toContain("never project this note");
    expect(serialized).not.toContain("never-project-this-tag");
    expect(savedListSharedPageSchemaSql).not.toMatch(
      /private_notes|private_tags|cost|sku|location|profit|loss|history/i,
    );
  });

  it("makes private, archived, rotated, and revoked state immediately query-visible", async () => {
    const queries: { sql: string; values: readonly unknown[] }[] = [];
    const db = {
      query: vi.fn(async (sql: string, values: readonly unknown[] = []) => {
        queries.push({ sql, values });
        return { rows: [] };
      }),
    };
    const handlers = buildSavedListSharedPageProjectionHandlers(db as never);
    await handlers["collections.saved-list.visibility-changed"]?.({
      streamVersion: 2,
      data: { listId: "svl_one", visibility: "private", changedAt: "2026-07-13T12:00:00.000Z" },
    } as never);
    await handlers["collections.saved-list.archived"]?.({
      streamVersion: 3,
      data: { listId: "svl_one", archivedAt: "2026-07-13T12:01:00.000Z" },
    } as never);
    await handlers["collections.saved-list-sharing.unlisted-access-rotated"]?.({
      streamVersion: 2,
      data: {
        listId: "svl_one",
        verifier: `sha256:${"a".repeat(64)}`,
        generation: 1,
        rotatedAt: "2026-07-13T12:02:00.000Z",
      },
    } as never);
    await handlers["collections.saved-list-sharing.unlisted-access-revoked"]?.({
      streamVersion: 3,
      data: { listId: "svl_one", generation: 2, revokedAt: "2026-07-13T12:03:00.000Z" },
    } as never);
    expect(queries.map((query) => query.sql).join("\n")).toContain("visibility = $2");
    expect(queries.map((query) => query.sql).join("\n")).toContain("lifecycle = 'archived'");
    expect(queries.map((query) => query.sql).join("\n")).toContain("unlisted_verifier = NULL");
    expect(queries.at(-1)?.sql).toContain("policy_changed_at");
  });
});
