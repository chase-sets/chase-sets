import { describe, expect, it } from "vitest";
import { listDiscoveryRecentSavedLists } from "./queries";

describe("Discovery Saved List Addition queries", () => {
  it("reads only active lists for the current account in recent order", async () => {
    const calls: Array<{ sql: string; values: readonly unknown[] }> = [];
    const items = await listDiscoveryRecentSavedLists(
      {
        query: async (sql: string, values: readonly unknown[] = []) => {
          calls.push({ sql, values });
          return {
            rows: [
              {
                list_id: "lst_1",
                title: "Trade targets",
                line_count: 2,
                tracked_unit_count: 5,
                list_version: 4,
                changed_at: "2026-07-14T00:00:00.000Z",
              },
            ],
          };
        },
      },
      { ownerAccountId: "acc_1" },
    );

    expect(calls[0]?.sql).toContain("WHERE owner_account_id = $1");
    expect(calls[0]?.sql).toContain("AND lifecycle = 'active'");
    expect(calls[0]?.sql).toContain("ORDER BY changed_at DESC, list_id DESC");
    expect(calls[0]?.values).toEqual(["acc_1", 8]);
    expect(items).toEqual([
      {
        listId: "lst_1",
        title: "Trade targets",
        lineCount: 2,
        trackedUnitCount: 5,
        version: 4,
        changedAt: "2026-07-14T00:00:00.000Z",
      },
    ]);
  });
});
