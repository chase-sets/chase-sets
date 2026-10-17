import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { decideFulfillmentShipment, initialFulfillmentShipmentState } from "../domain/domain";
import {
  buildFulfillmentCommandCenter,
  type FulfillmentCommandCenterShipmentInput,
} from "../read-model/command-center";
import { FulfillmentCommandCenterPage } from "./fulfillment-command-center-page";
import { runShipmentCommandCenterAction } from "./command-center-route-adapter";

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
    conflicts: [],
    ...overrides,
  };
}

function render(shipments: readonly FulfillmentCommandCenterShipmentInput[]) {
  return renderToString(
    <FulfillmentCommandCenterPage
      commandCenter={buildFulfillmentCommandCenter(shipments)}
      actionBasePath="/account/sales/shipments"
      shipmentDetailBasePath="/account/sales/shipments"
      packingFlowBasePath="/account/sales/shipments"
      errorMessage={null}
    />,
  );
}

describe("FulfillmentCommandCenterPage", () => {
  it("renders the context-aware primary action for each work state", () => {
    const html = render([
      shipment({ shipment_id: "1", status: "awaiting-label" }),
      shipment({ shipment_id: "2", status: "label-attached", label_status: "purchased" }),
    ]);
    // awaiting-label -> buy label (inline post), label-attached -> dispatch (inline post)
    expect(html).toContain('value="buy-label"');
    expect(html).toContain('value="dispatch"');
    expect(html).toContain("awaiting-label");
    expect(html).toContain("label-attached");
  });

  it("discloses void and exception on a ready-to-dispatch shipment", () => {
    const html = render([shipment({ shipment_id: "1", status: "label-attached", label_status: "purchased" })]);
    expect(html).toContain('value="void-label"');
    expect(html).toContain('value="raise-exception"');
  });

  it("routes packing to the focused packing flow rather than an inline post", () => {
    const html = render([shipment({ shipment_id: "9", status: "awaiting-package" })]);
    expect(html).toContain("/account/sales/shipments/shp_9".replace("shp_9", "9"));
    expect(html).toContain("/account/sales/shipments/9/packing");
  });

  it("excludes terminal and in-transit shipments from the work queue", () => {
    const html = render([
      shipment({ shipment_id: "d", status: "delivered" }),
      shipment({ shipment_id: "t", status: "dispatched" }),
    ]);
    // No actionable buckets -> empty state, no action intents rendered.
    expect(html).not.toContain('value="dispatch"');
    expect(html).not.toContain('value="buy-label"');
  });

  it("surfaces the current exception detail on an exception shipment", () => {
    const html = render([
      shipment({
        shipment_id: "e",
        status: "exception",
        current_exception_type: "carrier-delay",
        current_exception_notes: "Stuck at hub",
      }),
    ]);
    expect(html).toContain("carrier-delay");
    expect(html).toContain("Stuck at hub");
    expect(html).toContain('value="record-delivery"');
  });

  it("renders cancellation only for the matching conflict and carries the advisory fact", () => {
    const matching = {
      order_id: "ord_1",
      conflict_kind: "cancellation" as const,
      origin: "order-cancelled",
      reason: "buyer-cancelled",
      shipment_status: "packing",
      detected_at: "2026-07-10T00:01:00.000Z",
    };
    const html = render([shipment({ shipment_id: "race", status: "packing", conflicts: [matching] })]);
    expect(html).toContain('value="cancel-shipment"');
    expect(html).toContain('name="hasOrderCancellationConflict"');
    expect(html).toContain('value="true"');

    const fraudOnly = render([
      shipment({
        shipment_id: "fraud",
        status: "packing",
        conflicts: [{ ...matching, origin: "payment-fraud-warning" }],
      }),
    ]);
    expect(fraudOnly).not.toContain('value="cancel-shipment"');
  });

  it("uses the form conflict only as a pre-check before the server-authoritative cancel", async () => {
    const cancelShipment = vi.fn(async () => ({ id: "shp_race", version: 4 }));
    const api = { cancelShipment } as never;
    const matching = new FormData();
    matching.set("shipmentId", "shp_race");
    matching.set("status", "packing");
    matching.set("labelStatus", "not-purchased");
    matching.set("hasOrderCancellationConflict", "true");
    matching.set("mutationAttemptId", "attempt-race");
    await expect(runShipmentCommandCenterAction(api, "cancel-shipment", matching)).resolves.toEqual({ ok: true });
    expect(cancelShipment).toHaveBeenCalledTimes(1);

    const fraudOnly = new FormData();
    fraudOnly.set("shipmentId", "shp_race");
    fraudOnly.set("status", "packing");
    fraudOnly.set("labelStatus", "not-purchased");
    fraudOnly.set("hasOrderCancellationConflict", "false");
    fraudOnly.set("mutationAttemptId", "attempt-fraud");
    await expect(runShipmentCommandCenterAction(api, "cancel-shipment", fraudOnly)).resolves.toEqual({
      ok: false,
      error: "Cannot cancel shipment without an order cancellation conflict.",
    });
    expect(cancelShipment).toHaveBeenCalledTimes(1);
  });

  it("refuses a forged positive adapter fact when the aggregate records fraud only", async () => {
    const fraudOnlyState = {
      ...initialFulfillmentShipmentState,
      shipmentId: "shp_race" as never,
      orderId: "ord_race" as never,
      buyerAccountId: "acc_buyer" as never,
      sellerAccountId: "acc_seller" as never,
      status: "packing" as const,
      packageStatus: "packing" as const,
      conflicts: [
        {
          orderId: "ord_race" as never,
          conflictKind: "cancellation" as const,
          origin: "payment-fraud-warning" as const,
          reason: null,
          shipmentStatus: "packing" as const,
        },
      ],
    };
    const cancelShipment = vi.fn(async () => {
      const events = decideFulfillmentShipment(fraudOnlyState, {
        type: "CancelShipment",
        cancelledAt: "2026-08-02T12:00:00.000Z",
      });
      return { id: "shp_race", version: events.length + 1 };
    });
    const forged = new FormData();
    forged.set("shipmentId", "shp_race");
    forged.set("status", "packing");
    forged.set("labelStatus", "not-purchased");
    forged.set("hasOrderCancellationConflict", "true");
    forged.set("mutationAttemptId", "attempt-forged");

    await expect(
      runShipmentCommandCenterAction({ cancelShipment } as never, "cancel-shipment", forged),
    ).resolves.toEqual({ ok: false, error: "Only shipments with an order cancellation conflict can be cancelled." });
    expect(cancelShipment).toHaveBeenCalledTimes(1);
  });
});
