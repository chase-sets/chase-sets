import { z } from "zod";

// Decoded money responses. Objects stay loose so a field added by a newer Payments API still decodes during a
// rolling deploy; every field listed here is required in the shape it has always had.

const paymentsProviderEventSchema = z.looseObject({
  provider_event_id: z.string(),
  provider_name: z.string(),
  event_kind: z.string(),
  provider_object_reference: z.string().nullable(),
  received_at: z.string(),
});

export const paymentsPaymentDetailSchema = z.looseObject({
  payment_id: z.string(),
  buyer_account_id: z.string(),
  order_ids: z.array(z.string()).readonly(),
  amount: z.string(),
  balance_credit_amount: z.string(),
  processor_amount: z.string(),
  marketplace_sales_fee_amount: z.string(),
  marketplace_checkout_fee_amount: z.string(),
  marketplace_checkout_fee_policy_version: z.string().nullable(),
  marketplace_checkout_fee_quote_fingerprint: z.string().nullable(),
  payment_method_category: z.string().nullable(),
  saved_checkout_instrument_id: z.string().nullable(),
  seller_net_amount: z.string(),
  seller_payout_amount: z.string(),
  seller_payouts: z
    .array(
      z.looseObject({
        orderId: z.string(),
        sellerAccountId: z.string(),
        sellerItemNetAmount: z.string(),
        shippingAllowanceAmount: z.string(),
        sellerShippingPayoutAmount: z.string(),
        sellerPayoutAmount: z.string(),
      }),
    )
    .readonly(),
  currency_code: z.string(),
  processor_name: z.string(),
  processor_payment_kind: z.enum(["checkout-session", "payment-intent", "balance-credit"]),
  processor_payment_reference: z.string(),
  processor_client_secret: z.string().nullable(),
  processor_redirect_url: z.string().nullable(),
  processor_status: z.string(),
  source_context: z.string().nullable(),
  source_reference_id: z.string().nullable(),
  status: z.string(),
  failure_code: z.string().nullable(),
  failure_message: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
  captured_at: z.string().nullable(),
  failed_at: z.string().nullable(),
  cancelled_at: z.string().nullable(),
  processor_publishable_key: z.string().nullable(),
  provider_events: z.array(paymentsProviderEventSchema).readonly(),
});

export type PaymentsPaymentDetail = z.infer<typeof paymentsPaymentDetailSchema>;

const paymentsCheckoutFeeQuoteSchema = z.looseObject({
  payment_method_category: z.enum(["card", "bank-account", "platform-credit"]),
  external_basis_amount: z.string(),
  marketplace_checkout_fee_amount: z.string(),
  marketplace_checkout_fee_reduction_amount: z.string(),
  total_amount: z.string(),
  processor_amount: z.string(),
  policy_version: z.string(),
  quote_fingerprint: z.string(),
  quoted_at: z.string(),
});

export const paymentsCheckoutStatusSchema = z.looseObject({
  order_ids: z.array(z.string()).readonly(),
  currency_code: z.string(),
  amount: z.string(),
  marketplace_checkout_fee: paymentsCheckoutFeeQuoteSchema,
  payment_method_quotes: z.array(paymentsCheckoutFeeQuoteSchema).readonly(),
  wallet_credit: z.looseObject({
    requested_amount: z.string(),
    applied_amount: z.string(),
    external_amount: z.string(),
  }),
  can_start_payment: z.boolean(),
  unavailable_reasons: z.array(z.string()).readonly(),
  unavailable_reason_details: z
    .array(
      z.looseObject({
        code: z.string(),
        message: z.string(),
      }),
    )
    .readonly(),
});

export type PaymentsCheckoutStatus = z.infer<typeof paymentsCheckoutStatusSchema>;

export const paymentsCheckoutRecoveryOptionsSchema = z.looseObject({
  recovery_reference_id: z.string(),
  can_recover: z.boolean(),
  recommended_action: z.enum(["start-payment", "use-existing-payment", "unavailable"]),
  checkout_status: paymentsCheckoutStatusSchema,
});

export type PaymentsCheckoutRecoveryOptions = z.infer<typeof paymentsCheckoutRecoveryOptionsSchema>;

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
  listing_evidence?: readonly Readonly<{
    line_id: string;
    item_title: string;
    gallery: readonly import("../../../support/request-support/listing-evidence").MarketplaceListingPublicGalleryImage[];
  }>[];
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

export type PaymentsProviderEvent = z.infer<typeof paymentsProviderEventSchema>;
