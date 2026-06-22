import { beforeEach, describe, expect, it, vi } from "vitest";
import { createCheckoutOrdersThroughOrdering } from "../support/request-support/checkout-confirmation";

const mockPreviewCheckoutFulfillment = vi.fn();
const mockCreateCheckoutOrders = vi.fn();

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
    status = 400;
    body = {};
  },
  createMarketplaceRequestApiClient: () => ({}),
}));

describe("checkout confirmation support", () => {
  beforeEach(() => {
    mockPreviewCheckoutFulfillment.mockReset();
    mockCreateCheckoutOrders.mockReset();
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
});
