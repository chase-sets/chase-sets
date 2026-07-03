import { describe, expect, it } from "vitest";
import type { PgPoolClient, PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { releasePurchaseLimitClaimsForOrder } from "./purchase-limits";

describe("ordering purchase limits", () => {
  it("rolls back claim release when usage restoration fails", async () => {
    const calls: Array<{ sql: string; params: readonly unknown[] | undefined }> = [];
    const releaseCalls: unknown[] = [];
    const client = {
      query: async <Row = Record<string, unknown>>(sql: string, params?: readonly unknown[]) => {
        calls.push({ sql, params });
        if (sql.includes("RETURNING listing_id, quantity, claimed_at::date::text AS claimed_day")) {
          return {
            rows: [{ listing_id: "lst_1", quantity: 1, claimed_day: "2026-07-02" }] as Row[],
          };
        }
        if (sql.includes("UPDATE ordering_listing_purchase_limit_usage")) {
          throw new Error("usage update failed");
        }
        return { rows: [] as Row[] };
      },
      release: (error?: unknown) => {
        releaseCalls.push(error);
      },
    } satisfies PgPoolClient;
    const pool = {
      query: client.query,
      connect: async () => client,
    } satisfies PgTransactionalPool;

    await expect(
      releasePurchaseLimitClaimsForOrder(pool, {
        source_type: "cart-checkout",
        source_reference_id: "chk_1",
        buyer_account_id: "acct_buyer",
        lines: [{ listing_id: "lst_1" }],
      }),
    ).rejects.toThrow("usage update failed");

    expect(calls.map((call) => call.sql)).toEqual(
      expect.arrayContaining(["BEGIN", expect.stringContaining("claimed_at::date::text AS claimed_day"), "ROLLBACK"]),
    );
    expect(calls.some((call) => call.sql === "COMMIT")).toBe(false);
    expect(releaseCalls).toEqual([undefined]);
  });
});
