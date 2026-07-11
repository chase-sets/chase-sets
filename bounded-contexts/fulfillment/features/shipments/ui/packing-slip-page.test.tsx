import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { FulfillmentPackingSlipPrintPage } from "./packing-slip-page";
import { FulfillmentShipmentDetailPage } from "./shipment-detail-page";
import { FulfillmentShipmentListPage } from "./shipment-list-page";
import { FulfillmentShipmentPackingPage } from "./shipment-packing-page";
import type { FulfillmentPackingSlip } from "./contracts";

const slip: FulfillmentPackingSlip = {
  shipment_id: "shp_1",
  order_id: "ord_1",
  display_reference: "shp_1",
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
  shipping_plan_snapshot: {
    packagePlanVersion: "measured-package-plan-v1",
    packageCount: 1,
    packages: [
      {
        packageId: "pkg_1",
        mailpieceClass: "parcel",
        lengthInches: 7,
        widthInches: 5,
        heightInches: 1,
        weightOunces: 4,
        billableWeightOunces: 4,
        serviceLevel: "standard-parcel",
        productMeasureVersions: ["pokemon-raw-single:v1"],
      },
    ],
    letterEligibility: { eligible: false, reasons: ["parcel-required"] },
    postagePolicySnapshot: {
      policyVersion: "operator-postage-v1",
      parcelRequired: true,
      parcelReasons: ["declared-value-requires-parcel"],
      signatureRequired: true,
      signatureReasons: ["declared-value-requires-signature"],
      insuranceRequired: false,
      insuranceReasons: [],
      insuredValueAmount: null,
      shippingEvidenceTier: "signature-confirmed",
    },
    missingProductIds: [],
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
  packing_started_at: null,
  package_prepared_at: null,
  label_attached_at: null,
  label_voided_at: null,
  dispatched_at: null,
  delivered_at: null,
  returned_at: null,
  cancelled_at: null,
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
      packing_confirmed_quantity: 0,
      packing_confirmed_at: null,
    },
  ],
  exceptions: [],
  address_override_audits: [],
  postage_label_operations: [],
  postage_provider_events: [],
};

describe("fulfillment packing slip UI", () => {
  it("renders letter and thermal print pages without prices or payment details", () => {
    const letter = renderToString(<FulfillmentPackingSlipPrintPage format="letter" slips={[slip]} />);
    const thermal = renderToString(<FulfillmentPackingSlipPrintPage format="thermal-4x6" slips={[slip]} />);

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
      <FulfillmentShipmentDetailPage role="seller" backHref="/account/sales/shipments" shipment={slip} />,
    );

    expect(markup).toContain("Print packing slip");
    expect(markup).toContain("Start packing");
    expect(markup).toContain("Postage policy");
    expect(markup).toContain("Postage diagnostics");
    expect(markup).toContain("No postage operations recorded.");
    expect(markup).toContain("operator-postage-v1");
    expect(markup).toContain("Parcel required");
    expect(markup).toContain("declared-value-requires-parcel");
    expect(markup).toContain("Signature required");
    expect(markup).toContain("declared-value-requires-signature");
    expect(markup).toContain("/account/sales/shipments/shp_1/packing");
    expect(markup).toContain("/account/sales/shipments/packing-slips");
    expect(markup).toContain("shipmentIds=shp_1");
  });

  it("shows Letter Mail postage purchase for eligible letter mailpieces", () => {
    const letterShipment: FulfillmentPackingSlip = {
      ...slip,
      status: "awaiting-label",
      package_status: "packed",
      package_count: 1,
      shipping_plan_snapshot: {
        packagePlanVersion: "measured-package-plan-v1",
        packageCount: 1,
        packages: [
          {
            packageId: "pkg_letter_1",
            mailpieceClass: "letter",
            lengthInches: 9.5,
            widthInches: 4.125,
            heightInches: 0.012,
            weightOunces: 0.47,
            billableWeightOunces: 1,
            serviceLevel: "letter",
            productMeasureVersions: ["pokemon-raw-single:v1"],
          },
        ],
        letterEligibility: { eligible: true, reasons: [] },
        missingProductIds: [],
      },
    };
    const markup = renderToString(
      <FulfillmentShipmentDetailPage role="seller" backHref="/account/sales/shipments" shipment={letterShipment} />,
    );

    expect(markup).toContain("Letter Mailpiece");
    expect(markup).toContain("USPS Letter Mail postage");
    expect(markup).toContain("Print packing slip");
    expect(markup).toContain("Purchase Letter Mail label");
    expect(markup).toContain('value="First"');
    expect(markup).not.toContain("Purchase USPS label");
    expect(markup).not.toContain("Length (in)");
  });

  it("renders selected batch controls on seller shipment lists", () => {
    const markup = renderToString(
      <FulfillmentShipmentListPage
        title="Sale shipments"
        eyebrow="Seller"
        emptyTitle="No sale shipments yet"
        emptyDescription="Shipments appear here once paid."
        shipmentDetailBasePath="/account/sales/shipments"
        packingFlowBasePath="/account/sales/shipments"
        batchPrintActionPath="/account/sales/shipments/packing-slips"
        shipments={[slip]}
      />,
    );

    expect(markup).toContain('action="/account/sales/shipments/packing-slips"');
    expect(markup).toContain('name="shipmentIds"');
    expect(markup).toContain('value="shp_1"');
    expect(markup).toContain('name="format"');
    expect(markup).toContain("Print packing slips");
    expect(markup).toContain("Start packing");
    expect(markup).toContain('formAction="/account/sales/shipments/shp_1/packing"');
    expect(markup).toContain('formTarget="_self"');
  });

  it("renders the packing workspace with line confirmation before completion", () => {
    const packingShipment: FulfillmentPackingSlip = {
      ...slip,
      status: "packing",
      package_status: "packing",
      packing_started_at: "2026-04-02T00:01:00.000Z",
      lines: slip.lines.map((line) => ({
        ...line,
        packing_confirmed_quantity: line.line_id === "spl_1" ? line.quantity : 0,
        packing_confirmed_at: line.line_id === "spl_1" ? "2026-04-02T00:02:00.000Z" : null,
      })),
    };
    const markup = renderToString(
      <FulfillmentShipmentPackingPage
        backHref="/account/sales/shipments"
        shipment={packingShipment}
        errorMessage={null}
      />,
    );

    expect(markup).toContain("Pack shipment");
    expect(markup).toContain("Packed 2 x Charizard");
    expect(markup).toContain("Finish packing");
    expect(markup).toContain('value="complete-packing"');
    expect(markup).toContain("Order changes locked while packing");
  });
});
