import { describe, expect, it, vi } from "vitest";
import { buildFulfillmentReturnShipmentProjectionHandlers } from "./projection";
import type { ReturnDestinationSnapshot } from "../domain/facility-directory";

type Captured = { sql: string; params: readonly unknown[] };

function mockDb() {
  const captured: Captured[] = [];
  const db = {
    query: vi.fn(async (sql: string, params?: readonly unknown[]) => {
      captured.push({ sql, params: params ?? [] });
      return { rows: [], rowCount: 0 };
    }),
  };
  return { db: db as never, captured };
}

const destination: ReturnDestinationSnapshot = {
  destinationType: "platform-facility",
  facilityId: "fac_east",
  configVersion: "v1",
  displayName: "Chase Sets Returns (East)",
  displayInstructions: "Include the packing slip.",
  postalAddress: {
    name: "Returns East",
    line1: "100 Dock St",
    city: "Newark",
    state: "NJ",
    postalCode: "07102",
    country: "US",
  },
  region: "us-east",
  selectionPolicyVersion: "facility-selection-v1",
  selectedAt: "2026-06-01T00:00:00.000Z",
};

const requestedEvent = {
  type: "fulfillment.return-shipment.requested.v1",
  data: {
    returnShipmentId: "rsh_1",
    remedyId: "rmd_1",
    supportRequestId: "sup_1",
    orderId: "ord_1",
    outboundShipmentId: "shp_1",
    returnDirective: "return-to-platform",
    shipFromSnapshot: {
      name: "Buyer",
      line1: "2 Market St",
      city: "Chicago",
      state: "IL",
      postalCode: "60601",
      country: "US",
    },
    destinationSnapshot: destination,
    packageRequirements: { weightOunces: 10, lengthInches: 9, widthInches: 6, heightInches: 2 },
    costPayer: "platform",
    costAllocationReference: "cov_1",
    shipByDeadlineAt: "2026-06-10T00:00:00.000Z",
    returnByDeadlineAt: "2026-06-20T00:00:00.000Z",
    metadata: {
      correlationRemedyId: "rmd_1",
      causationId: null,
      idempotencyKey: "idem-1",
      policyVersion: "return-policy-v1",
    },
    requestedAt: "2026-06-01T00:00:00.000Z",
  },
} as never;

describe("return shipment projection", () => {
  it("seeds both read models on request with idempotent upserts", async () => {
    const { db, captured } = mockDb();
    const handlers = buildFulfillmentReturnShipmentProjectionHandlers(db);
    await handlers["fulfillment.return-shipment.requested.v1"](requestedEvent);

    const operatorInsert = captured.find((entry) =>
      entry.sql.includes("INTO fulfillment_return_shipment_operator_pages"),
    );
    const customerInsert = captured.find((entry) =>
      entry.sql.includes("INTO fulfillment_return_shipment_customer_pages"),
    );
    expect(operatorInsert).toBeDefined();
    expect(customerInsert).toBeDefined();
    expect(operatorInsert?.sql).toContain("ON CONFLICT (return_shipment_id) DO UPDATE");
    expect(customerInsert?.sql).toContain("ON CONFLICT (return_shipment_id) DO UPDATE");
  });

  it("keeps protected facility and party metadata out of the customer read model", async () => {
    const { db, captured } = mockDb();
    const handlers = buildFulfillmentReturnShipmentProjectionHandlers(db);
    await handlers["fulfillment.return-shipment.requested.v1"](requestedEvent);

    const customerInsert = captured.find((entry) =>
      entry.sql.includes("INTO fulfillment_return_shipment_customer_pages"),
    );
    const sql = customerInsert?.sql ?? "";
    for (const forbiddenColumn of [
      "ship_from",
      "destination_snapshot",
      "facility_id",
      "cost_payer",
      "policy_version",
      "idempotency_key",
    ]) {
      expect(sql).not.toContain(forbiddenColumn);
    }
    const serializedParams = JSON.stringify(customerInsert?.params ?? []);
    // The buyer ship-from street and the full facility street address must not reach the customer row.
    expect(serializedParams).not.toContain("2 Market St");
    expect(serializedParams).not.toContain("100 Dock St");
    // Display copy and coarse region/city/state are allowed.
    expect(serializedParams).toContain("Chase Sets Returns (East)");
    expect(serializedParams).toContain("Newark");
  });

  it("advances status and stamps timestamps on carrier milestones", async () => {
    const { db, captured } = mockDb();
    const handlers = buildFulfillmentReturnShipmentProjectionHandlers(db);
    await handlers["fulfillment.return-shipment.delivered.v1"]({
      type: "fulfillment.return-shipment.delivered.v1",
      data: {
        returnShipmentId: "rsh_1",
        detail: null,
        metadata: { correlationRemedyId: "rmd_1", causationId: null, idempotencyKey: "m", policyVersion: "p" },
        deliveredAt: "2026-06-05T00:00:00.000Z",
      },
    } as never);

    const operatorUpdate = captured.find((entry) =>
      entry.sql.includes("UPDATE fulfillment_return_shipment_operator_pages"),
    );
    const customerUpdate = captured.find((entry) =>
      entry.sql.includes("UPDATE fulfillment_return_shipment_customer_pages"),
    );
    expect(operatorUpdate?.sql).toContain("delivered_at = $3");
    expect(operatorUpdate?.sql).toContain("milestones = milestones || $4::jsonb");
    expect(customerUpdate?.sql).toContain("delivered_at = $3");
  });

  it("appends the operator exception timeline and exposes only the type to customers", async () => {
    const { db, captured } = mockDb();
    const handlers = buildFulfillmentReturnShipmentProjectionHandlers(db);
    await handlers["fulfillment.return-shipment.exception-raised.v1"]({
      type: "fulfillment.return-shipment.exception-raised.v1",
      data: {
        returnShipmentId: "rsh_1",
        exceptionType: "carrier-delay",
        notes: "stuck",
        metadata: { correlationRemedyId: "rmd_1", causationId: null, idempotencyKey: "m", policyVersion: "p" },
        raisedAt: "2026-06-05T00:00:00.000Z",
      },
    } as never);

    const operatorUpdate = captured.find((entry) =>
      entry.sql.includes("UPDATE fulfillment_return_shipment_operator_pages"),
    );
    const customerUpdate = captured.find((entry) =>
      entry.sql.includes("UPDATE fulfillment_return_shipment_customer_pages"),
    );
    expect(operatorUpdate?.sql).toContain("exceptions = exceptions || $5::jsonb");
    expect(JSON.stringify(operatorUpdate?.params)).toContain("stuck");
    expect(customerUpdate?.sql).not.toContain("current_exception_notes");
    expect(JSON.stringify(customerUpdate?.params)).not.toContain("stuck");
  });
});
