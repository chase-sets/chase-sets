import { describe, expect, it } from "vitest";
import {
  checkoutOrderCreationSources,
  checkoutOrderSourceContract,
  checkoutSourceContractMatrix,
  checkoutSourceContractMatrixSourceTypes,
  checkoutSessionSourceCreatesOrders,
  parseCheckoutOrderingSourceType,
  toOrderingSourceForCheckoutOrderCreation,
  type CheckoutOrderCreationSourceType,
  type CheckoutSourceContractMatrixSourceType,
} from ".";

describe("checkout to ordering source contract", () => {
  it("names all checkout source contract matrix source types", () => {
    const sourceTypes =
      checkoutSourceContractMatrixSourceTypes satisfies readonly CheckoutSourceContractMatrixSourceType[];

    expect(sourceTypes).toEqual([
      "locked-listing-direct-buy-now",
      "product-level-cart-line",
      "accepted-offer",
      "offer-intent",
      "sell-list-selected-offer-line",
      "sell-list-product-line",
    ]);
    expect(Object.values(checkoutSourceContractMatrix).map((entry) => entry.sourceType)).toEqual(sourceTypes);
  });

  it("documents ownership, ordering, and session readiness for every source", () => {
    expect(checkoutSourceContractMatrix).toMatchObject({
      lockedListingBuyNow: {
        sourceOwner: "marketplace",
        checkoutSessionSource: "buy-now",
        sessionReadinessPosture: "requires-marketplace-locked-listing-before-session",
        orderingOrderSource: "buy-now",
        orderingPosture: "checkout-session-confirmation",
      },
      productLevelCartLine: {
        sourceOwner: "checkout",
        checkoutSessionSource: "cart",
        sessionReadinessPosture: "requires-cart-readiness-before-session",
        orderingOrderSource: "cart-checkout",
        orderingPosture: "checkout-session-confirmation",
      },
      acceptedOffer: {
        sourceOwner: "marketplace",
        checkoutSessionSource: null,
        sessionReadinessPosture: "accepted-offer-commits-through-marketplace",
        orderingOrderSource: "offer-acceptance",
        orderingPosture: "marketplace-accepted-offer",
      },
      offerIntent: {
        sourceOwner: "checkout",
        checkoutSessionSource: "offer-intent",
        sessionReadinessPosture: "requires-marketplace-offer-submission-before-commitment",
        orderingOrderSource: null,
        orderingPosture: "not-an-ordering-source",
      },
      sellListSelectedOfferLine: {
        sourceOwner: "marketplace",
        checkoutSessionSource: null,
        sessionReadinessPosture: "requires-sell-list-readiness-and-marketplace-offer-evidence",
        orderingOrderSource: null,
        orderingPosture: "sell-list-readiness-only",
      },
      sellListProductLine: {
        sourceOwner: "checkout",
        checkoutSessionSource: null,
        sessionReadinessPosture: "requires-sell-list-readiness-and-marketplace-listing-evidence",
        orderingOrderSource: null,
        orderingPosture: "sell-list-readiness-only",
      },
    });
  });

  it("keeps accepted offers Marketplace-owned and outside Checkout sessions", () => {
    expect(checkoutSourceContractMatrix.acceptedOffer).toMatchObject({
      sourceOwner: "marketplace",
      checkoutSessionSource: null,
      orderingOrderSource: "offer-acceptance",
    });
  });

  it("makes sell-list readiness expectations visible without making them Checkout session sources", () => {
    expect(checkoutSourceContractMatrix.sellListSelectedOfferLine).toMatchObject({
      sourceOwner: "marketplace",
      checkoutSessionSource: null,
      sessionReadinessPosture: "requires-sell-list-readiness-and-marketplace-offer-evidence",
      orderingOrderSource: null,
    });
    expect(checkoutSourceContractMatrix.sellListProductLine).toMatchObject({
      sourceOwner: "checkout",
      checkoutSessionSource: null,
      sessionReadinessPosture: "requires-sell-list-readiness-and-marketplace-listing-evidence",
      orderingOrderSource: null,
    });
  });

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
