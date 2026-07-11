import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { describe, expect, it } from "vitest";
import { listSupportOperationsQueue } from "./queries";

type QueryCall = Readonly<{ sql: string; params: readonly unknown[] }>;

function buildDb(calls: QueryCall[], countValue = "0", rows: unknown[] = []): PgQueryable {
  return {
    async query<Row = Record<string, unknown>>(sql: string, params: readonly unknown[] = []) {
      calls.push({ sql, params });
      if (sql.includes("COUNT(*)")) {
        return { rows: [{ count: countValue } as Row] };
      }
      return { rows: rows as Row[] };
    },
  };
}

describe("support operations queue read-model query", () => {
  it("applies only the now-timestamp filter when no status, priority, or search is supplied", async () => {
    const calls: QueryCall[] = [];
    const db = buildDb(calls);

    await listSupportOperationsQueue(db, { now: "2026-06-01T00:00:00.000Z" });

    expect(calls[0]?.params).toEqual(["2026-06-01T00:00:00.000Z"]);
    expect(calls[0]?.sql).not.toContain("status = $2");
    expect(calls[0]?.sql).not.toContain("priority = $2");
    expect(calls[0]?.sql).not.toContain("ILIKE");
  });

  it("filters by status and priority when both are recognized values", async () => {
    const calls: QueryCall[] = [];
    const db = buildDb(calls);

    await listSupportOperationsQueue(db, {
      now: "2026-06-01T00:00:00.000Z",
      status: "ready-for-support",
      priority: "urgent",
    });

    expect(calls[0]?.sql).toContain("status = $2");
    expect(calls[0]?.sql).toContain("priority = $3");
    expect(calls[0]?.params).toEqual(["2026-06-01T00:00:00.000Z", "ready-for-support", "urgent"]);
  });

  it("ignores unrecognized status and priority filter values", async () => {
    const calls: QueryCall[] = [];
    const db = buildDb(calls);

    await listSupportOperationsQueue(db, {
      now: "2026-06-01T00:00:00.000Z",
      status: "not-a-real-status",
      priority: "not-a-real-priority",
    });

    expect(calls[0]?.params).toEqual(["2026-06-01T00:00:00.000Z"]);
    expect(calls[0]?.sql).not.toContain("status = $2");
    expect(calls[0]?.sql).not.toContain("priority = $2");
  });

  it("escapes the search term and searches request, order, and account identifiers", async () => {
    const calls: QueryCall[] = [];
    const db = buildDb(calls);

    await listSupportOperationsQueue(db, { now: "2026-06-01T00:00:00.000Z", search: "ord_100%_test" });

    expect(calls[0]?.sql).toContain("support_request_id ILIKE $2 ESCAPE '\\'");
    expect(calls[0]?.sql).toContain("order_id ILIKE $2 ESCAPE '\\'");
    expect(calls[0]?.sql).toContain("buyer_account_id ILIKE $2 ESCAPE '\\'");
    expect(calls[0]?.sql).toContain("seller_account_id ILIKE $2 ESCAPE '\\'");
    expect(calls[0]?.params).toEqual(["2026-06-01T00:00:00.000Z", "%ord\\_100\\%\\_test%"]);
  });

  it("combines account scoping with status, priority, and search filters using stable parameter ordering", async () => {
    const calls: QueryCall[] = [];
    const db = buildDb(calls, "1", [{ support_request_id: "sup_1" }]);

    await listSupportOperationsQueue(db, {
      now: "2026-06-01T00:00:00.000Z",
      accountId: "acc_seller",
      status: "waiting-on-seller",
      priority: "normal",
      search: "sup1",
      limit: 10,
      offset: 20,
    });

    expect(calls[0]?.params).toEqual([
      "2026-06-01T00:00:00.000Z",
      "acc_seller",
      "waiting-on-seller",
      "normal",
      "%sup1%",
    ]);
    expect(calls[1]?.params).toEqual([
      "2026-06-01T00:00:00.000Z",
      "acc_seller",
      "waiting-on-seller",
      "normal",
      "%sup1%",
      10,
      20,
    ]);
    expect(calls[1]?.sql).toContain("LIMIT $6 OFFSET $7");
  });
});
