import { describe, expect, it } from "vitest";
import type { PgQueryable, PgQueryResult } from "@chase-sets/event-core-postgres";
import { getInventoryCheckoutHold, getInventoryHold } from "./queries";

function database(rows: Record<string, unknown>[] = []) {
  const calls: { sql: string; values: readonly unknown[] }[] = [];
  const db: PgQueryable = {
    query: async <Row = Record<string, unknown>>(
      sql: string,
      values: readonly unknown[] = [],
    ): Promise<PgQueryResult<Row>> => {
      calls.push({ sql, values });
      return { rows: rows as Row[] };
    },
  };
  return { db, calls };
}

describe("inventory hold queries", () => {
  it("retains the account filter on the existing lookup", async () => {
    const { db, calls } = database([{ hold_id: "hld_1", account_id: "acc_seller" }]);
    expect(await getInventoryHold(db, "hld_1", "acc_seller")).toMatchObject({ account_id: "acc_seller" });
    const { sql, values } = calls[0]!;
    expect(sql).toContain("WHERE hold_id = $1");
    expect(sql).toContain("AND account_id = $2");
    expect(values).toEqual(["hld_1", "acc_seller"]);
  });

  it("binds a single checkout-purpose hold to its stored session and returns the stored seller", async () => {
    const { db, calls } = database([{ hold_id: "hld_1", account_id: "acc_seller" }]);
    expect(await getInventoryCheckoutHold(db, "hld_1", "chk_own")).toMatchObject({ account_id: "acc_seller" });
    const { sql, values } = calls[0]!;
    expect(sql).toContain("WHERE hold_id = $1");
    expect(sql).toContain("AND purpose = 'checkout'");
    expect(sql).toContain("AND source_ref->>'checkoutSessionId' = $2");
    expect(values).toEqual(["hld_1", "chk_own"]);
    expect(calls).toHaveLength(1);
  });

  it("returns null for an unmatched row without an account-lookup fallback", async () => {
    const { db, calls } = database();
    expect(await getInventoryCheckoutHold(db, "hld_1", "chk_foreign")).toBeNull();
    expect(calls).toHaveLength(1);
    expect(await getInventoryHold(db, "hld_missing", "acc_seller")).toBeNull();
  });

  it.each(["", "   "])("refuses an empty session %j without a query", async (sessionId) => {
    const { db, calls } = database();
    expect(await getInventoryCheckoutHold(db, "hld_1", sessionId)).toBeNull();
    expect(calls).toHaveLength(0);
  });
});
