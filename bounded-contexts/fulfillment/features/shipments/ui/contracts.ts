export interface FulfillmentShipmentListItem {
  shipment_id: string;
  order_id: string;
  buyer_account_id: string;
  buyer_display_name: string | null;
  seller_account_id: string;
  seller_display_name: string | null;
  shipping_option: string;
  shipping_method: string | null;
  carrier_name: string | null;
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
  package_prepared_at: string | null;
  label_attached_at: string | null;
  label_voided_at: string | null;
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
}

export interface FulfillmentShipmentException {
  raised_at: string;
  exception_type: string;
  notes: string | null;
}

export interface FulfillmentShipmentDetail extends FulfillmentShipmentListItem {
  lines: readonly FulfillmentShipmentLine[];
  exceptions: readonly FulfillmentShipmentException[];
}
