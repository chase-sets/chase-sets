import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { describe, expect, it, vi } from "vitest";
import { lookupPayoutBySupportId, lookupPayoutBySupportReference } from "./support-lookup";

function createDb(rows: readonly unknown[]) {
  const query = vi.fn(async (_sql: string, _params: readonly unknown[] = []) => ({ rows: [...rows] }));
  return { db: { query } as unknown as PgQueryable, query };
}

const row = {
  payout_id: "pyo_01JZ6DKP7S7Z4AZ5N5E6K7M8N9",
  display_reference: "PYO-E6K7M8N9",
  status: "completed",
  account_id: "acc_seller",
  amount: "150.00",
  currency_code: "USD",
  requested_at: "2026-07-11T00:00:00.000Z",
};

describe("lookupPayoutBySupportReference", () => {
  it("finds a payout by its display reference with a single indexed lookup", async () => {
    const { db, query } = createDb([row]);

    const result = await lookupPayoutBySupportReference(db, "PYO-E6K7M8N9");

    expect(result).toEqual(row);
    expect(query.mock.calls[0]![0]).toContain("WHERE display_reference = $1");
    expect(query.mock.calls[0]![1]).toEqual(["PYO-E6K7M8N9"]);
  });

  it("returns null when no payout matches", async () => {
    const { db } = createDb([]);

    expect(await lookupPayoutBySupportReference(db, "PYO-NOTFOUND")).toBeNull();
  });
});

describe("lookupPayoutBySupportId", () => {
  it("finds a payout by its raw typed id with a single primary-key lookup", async () => {
    const { db, query } = createDb([row]);

    const result = await lookupPayoutBySupportId(db, "pyo_01JZ6DKP7S7Z4AZ5N5E6K7M8N9");

    expect(result).toEqual(row);
    expect(query.mock.calls[0]![0]).toContain("WHERE payout_id = $1");
    expect(query.mock.calls[0]![1]).toEqual(["pyo_01JZ6DKP7S7Z4AZ5N5E6K7M8N9"]);
  });

  it("returns null when no payout matches", async () => {
    const { db } = createDb([]);

    expect(await lookupPayoutBySupportId(db, "pyo_missing")).toBeNull();
  });
});
