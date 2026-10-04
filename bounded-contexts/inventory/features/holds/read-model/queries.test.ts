import { describe, expect, it, vi } from "vitest";
import type { PgQueryable, PgQueryResult } from "@chase-sets/event-core-postgres";
import { getInventoryCheckoutHold, getInventoryHold } from "./queries";

function database(rows: Record<string, unknown>[] = []) {
  const query = vi.fn(async <Row>(sql: string, values?: readonly unknown[]): Promise<PgQueryResult<Row>> => {
    void sql;
    void values;
    return { rows: rows as Row[] };
  });
  return { query } satisfies PgQueryable;
}

describe("inventory hold queries", () => {
  it("retains the account filter on the existing lookup", async () => {
    const db = database([{ hold_id: "hld_1", account_id: "acc_seller" }]);
    expect(await getInventoryHold(db, "hld_1", "acc_seller")).toMatchObject({ account_id: "acc_seller" });
    const [sql, values] = db.query.mock.calls[0]!;
    expect(sql).toContain("WHERE hold_id = $1");
    expect(sql).toContain("AND account_id = $2");
    expect(values).toEqual(["hld_1", "acc_seller"]);
  });

  it("binds a single checkout-purpose hold to its stored session and returns the stored seller", async () => {
    const db = database([{ hold_id: "hld_1", account_id: "acc_seller" }]);
    expect(await getInventoryCheckoutHold(db, "hld_1", "chk_own")).toMatchObject({ account_id: "acc_seller" });
    const [sql, values] = db.query.mock.calls[0]!;
    expect(sql).toContain("WHERE hold_id = $1");
    expect(sql).toContain("AND purpose = 'checkout'");
    expect(sql).toContain("AND source_ref->>'checkoutSessionId' = $2");
    expect(values).toEqual(["hld_1", "chk_own"]);
    expect(db.query).toHaveBeenCalledTimes(1);
  });

  it("returns null for an unmatched row without an account-lookup fallback", async () => {
    const db = database();
    expect(await getInventoryCheckoutHold(db, "hld_1", "chk_foreign")).toBeNull();
    expect(db.query).toHaveBeenCalledTimes(1);
    expect(await getInventoryHold(db, "hld_missing", "acc_seller")).toBeNull();
  });

  it.each(["", "   "])("refuses an empty session %j without a query", async (sessionId) => {
    const db = database();
    expect(await getInventoryCheckoutHold(db, "hld_1", sessionId)).toBeNull();
    expect(db.query).not.toHaveBeenCalled();
  });
});
