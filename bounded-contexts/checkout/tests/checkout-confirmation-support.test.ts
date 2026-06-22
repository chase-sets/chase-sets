import { beforeEach, describe, expect, it, vi } from "vitest";
import { MarketplaceApiError } from "@chase-sets/marketplace/server";
import {
  createCheckoutOrdersThroughOrdering,
  submitPurchaseIntentThroughMarketplace,
} from "../support/request-support/checkout-confirmation";

const mockPreviewCheckoutFulfillment = vi.fn();
const mockCreateCheckoutOrders = vi.fn();
const mockCreateSubmittedOffer = vi.fn();

vi.mock("@chase-sets/ordering/server", () => ({
  createOrderingRequestApiClient: () => ({
    previewCheckoutFulfillment: mockPreviewCheckoutFulfillment,
    createCheckoutOrders: mockCreateCheckoutOrders,
  }),
}));

vi.mock("@chase-sets/payments/server", () => ({
  createPaymentsRequestApiClient: () => ({}),
}));

vi.mock("@chase-sets/marketplace/server", () => ({
  MarketplaceApiError: class MarketplaceApiError extends Error {
    status: number;
    body: unknown;

    constructor(status: number, body: unknown) {
      super("Marketplace API request failed.");
      this.status = status;
      this.body = body;
    }
  },
  createMarketplaceRequestApiClient: () => ({
    createSubmittedOffer: mockCreateSubmittedOffer,
  }),
}));

describe("checkout confirmation support", () => {
  beforeEach(() => {
    mockPreviewCheckoutFulfillment.mockReset();
    mockCreateCheckoutOrders.mockReset();
    mockCreateSubmittedOffer.mockReset();
  });

  const cartSession = {
    session_id: "chk_1",
    source_type: "cart",
    shipping_option: "standard",
    shipping_address: {
      name: "Jane Smith",
      line1: "100 Market Street",
      city: "Chicago",
      state: "IL",
      postalCode: "60601",
      country: "US",
    },
    optimization_goal: "lowest-total",
    lines: [
      {
        cartLineId: "cli_1",
        listingId: null,
        catalogItemId: "cat_1",
        productId: "cat_1::",
        itemTitle: "Charizard",
        itemSubtitle: null,
        selectedOptions: [],
        productSummary: null,
        quantity: 1,
      },
    ],
  } as const;

  const offerIntentSession = {
    ...cartSession,
    session_id: "chk_offer_1",
    source_type: "offer-intent",
    lines: [
      {
        cartLineId: null,
        listingId: null,
        catalogItemId: "cat_offer",
        productId: "cat_offer::form:raw",
        itemTitle: "Charizard",
        itemSubtitle: "Base Set",
        selectedOptions: [{ dimensionId: "form", optionId: "raw" }],
        productSummary: "Raw",
        offerPriceAmount: "350.00",
        quantity: 2,
      },
    ],
  } as const;

  it("forwards the fresh fulfillment preview revision when the client does not submit one", async () => {
    mockPreviewCheckoutFulfillment.mockResolvedValue({
      revision: "preview_policy_v2",
      readyLineKeys: ["cli_1"],
    });
    mockCreateCheckoutOrders.mockResolvedValue({
      orderIds: ["ord_1"],
    });

    await createCheckoutOrdersThroughOrdering(
      new Request("https://checkout.test/checkout/buy/session/chk_1"),
      cartSession as never,
    );

    expect(mockCreateCheckoutOrders).toHaveBeenCalledWith(
      expect.objectContaining({
        checkoutSessionId: "chk_1",
        fulfillmentPreviewRevision: "preview_policy_v2",
      }),
    );
  });

  it("maps Checkout cart source to the Ordering cart-checkout source", async () => {
    mockPreviewCheckoutFulfillment.mockResolvedValue({
      revision: "preview_policy_v2",
      readyLineKeys: ["cli_1"],
    });
    mockCreateCheckoutOrders.mockResolvedValue({
      orderIds: ["ord_1"],
    });

    await createCheckoutOrdersThroughOrdering(
      new Request("https://checkout.test/checkout/buy/session/chk_1"),
      cartSession as never,
    );

    expect(mockPreviewCheckoutFulfillment).toHaveBeenCalledWith(
      expect.objectContaining({ sourceType: "cart-checkout" }),
    );
    expect(mockCreateCheckoutOrders).toHaveBeenCalledWith(expect.objectContaining({ sourceType: "cart-checkout" }));
  });

  it("keeps Buy Now source stable when creating Ordering orders", async () => {
    mockPreviewCheckoutFulfillment.mockResolvedValue({
      revision: "preview_policy_v2",
      readyLineKeys: ["cli_1"],
    });
    mockCreateCheckoutOrders.mockResolvedValue({
      orderIds: ["ord_1"],
    });

    await createCheckoutOrdersThroughOrdering(new Request("https://checkout.test/checkout/buy/session/chk_1"), {
      ...cartSession,
      source_type: "buy-now",
    } as never);

    expect(mockPreviewCheckoutFulfillment).toHaveBeenCalledWith(expect.objectContaining({ sourceType: "buy-now" }));
    expect(mockCreateCheckoutOrders).toHaveBeenCalledWith(expect.objectContaining({ sourceType: "buy-now" }));
  });

  it("does not map offer intent directly to Ordering", async () => {
    await expect(
      createCheckoutOrdersThroughOrdering(new Request("https://checkout.test/checkout/buy/session/chk_1"), {
        ...cartSession,
        source_type: "offer-intent",
      } as never),
    ).rejects.toThrow("Offer intent submits a Marketplace offer and does not create orders during checkout.");

    expect(mockPreviewCheckoutFulfillment).not.toHaveBeenCalled();
    expect(mockCreateCheckoutOrders).not.toHaveBeenCalled();
  });

  it("submits offer-intent sessions through Marketplace with the checkout source facts", async () => {
    mockCreateSubmittedOffer.mockResolvedValue({
      id: "off_marketplace_1",
      commandReceipt: { commitPosition: "42" },
    });

    const result = await submitPurchaseIntentThroughMarketplace(
      new Request("https://checkout.test/checkout/buy/session/chk_offer_1"),
      offerIntentSession as never,
    );

    expect(result).toEqual({
      offerId: "off_marketplace_1",
      writeResult: {
        id: "off_marketplace_1",
        commandReceipt: { commitPosition: "42" },
      },
    });
    expect(mockCreateSubmittedOffer).toHaveBeenCalledWith({
      offerId: "off_offer_1",
      catalogItemId: "cat_offer",
      productId: "cat_offer::form:raw",
      itemTitle: "Charizard",
      itemSubtitle: "Base Set",
      selectedOptions: [{ dimensionId: "form", optionId: "raw" }],
      productSummary: "Raw",
      shippingDestinationSnapshot: offerIntentSession.shipping_address,
      priceAmount: "350.00",
      quantityRequested: 2,
    });
    expect(mockPreviewCheckoutFulfillment).not.toHaveBeenCalled();
    expect(mockCreateCheckoutOrders).not.toHaveBeenCalled();
  });

  it("requires shipping destination before submitting purchase intent", async () => {
    await expect(
      submitPurchaseIntentThroughMarketplace(new Request("https://checkout.test/checkout/buy/session/chk_offer_1"), {
        ...offerIntentSession,
        shipping_address: null,
      } as never),
    ).rejects.toThrow("Shipping destination is required before checkout can place purchase intent.");

    expect(mockCreateSubmittedOffer).not.toHaveBeenCalled();
    expect(mockPreviewCheckoutFulfillment).not.toHaveBeenCalled();
    expect(mockCreateCheckoutOrders).not.toHaveBeenCalled();
  });

  it("requires an offer price before submitting purchase intent", async () => {
    await expect(
      submitPurchaseIntentThroughMarketplace(new Request("https://checkout.test/checkout/buy/session/chk_offer_1"), {
        ...offerIntentSession,
        lines: [{ ...offerIntentSession.lines[0], offerPriceAmount: "   " }],
      } as never),
    ).rejects.toThrow("Purchase intent requires an offer price.");

    expect(mockCreateSubmittedOffer).not.toHaveBeenCalled();
    expect(mockPreviewCheckoutFulfillment).not.toHaveBeenCalled();
    expect(mockCreateCheckoutOrders).not.toHaveBeenCalled();
  });

  it("treats already-submitted Marketplace offers as idempotent", async () => {
    mockCreateSubmittedOffer.mockRejectedValue(
      new MarketplaceApiError(400, { error: { message: "Offer has already been submitted." } }),
    );

    await expect(
      submitPurchaseIntentThroughMarketplace(
        new Request("https://checkout.test/checkout/buy/session/chk_offer_1"),
        offerIntentSession as never,
      ),
    ).resolves.toEqual({
      offerId: "off_offer_1",
      writeResult: null,
    });

    expect(mockPreviewCheckoutFulfillment).not.toHaveBeenCalled();
    expect(mockCreateCheckoutOrders).not.toHaveBeenCalled();
  });
});
