import { describe, expect, it, vi } from "vitest";
import { findReturnShipmentIdForRemedy, getCustomerReturnShipment, getOperatorReturnShipment } from "./queries";

function mockDb(rows: readonly unknown[]) {
  const captured: string[] = [];
  const db = {
    query: vi.fn(async (sql: string) => {
      captured.push(sql);
      return { rows, rowCount: rows.length };
    }),
  };
  return { db: db as never, captured };
}

describe("return shipment read-model queries", () => {
  it("customer query reads only the customer page and never the operator page or protected columns", async () => {
    const { db, captured } = mockDb([]);
    await getCustomerReturnShipment(db, "rsh_1");
    const sql = captured[0];
    expect(sql).toContain("FROM fulfillment_return_shipment_customer_pages");
    expect(sql).not.toContain("operator_pages");
    for (const forbiddenColumn of [
      "ship_from",
      "destination_snapshot",
      "facility_id",
      "cost_payer",
      "operational",
      "internal_routing",
    ]) {
      expect(sql).not.toContain(forbiddenColumn);
    }
  });

  it("operator query exposes evidence from a single context without cross-context joins", async () => {
    const { db, captured } = mockDb([
      {
        return_shipment_id: "rsh_1",
        remedy_id: "rmd_1",
        status: "in-transit",
        destination_snapshot: {},
        cost_payer: "platform",
      },
    ]);
    const view = await getOperatorReturnShipment(db, "rsh_1");
    const sql = captured[0];
    expect(sql).toContain("FROM fulfillment_return_shipment_operator_pages");
    expect(sql).not.toContain(" JOIN ");
    expect(view?.cost_payer).toBe("platform");
  });

  it("finds an existing return shipment for a remedy to support idempotent creation", async () => {
    const { db } = mockDb([{ return_shipment_id: "rsh_1" }]);
    expect(await findReturnShipmentIdForRemedy(db, "rmd_1")).toBe("rsh_1");
    const { db: emptyDb } = mockDb([]);
    expect(await findReturnShipmentIdForRemedy(emptyDb, "rmd_missing")).toBeNull();
  });
});
