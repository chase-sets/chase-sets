import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { describe, expect, it, vi } from "vitest";
import {
  lookupWalletAdjustmentBySupportId,
  lookupWalletAdjustmentBySupportReference,
} from "./wallet-adjustment-support-lookup";

function createDb(rows: readonly unknown[]) {
  const query = vi.fn(async (_sql: string, _params: readonly unknown[] = []) => ({ rows: [...rows] }));
  return { db: { query } as unknown as PgQueryable, query };
}

const row = {
  adjustment_id: "wad_01JZ6DKP7S7Z4AZ5N5E6K7M8N9",
  display_reference: "WAD-E6K7M8N9",
  status: "posted",
  target_account_id: "acc_seller",
  direction: "credit",
  amount: "40.00",
  currency_code: "usd",
  reason_code: "goodwill-cash-credit",
  requested_at: "2026-07-11T00:00:00.000Z",
};

describe("lookupWalletAdjustmentBySupportReference", () => {
  it("finds an adjustment by its display reference with a single indexed lookup", async () => {
    const { db, query } = createDb([row]);

    const result = await lookupWalletAdjustmentBySupportReference(db, "WAD-E6K7M8N9");

    expect(result).toEqual(row);
    expect(query.mock.calls[0]![0]).toContain("WHERE display_reference = $1");
    expect(query.mock.calls[0]![1]).toEqual(["WAD-E6K7M8N9"]);
    expect(query.mock.calls[0]![0]).not.toContain("explanation");
    expect(query.mock.calls[0]![0]).not.toContain("evidence_references");
  });

  it("returns null when no adjustment matches", async () => {
    const { db } = createDb([]);

    expect(await lookupWalletAdjustmentBySupportReference(db, "WAD-NOTFOUND")).toBeNull();
  });
});

describe("lookupWalletAdjustmentBySupportId", () => {
  it("finds an adjustment by its raw typed id with a single primary-key lookup", async () => {
    const { db, query } = createDb([row]);

    const result = await lookupWalletAdjustmentBySupportId(db, "wad_01JZ6DKP7S7Z4AZ5N5E6K7M8N9");

    expect(result).toEqual(row);
    expect(query.mock.calls[0]![0]).toContain("WHERE adjustment_id = $1");
    expect(query.mock.calls[0]![1]).toEqual(["wad_01JZ6DKP7S7Z4AZ5N5E6K7M8N9"]);
  });

  it("returns null when no adjustment matches", async () => {
    const { db } = createDb([]);

    expect(await lookupWalletAdjustmentBySupportId(db, "wad_missing")).toBeNull();
  });
});
