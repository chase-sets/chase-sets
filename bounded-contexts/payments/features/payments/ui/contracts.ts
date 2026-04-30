export interface PaymentsPaymentDetail {
  payment_id: string;
  buyer_account_id: string;
  order_ids: readonly string[];
  amount: string;
  marketplace_fee_amount: string;
  payment_fee_amount: string;
  seller_net_amount: string;
  currency_code: string;
  processor_name: string;
  processor_payment_reference: string;
  processor_client_secret: string | null;
  processor_status: string;
  source_context: string | null;
  source_reference_id: string | null;
  status: string;
  failure_code: string | null;
  failure_message: string | null;
  created_at: string;
  updated_at: string;
  captured_at: string | null;
  failed_at: string | null;
  cancelled_at: string | null;
  processor_publishable_key: string | null;
}
