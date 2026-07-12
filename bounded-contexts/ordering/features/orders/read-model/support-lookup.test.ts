import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { describe, expect, it, vi } from "vitest";
import { lookupOrderBySupportId, lookupOrderBySupportReference } from "./support-lookup";

function createDb(rows: readonly unknown[]) {
  const query = vi.fn(async (_sql: string, _params: readonly unknown[] = []) => ({ rows: [...rows] }));
  return { db: { query } as unknown as PgQueryable, query };
}

const row = {
  order_id: "ord_01JZ6DKP7S7Z4AZ5N5E6K7M8N9",
  display_reference: "ORD-E6K7M8N9",
  status: "pending-payment",
  source_type: "cart",
  buyer_account_id: "acc_buyer",
  seller_account_id: "acc_seller",
  total_amount: "42.00",
  created_at: "2026-07-11T00:00:00.000Z",
};

describe("lookupOrderBySupportReference", () => {
  it("finds an order by its display reference with a single indexed lookup", async () => {
    const { db, query } = createDb([row]);

    const result = await lookupOrderBySupportReference(db, "ORD-E6K7M8N9");

    expect(result).toEqual(row);
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0]![0]).toContain("WHERE display_reference = $1");
    expect(query.mock.calls[0]![1]).toEqual(["ORD-E6K7M8N9"]);
  });

  it("returns null when no order matches", async () => {
    const { db } = createDb([]);

    const result = await lookupOrderBySupportReference(db, "ORD-NOTFOUND");

    expect(result).toBeNull();
  });
});

describe("lookupOrderBySupportId", () => {
  it("finds an order by its raw typed id with a single primary-key lookup", async () => {
    const { db, query } = createDb([row]);

    const result = await lookupOrderBySupportId(db, "ord_01JZ6DKP7S7Z4AZ5N5E6K7M8N9");

    expect(result).toEqual(row);
    expect(query.mock.calls[0]![0]).toContain("WHERE order_id = $1");
    expect(query.mock.calls[0]![1]).toEqual(["ord_01JZ6DKP7S7Z4AZ5N5E6K7M8N9"]);
  });

  it("returns null when no order matches", async () => {
    const { db } = createDb([]);

    const result = await lookupOrderBySupportId(db, "ord_missing");

    expect(result).toBeNull();
  });
});
