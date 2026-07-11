// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { FulfillmentShipmentPackingPage } from "./shipment-packing-page";
import type { FulfillmentShipmentDetail } from "./contracts";

function shipment(): FulfillmentShipmentDetail {
  return {
    shipment_id: "shp_1",
    order_id: "ord_1",
    display_reference: "shp_1",
    buyer_account_id: "acc_buyer",
    buyer_display_name: "Buyer",
    seller_account_id: "acc_seller",
    seller_display_name: "Seller",
    shipping_option: "standard",
    shipping_plan_snapshot: null,
    shipping_destination_snapshot: {
      name: "Buyer",
      company: null,
      line1: "2 Market St",
      line2: null,
      city: "Chicago",
      state: "IL",
      postalCode: "60601",
      country: "US",
      phone: null,
      email: null,
    },
    shipping_origin_snapshot: null,
    shipping_method: null,
    carrier_name: null,
    label_reference: null,
    label_document_url: null,
    tracking_identifier: null,
    postage_provider_name: null,
    postage_provider_mode: null,
    postage_provider_shipment_id: null,
    postage_provider_label_id: null,
    postage_rate_id: null,
    postage_service_level: null,
    postage_amount_cents: null,
    postage_currency: null,
    label_status: "not-purchased",
    label_error_code: null,
    label_error_message: null,
    label_refund_status: null,
    label_refund_reference: null,
    status: "packing",
    package_status: "packing",
    package_count: null,
    current_exception_type: null,
    current_exception_notes: null,
    created_at: "2026-04-02T00:00:00.000Z",
    updated_at: "2026-04-02T00:00:00.000Z",
    packing_started_at: "2026-04-02T00:01:00.000Z",
    package_prepared_at: null,
    label_attached_at: null,
    label_voided_at: null,
    cancelled_at: null,
    dispatched_at: null,
    delivered_at: null,
    returned_at: null,
    exception_raised_at: null,
    line_count: 1,
    total_quantity: 2,
    lines: [
      {
        line_id: "spl_1",
        order_line_id: "oli_1",
        catalog_catalog_item_id: "cat_1",
        product_id: "cat_1::",
        item_title: "Charizard",
        item_subtitle: null,
        product_summary: "Condition: Near Mint",
        quantity: 2,
        packing_confirmed_quantity: 0,
        packing_confirmed_at: null,
      },
    ],
    exceptions: [],
    address_override_audits: [],
    postage_label_operations: [],
    postage_provider_events: [],
  };
}

describe("fulfillment packing optimistic correction", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("applies a line quantity optimistically, serializes in-flight writes, and rolls back failed latest writes", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: "Line update failed." }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    render(<FulfillmentShipmentPackingPage shipment={shipment()} backHref="/account/sales/shipments" />);

    const increase = screen.getByRole("button", { name: "Increase packed quantity for Charizard" });
    fireEvent.click(increase);
    fireEvent.click(increase);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(screen.getByText("1 of 2 packed")).toBeTruthy();
    expect((increase as HTMLButtonElement).disabled).toBe(true);

    await waitFor(() => expect(screen.getByText("0 of 2 packed")).toBeTruthy());
    expect(screen.getByText("Line update failed.")).toBeTruthy();
    expect((increase as HTMLButtonElement).disabled).toBe(false);
  });
});
