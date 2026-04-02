export interface OrderingOrderListItem {
  order_id: string;
  source_type: string;
  source_reference_id: string | null;
  buyer_account_id: string;
  buyer_display_name: string | null;
  seller_account_id: string;
  seller_display_name: string | null;
  shipping_option: string;
  item_subtotal_amount: string;
  shipping_base_amount: string;
  shipping_discount_amount: string;
  shipping_charge_amount: string;
  total_amount: string;
  status: string;
  created_at: string;
  updated_at: string;
  cancelled_at: string | null;
  ready_for_fulfillment_at: string | null;
  line_count: number;
  total_quantity: number;
}

export interface OrderingOrderLine {
  line_id: string;
  listing_id: string;
  inventory_record_id: string;
  catalog_item_id: string;
  catalog_version_key: string;
  item_title: string;
  item_subtitle: string | null;
  version_selection: readonly { dimensionId: string; choiceId: string }[];
  version_summary: string | null;
  unit_price_amount: string;
  quantity: number;
  line_total_amount: string;
}

export interface OrderingOrderHold {
  hold_id: string;
  inventory_record_id: string;
  seller_account_id: string;
  quantity: number;
  status: string;
  created_at: string;
  released_at: string | null;
}

export interface OrderingOrderDetail extends OrderingOrderListItem {
  lines: readonly OrderingOrderLine[];
  inventory_holds: readonly OrderingOrderHold[];
}
