import { describe, expect, it } from "vitest";
import { createLocalTaxQuoteResolver } from "../features/tax-quotes/domain/tax-quote";

describe("local tax quote resolver", () => {
  it("quotes configured destination tax and rounds positive fractions up", async () => {
    const resolver = createLocalTaxQuoteResolver([
      {
        country: "US",
        state: "IL",
        rateBps: 625,
        shippingTaxable: true,
      },
    ]);

    const quote = await resolver.quoteTax({
      buyerAccountId: "acc_buyer",
      sellerAccountId: "acc_seller",
      currencyCode: "usd",
      destinationAddress: {
        name: null,
        line1: "1 Main St",
        line2: null,
        city: "Chicago",
        state: "IL",
        postalCode: "60601",
        country: "US",
      },
      itemSubtotalAmount: "10.01",
      shippingAmount: "1.00",
    });

    expect(quote.taxableAmount).toBe("11.01");
    expect(quote.taxAmount).toBe("0.69");
    expect(quote.providerName).toBe("local-stub");
  });

  it("returns exact zero when no rule applies", async () => {
    const quote = await createLocalTaxQuoteResolver().quoteTax({
      buyerAccountId: "acc_buyer",
      sellerAccountId: "acc_seller",
      currencyCode: "usd",
      destinationAddress: {
        name: null,
        line1: "1 Main St",
        line2: null,
        city: "Unknown",
        state: "ZZ",
        postalCode: "00000",
        country: "US",
      },
      itemSubtotalAmount: "10.00",
      shippingAmount: "1.00",
    });

    expect(quote.taxableAmount).toBe("0.00");
    expect(quote.taxAmount).toBe("0.00");
    expect(quote.rateBps).toBe(0);
  });

  it.each(["1e2", "12.999", "12.34abc"])("rejects malformed tax amount %s", async (itemSubtotalAmount) => {
    await expect(
      createLocalTaxQuoteResolver().quoteTax({
        buyerAccountId: "acc_buyer",
        sellerAccountId: "acc_seller",
        currencyCode: "usd",
        destinationAddress: {
          name: null,
          line1: "1 Main St",
          line2: null,
          city: "Unknown",
          state: "ZZ",
          postalCode: "00000",
          country: "US",
        },
        itemSubtotalAmount,
        shippingAmount: "1.00",
      }),
    ).rejects.toThrow("Tax amounts must be non-negative money values.");
  });
});
