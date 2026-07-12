import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { describe, expect, it, vi } from "vitest";
import { lookupShipmentBySupportId, lookupShipmentBySupportReference } from "./support-lookup";

function createDb(rows: readonly unknown[]) {
  const query = vi.fn(async (_sql: string, _params: readonly unknown[] = []) => ({ rows: [...rows] }));
  return { db: { query } as unknown as PgQueryable, query };
}

const row = {
  shipment_id: "shp_01JZ6DKP7S7Z4AZ5N5E6K7M8N9",
  display_reference: "SHP-E6K7M8N9",
  status: "dispatched",
  order_id: "ord_01JZ6DKP7S7Z4AZ5N5E6K7M8N9",
  seller_account_id: "acc_seller",
  tracking_identifier: "1Z999AA10123456784",
  created_at: "2026-07-11T00:00:00.000Z",
};

describe("lookupShipmentBySupportReference", () => {
  it("finds a shipment by its display reference with a single indexed lookup", async () => {
    const { db, query } = createDb([row]);

    const result = await lookupShipmentBySupportReference(db, "SHP-E6K7M8N9");

    expect(result).toEqual(row);
    expect(query.mock.calls[0]![0]).toContain("WHERE display_reference = $1");
    expect(query.mock.calls[0]![1]).toEqual(["SHP-E6K7M8N9"]);
  });

  it("returns null when no shipment matches", async () => {
    const { db } = createDb([]);

    expect(await lookupShipmentBySupportReference(db, "SHP-NOTFOUND")).toBeNull();
  });
});

describe("lookupShipmentBySupportId", () => {
  it("finds a shipment by its raw typed id with a single primary-key lookup", async () => {
    const { db, query } = createDb([row]);

    const result = await lookupShipmentBySupportId(db, "shp_01JZ6DKP7S7Z4AZ5N5E6K7M8N9");

    expect(result).toEqual(row);
    expect(query.mock.calls[0]![0]).toContain("WHERE shipment_id = $1");
    expect(query.mock.calls[0]![1]).toEqual(["shp_01JZ6DKP7S7Z4AZ5N5E6K7M8N9"]);
  });

  it("returns null when no shipment matches", async () => {
    const { db } = createDb([]);

    expect(await lookupShipmentBySupportId(db, "shp_missing")).toBeNull();
  });
});
