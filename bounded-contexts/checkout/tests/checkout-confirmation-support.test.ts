import { describe, expect, it, vi } from "vitest";
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
  it("forwards the fresh fulfillment preview revision when the client does not submit one", async () => {
    mockPreviewCheckoutFulfillment.mockResolvedValue({
      revision: "preview_policy_v2",
      readyLineKeys: ["cli_1"],
    });
    mockCreateCheckoutOrders.mockResolvedValue({
      orderIds: ["ord_1"],
    });

    await createCheckoutOrdersThroughOrdering(new Request("https://checkout.test/checkout/buy/session/chk_1"), {
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
    } as never);

    expect(mockCreateCheckoutOrders).toHaveBeenCalledWith(
      expect.objectContaining({
        checkoutSessionId: "chk_1",
        fulfillmentPreviewRevision: "preview_policy_v2",
      }),
    );
  });
});
