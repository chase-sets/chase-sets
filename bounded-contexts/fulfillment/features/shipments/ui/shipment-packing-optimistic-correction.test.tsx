// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { FulfillmentShipmentPackingPage, submitPackingLineQuantity } from "./shipment-packing-page";
import * as recovery from "./mutation-recovery";
import type { FulfillmentShipmentDetail } from "./contracts";

vi.mock("./mutation-recovery", () => ({
  hashShipmentMutationIntent: vi.fn(async () => "intent-hash"),
  persistShipmentMutationDescriptor: vi.fn(async () => ({
    schemaVersion: 1,
    tenantId: "tnt_1",
    sellerAccountId: "acc_seller",
    shipmentId: "shp_1",
    command: "set-line-confirmed",
    target: "spl_1",
    intentHash: "intent-hash",
    mutationAttemptId: "018f47d2-9d2a-4d68-8f33-6fb718c3f001",
    createdAt: "2026-08-23T00:00:00.000Z",
    lastObservedAt: "2026-08-23T00:00:00.000Z",
    state: "submitting",
    sentAt: null,
    automaticRecoveryReadAt: null,
  })),
  updateShipmentMutationDescriptor: vi.fn(async (descriptor) => descriptor),
  completeShipmentMutationDescriptor: vi.fn(),
}));

function shipment(): FulfillmentShipmentDetail {
  return {
    conflicts: [],
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

  it.each(["shp_first", "shp_second & extra"])(
    "keeps both print links on %s after clicks and packing completion",
    (shipmentId) => {
      const value = { ...shipment(), shipment_id: shipmentId };
      const props = {
        shipment: value,
        backHref: "/account/sales/shipments",
        recoveryScope: { tenantId: "tnt_1", sellerAccountId: "acc_seller" },
      };
      const view = render(<FulfillmentShipmentPackingPage {...props} />);
      function assertLinks(count: number) {
        const links = screen.getAllByRole<HTMLAnchorElement>("link", {
          name: /Print packing slip.*\(opens in a new tab\)/,
        });
        expect(links).toHaveLength(count);
        for (const link of links) {
          const target = new URL(link.href);
          expect(target.pathname).toBe("/account/sales/shipments/packing-slips");
          expect(target.searchParams.getAll("shipmentIds")).toEqual([shipmentId]);
          expect(target.searchParams.getAll("format")).toEqual(["letter"]);
          expect(link.target).toBe("_blank");
          expect(link.querySelectorAll("svg")).toHaveLength(1);
          expect(link.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
          expect(link.querySelector("title")).toBeNull();
          expect(link.getAttribute("aria-label")?.match(/opens in a new tab/g)).toHaveLength(1);
        }
        return links;
      }
      // WorkstationLayout renders the summary in both desktop and mobile containers.
      const links = assertLinks(3);
      fireEvent.click(links[0]!);
      assertLinks(3);
      expect(screen.getAllByText("Packing slip opened in a new tab.")).toHaveLength(2);
      expect(screen.getAllByRole("link", { name: "Print packing slip again (opens in a new tab)" })).toHaveLength(2);
      fireEvent.click(links[1]!);
      assertLinks(3);
      view.rerender(
        <FulfillmentShipmentPackingPage
          {...props}
          shipment={{ ...value, status: "awaiting-label", package_status: "packed" }}
        />,
      );
      assertLinks(2);
    },
  );

  it("waits for durable descriptor and sent-marker writes before the direct quantity POST", async () => {
    let releaseDescriptor!: () => void;
    let releaseMarker!: () => void;
    const existing = await recovery.persistShipmentMutationDescriptor({
      tenantId: "tnt_1",
      sellerAccountId: "acc_seller",
      shipmentId: "shp_1",
      command: "set-line-confirmed",
      intentHash: "intent-hash",
    });
    vi.mocked(recovery.persistShipmentMutationDescriptor).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseDescriptor = () => resolve(existing);
        }),
    );
    vi.mocked(recovery.updateShipmentMutationDescriptor).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseMarker = () => resolve(existing);
        }),
    );
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ lineId: "spl_1", confirmedQuantity: 1 })));
    vi.stubGlobal("fetch", fetchMock);
    const pending = submitPackingLineQuantity({
      recoveryScope: { tenantId: "tnt_1", sellerAccountId: "acc_seller" },
      shipmentId: "shp_1",
      lineId: "spl_1",
      confirmedQuantity: 1,
      action: "/packing",
    });
    await waitFor(() => expect(releaseDescriptor).toBeTypeOf("function"));
    expect(fetchMock).not.toHaveBeenCalled();
    releaseDescriptor();
    await waitFor(() => expect(releaseMarker).toBeTypeOf("function"));
    expect(fetchMock).not.toHaveBeenCalled();
    releaseMarker();
    await expect(pending).resolves.toEqual({ lineId: "spl_1", confirmedQuantity: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("never directly POSTs when descriptor storage rejects, independent of the boundary fence", async () => {
    vi.mocked(recovery.persistShipmentMutationDescriptor).mockRejectedValueOnce(new Error("storage rejected"));
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      submitPackingLineQuantity({
        recoveryScope: { tenantId: "tnt_1", sellerAccountId: "acc_seller" },
        shipmentId: "shp_1",
        lineId: "spl_1",
        confirmedQuantity: 1,
        action: "/packing",
      }),
    ).rejects.toThrow("storage rejected");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("applies a line quantity optimistically, serializes in-flight writes, and rolls back failed latest writes", async () => {
    let resolveResponse!: (response: Response) => void;
    const fetchMock = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          resolveResponse = resolve;
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    render(
      <FulfillmentShipmentPackingPage
        shipment={shipment()}
        backHref="/account/sales/shipments"
        recoveryScope={{ tenantId: "tnt_1", sellerAccountId: "acc_seller" }}
      />,
    );

    const increase = screen.getByRole("button", { name: "Increase packed quantity for Charizard" });
    fireEvent.click(increase);
    fireEvent.click(increase);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(screen.getByText("1 of 2 packed")).toBeTruthy();
    expect((increase as HTMLButtonElement).disabled).toBe(true);

    resolveResponse(
      new Response(JSON.stringify({ error: "Line update failed." }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      }),
    );

    await waitFor(() => expect(screen.getByText("0 of 2 packed")).toBeTruthy());
    expect(screen.getByText("Line update failed.")).toBeTruthy();
    expect((increase as HTMLButtonElement).disabled).toBe(false);
  });
});
