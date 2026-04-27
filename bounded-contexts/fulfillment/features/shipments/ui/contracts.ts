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
  tracking_identifier: string | null;
  status: string;
  package_status: string;
  package_count: number | null;
  current_exception_type: string | null;
  current_exception_notes: string | null;
  created_at: string;
  updated_at: string;
  package_prepared_at: string | null;
  label_attached_at: string | null;
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
