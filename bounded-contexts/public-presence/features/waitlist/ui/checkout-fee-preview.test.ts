import { describe, expect, it } from "vitest";
import { centsToMoneyAmount } from "@chase-sets/primitives/money";
import { formatMoney } from "@chase-sets/localization";
import {
  buildCheckoutFeePreview,
  checkoutFeePreviewSampleOrderCents,
  checkoutFeeTranslationValues,
  compiledCheckoutProcessingTerms,
  fallbackCheckoutFeePreview,
  selectCheckoutProcessingTerms,
} from "./checkout-fee-preview";
import { publicPresenceT as t } from "./public-presence-translator";

describe("checkout fee preview", () => {
  it("derives the ratified card passthrough presentation with integer-cents gross-up math", () => {
    // Independent BigInt-cents recomputation of the Payments gross-up
    // (fee covers its own processing, ceil rounding): the $83.88 sample
    // basis carries a $2.82 card fee, never a float approximation.
    const { itemCents, shippingCents, taxCents } = checkoutFeePreviewSampleOrderCents;
    const basisCents = itemCents + shippingCents + taxCents;
    const numerator = basisCents * 290n + 30n * 10_000n;
    const denominator = 10_000n - 290n;
    const expectedFeeCents = (numerator + denominator - 1n) / denominator;

    expect(basisCents).toBe(8388n);
    expect(expectedFeeCents).toBe(282n);
    expect(fallbackCheckoutFeePreview).toEqual({
      cardRate: "2.9%",
      cardFixed: "$0.30",
      bankRate: "0.5%",
      bankFixed: "$0.00",
      cardFeeAmount: formatMoney(centsToMoneyAmount(expectedFeeCents), "USD"),
      cardTotalAmount: formatMoney(centsToMoneyAmount(basisCents + expectedFeeCents), "USD"),
      balanceTotalAmount: formatMoney(centsToMoneyAmount(basisCents), "USD"),
    });
    expect(fallbackCheckoutFeePreview.cardFeeAmount).toBe("$2.82");
    expect(fallbackCheckoutFeePreview.cardTotalAmount).toBe("$86.70");
    expect(fallbackCheckoutFeePreview.balanceTotalAmount).toBe("$83.88");
  });

  // The product-preview sample order left the landing page with #8503; the
  // FAQ fees answer is the surviving public surface these values interpolate.
  it("states the checkout-fee answer concretely -- no fee is only 'quoted before payment' (#3951)", () => {
    const values = checkoutFeeTranslationValues(fallbackCheckoutFeePreview);
    const copy = t("publicPresence.faq.fees.answer", values);

    expect(copy).not.toContain("{checkout");
    expect(copy.toLowerCase()).not.toContain("quoted before payment");
    expect(copy).toContain("2.9% + $0.30 by card");
    expect(copy).toContain("0.5% by bank account");
  });

  it("selects the whitelisted checkout processing terms and rejects malformed reads", () => {
    const preview = buildCheckoutFeePreview(
      selectCheckoutProcessingTerms({
        "checkout-processing-fee.card.bps": { value: 320 },
        "checkout-processing-fee.card.fixed": { value: "0.25" },
        "checkout-processing-fee.bank-account.bps": { value: 80 },
        "checkout-processing-fee.bank-account.fixed": { value: "0.10" },
      }),
    );

    expect(preview.cardRate).toBe("3.2%");
    expect(preview.cardFixed).toBe("$0.25");
    expect(preview.bankRate).toBe("0.8%");
    expect(preview.bankFixed).toBe("$0.10");

    expect(() => selectCheckoutProcessingTerms({})).toThrowError(/checkout-processing-fee.card.bps/);
    expect(() =>
      selectCheckoutProcessingTerms({
        "checkout-processing-fee.card.bps": { value: 290 },
        "checkout-processing-fee.card.fixed": { value: 0.3 },
        "checkout-processing-fee.bank-account.bps": { value: 50 },
        "checkout-processing-fee.bank-account.fixed": { value: "0.00" },
      }),
    ).toThrowError(/checkout-processing-fee.card.fixed/);
  });

  it("matches the compiled launch terms ratified for the v1 processing passthrough", () => {
    expect(compiledCheckoutProcessingTerms).toEqual({
      card: { percentageBps: 290, fixedAmount: "0.30" },
      bankAccount: { percentageBps: 50, fixedAmount: "0.00" },
    });
  });
});
