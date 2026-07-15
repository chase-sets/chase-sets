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

  it("exposes the customer-safe label document and postage cost on label-ready", async () => {
    const { db, captured } = mockDb();
    const handlers = buildFulfillmentReturnShipmentProjectionHandlers(db);
    await handlers["fulfillment.return-shipment.label-ready.v1"]({
      type: "fulfillment.return-shipment.label-ready.v1",
      data: {
        returnShipmentId: "rsh_1",
        carrierName: "USPS",
        trackingIdentifier: "9400-1",
        labelProviderReference: "lbl_1",
        labelDocumentUrl: "https://labels.test/rsh_1.pdf",
        postageProviderName: "sandbox-usps",
        postageProviderMode: "test",
        postageProviderShipmentId: "ps_1",
        postageProviderLabelId: "pl_1",
        postageAmountCents: 499,
        estimatedPostageAmountCents: 450,
        postageCurrency: "USD",
        metadata: { correlationRemedyId: "rmd_1", causationId: null, idempotencyKey: "m", policyVersion: "p" },
        readyAt: "2026-06-02T00:00:00.000Z",
      },
    } as never);

    const operatorUpdate = captured.find((entry) =>
      entry.sql.includes("UPDATE fulfillment_return_shipment_operator_pages"),
    );
    const customerUpdate = captured.find((entry) =>
      entry.sql.includes("UPDATE fulfillment_return_shipment_customer_pages"),
    );
    expect(operatorUpdate?.sql).toContain("postage_amount_cents = $10");
    expect(JSON.stringify(operatorUpdate?.params)).toContain("ps_1");
    // The buyer can retrieve the label; the operator-only provider handles never reach the customer row.
    expect(customerUpdate?.sql).toContain("label_document_url = $4");
    expect(JSON.stringify(customerUpdate?.params)).toContain("https://labels.test/rsh_1.pdf");
    expect(JSON.stringify(customerUpdate?.params)).not.toContain("ps_1");
  });

  it("marks a machine-readable failure without leaking operator detail to customers", async () => {
    const { db, captured } = mockDb();
    const handlers = buildFulfillmentReturnShipmentProjectionHandlers(db);
    await handlers["fulfillment.return-shipment.label-purchase-failed.v1"]({
      type: "fulfillment.return-shipment.label-purchase-failed.v1",
      data: {
        returnShipmentId: "rsh_1",
        failureReason: "provider-timeout",
        failureDetail: "USPS rating gateway timed out",
        postageProviderName: "sandbox-usps",
        postageProviderMode: "test",
        metadata: { correlationRemedyId: "rmd_1", causationId: null, idempotencyKey: "m", policyVersion: "p" },
        failedAt: "2026-06-02T00:00:00.000Z",
      },
    } as never);

    const operatorUpdate = captured.find((entry) =>
      entry.sql.includes("UPDATE fulfillment_return_shipment_operator_pages"),
    );
    const customerUpdate = captured.find((entry) =>
      entry.sql.includes("UPDATE fulfillment_return_shipment_customer_pages"),
    );
    expect(operatorUpdate?.sql).toContain("label_status = 'failed'");
    expect(JSON.stringify(operatorUpdate?.params)).toContain("provider-timeout");
    expect(JSON.stringify(operatorUpdate?.params)).toContain("USPS rating gateway timed out");
    // Customers see the machine-readable code, not the raw operator detail.
    expect(JSON.stringify(customerUpdate?.params)).toContain("provider-timeout");
    expect(JSON.stringify(customerUpdate?.params)).not.toContain("USPS rating gateway timed out");
  });

  it("records a void refund and clears the customer label document", async () => {
    const { db, captured } = mockDb();
    const handlers = buildFulfillmentReturnShipmentProjectionHandlers(db);
    await handlers["fulfillment.return-shipment.label-voided.v1"]({
      type: "fulfillment.return-shipment.label-voided.v1",
      data: {
        returnShipmentId: "rsh_1",
        refundStatus: "submitted",
        refundReference: "refund_1",
        reason: "case cancelled",
        metadata: { correlationRemedyId: "rmd_1", causationId: null, idempotencyKey: "m", policyVersion: "p" },
        voidedAt: "2026-06-02T12:00:00.000Z",
      },
    } as never);

    const operatorUpdate = captured.find((entry) =>
      entry.sql.includes("UPDATE fulfillment_return_shipment_operator_pages"),
    );
    const customerUpdate = captured.find((entry) =>
      entry.sql.includes("UPDATE fulfillment_return_shipment_customer_pages"),
    );
    expect(operatorUpdate?.sql).toContain("label_status = 'voided'");
    expect(JSON.stringify(operatorUpdate?.params)).toContain("refund_1");
    expect(customerUpdate?.sql).toContain("label_document_url = NULL");
  });

  it("projects intake evidence only to the operator row and counts duplicate scans", async () => {
    const { db, captured } = mockDb();
    const handlers = buildFulfillmentReturnShipmentProjectionHandlers(db);
    const intake = {
      facilityId: "fac_east",
      stationId: "station-1",
      operatorUserId: "usr_operator",
      receivedAt: "2026-07-14T12:00:00.000Z",
      packageCondition: "intact",
      sealCondition: "intact",
      measuredWeightOunces: 10,
      evidence: [{ attachmentId: "rie_1", storageKey: "private/key.jpg" }],
      discrepancies: [{ type: "expected", owner: "Fulfillment", nextAction: "Complete" }],
      disposition: "completed",
      custodyIdentifier: "CUST-1",
      idempotencyKey: "intake-1",
    };
    await handlers["fulfillment.return-shipment.facility-intake-completed.v1"]!({
      type: "fulfillment.return-shipment.facility-intake-completed.v1",
      data: { returnShipmentId: "rsh_1", remedyId: "rmd_1", supportRequestId: "sup_1", intake },
    } as never);
    await handlers["fulfillment.return-shipment.duplicate-intake-scan-observed.v1"]!({
      type: "fulfillment.return-shipment.duplicate-intake-scan-observed.v1",
      data: {
        returnShipmentId: "rsh_1",
        facilityId: "fac_east",
        operatorUserId: "usr_operator",
        observedAt: "2026-07-14T12:01:00.000Z",
      },
    } as never);

    const operatorUpdate = captured.find((entry) => entry.sql.includes("facility_intake = $3::jsonb"));
    const customerUpdate = captured.find(
      (entry) =>
        entry.sql.includes("UPDATE fulfillment_return_shipment_customer_pages") && entry.params.includes("rsh_1"),
    );
    expect(JSON.stringify(operatorUpdate?.params)).toContain("private/key.jpg");
    expect(JSON.stringify(customerUpdate?.params)).not.toContain("private/key.jpg");
    expect(captured.some((entry) => entry.sql.includes("duplicate_intake_scan_count + 1"))).toBe(true);
  });

  it("projects unidentified package reconciliation without replacing receipt evidence", async () => {
    const { db, captured } = mockDb();
    const handlers = buildFulfillmentReturnShipmentProjectionHandlers(db);
    await handlers["fulfillment.unidentified-return-package.recorded.v1"]!({
      type: "fulfillment.unidentified-return-package.recorded.v1",
      data: {
        unidentifiedPackageId: "urp_1",
        facilityId: "fac_east",
        stationId: "station-1",
        operatorUserId: "usr_operator",
        receivedAt: "2026-07-14T12:00:00.000Z",
        packageCondition: "unreadable",
        sealCondition: "broken",
        measuredWeightOunces: 5,
        evidence: [{ attachmentId: "rie_1", storageKey: "private/key.jpg" }],
        custodyIdentifier: "CUST-U-1",
        notes: null,
        owner: "Fulfillment",
        nextAction: "Identify from carrier manifest",
      },
    } as never);
    await handlers["fulfillment.unidentified-return-package.reconciled.v1"]!({
      type: "fulfillment.unidentified-return-package.reconciled.v1",
      data: {
        unidentifiedPackageId: "urp_1",
        returnShipmentId: "rsh_1",
        reconciledByUserId: "usr_supervisor",
        reconciledAt: "2026-07-15T12:00:00.000Z",
        reason: "Manifest match",
      },
    } as never);

    expect(captured[0].sql).toContain("ON CONFLICT (unidentified_package_id) DO UPDATE");
    expect(captured[1].sql).toContain("return_shipment_id = $2");
    expect(captured[1].sql).not.toContain("evidence =");
  });
});
