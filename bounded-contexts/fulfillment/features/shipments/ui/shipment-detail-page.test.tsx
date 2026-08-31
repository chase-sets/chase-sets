import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type {
  FulfillmentPostageLabelOperationDiagnostic,
  FulfillmentPostageProviderEventDiagnostic,
  FulfillmentShipmentDetail,
} from "./contracts";
import { FulfillmentShipmentDetailPage } from "./shipment-detail-page";

const elevationRoleAttribute = ["data", "elevation", "role"].join("-");

function markedRoleCount(markup: string, role: "entity" | "furniture") {
  return markup.match(new RegExp(`${elevationRoleAttribute}="${role}"`, "g"))?.length ?? 0;
}

const destination = {
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
};

function operation(operationKey: string, operationKind: string): FulfillmentPostageLabelOperationDiagnostic {
  return {
    operation_key: operationKey,
    operation_kind: operationKind,
    provider_name: "USPS",
    provider_mode: "test",
    status: "completed",
    requested_service_level: "USPS_GROUND_ADVANTAGE",
    requested_delivery_confirmation: "signature",
    requested_insurance_amount: null,
    requested_label_size: "4x6",
    requested_mailpiece_class: "parcel",
    requested_weight_ounces: "4",
    address_override_changed_side: null,
    address_override_reason: null,
    policy_version: "operator-postage-v1",
    parcel_required: "true",
    signature_required: "true",
    insurance_required: "false",
    insured_value_amount: null,
    shipping_evidence_tier: "signature-confirmed",
    provider_shipment_id: `provider-${operationKey}`,
    provider_label_id: `label-${operationKey}`,
    tracking_identifier: `tracking-${operationKey}`,
    error_message: null,
    created_at: "2026-04-02T01:00:00.000Z",
    updated_at: "2026-04-02T01:05:00.000Z",
    completed_at: "2026-04-02T01:05:00.000Z",
  };
}

function providerEvent(providerEventId: string, eventKind: string): FulfillmentPostageProviderEventDiagnostic {
  return {
    provider_event_id: providerEventId,
    provider_name: "USPS",
    provider_mode: "test",
    event_kind: eventKind,
    provider_object_reference: `object-${providerEventId}`,
    tracking_identifier: `tracking-${providerEventId}`,
    status: "processed",
    status_detail: "Accepted",
    processing_result: "applied",
    occurred_at: "2026-04-02T02:00:00.000Z",
    received_at: "2026-04-02T02:01:00.000Z",
  };
}

const shipment: FulfillmentShipmentDetail = {
  shipment_id: "shp_populated",
  order_id: "ord_populated",
  buyer_account_id: "acc_buyer",
  buyer_display_name: "Buyer",
  seller_account_id: "acc_seller",
  seller_display_name: "Seller",
  shipping_option: "standard",
  shipping_destination_snapshot: destination,
  shipping_origin_snapshot: { ...destination, name: "Seller", city: "Austin", state: "TX", postalCode: "78701" },
  shipping_plan_snapshot: null,
  shipping_method: "USPS Ground Advantage",
  carrier_name: "USPS",
  display_reference: "SHP-POPULATE",
  label_reference: "lbl_populated",
  label_document_url: null,
  tracking_identifier: "9400000000000000000000",
  postage_provider_name: "USPS",
  postage_provider_mode: "test",
  postage_provider_shipment_id: "provider_shipment",
  postage_provider_label_id: "provider_label",
  postage_rate_id: "rate_ground",
  postage_service_level: "USPS_GROUND_ADVANTAGE",
  postage_amount_cents: 595,
  postage_currency: "USD",
  label_status: "purchased",
  label_error_code: null,
  label_error_message: null,
  label_refund_status: null,
  label_refund_reference: null,
  status: "dispatched",
  package_status: "dispatched",
  package_count: 1,
  current_exception_type: "carrier-delay",
  current_exception_notes: "Carrier scan is delayed.",
  created_at: "2026-04-02T00:00:00.000Z",
  updated_at: "2026-04-02T03:00:00.000Z",
  packing_started_at: "2026-04-02T00:15:00.000Z",
  package_prepared_at: "2026-04-02T00:30:00.000Z",
  label_attached_at: "2026-04-02T01:05:00.000Z",
  label_voided_at: null,
  cancelled_at: null,
  dispatched_at: "2026-04-02T01:30:00.000Z",
  delivered_at: null,
  returned_at: null,
  exception_raised_at: "2026-04-02T03:00:00.000Z",
  line_count: 3,
  total_quantity: 3,
  lines: [
    {
      line_id: "spl_1",
      order_line_id: "oli_1",
      catalog_catalog_item_id: "cat_1",
      product_id: "cat_1::raw",
      item_title: "Charizard",
      item_subtitle: "Base Set",
      product_summary: "Condition: Near Mint",
      quantity: 1,
      packing_confirmed_quantity: 1,
      packing_confirmed_at: "2026-04-02T00:30:00.000Z",
    },
    {
      line_id: "spl_2",
      order_line_id: "oli_2",
      catalog_catalog_item_id: "cat_2",
      product_id: "cat_2::raw",
      item_title: "Blastoise",
      item_subtitle: "Base Set",
      product_summary: "Condition: Excellent",
      quantity: 1,
      packing_confirmed_quantity: 1,
      packing_confirmed_at: "2026-04-02T00:30:00.000Z",
    },
    {
      line_id: "spl_3",
      order_line_id: "oli_3",
      catalog_catalog_item_id: "cat_3",
      product_id: "cat_3::raw",
      item_title: "Venusaur",
      item_subtitle: "Base Set",
      product_summary: "Condition: Good",
      quantity: 1,
      packing_confirmed_quantity: 1,
      packing_confirmed_at: "2026-04-02T00:30:00.000Z",
    },
  ],
  exceptions: [
    {
      raised_at: "2026-04-02T03:00:00.000Z",
      exception_type: "carrier-delay",
      notes: "Carrier scan is delayed.",
    },
  ],
  address_override_audits: [],
  postage_label_operations: [operation("purchase-1", "purchase"), operation("attach-1", "attach")],
  postage_provider_events: [providerEvent("evt_created", "created"), providerEvent("evt_scan", "tracking-scan")],
};

describe("FulfillmentShipmentDetailPage", () => {
  it("renders populated shipment sections with zero marked entity roots", () => {
    const html = renderToString(
      <FulfillmentShipmentDetailPage role="seller" backHref="/account/sales/shipments" shipment={shipment} />,
    );

    expect(markedRoleCount(html, "entity")).toBe(0);
    expect(markedRoleCount(html, "furniture")).toBe(10);
    expect(html).toContain("purchase-1");
    expect(html).toContain("attach-1");
    expect(html).toContain("created / processed");
    expect(html).toContain("tracking-scan / processed");
    expect(html).toContain("Charizard");
    expect(html).toContain("Blastoise");
    expect(html).toContain("Venusaur");
    expect(html).toContain("carrier-delay");
    expect({
      mainHeadings: (html.match(/<h1\b/g) ?? []).length,
      forms: (html.match(/<form\b/g) ?? []).length,
      buttons: (html.match(/<button\b/g) ?? []).length,
    }).toEqual({ mainHeadings: 1, forms: 3, buttons: 3 });
  });
});
