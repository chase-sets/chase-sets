import type { AddressSnapshot } from "@chase-sets/primitives/address-snapshot";
import type { PackagePlan } from "@chase-sets/product-measures";

export interface FulfillmentLabelAddressOverrideAudit {
  recorded_at: string;
  changed_side: string;
  reason: string;
  actor: string;
  original_sender_snapshot: AddressSnapshot;
  submitted_sender_address: AddressSnapshot;
  original_recipient_snapshot: AddressSnapshot;
  submitted_recipient_address: AddressSnapshot;
}

export interface FulfillmentPostageLabelOperationDiagnostic {
  operation_key: string;
  operation_kind: string;
  provider_name: string;
  provider_mode: string;
  status: string;
  requested_service_level: string | null;
  requested_delivery_confirmation: string | null;
  requested_insurance_amount: string | null;
  requested_label_size: string | null;
  requested_mailpiece_class: string | null;
  requested_weight_ounces: string | null;
  address_override_changed_side: string | null;
  address_override_reason: string | null;
  policy_version: string | null;
  parcel_required: string | null;
  signature_required: string | null;
  insurance_required: string | null;
  insured_value_amount: string | null;
  shipping_evidence_tier: string | null;
  provider_shipment_id: string | null;
  provider_label_id: string | null;
  tracking_identifier: string | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export interface FulfillmentPostageProviderEventDiagnostic {
  provider_event_id: string;
  provider_name: string;
  provider_mode: string;
  event_kind: string;
  provider_object_reference: string | null;
  tracking_identifier: string | null;
  status: string;
  status_detail: string | null;
  processing_result: string | null;
  occurred_at: string;
  received_at: string;
}

export interface FulfillmentShipmentListItem {
  shipment_id: string;
  order_id: string;
  buyer_account_id: string;
  buyer_display_name: string | null;
  seller_account_id: string;
  seller_display_name: string | null;
  shipping_option: string;
  shipping_destination_snapshot: AddressSnapshot;
  shipping_origin_snapshot: AddressSnapshot | null;
  shipping_plan_snapshot: PackagePlan | null;
  shipping_method: string | null;
  carrier_name: string | null;
  display_reference: string;
  label_reference: string | null;
  label_document_url: string | null;
  tracking_identifier: string | null;
  postage_provider_name: string | null;
  postage_provider_mode: string | null;
  postage_provider_shipment_id: string | null;
  postage_provider_label_id: string | null;
  postage_rate_id: string | null;
  postage_service_level: string | null;
  postage_amount_cents: number | null;
  postage_currency: string | null;
  label_status: string;
  label_error_code: string | null;
  label_error_message: string | null;
  label_refund_status: string | null;
  label_refund_reference: string | null;
  status: string;
  package_status: string;
  package_count: number | null;
  current_exception_type: string | null;
  current_exception_notes: string | null;
  created_at: string;
  updated_at: string;
  packing_started_at: string | null;
  package_prepared_at: string | null;
  label_attached_at: string | null;
  label_voided_at: string | null;
  cancelled_at: string | null;
  dispatched_at: string | null;
  delivered_at: string | null;
  returned_at: string | null;
  exception_raised_at: string | null;
  line_count: number;
  total_quantity: number;
}

export interface FulfillmentShipmentLine {
  line_id: string;
  order_line_id: string;
  catalog_catalog_item_id: string;
  product_id: string;
  item_title: string;
  item_subtitle: string | null;
  product_summary: string | null;
  quantity: number;
  packing_confirmed_quantity: number;
  packing_confirmed_at: string | null;
}

export interface FulfillmentShipmentException {
  raised_at: string;
  exception_type: string;
  notes: string | null;
}

export interface FulfillmentShipmentDetail extends FulfillmentShipmentListItem {
  lines: readonly FulfillmentShipmentLine[];
  exceptions: readonly FulfillmentShipmentException[];
  address_override_audits: readonly FulfillmentLabelAddressOverrideAudit[];
  postage_label_operations: readonly FulfillmentPostageLabelOperationDiagnostic[];
  postage_provider_events: readonly FulfillmentPostageProviderEventDiagnostic[];
}

export type FulfillmentPackingSlipFormat = "letter" | "thermal-4x6";

export type FulfillmentPackingSlip = FulfillmentShipmentDetail;

export interface FulfillmentPackingSlipBatch {
  items: readonly FulfillmentPackingSlip[];
  count: number;
}
