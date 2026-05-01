export interface PaymentsPaymentDetail {
  payment_id: string;
  buyer_account_id: string;
  order_ids: readonly string[];
  amount: string;
  balance_credit_amount: string;
  processor_amount: string;
  marketplace_fee_amount: string;
  payment_fee_amount: string;
  seller_net_amount: string;
  currency_code: string;
  processor_name: string;
  processor_payment_kind: "checkout-session" | "payment-intent" | "balance-credit";
  processor_payment_reference: string;
  processor_client_secret: string | null;
  processor_redirect_url: string | null;
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
  provider_events: readonly PaymentsProviderEvent[];
}

export interface PaymentsCheckoutStatus {
  order_ids: readonly string[];
  currency_code: string;
  amount: string;
  wallet_credit: {
    requested_amount: string;
    applied_amount: string;
    external_amount: string;
  };
  can_start_payment: boolean;
  unavailable_reasons: readonly string[];
  unavailable_reason_details: readonly {
    code: string;
    message: string;
  }[];
}

export interface PaymentsCheckoutRecoveryOptions {
  recovery_reference_id: string;
  can_recover: boolean;
  recommended_action: "start-payment" | "use-existing-payment" | "unavailable";
  checkout_status: PaymentsCheckoutStatus;
}

export interface PaymentsProviderEvent {
  provider_event_id: string;
  provider_name: string;
  event_kind: string;
  provider_object_reference: string | null;
  received_at: string;
}
