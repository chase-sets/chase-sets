import { describe, expect, it } from "vitest";
import { SELLER_ATTENTION_SOURCES } from "@chase-sets/seller-attention-queue";
import {
  buildFulfillmentCommandCenter,
  FULFILLMENT_COMMAND_CENTER_BUCKET_ORDER,
  type FulfillmentCommandCenterShipmentInput,
} from "./command-center";

function shipment(
  overrides: Partial<FulfillmentCommandCenterShipmentInput> &
    Pick<FulfillmentCommandCenterShipmentInput, "shipment_id" | "status">,
): FulfillmentCommandCenterShipmentInput {
  return {
    order_id: `ord_${overrides.shipment_id}`,
    display_reference: `S-${overrides.shipment_id}`,
    label_status: "not-purchased",
    tracking_identifier: null,
    carrier_name: null,
    buyer_display_name: "Buyer",
    current_exception_type: null,
    current_exception_notes: null,
    line_count: 1,
    total_quantity: 1,
    created_at: "2026-07-10T00:00:00.000Z",
    updated_at: "2026-07-10T00:00:00.000Z",
    ...overrides,
  };
}

describe("fulfillment command center", () => {
  it("buckets actionable shipments by work state and excludes terminal / in-transit ones", () => {
    const center = buildFulfillmentCommandCenter([
      shipment({ shipment_id: "1", status: "awaiting-package" }),
      shipment({ shipment_id: "2", status: "packing" }),
      shipment({ shipment_id: "3", status: "awaiting-label" }),
      shipment({ shipment_id: "4", status: "label-attached", label_status: "purchased" }),
      shipment({ shipment_id: "5", status: "exception", current_exception_type: "carrier-delay" }),
      shipment({ shipment_id: "6", status: "dispatched" }),
      shipment({ shipment_id: "7", status: "delivered" }),
      shipment({ shipment_id: "8", status: "cancelled" }),
    ]);

    expect(center.totalNeedingAttention).toBe(5);
    const byId = new Map(center.buckets.map((bucket) => [bucket.id, bucket]));
    expect(byId.get("needs-packing")?.count).toBe(2);
    expect(byId.get("needs-label")?.count).toBe(1);
    expect(byId.get("ready-to-dispatch")?.count).toBe(1);
    expect(byId.get("exceptions")?.count).toBe(1);
  });

  it("orders buckets exceptions-first, matching the work-ordered surface", () => {
    const center = buildFulfillmentCommandCenter([]);
    expect(center.buckets.map((bucket) => bucket.id)).toEqual(FULFILLMENT_COMMAND_CENTER_BUCKET_ORDER);
    expect(center.buckets[0]?.id).toBe("exceptions");
  });

  it("derives the context-aware primary action from each shipment's state", () => {
    const center = buildFulfillmentCommandCenter([
      shipment({ shipment_id: "1", status: "awaiting-package" }),
      shipment({ shipment_id: "2", status: "awaiting-label" }),
      shipment({ shipment_id: "3", status: "label-attached", label_status: "purchased" }),
    ]);
    const plans = new Map(center.queue.map((item) => [item.shipmentId, item.plan.primary]));
    expect(plans.get("1")).toBe("start-packing");
    expect(plans.get("2")).toBe("buy-label");
    expect(plans.get("3")).toBe("dispatch");
  });

  it("discloses void and exception on a ready-to-dispatch shipment", () => {
    const center = buildFulfillmentCommandCenter([
      shipment({ shipment_id: "1", status: "label-attached", label_status: "purchased" }),
    ]);
    const item = center.queue[0];
    expect(item?.plan.disclosed).toContain("void-label");
    expect(item?.plan.disclosed).toContain("raise-exception");
  });

  it("orders the flat queue critical (exceptions) first, then oldest work first", () => {
    const center = buildFulfillmentCommandCenter([
      shipment({ shipment_id: "new", status: "awaiting-label", created_at: "2026-07-12T00:00:00.000Z" }),
      shipment({ shipment_id: "old", status: "awaiting-label", created_at: "2026-07-01T00:00:00.000Z" }),
      shipment({ shipment_id: "exc", status: "exception", created_at: "2026-07-13T00:00:00.000Z" }),
    ]);
    expect(center.queue.map((item) => item.shipmentId)).toEqual(["exc", "old", "new"]);
  });

  it("tags every item with the fulfillment-ship-by attention source from the contract", () => {
    const contractSource = SELLER_ATTENTION_SOURCES.find((source) => source.ownerContext === "fulfillment");
    const center = buildFulfillmentCommandCenter([shipment({ shipment_id: "1", status: "awaiting-package" })]);
    expect(center.source).toBe(contractSource?.id);
    expect(center.queue[0]?.attention.source).toBe(contractSource?.id);
    expect(contractSource?.id).toBe("fulfillment-ship-by");
  });
});
