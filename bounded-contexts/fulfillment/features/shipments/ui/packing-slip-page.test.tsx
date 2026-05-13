import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { FulfillmentPackingSlipPrintPage } from "./packing-slip-page";
import { FulfillmentShipmentDetailPage } from "./shipment-detail-page";
import { FulfillmentShipmentListPage } from "./shipment-list-page";
import type { FulfillmentPackingSlip } from "./contracts";

const slip: FulfillmentPackingSlip = {
  shipment_id: "shp_1",
  order_id: "ord_1",
  buyer_account_id: "acc_buyer",
  buyer_display_name: "Buyer",
  seller_account_id: "acc_seller",
  seller_display_name: "Seller",
  shipping_option: "standard",
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
  shipping_origin_snapshot: {
    name: "Seller",
    company: null,
    line1: "1 Main St",
    line2: null,
    city: "Austin",
    state: "TX",
    postalCode: "78701",
    country: "US",
    phone: null,
    email: null,
  },
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
  status: "awaiting-package",
  package_status: "awaiting-package",
  package_count: null,
  current_exception_type: null,
  current_exception_notes: null,
  created_at: "2026-04-02T00:00:00.000Z",
  updated_at: "2026-04-02T00:00:00.000Z",
  package_prepared_at: null,
  label_attached_at: null,
  label_voided_at: null,
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
      item_subtitle: "Base Set",
      product_summary: "Condition: Near Mint",
      quantity: 2,
    },
  ],
  exceptions: [],
  address_override_audits: [],
};

describe("fulfillment packing slip UI", () => {
  it("renders letter and thermal print pages without prices or payment details", () => {
    const letter = renderToString(
      <FulfillmentPackingSlipPrintPage format="letter" slips={[slip]} />,
    );
    const thermal = renderToString(
      <FulfillmentPackingSlipPrintPage format="thermal-4x6" slips={[slip]} />,
    );

    expect(letter).toContain("fulfillment-packing-slip--letter");
    expect(letter).toContain("size: letter");
    expect(letter).toContain("Charizard");
    expect(letter).toContain("Condition: Near Mint");
    expect(letter).toContain("shp_1");
    expect(letter).not.toContain("price_amount");
    expect(letter).not.toContain("payment_id");
    expect(letter).not.toContain("$");
    expect(thermal).toContain("fulfillment-packing-slip--thermal");
    expect(thermal).toContain("size: 4in 6in");
    expect(thermal).toContain("data-packing-slip-page");
    expect(thermal).toMatch(
      /\.fulfillment-packing-slip--thermal \.fulfillment-packing-slip__grid \{[^}]*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\);/,
    );
    expect(thermal.match(/\.fulfillment-packing-slip--thermal \.fulfillment-packing-slip__grid/g)).toHaveLength(2);
    expect(thermal).not.toContain("@page fulfillment-packing-slip-thermal");
  });

  it("adds a seller detail print action for the current shipment", () => {
    const markup = renderToString(
      <FulfillmentShipmentDetailPage
        role="seller"
        backHref="/account/sales/shipments"
        shipment={slip}
      />,
    );

    expect(markup).toContain("Print packing slip");
    expect(markup).toContain("/account/sales/shipments/packing-slips");
    expect(markup).toContain("shipmentIds=shp_1");
  });

  it("renders selected batch controls on seller shipment lists", () => {
    const markup = renderToString(
      <FulfillmentShipmentListPage
        title="Sale shipments"
        eyebrow="Seller"
        emptyTitle="No sale shipments yet"
        emptyDescription="Shipments appear here once paid."
        shipmentDetailBasePath="/account/sales/shipments"
        batchPrintActionPath="/account/sales/shipments/packing-slips"
        shipments={[slip]}
      />,
    );

    expect(markup).toContain('action="/account/sales/shipments/packing-slips"');
    expect(markup).toContain('name="shipmentIds"');
    expect(markup).toContain('value="shp_1"');
    expect(markup).toContain('name="format"');
    expect(markup).toContain("Print packing slips");
  });
});
