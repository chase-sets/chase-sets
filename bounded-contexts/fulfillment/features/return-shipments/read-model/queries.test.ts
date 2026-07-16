import { describe, expect, it, vi } from "vitest";
import {
  findReturnShipmentIdForRemedy,
  getCustomerReturnShipment,
  getOperatorReturnShipment,
  getReturnIntakeEvidenceReference,
  listReturnShipmentDeadlineCandidates,
  resolveOperatorReturnShipmentForIntake,
} from "./queries";

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

  it("resolves tracking or Return Shipment identifiers only within the assigned facility", async () => {
    const { db, captured } = mockDb([{ return_shipment_id: "rsh_1", facility_id: "fac_east" }]);
    const result = await resolveOperatorReturnShipmentForIntake(db, "track-1", "fac_east");
    expect(result.outcome).toBe("resolved");
    expect(captured[0]).toContain("facility_id = $2");
    expect(captured[0]).toContain("FROM fulfillment_shipment_line_pages");
    expect(captured[0]).toContain("return_shipment_id = $1 OR tracking_identifier = $1");

    const { db: ambiguousDb } = mockDb([{ return_shipment_id: "rsh_1" }, { return_shipment_id: "rsh_2" }]);
    expect((await resolveOperatorReturnShipmentForIntake(ambiguousDb, "duplicate", "fac_east")).outcome).toBe(
      "ambiguous",
    );
  });

  it("looks up evidence through facility-scoped projected references", async () => {
    const { db, captured } = mockDb([]);
    await getReturnIntakeEvidenceReference(db, "rie_1", "fac_east");
    expect(captured[0]).toContain("WHERE facility_id = $2");
    expect(captured[0]).toContain("evidence->>'attachmentId' = $1");
    expect(captured[0]).not.toContain("public");
  });

  it("selects only pre-carrier returns whose ship-by window has lapsed", async () => {
    const { db, captured } = mockDb([{ return_shipment_id: "rsh_due" }]);
    expect(await listReturnShipmentDeadlineCandidates(db, { now: "2026-07-30T00:00:00.000Z", limit: 25 })).toEqual([
      "rsh_due",
    ]);
    expect(captured[0]).toContain("status IN ('requested', 'ready-to-ship')");
    expect(captured[0]).toContain("ship_by_deadline_at <= $1");
  });
});
