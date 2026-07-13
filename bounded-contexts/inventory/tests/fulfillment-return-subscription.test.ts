import { describe, expect, it, vi } from "vitest";
import type { TransportEvent } from "@chase-sets/event-core/transport";
import { buildTransportEvent } from "@chase-sets/event-core/test-support";
import { module as inventoryModule } from "../index";
import type { InventoryServices } from "../support/runtime-support/services";

function getFulfillmentReturnHandlers(services: InventoryServices) {
  const subscription = (inventoryModule.buildSubscriptions?.(services) ?? []).find(
    (candidate) => candidate.subscriptionName === "inventory.fulfillment-restock-workflow",
  );

  if (!subscription) {
    throw new Error("Inventory fulfillment restock subscription was not registered.");
  }

  return subscription.handlers;
}

describe("inventory fulfillment return subscription", () => {
  it("routes returned shipments to the restock decision queue", async () => {
    const markShipmentReturned = vi.fn(async () => [{ decisionId: "rstk_1", version: 1 }]);
    const services = {
      restockDecisions: { markShipmentReturned },
      db: { query: vi.fn(async () => ({ rows: [] })) },
      projectors: [],
      pool: {},
    } as unknown as InventoryServices;

    await getFulfillmentReturnHandlers(services)["fulfillment.shipment.returned"]!(
      buildTransportEvent(
        "fulfillment.shipment.returned",
        {
          shipmentId: "shp_1",
          reason: "condition-dispute",
          returnedAt: "2026-07-07T01:00:00.000Z",
        },
        {
          id: "evt_shipment_returned",
          tenantId: "tenant_1",
          streamId: "fulfillment.shipment-shp_1",
          streamVersion: 3,
          globalPosition: "3",
          audit: { performedByUserId: "usr_system", forAccountId: null },
          trace: { traceId: "trace_1" },
          timing: { occurredAt: "2026-07-07T01:00:00.000Z", recordedAt: "2026-07-07T01:00:00.000Z" },
        },
      ),
    );

    expect(markShipmentReturned).toHaveBeenCalledWith(
      {
        shipmentId: "shp_1",
        returnReason: "condition-dispute",
        returnedAt: "2026-07-07T01:00:00.000Z",
      },
      expect.objectContaining({
        tenantId: "tenant_1",
      }),
    );
  });
});
