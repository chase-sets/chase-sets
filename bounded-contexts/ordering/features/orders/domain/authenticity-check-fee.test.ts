import { describe, expect, it } from "vitest";
import {
  defaultAuthenticityCheckFeePolicyValue,
  quoteAuthenticityCheckFee,
  type AuthenticityCheckFeePolicyValue,
} from "./authenticity-check-fee";

describe("quoteAuthenticityCheckFee", () => {
  it("is not eligible below the opt-in threshold", () => {
    const quote = quoteAuthenticityCheckFee({ orderValueAmount: "99.99" });
    expect(quote.eligible).toBe(false);
    expect(quote.fee_amount).toBe("0.00");
  });

  it("is eligible at the opt-in threshold and quotes flat + percentage", () => {
    const quote = quoteAuthenticityCheckFee({ orderValueAmount: "100.00" });
    expect(quote.eligible).toBe(true);
    // $8.00 flat + 2% of $100.00 = $8.00 + $2.00 = $10.00
    expect(quote.fee_amount).toBe("10.00");
  });

  it("caps the fee at the band's cap amount for high order values", () => {
    const quote = quoteAuthenticityCheckFee({ orderValueAmount: "10000.00" });
    expect(quote.eligible).toBe(true);
    expect(quote.fee_amount).toBe("50.00");
  });

  it("produces a stable fingerprint for identical inputs", () => {
    const first = quoteAuthenticityCheckFee({ orderValueAmount: "250.00", quotedAt: "2026-07-10T00:00:00.000Z" });
    const second = quoteAuthenticityCheckFee({ orderValueAmount: "250.00", quotedAt: "2026-07-10T00:00:00.000Z" });
    expect(first.quote_fingerprint).toBe(second.quote_fingerprint);
  });

  it("changes the fingerprint when the order value changes", () => {
    const first = quoteAuthenticityCheckFee({ orderValueAmount: "250.00" });
    const second = quoteAuthenticityCheckFee({ orderValueAmount: "260.00" });
    expect(first.quote_fingerprint).not.toBe(second.quote_fingerprint);
  });

  it("changes the fingerprint when the policy changes even at the same order value (staleness detection)", () => {
    const original = quoteAuthenticityCheckFee({ orderValueAmount: "250.00" });
    const revisedPolicy: AuthenticityCheckFeePolicyValue = {
      optInThresholdAmount: "100.00",
      bands: [
        { minOrderValueAmount: "0.00", category: "any", flatAmount: "12.00", percentageBps: 300, capAmount: "60.00" },
      ],
    };
    const revised = quoteAuthenticityCheckFee({ orderValueAmount: "250.00" }, revisedPolicy);
    expect(original.quote_fingerprint).not.toBe(revised.quote_fingerprint);
    expect(original.fee_amount).not.toBe(revised.fee_amount);
  });

  it("resolves category-specific bands layered above an any-category floor", () => {
    const policy: AuthenticityCheckFeePolicyValue = {
      optInThresholdAmount: "100.00",
      bands: [
        { minOrderValueAmount: "0.00", category: "any", flatAmount: "8.00", percentageBps: 200, capAmount: "50.00" },
        {
          minOrderValueAmount: "0.00",
          category: "graded",
          flatAmount: "15.00",
          percentageBps: 150,
          capAmount: "75.00",
        },
      ],
    };

    const rawQuote = quoteAuthenticityCheckFee({ orderValueAmount: "100.00", category: "raw" }, policy);
    const gradedQuote = quoteAuthenticityCheckFee({ orderValueAmount: "100.00", category: "graded" }, policy);

    // raw falls back to the "any" band: $8 + 2% of $100 = $10.00
    expect(rawQuote.fee_amount).toBe("10.00");
    // graded matches its own band: $15 + 1.5% of $100 = $16.50
    expect(gradedQuote.fee_amount).toBe("16.50");
  });

  it("prefers the highest matching minimum order value band", () => {
    const policy: AuthenticityCheckFeePolicyValue = {
      optInThresholdAmount: "100.00",
      bands: [
        { minOrderValueAmount: "0.00", category: "any", flatAmount: "8.00", percentageBps: 200, capAmount: "50.00" },
        {
          minOrderValueAmount: "1000.00",
          category: "any",
          flatAmount: "15.00",
          percentageBps: 100,
          capAmount: "75.00",
        },
      ],
    };

    const belowTier = quoteAuthenticityCheckFee({ orderValueAmount: "500.00" }, policy);
    const atTier = quoteAuthenticityCheckFee({ orderValueAmount: "1000.00" }, policy);

    expect(belowTier.fee_amount).toBe("18.00");
    expect(atTier.fee_amount).toBe("25.00");
  });

  it("is not eligible when no band matches the category and order value", () => {
    const policy: AuthenticityCheckFeePolicyValue = {
      optInThresholdAmount: "0.00",
      bands: [
        { minOrderValueAmount: "0.00", category: "graded", flatAmount: "8.00", percentageBps: 200, capAmount: "50.00" },
      ],
    };

    const quote = quoteAuthenticityCheckFee({ orderValueAmount: "100.00", category: "raw" }, policy);
    expect(quote.eligible).toBe(false);
    expect(quote.fee_amount).toBe("0.00");
  });

  it("uses the compiled launch default when no policy is supplied", () => {
    const quote = quoteAuthenticityCheckFee({ orderValueAmount: "100.00" });
    const withDefault = quoteAuthenticityCheckFee(
      { orderValueAmount: "100.00" },
      defaultAuthenticityCheckFeePolicyValue,
    );
    expect(quote).toEqual(withDefault);
  });
});
