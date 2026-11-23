import { afterEach, describe, expect, it, vi } from "vitest";
import { quoteAuthenticityCheckFee, type AuthenticityCheckFeePolicyValue } from "./authenticity-check-fee";

// The policy value these tests quote against unless a test states its own: offered from $100.00,
// $8.00 plus 2% of the order value, capped at $50.00.
const quotedPolicy: AuthenticityCheckFeePolicyValue = {
  optInThresholdAmount: "100.00",
  bands: [{ minOrderValueAmount: "0.00", category: "any", flatAmount: "8.00", percentageBps: 200, capAmount: "50.00" }],
};

describe("quoteAuthenticityCheckFee", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("is not eligible below the opt-in threshold", () => {
    const quote = quoteAuthenticityCheckFee({ orderValueAmount: "99.99" }, quotedPolicy);
    expect(quote.eligible).toBe(false);
    expect(quote.fee_amount).toBe("0.00");
  });

  it("is eligible at the opt-in threshold and quotes flat + percentage", () => {
    const quote = quoteAuthenticityCheckFee({ orderValueAmount: "100.00" }, quotedPolicy);
    expect(quote.eligible).toBe(true);
    // $8.00 flat + 2% of $100.00 = $8.00 + $2.00 = $10.00
    expect(quote.fee_amount).toBe("10.00");
  });

  it("caps the fee at the band's cap amount for high order values", () => {
    const quote = quoteAuthenticityCheckFee({ orderValueAmount: "10000.00" }, quotedPolicy);
    expect(quote.eligible).toBe(true);
    expect(quote.fee_amount).toBe("50.00");
  });

  it("produces a stable fingerprint for identical inputs", () => {
    const params = { orderValueAmount: "250.00", quotedAt: "2026-07-10T00:00:00.000Z" };
    const first = quoteAuthenticityCheckFee(params, quotedPolicy);
    const second = quoteAuthenticityCheckFee(params, quotedPolicy);
    expect(first.quote_fingerprint).toBe(second.quote_fingerprint);
  });

  it("changes the fingerprint when the order value changes", () => {
    const first = quoteAuthenticityCheckFee({ orderValueAmount: "250.00" }, quotedPolicy);
    const second = quoteAuthenticityCheckFee({ orderValueAmount: "260.00" }, quotedPolicy);
    expect(first.quote_fingerprint).not.toBe(second.quote_fingerprint);
  });

  it("changes the fingerprint when the policy changes even at the same order value (staleness detection)", () => {
    const original = quoteAuthenticityCheckFee({ orderValueAmount: "250.00" }, quotedPolicy);
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

  it("declares the policy value as a required parameter and exports no policy value of its own", async () => {
    expect(quoteAuthenticityCheckFee.length).toBe(2);

    const exported = await import("./authenticity-check-fee");
    for (const value of Object.values(exported)) {
      expect(value).not.toEqual(expect.objectContaining({ bands: expect.anything() }));
    }
  });

  it("quotes the same decision for the same policy value and stamps each quote with the current time", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-10T00:00:00.000Z"));
    const { quoted_at: firstQuotedAt, ...first } = quoteAuthenticityCheckFee(
      { orderValueAmount: "100.00" },
      quotedPolicy,
    );
    vi.advanceTimersByTime(1);
    const { quoted_at: secondQuotedAt, ...second } = quoteAuthenticityCheckFee(
      { orderValueAmount: "100.00" },
      quotedPolicy,
    );
    expect(first).toEqual(second);
    expect(new Date(firstQuotedAt).toISOString()).toBe(firstQuotedAt);
    expect(new Date(secondQuotedAt).toISOString()).toBe(secondQuotedAt);
    expect(Date.parse(secondQuotedAt) - Date.parse(firstQuotedAt)).toBe(1);
  });
});
