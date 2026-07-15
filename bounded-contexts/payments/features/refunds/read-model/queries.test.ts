import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { describe, expect, it } from "vitest";
import { listRefundsForOrder } from "./queries";

describe("refund read-model queries", () => {
  it("lists refunds by order without requiring a refund id", async () => {
    const calls: Array<{ sql: string; params?: readonly unknown[] }> = [];
    const db = {
      query: async <Row>(sql: string, params?: readonly unknown[]) => {
        calls.push({ sql, params });
        return { rows: [] as Row[] };
      },
    } satisfies PgQueryable;

    await expect(listRefundsForOrder(db, "ord_1")).resolves.toEqual([]);

    expect(calls[0]?.sql).toContain("order_ids ? $1");
    expect(calls[0]?.sql).toContain("ORDER BY requested_at ASC, refund_id ASC");
    expect(calls[0]?.params).toEqual(["ord_1"]);
  });
});
