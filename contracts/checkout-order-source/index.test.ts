import { describe, expect, it } from "vitest";
import {
  checkoutOrderCreationSources,
  checkoutOrderSourceContract,
  checkoutSessionSourceCreatesOrders,
  parseCheckoutOrderingSourceType,
  toOrderingSourceForCheckoutOrderCreation,
  type CheckoutOrderCreationSourceType,
} from ".";

describe("checkout to ordering source contract", () => {
  it("maps Checkout cart source to Ordering cart-checkout source", () => {
    expect(toOrderingSourceForCheckoutOrderCreation("cart")).toBe("cart-checkout");
  });

  it("keeps Buy Now source stable across Checkout and Ordering", () => {
    expect(toOrderingSourceForCheckoutOrderCreation("buy-now")).toBe("buy-now");
  });

  it("keeps offer intent out of Checkout-created orders", () => {
    expect(checkoutSessionSourceCreatesOrders("offer-intent")).toBe(false);
    expect(checkoutOrderSourceContract.offerIntent).toMatchObject({
      checkoutSessionSource: "offer-intent",
      orderingOrderSource: null,
      commitmentOwner: "marketplace-offer-acceptance",
    });
  });

  it("only exposes Checkout sources that are allowed to create orders", () => {
    const checkoutOrderSources = checkoutOrderCreationSources satisfies readonly CheckoutOrderCreationSourceType[];

    expect(checkoutOrderSources).toEqual(["cart", "buy-now"]);
    expect(checkoutOrderSources).not.toContain("offer-intent");
  });

  it("parses only committed checkout sources at the Ordering boundary", () => {
    expect(parseCheckoutOrderingSourceType("cart-checkout")).toBe("cart-checkout");
    expect(parseCheckoutOrderingSourceType("buy-now")).toBe("buy-now");
    expect(() => parseCheckoutOrderingSourceType("offer-intent")).toThrow(
      "Ordering checkout source must be cart-checkout or buy-now.",
    );
    expect(() => parseCheckoutOrderingSourceType("cart")).toThrow(
      "Ordering checkout source must be cart-checkout or buy-now.",
    );
  });
});
