import { describe, expect, it, vi } from "vitest";
import { createInMemoryEventStore } from "@chase-sets/event-core/test-support";
import { createRecoveredItemRuntime, recoveredItemIdForReturnShipment } from "./runtime";

const context = {
  tenantId: "tnt_1",
  audit: { performedByUserId: "usr_1", forAccountId: "acc_platform" },
  trace: { traceId: "trace_1" },
} as const;

describe("recovered item runtime", () => {
  it("uses the return shipment as the deterministic idempotency boundary", async () => {
    const { eventStore } = createInMemoryEventStore();
    const runtime = createRecoveredItemRuntime({
      eventStore,
      checkpointStore: {} as never,
      db: { query: vi.fn(async () => ({ rows: [] })) },
    });
    const input = {
      returnShipmentId: "rsh_1",
      remedyId: "rmd_1",
      facilityId: "facility-1",
      stationId: "station-1",
      custodyIdentifier: "CUST-1",
      evidenceReferences: ["att_1"],
      intakeDisposition: "completed" as const,
      hasDiscrepancy: false,
      observedItemReference: "line-1",
      policyVersion: "returns-2026-07",
      receivedAt: "2026-07-15T02:00:00.000Z",
    };

    const first = await runtime.createFromFacilityIntake(input, context);
    const replay = await runtime.createFromFacilityIntake(input, context);

    expect(first.recoveredItemId).toBe(recoveredItemIdForReturnShipment("rsh_1"));
    expect(replay).toEqual(first);
  });
});
