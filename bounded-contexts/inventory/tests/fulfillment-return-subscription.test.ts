import { describe, expect, it, vi } from "vitest";
import type { TransportEvent } from "@chase-sets/event-core/transport";
import { buildTransportEvent } from "@chase-sets/event-core/test-support";
import { module as inventoryModule } from "../index";
import type { InventoryServices } from "../support/runtime-support/services";
import { seedContext } from "../support/seed-support/context";

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

  it("seed returned decision uses seller tenant", async () => {
    const markShipmentReturned = vi.fn(async () => [{ decisionId: "rstk_seed", version: 1 }]);
    const services = {
      restockDecisions: { markShipmentReturned },
      db: { query: vi.fn(async () => ({ rows: [] })) },
      projectors: [],
      pool: {},
    } as unknown as InventoryServices;
    const returned = (tenantId: string) =>
      buildTransportEvent(
        "fulfillment.shipment.returned",
        { shipmentId: "shp_seed_returned", reason: "Carrier return to sender", returnedAt: "2026-03-22T12:00:00.000Z" },
        {
          id: `evt_seed_returned_${tenantId}`,
          tenantId,
          streamId: "fulfillment.shipment-shp_seed_returned",
          streamVersion: 8,
          globalPosition: "8",
          audit: seedContext.audit,
          trace: {},
          timing: { occurredAt: "2026-03-22T12:00:00.000Z", recordedAt: "2026-03-22T12:00:00.000Z" },
        },
      );
    const handle = getFulfillmentReturnHandlers(services)["fulfillment.shipment.returned"]!;

    // The Fulfillment seed now writes its shipments under the demo seller's tenant, so the decision
    // is pending where the seller's session (Inventory's seed tenant) records it.
    await handle(returned(seedContext.tenantId));
    // The old seed tenant put the decision under a tenant the seller's session never carries, so
    // recording it answered Restock decision not found.
    await handle(returned("tnt_seed_development"));

    const tenants = markShipmentReturned.mock.calls.map(
      (call) => (call as unknown as [unknown, { tenantId: string }])[1].tenantId,
    );
    expect(tenants).toEqual([seedContext.tenantId, "tnt_seed_development"]);
    expect(tenants[1]).not.toBe(seedContext.tenantId);
    expect(markShipmentReturned).toHaveBeenCalledWith(
      expect.objectContaining({ shipmentId: "shp_seed_returned" }),
      expect.objectContaining({ tenantId: seedContext.tenantId, audit: seedContext.audit }),
    );
  });
});
