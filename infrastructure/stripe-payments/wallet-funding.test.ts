import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createStripePaymentProcessorGateway } from "./index";

const gateway = () =>
  createStripePaymentProcessorGateway({
    secretKey: "sk_test_synthetic",
    publishableKey: "pk_test_synthetic",
    webhookSecret: "whsec_synthetic",
    apiBaseUrl: "https://stripe.synthetic.test",
  });
const response = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
afterEach(() => vi.unstubAllGlobals());

describe("wallet funding Stripe contract (synthetic responses only)", () => {
  it("uses a card-only on-session PaymentIntent with funding metadata and 3DS any", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      response({ id: "pi_synthetic", client_secret: "synthetic-secret", status: "requires_confirmation" }),
    );
    vi.stubGlobal("fetch", fetch);
    await gateway().createPaymentSession({
      paymentId: "wfp_synthetic",
      buyerAccountId: "acc_synthetic",
      orderIds: [],
      amount: "10.61",
      currencyCode: "usd",
      paymentMethodCategory: "card",
      purpose: "wallet-funding",
      description: "Wallet Funding Payment",
      idempotencyKey: "synthetic-create",
      cardAuthentication: { requestThreeDSecure: "any", reasonCodes: ["wallet-funding"] },
      marketplaceRiskMetadata: { purpose: "wallet-funding" },
    });
    const [url, init] = fetch.mock.calls[0];
    expect(String(url)).toContain("/v1/payment_intents");
    const form = new URLSearchParams(String(init?.body));
    expect(form.get("amount")).toBe("1061");
    expect(form.get("metadata[purpose]")).toBe("wallet-funding");
    expect(form.get("payment_method_options[card][request_three_d_secure]")).toBe("any");
    expect(form.get("payment_method_types[0]")).toBe("card");
    expect(form.has("payment_method_types[1]")).toBe(false);
    expect(form.has("transfer_data[destination]")).toBe(false);
  });
  it.each(["pending", "failed", "canceled", "succeeded"])(
    "preserves %s refund webhook status and correlation",
    async (status) => {
      const timestamp = Math.floor(Date.now() / 1000);
      const rawBody = JSON.stringify({
        id: "evt_synthetic",
        type: "refund.updated",
        created: timestamp,
        data: {
          object: {
            id: "re_synthetic",
            status,
            payment_intent: "pi_synthetic",
            amount: 200,
            currency: "usd",
            metadata: { payment_id: "wfp_synthetic", refund_id: "wfr_synthetic", purpose: "wallet-funding" },
          },
        },
      });
      const signatureHeader = `t=${timestamp},v1=${createHmac("sha256", "whsec_synthetic").update(`${timestamp}.${rawBody}`).digest("hex")}`;
      const event = await gateway().parseWebhook({ rawBody, signatureHeader });
      expect(event).toMatchObject({
        internalPaymentId: "wfp_synthetic",
        processorRefundReference: "re_synthetic",
        refundId: "wfr_synthetic",
        processorStatus: status,
        amount: "2.00",
      });
    },
  );
  it("looks up the exact refund and refuses a wrong funding identity", async () => {
    const refund = {
      id: "re_synthetic",
      status: "succeeded",
      payment_intent: "pi_synthetic",
      amount: 200,
      currency: "usd",
      metadata: { payment_id: "wfp_synthetic", refund_id: "wfr_synthetic", purpose: "wallet-funding" },
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => response({ data: [refund], has_more: false })),
    );
    const input = {
      fundingId: "wfp_synthetic" as const,
      refundId: "wfr_synthetic",
      processorPaymentReference: "pi_synthetic",
      processorRefundReference: null,
    };
    expect(await gateway().retrieveWalletFundingRefund!(input)).toMatchObject({
      amount: "2.00",
      status: "succeeded",
      processorRefundReference: "re_synthetic",
    });
    expect(await gateway().retrieveWalletFundingRefund!({ ...input, fundingId: "wfp_wrong" })).toBeNull();
  });
});
