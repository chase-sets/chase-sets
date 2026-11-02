import { describe, expect, it } from "vitest";
import { getMutationResultCommandReceipt, getResponseMetadata } from "@chase-sets/http/responses";
import { createPaymentsApiClient, PaymentsApiError, PaymentsApiResponseError } from "../client";

type PaymentsApiClient = ReturnType<typeof createPaymentsApiClient>;

const clientSecret = "pi_8845_sentinel_secret_do_not_echo";

const feeQuote = {
  payment_method_category: "card",
  external_basis_amount: "24.99",
  marketplace_checkout_fee_amount: "1.06",
  marketplace_checkout_fee_reduction_amount: "0.00",
  total_amount: "26.05",
  processor_amount: "26.05",
  policy_version: "marketplace-checkout-fee-v1",
  quote_fingerprint: "marketplace-checkout-fee-v1|card|24.99|0.00|24.99|1.06|26.05|26.05",
  quoted_at: "2026-04-01T00:00:00.000Z",
};

const sellerPayout = {
  orderId: "ord_1",
  sellerAccountId: "acc_seller",
  sellerItemNetAmount: "23.49",
  shippingAllowanceAmount: "0.00",
  sellerShippingPayoutAmount: "0.00",
  sellerPayoutAmount: "23.49",
};

function paymentDetail(): Record<string, unknown> {
  return {
    payment_id: "pay_1",
    buyer_account_id: "acc_buyer",
    order_ids: ["ord_1"],
    amount: "24.99",
    balance_credit_amount: "0.00",
    processor_amount: "24.99",
    marketplace_sales_fee_amount: "1.00",
    marketplace_checkout_fee_amount: "1.06",
    marketplace_checkout_fee_policy_version: "marketplace-checkout-fee-v1",
    marketplace_checkout_fee_quote_fingerprint: feeQuote.quote_fingerprint,
    payment_method_category: "card",
    saved_checkout_instrument_id: null,
    seller_net_amount: "23.49",
    seller_payout_amount: "23.49",
    seller_payouts: [sellerPayout],
    currency_code: "usd",
    processor_name: "stripe",
    processor_payment_kind: "payment-intent",
    processor_payment_reference: "pi_8845",
    processor_client_secret: clientSecret,
    processor_redirect_url: null,
    processor_status: "requires_payment_method",
    source_context: null,
    source_reference_id: null,
    status: "pending-confirmation",
    failure_code: null,
    failure_message: null,
    created_at: "2026-04-01T00:00:00.000Z",
    updated_at: "2026-04-01T00:00:00.000Z",
    captured_at: null,
    failed_at: null,
    cancelled_at: null,
    processor_publishable_key: "pk_test_8845",
    provider_events: [
      {
        provider_event_id: "evt_1",
        provider_name: "stripe",
        event_kind: "payment_intent.created",
        provider_object_reference: "pi_8845",
        received_at: "2026-04-01T00:00:00.000Z",
      },
    ],
  };
}

function checkoutStatus(): Record<string, unknown> {
  return {
    order_ids: ["ord_1"],
    currency_code: "usd",
    amount: "24.99",
    marketplace_checkout_fee: feeQuote,
    payment_method_quotes: [feeQuote],
    wallet_credit: { requested_amount: "0.00", applied_amount: "0.00", external_amount: "24.99" },
    can_start_payment: true,
    unavailable_reasons: [],
    unavailable_reason_details: [],
  };
}

function recoveryOptions(): Record<string, unknown> {
  return {
    recovery_reference_id: "rcv_1",
    can_recover: true,
    recommended_action: "start-payment",
    checkout_status: checkoutStatus(),
  };
}

const orderIds = ["ord_1"];

// The six decoded endpoints, each with a valid 2xx body and a body-level mutation that plants the secret.
const decodedEndpoints: readonly Readonly<{
  name: string;
  status: number;
  call: (client: PaymentsApiClient) => Promise<unknown>;
  body: () => Record<string, unknown>;
}>[] = [
  {
    name: "createAccountPayment",
    status: 201,
    call: (client) => client.createAccountPayment({ orderIds }),
    body: paymentDetail,
  },
  { name: "getAccountPayment", status: 200, call: (client) => client.getAccountPayment("pay_1"), body: paymentDetail },
  {
    name: "recoverCheckoutPayment",
    status: 201,
    call: (client) => client.recoverCheckoutPayment({ orderIds }),
    body: paymentDetail,
  },
  {
    name: "getCheckoutStatus",
    status: 200,
    call: (client) => client.getCheckoutStatus({ orderIds }),
    body: checkoutStatus,
  },
  {
    name: "previewCheckoutStatus",
    status: 200,
    call: (client) => client.previewCheckoutStatus({ amount: "24.99" }),
    body: checkoutStatus,
  },
  {
    name: "getCheckoutRecoveryOptions",
    status: 200,
    call: (client) => client.getCheckoutRecoveryOptions({ orderIds }),
    body: recoveryOptions,
  },
];

function clientReturning(status: number, body: string, headers: Record<string, string> = {}) {
  return createPaymentsApiClient({
    baseUrl: "http://payments.test/api/marketplace",
    fetch: async () => new Response(body, { status, headers: { "Content-Type": "application/json", ...headers } }),
  });
}

function malformedBodies(body: Record<string, unknown>): readonly Readonly<{ label: string; text: string }>[] {
  const [firstKey] = Object.keys(body);
  const missing: Record<string, unknown> = { ...body, processor_client_secret: clientSecret };
  delete missing[firstKey!];
  return [
    { label: "missing required field", text: JSON.stringify(missing) },
    {
      label: "wrong-typed required field",
      text: JSON.stringify({ ...body, processor_client_secret: clientSecret, [firstKey!]: { value: clientSecret } }),
    },
    {
      label: "wrong-typed nested field",
      text: JSON.stringify(
        "seller_payouts" in body
          ? { ...body, seller_payouts: [{ ...sellerPayout, sellerPayoutAmount: 23.49 }] }
          : "checkout_status" in body
            ? {
                ...body,
                checkout_status: { ...checkoutStatus(), payment_method_quotes: [{ ...feeQuote, total_amount: 26.05 }] },
              }
            : { ...body, payment_method_quotes: [{ ...feeQuote, total_amount: 26.05 }] },
      ),
    },
    { label: "non-JSON body", text: `{"processor_client_secret":"${clientSecret}"` },
  ];
}

describe("payments client decoding", () => {
  it("payments client rejects malformed money responses without leaking values", async () => {
    for (const endpoint of decodedEndpoints) {
      for (const malformed of malformedBodies(endpoint.body())) {
        const rejection = await endpoint.call(clientReturning(endpoint.status, malformed.text)).then(
          () => null,
          (caught: unknown) => caught,
        );
        const context = `${endpoint.name}: ${malformed.label}`;

        expect(rejection, context).toBeInstanceOf(PaymentsApiResponseError);
        expect(rejection, context).toBeInstanceOf(PaymentsApiError);
        const error = rejection as PaymentsApiResponseError;
        expect(error.status, context).toBe(502);
        expect(error.body, context).toEqual({
          error: { code: "internal_error", message: "Payments API returned an unexpected response." },
        });
        expect(error.message, context).toBe("Payments API returned an unexpected response.");
        expect(error.issues.length, context).toBeGreaterThan(0);
        for (const issue of error.issues) {
          expect(Object.keys(issue).sort(), context).toEqual(["code", "path"]);
        }
        for (const text of [error.message, JSON.stringify(error.issues), JSON.stringify(error)]) {
          expect(text, context).not.toContain(clientSecret);
        }
      }
    }
  });

  it("payments client decoding preserves response metadata", async () => {
    const consistencyHeaders = {
      "Chase-Sets-Consistency": "read-your-writes",
      "Chase-Sets-Commit-Position": "8845",
      "Chase-Sets-Commit-Event-Ids": "evt_8845_a,evt_8845_b",
    };
    const expectedConsistency = {
      mode: "read-your-writes",
      commitPosition: "8845",
      commitEventIds: ["evt_8845_a", "evt_8845_b"],
    };

    for (const endpoint of decodedEndpoints) {
      const body = { ...endpoint.body(), added_by_a_newer_payments_api: { rolling: true } };
      const decoded = await endpoint.call(clientReturning(endpoint.status, JSON.stringify(body), consistencyHeaders));

      expect(decoded, endpoint.name).toEqual(body);
      expect(getResponseMetadata(decoded)?.consistency, endpoint.name).toMatchObject(expectedConsistency);
      expect(getMutationResultCommandReceipt(decoded), endpoint.name).toMatchObject(expectedConsistency);
    }
  });
});
