import { describe, expect, it } from "vitest";
import {
  defaultMarketplaceCheckoutFeePolicyValue,
  marketplaceCheckoutFeePaymentMethodCategories,
  marketplaceCheckoutFeePolicy,
  normalizeMarketplaceCheckoutFeePaymentMethodCategory,
  quoteMarketplaceCheckoutFee,
  type MarketplaceCheckoutFeePolicyValue,
} from "./marketplace-checkout-fee-policy";

describe("marketplace checkout fee policy", () => {
  it("quotes the canonical card checkout fee fingerprint from the compiled default (no policy passed)", () => {
    expect(
      quoteMarketplaceCheckoutFee({
        orderAmount: "26.00",
        externalBasisAmount: "26.00",
        balanceCreditAmount: "0.00",
        paymentMethodCategory: "card",
        quotedAt: "2026-05-03T00:00:00.000Z",
      }),
    ).toMatchObject({
      payment_method_category: "card",
      marketplace_checkout_fee_amount: "1.09",
      total_amount: "27.09",
      processor_amount: "27.09",
      quote_fingerprint: "marketplace-checkout-fee-v1|card|26.00|0.00|26.00|1.09|27.09|27.09",
    });
  });

  it("quotes byte-identically when the resolved default policy value is passed explicitly", () => {
    expect(
      quoteMarketplaceCheckoutFee(
        {
          orderAmount: "26.00",
          externalBasisAmount: "26.00",
          balanceCreditAmount: "0.00",
          paymentMethodCategory: "card",
          quotedAt: "2026-05-03T00:00:00.000Z",
        },
        defaultMarketplaceCheckoutFeePolicyValue,
      ),
    ).toMatchObject({
      payment_method_category: "card",
      marketplace_checkout_fee_amount: "1.09",
      total_amount: "27.09",
      processor_amount: "27.09",
      quote_fingerprint: "marketplace-checkout-fee-v1|card|26.00|0.00|26.00|1.09|27.09|27.09",
    });
  });

  it("quotes the canonical bank-account and platform-credit checkout fees from the default policy", () => {
    expect(
      quoteMarketplaceCheckoutFee({
        orderAmount: "26.00",
        externalBasisAmount: "26.00",
        balanceCreditAmount: "0.00",
        paymentMethodCategory: "bank-account",
        quotedAt: "2026-05-03T00:00:00.000Z",
      }),
    ).toMatchObject({
      payment_method_category: "bank-account",
      marketplace_checkout_fee_amount: "0.14",
      quote_fingerprint: "marketplace-checkout-fee-v1|bank-account|26.00|0.00|26.00|0.14|26.14|26.14",
    });

    expect(
      quoteMarketplaceCheckoutFee({
        orderAmount: "26.00",
        externalBasisAmount: "0.00",
        balanceCreditAmount: "26.00",
        paymentMethodCategory: "platform-credit",
        quotedAt: "2026-05-03T00:00:00.000Z",
      }),
    ).toMatchObject({
      payment_method_category: "platform-credit",
      marketplace_checkout_fee_amount: "0.00",
      quote_fingerprint: "marketplace-checkout-fee-v1|platform-credit|26.00|26.00|0.00|0.00|26.00|0.00",
    });
  });

  it("normalizes aliases and publishes matching policy categories", () => {
    expect(normalizeMarketplaceCheckoutFeePaymentMethodCategory("bank_account")).toBe("bank-account");
    expect(normalizeMarketplaceCheckoutFeePaymentMethodCategory("credit")).toBe("platform-credit");
    expect(
      marketplaceCheckoutFeePolicy().method_adjustments.map((adjustment) => adjustment.payment_method_category),
    ).toEqual([...marketplaceCheckoutFeePaymentMethodCategories]);
  });

  it("publishes the compiled default policy struct byte-identically", () => {
    expect(marketplaceCheckoutFeePolicy()).toEqual({
      policy_version: "marketplace-checkout-fee-v1",
      effective_at: "2026-05-03T00:00:00.000Z",
      enabled_jurisdictions: ["US"],
      base: { percentage_bps: 290, fixed_amount: "0.30" },
      method_adjustments: [
        {
          payment_method_category: "card",
          percentage_bps_delta: 0,
          fixed_amount_delta: "0.00",
          resulting_percentage_bps: 290,
          resulting_fixed_amount: "0.30",
        },
        {
          payment_method_category: "bank-account",
          percentage_bps_delta: -240,
          fixed_amount_delta: "-0.30",
          resulting_percentage_bps: 50,
          resulting_fixed_amount: "0.00",
        },
        {
          payment_method_category: "platform-credit",
          percentage_bps_delta: -290,
          fixed_amount_delta: "-0.30",
          resulting_percentage_bps: 0,
          resulting_fixed_amount: "0.00",
        },
      ],
      unsupported_methods_default: "no-positive-fee",
      quote_audit: {
        confirmation_required: true,
        stale_response_code: 409,
        stale_response_error: "fee_quote_stale",
        snapshot_fields: [
          "marketplace_checkout_fee_amount",
          "marketplace_checkout_fee_policy_version",
          "marketplace_checkout_fee_quote_fingerprint",
          "payment_method_category",
        ],
      },
    });
  });

  it("publishes a revised policy's resolved effective-at and resulting terms", () => {
    const revisedPolicy: MarketplaceCheckoutFeePolicyValue = {
      enabledJurisdictions: ["US"],
      base: { percentageBps: 250, fixedAmount: "0.25" },
      methodAdjustments: [
        { paymentMethodCategory: "card", percentageBpsDelta: 0, fixedAmountDelta: "0.00" },
        { paymentMethodCategory: "bank-account", percentageBpsDelta: -200, fixedAmountDelta: "-0.25" },
        { paymentMethodCategory: "platform-credit", percentageBpsDelta: -250, fixedAmountDelta: "-0.25" },
      ],
    };

    expect(marketplaceCheckoutFeePolicy(revisedPolicy, { effectiveAt: "2026-08-01T00:00:00.000Z" })).toMatchObject({
      policy_version: "marketplace-checkout-fee-v1",
      effective_at: "2026-08-01T00:00:00.000Z",
      base: { percentage_bps: 250, fixed_amount: "0.25" },
      method_adjustments: [
        expect.objectContaining({ payment_method_category: "card", resulting_percentage_bps: 250 }),
        expect.objectContaining({ payment_method_category: "bank-account", resulting_percentage_bps: 50 }),
        expect.objectContaining({ payment_method_category: "platform-credit", resulting_percentage_bps: 0 }),
      ],
    });
  });

  it("quotes a revised policy's fee and produces a different fingerprint than the default policy", () => {
    const revisedPolicy: MarketplaceCheckoutFeePolicyValue = {
      enabledJurisdictions: ["US"],
      base: { percentageBps: 350, fixedAmount: "0.35" },
      methodAdjustments: [
        { paymentMethodCategory: "card", percentageBpsDelta: 0, fixedAmountDelta: "0.00" },
        { paymentMethodCategory: "bank-account", percentageBpsDelta: -300, fixedAmountDelta: "-0.35" },
        { paymentMethodCategory: "platform-credit", percentageBpsDelta: -350, fixedAmountDelta: "-0.35" },
      ],
    };

    const defaultQuote = quoteMarketplaceCheckoutFee({
      orderAmount: "26.00",
      externalBasisAmount: "26.00",
      balanceCreditAmount: "0.00",
      paymentMethodCategory: "card",
      quotedAt: "2026-05-03T00:00:00.000Z",
    });
    const revisedQuote = quoteMarketplaceCheckoutFee(
      {
        orderAmount: "26.00",
        externalBasisAmount: "26.00",
        balanceCreditAmount: "0.00",
        paymentMethodCategory: "card",
        quotedAt: "2026-05-03T00:00:00.000Z",
      },
      revisedPolicy,
    );

    // Same quote-format version (fingerprint schema is stable across revisions)...
    expect(revisedQuote.policy_version).toBe(defaultQuote.policy_version);
    // ...but a different fee and fingerprint, which is exactly what drives the
    // existing `fee_quote_stale` re-quote flow when a policy revision lands
    // mid-session.
    expect(revisedQuote.marketplace_checkout_fee_amount).not.toBe(defaultQuote.marketplace_checkout_fee_amount);
    expect(revisedQuote.quote_fingerprint).not.toBe(defaultQuote.quote_fingerprint);
  });

  it.each(["1e2", "12.999", "12.34abc", "-0.75"])("rejects malformed checkout fee amount %s", (amount) => {
    expect(() =>
      quoteMarketplaceCheckoutFee({
        orderAmount: amount,
        externalBasisAmount: amount,
        balanceCreditAmount: "0.00",
        paymentMethodCategory: "card",
      }),
    ).toThrow("Checkout amount must be a valid decimal.");
  });
});
