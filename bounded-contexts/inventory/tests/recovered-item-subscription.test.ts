import { describe, expect, it, vi } from "vitest";
import { buildTransportEvent } from "@chase-sets/event-core/test-support";
import { module as inventoryModule } from "../index";
import type { InventoryServices } from "../support/runtime-support/services";

describe("inventory recovered return subscription", () => {
  it("hands facility intake to one Inventory recovered item under replay", async () => {
    const createFromFacilityIntake = vi.fn(async () => ({ recoveredItemId: "rcv_1", version: 1 }));
    const services = {
      recoveredItems: { createFromFacilityIntake },
      db: { query: vi.fn(async () => ({ rows: [] })) },
      projectors: [],
    } as unknown as InventoryServices;
    const subscription = (inventoryModule.buildSubscriptions?.(services) ?? []).find(
      (candidate) => candidate.subscriptionName === "inventory.fulfillment-recovered-item-workflow",
    );
    expect(subscription).toBeDefined();
    const event = buildTransportEvent(
      "fulfillment.return-shipment.facility-intake-completed.v1",
      {
        returnShipmentId: "rsh_1",
        remedyId: "rmd_1",
        intake: {
          facilityId: "facility-1",
          stationId: "station-1",
          custodyIdentifier: "CUST-1",
          receivedAt: "2026-07-15T02:00:00.000Z",
          disposition: "quarantine",
          evidence: [{ attachmentId: "att_1" }],
          discrepancies: [
            {
              type: "damaged",
              observedItemReference: "line-1",
            },
          ],
        },
        metadata: { policyVersion: "returns-2026-07" },
      },
      {
        id: "evt_intake_1",
        tenantId: "tnt_1",
        streamId: "fulfillment.return-shipment-rsh_1",
        streamVersion: 5,
        globalPosition: "5",
        audit: { performedByUserId: "usr_operator", forAccountId: null },
        trace: { traceId: "trace_1" },
        timing: { occurredAt: "2026-07-15T02:00:00.000Z", recordedAt: "2026-07-15T02:00:00.000Z" },
      },
    );

    await subscription!.handlers["fulfillment.return-shipment.facility-intake-completed.v1"]!(event);
    await subscription!.handlers["fulfillment.return-shipment.facility-intake-completed.v1"]!(event);

    expect(createFromFacilityIntake).toHaveBeenNthCalledWith(
      1,
      {
        returnShipmentId: "rsh_1",
        remedyId: "rmd_1",
        facilityId: "facility-1",
        stationId: "station-1",
        custodyIdentifier: "CUST-1",
        evidenceReferences: ["att_1"],
        intakeDisposition: "quarantine",
        hasDiscrepancy: true,
        observedItemReference: "line-1",
        policyVersion: "returns-2026-07",
        receivedAt: "2026-07-15T02:00:00.000Z",
      },
      expect.objectContaining({ tenantId: "tnt_1" }),
    );
  });
});
