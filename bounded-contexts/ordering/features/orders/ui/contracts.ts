export interface OrderingOrderProjection {
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
  shipping_allowance_amount: string;
  shipping_overage_amount: string;
  shipping_charge_amount: string;
  sales_tax_amount: string;
  total_amount: string;
  marketplace_sales_fee_amount: string;
  seller_net_amount: string;
  seller_item_net_amount: string;
  seller_payout_amount: string;
  shipping_allowance_percentage_bps: number;
  taxable_amount: string;
  tax_jurisdiction_country: string | null;
  tax_jurisdiction_state: string | null;
  tax_rate_bps: number | null;
  tax_provider_name: string | null;
  tax_provider_quote_reference: string | null;
  tax_quoted_at: string | null;
  terms_schedule_id: string | null;
  terms_agreement_id: string | null;
  terms_resolved_at: string;
  status: string;
  created_at: string;
  updated_at: string;
  cancelled_at: string | null;
  cancellation_reason: string | null;
  ready_for_fulfillment_at: string | null;
  line_count: number;
  total_quantity: number;
}

export interface OrderingOrderProjectionLine {
  line_id: string;
  listing_id: string;
  inventory_item_id: string;
  catalog_catalog_item_id: string;
  product_id: string;
  item_title: string;
  item_subtitle: string | null;
  selected_options: readonly { dimensionId: string; optionId: string }[];
  product_summary: string | null;
  unit_price_amount: string;
  quantity: number;
  line_total_amount: string;
  marketplace_sales_fee_unit_amount: string;
  marketplace_sales_fee_total_amount: string;
  seller_net_unit_amount: string;
  seller_net_total_amount: string;
}

export interface OrderingOrderProjectionHold {
  hold_id: string;
  inventory_item_id: string;
  seller_account_id: string;
  quantity: number;
  status: string;
  created_at: string;
  released_at: string | null;
}

export interface OrderingOrderProjectionDetail extends OrderingOrderProjection {
  lines: readonly OrderingOrderProjectionLine[];
  inventory_holds: readonly OrderingOrderProjectionHold[];
}

export interface PurchaseListItem extends OrderingOrderProjection {}
export interface PurchaseDetail extends OrderingOrderProjectionDetail {}
export interface SaleListItem extends OrderingOrderProjection {}
export interface SaleDetail extends OrderingOrderProjectionDetail {}
