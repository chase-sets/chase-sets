import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createStripePaymentProcessorGateway } from "./index";
import { STRIPE_API_VERSION } from "@chase-sets/stripe-config";
import type { CreateProcessorPaymentInput } from "@chase-sets/payment-processing";

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

describe("wallet-funding-card-cohort (synthetic responses only, not provider method-selection proof)", () => {
  const intent = { id: "pi_synthetic", client_secret: "synthetic-secret", status: "requires_confirmation" };
  const checkoutSession = {
    id: "cs_synthetic",
    client_secret: "cs_synthetic_secret",
    status: "open",
    payment_status: "unpaid",
  };
  const savedCard = {
    instrumentId: "sci_synthetic_card",
    providerReference: "pm_synthetic_card",
    providerCustomerReference: "cus_synthetic",
    confirmationExperience: "trusted-payment-step" as const,
  };
  // Mirrors the exact request the wallet runtime builds (runtime.ts create -> createPaymentSession).
  const walletRequest = (patch: Partial<CreateProcessorPaymentInput> = {}): CreateProcessorPaymentInput => ({
    paymentId: "wfp_synthetic" as never,
    buyerAccountId: "acc_synthetic" as never,
    orderIds: [],
    purpose: "wallet-funding",
    amount: "10.61",
    currencyCode: "usd",
    paymentMethodCategory: "card",
    description: "Wallet Funding Payment",
    idempotencyKey: "payments:wallet-funding:wfp_synthetic:create",
    cardAuthentication: { requestThreeDSecure: "any", reasonCodes: ["wallet-funding"] },
    marketplaceRiskMetadata: { purpose: "wallet-funding" },
    ...patch,
  });
  async function capture(input: CreateProcessorPaymentInput, body: unknown = intent) {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => response(body));
    vi.stubGlobal("fetch", fetch);
    const created = await gateway().createPaymentSession(input);
    const [url, init] = fetch.mock.calls[0];
    const form = new URLSearchParams(String(init?.body));
    const methodTypes = [...form.keys()]
      .filter((key) => key.startsWith("payment_method_types["))
      .map((key) => form.get(key));
    return {
      created,
      url: String(url),
      headers: new Headers(init?.headers),
      form,
      methodTypes,
      calls: fetch.mock.calls.length,
    };
  }

  it("unsaved wallet create encodes exactly one card method type: no Link, bank or automatic methods", async () => {
    const { created, url, headers, form, methodTypes, calls } = await capture(walletRequest());
    expect(calls).toBe(1);
    expect(url).toBe("https://stripe.synthetic.test/v1/payment_intents");
    expect(headers.get("Stripe-Version")).toBe(STRIPE_API_VERSION);
    expect(headers.get("Idempotency-Key")).toBe("payments:wallet-funding:wfp_synthetic:create");
    expect(methodTypes).toEqual(["card"]);
    expect([...form.keys()].some((key) => key.startsWith("automatic_payment_methods"))).toBe(false);
    expect([...form.values()]).not.toContain("link");
    expect([...form.values()]).not.toContain("us_bank_account");
    expect(form.has("payment_method")).toBe(false);
    expect(form.has("customer")).toBe(false);
    expect(form.has("confirm")).toBe(false);
    expect(form.has("setup_future_usage")).toBe(false);
    expect(form.get("payment_method_options[card][request_three_d_secure]")).toBe("any");
    expect(form.get("metadata[purpose]")).toBe("wallet-funding");
    expect(form.get("metadata[payment_id]")).toBe("wfp_synthetic");
    expect(created).toMatchObject({
      processorPaymentKind: "payment-intent",
      processorPaymentReference: "pi_synthetic",
      processorClientSecret: "synthetic-secret",
      processorRedirectUrl: null,
    });
  });

  it("saved card create keeps the card-only PaymentIntent with the saved card and customer, never the off-session branch", async () => {
    const { created, url, form, methodTypes } = await capture(walletRequest({ savedCheckoutInstrument: savedCard }));
    expect(url).toBe("https://stripe.synthetic.test/v1/payment_intents");
    expect(methodTypes).toEqual(["card"]);
    expect(form.get("payment_method")).toBe("pm_synthetic_card");
    expect(form.get("customer")).toBe("cus_synthetic");
    expect(form.has("confirm")).toBe(false);
    expect(form.has("off_session")).toBe(false);
    expect(form.has("transfer_group")).toBe(false);
    expect(form.get("payment_method_options[card][request_three_d_secure]")).toBe("any");
    expect(form.get("metadata[purpose]")).toBe("wallet-funding");
    expect(created).toMatchObject({ processorPaymentKind: "payment-intent", processorClientSecret: "synthetic-secret" });
  });

  it.each([
    ["a bank-account category", { paymentMethodCategory: "bank-account" as const }],
    ["a platform-credit category", { paymentMethodCategory: "platform-credit" as const }],
    ["a metadata method hint", { marketplaceRiskMetadata: { purpose: "wallet-funding", payment_method_types: "link" } }],
    ["a saved bank reference", { savedCheckoutInstrument: { ...savedCard, providerReference: "pm_synthetic_bank" } }],
  ])("%s under the wallet purpose cannot widen the card-only request", async (_label, patch) => {
    const { url, form, methodTypes } = await capture(walletRequest(patch));
    expect(url).toBe("https://stripe.synthetic.test/v1/payment_intents");
    expect(methodTypes).toEqual(["card"]);
    expect(form.has("payment_method_types[1]")).toBe(false);
    expect([...form.keys()].some((key) => key.startsWith("automatic_payment_methods"))).toBe(false);
    expect(form.has("confirm")).toBe(false);
  });

  it("omitting or misspelling the purpose is the only route to ordinary Checkout, which keeps card and Link for orders", async () => {
    const { purpose: _omitted, ...withoutPurpose } = walletRequest();
    const omitted = await capture(withoutPurpose, checkoutSession);
    expect(omitted.url).toBe("https://stripe.synthetic.test/v1/checkout/sessions");
    expect(omitted.methodTypes).toEqual(["card", "link"]);
    // Risk metadata still spells the purpose, yet metadata alone never selects the card-only branch.
    expect(omitted.form.get("metadata[purpose]")).toBe("wallet-funding");
    vi.unstubAllGlobals();
    const misspelled: CreateProcessorPaymentInput = {
      ...walletRequest(),
      // @ts-expect-error the purpose seam admits only the exact "wallet-funding" literal
      purpose: "Wallet-Funding",
    };
    const drifted = await capture(misspelled, checkoutSession);
    expect(drifted.url).toBe("https://stripe.synthetic.test/v1/checkout/sessions");
    expect(drifted.methodTypes).toEqual(["card", "link"]);
  });

  it("reload retrieves the same PaymentIntent read-only and refuses foreign or non-wallet intents", async () => {
    const walletIntent = {
      ...intent,
      status: "requires_payment_method",
      metadata: { payment_id: "wfp_synthetic", purpose: "wallet-funding" },
    };
    const fetch = vi.fn<typeof globalThis.fetch>(async () => response(walletIntent));
    vi.stubGlobal("fetch", fetch);
    expect(await gateway().retrieveWalletFundingConfirmation!("wfp_synthetic", "pi_synthetic")).toEqual({
      processorName: "stripe",
      processorPaymentKind: "payment-intent",
      processorPaymentReference: "pi_synthetic",
      processorClientSecret: "synthetic-secret",
      processorRedirectUrl: null,
      processorStatus: "requires_payment_method",
    });
    expect(fetch).toHaveBeenCalledOnce();
    const [url, init] = fetch.mock.calls[0];
    expect(String(url)).toBe("https://stripe.synthetic.test/v1/payment_intents/pi_synthetic");
    expect(init?.method).toBe("GET");
    expect(init?.body ?? null).toBeNull();
    for (const foreign of [
      { ...walletIntent, metadata: { payment_id: "wfp_synthetic" } },
      { ...walletIntent, metadata: { payment_id: "wfp_other", purpose: "wallet-funding" } },
      { ...walletIntent, id: "pi_other" },
    ]) {
      vi.stubGlobal("fetch", vi.fn(async () => response(foreign)));
      expect(await gateway().retrieveWalletFundingConfirmation!("wfp_synthetic", "pi_synthetic")).toBeNull();
    }
  });
});
