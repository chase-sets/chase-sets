import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  buildFulfillmentCommandCenter,
  type FulfillmentCommandCenterShipmentInput,
} from "../read-model/command-center";
import { FulfillmentCommandCenterPage } from "./fulfillment-command-center-page";

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
});
