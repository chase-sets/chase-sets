import { describe, expect, it, vi } from "vitest";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { listPendingRestockDecisions } from "./queries";

describe("issue-7169-c2-route-isolation: paged pending decisions", () => {
  it("retains the independent total when an offset page is empty", async () => {
    const db: PgQueryable = {
      query: async <Row>(sql: string) => ({
        rows: (sql.includes("COUNT(*)::text AS total") ? [{ total: "251" }] : []) as Row[],
      }),
    };
    expect(await listPendingRestockDecisions(db, { accountId: "acc_c2_synthetic", limit: 250, offset: 251 })).toEqual({
      items: [],
      total: 251,
    });
  });
  it.each([
    { limit: Number.NaN },
    { limit: Infinity },
    { limit: 1.5 },
    { limit: 0 },
    { offset: -1 },
    { offset: Number.NaN },
    { offset: 0.5 },
  ])("rejects malformed pagination before querying: %j", async (invalid) => {
    const query = vi.fn(async () => ({ rows: [] }));
    await expect(
      listPendingRestockDecisions({ query }, { accountId: "acc_c2_synthetic", ...invalid }),
    ).rejects.toThrow();
    expect(query).not.toHaveBeenCalled();
  });
});
