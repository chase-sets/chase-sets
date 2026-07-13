export interface PaymentsPaymentDetail {
  payment_id: string;
  buyer_account_id: string;
  order_ids: readonly string[];
  amount: string;
  balance_credit_amount: string;
  processor_amount: string;
  marketplace_sales_fee_amount: string;
  marketplace_checkout_fee_amount: string;
  marketplace_checkout_fee_policy_version: string | null;
  marketplace_checkout_fee_quote_fingerprint: string | null;
  payment_method_category: string | null;
  saved_checkout_instrument_id: string | null;
  seller_net_amount: string;
  seller_payout_amount: string;
  seller_payouts: readonly {
    orderId: string;
    sellerAccountId: string;
    sellerItemNetAmount: string;
    shippingAllowanceAmount: string;
    sellerShippingPayoutAmount: string;
    sellerPayoutAmount: string;
  }[];
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
  marketplace_checkout_fee: {
    payment_method_category: "card" | "bank-account" | "platform-credit";
    external_basis_amount: string;
    marketplace_checkout_fee_amount: string;
    marketplace_checkout_fee_reduction_amount: string;
    total_amount: string;
    processor_amount: string;
    policy_version: string;
    quote_fingerprint: string;
    quoted_at: string;
  };
  payment_method_quotes: readonly {
    payment_method_category: "card" | "bank-account" | "platform-credit";
    external_basis_amount: string;
    marketplace_checkout_fee_amount: string;
    marketplace_checkout_fee_reduction_amount: string;
    total_amount: string;
    processor_amount: string;
    policy_version: string;
    quote_fingerprint: string;
    quoted_at: string;
  }[];
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

export interface PaymentsAccountOrderInput {
  order_id: string;
  buyer_account_id: string;
  buyer_email: string | null;
  shipping_destination_snapshot: {
    name: string;
    line1: string;
    line2?: string | null;
    city: string;
    state: string;
    postalCode: string;
    country: string;
    email?: string | null;
  } | null;
  seller_account_id: string;
  sales_tax_amount: string;
  total_amount: string;
  marketplace_sales_fee_amount: string;
  marketplace_checkout_fee_amount: string;
  seller_net_amount: string;
  seller_item_net_amount: string;
  shipping_allowance_amount: string;
  shipping_overage_amount: string;
  seller_shipping_payout_amount: string;
  seller_payout_amount: string;
  shipping_allowance_percentage_bps: number;
  terms_schedule_id: string | null;
  terms_agreement_id: string | null;
  terms_resolved_at: string;
  status: string;
  pending_payment_at: string | null;
  payment_deadline_at: string | null;
  payment_deadline_policy: string | null;
}

export interface PaymentsMarketplaceCheckoutFeePolicy {
  policy_version: string;
  effective_at: string;
  enabled_jurisdictions: readonly string[];
  base: {
    percentage_bps: number;
    fixed_amount: string;
  };
  method_adjustments: readonly {
    payment_method_category: "card" | "bank-account" | "platform-credit";
    percentage_bps_delta: number;
    fixed_amount_delta: string;
    resulting_percentage_bps: number;
    resulting_fixed_amount: string;
  }[];
  unsupported_methods_default: "no-positive-fee";
  quote_audit: {
    confirmation_required: boolean;
    stale_response_code: number;
    stale_response_error: string;
    snapshot_fields: readonly string[];
  };
}

export interface PaymentsProviderEvent {
  provider_event_id: string;
  provider_name: string;
  event_kind: string;
  provider_object_reference: string | null;
  received_at: string;
}
