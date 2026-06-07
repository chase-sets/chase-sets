import { describe, expect, it, vi } from "vitest";
import { getSellerShipment } from "./queries";

describe("fulfillment shipment read model queries", () => {
  it("loads bounded postage diagnostics without exposing raw provider payloads", async () => {
    const queries: string[] = [];
    const operationDiagnostic = {
      operation_key: "shipment:shp_1:purchase-usps-label:2026-04-02T00:10:00.000Z",
      operation_kind: "purchase-usps-label",
      provider_name: "sandbox-usps",
      provider_mode: "test",
      status: "failed",
      requested_service_level: "USPS_GROUND_ADVANTAGE",
      requested_delivery_confirmation: "signature",
      requested_label_size: null,
      requested_mailpiece_class: "parcel",
      requested_weight_ounces: "5.25",
      address_override_changed_side: null,
      address_override_reason: null,
      policy_version: "operator-postage-v1",
      parcel_required: "true",
      signature_required: "true",
      provider_shipment_id: null,
      provider_label_id: null,
      tracking_identifier: null,
      error_message: "Signature delivery confirmation is unavailable.",
      created_at: "2026-04-02T00:10:00.000Z",
      updated_at: "2026-04-02T00:10:01.000Z",
      completed_at: "2026-04-02T00:10:01.000Z",
    };
    const providerEventDiagnostic = {
      provider_event_id: "evt_tracker_1",
      provider_name: "easypost",
      provider_mode: "production",
      event_kind: "tracking-status",
      provider_object_reference: "trk_provider_1",
      tracking_identifier: "940000000000000000",
      status: "delivered",
      status_detail: "arrived_at_destination",
      processing_result: "delivered",
      occurred_at: "2026-04-02T00:20:00.000Z",
      received_at: "2026-04-02T00:20:01.000Z",
    };
    const db = {
      query: vi.fn(async (sql: string) => {
        queries.push(sql);
        if (sql.includes("FROM fulfillment_shipment_pages AS page")) {
          return {
            rows: [
              {
                shipment_id: "shp_1",
                order_id: "ord_1",
                buyer_account_id: "acc_buyer",
                buyer_display_name: "Buyer",
                seller_account_id: "acc_seller",
                seller_display_name: "Seller",
                shipping_option: "standard",
                shipping_destination_snapshot: {},
                shipping_origin_snapshot: {},
                shipping_plan_snapshot: null,
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
                label_status: "purchase-error",
                label_error_code: "postage_provider_capability_failure",
                label_error_message: "Signature delivery confirmation is unavailable.",
                label_refund_status: null,
                label_refund_reference: null,
                status: "awaiting-label",
                package_status: "packed",
                package_count: 1,
                current_exception_type: null,
                current_exception_notes: null,
                created_at: "2026-04-02T00:00:00.000Z",
                updated_at: "2026-04-02T00:10:01.000Z",
                packing_started_at: null,
                package_prepared_at: "2026-04-02T00:05:00.000Z",
                label_attached_at: null,
                label_voided_at: null,
                cancelled_at: null,
                dispatched_at: null,
                delivered_at: null,
                returned_at: null,
                exception_raised_at: null,
                line_count: 1,
                total_quantity: 1,
              },
            ],
          };
        }
        if (sql.includes("FROM fulfillment_postage_label_operations")) {
          return { rows: [operationDiagnostic] };
        }
        if (sql.includes("FROM fulfillment_postage_provider_events")) {
          return { rows: [providerEventDiagnostic] };
        }
        return { rows: [] };
      }),
    };

    const detail = await getSellerShipment(db as never, "shp_1", "acc_seller");

    expect(detail?.postage_label_operations).toEqual([operationDiagnostic]);
    expect(detail?.postage_provider_events).toEqual([providerEventDiagnostic]);
    const operationSql = queries.find((sql) => sql.includes("FROM fulfillment_postage_label_operations")) ?? "";
    expect(operationSql).toContain("request_json #>>");
    expect(operationSql).not.toContain("sender");
    expect(operationSql).not.toContain("recipient");
    const providerEventSql = queries.find((sql) => sql.includes("FROM fulfillment_postage_provider_events")) ?? "";
    expect(providerEventSql).not.toContain("payload_json");
  });
});
