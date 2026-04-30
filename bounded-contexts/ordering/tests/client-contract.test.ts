import { describe, expectTypeOf, it } from "vitest";
import type { CreateCheckoutOrdersRequest } from "../client";

describe("ordering client request contracts", () => {
  it("types checkout order creation requests", () => {
    const request = {
      checkoutSessionId: "chk_1",
      sourceType: "cart-checkout",
      shippingOption: "standard",
      lines: [
        {
          listingId: null,
          cartLineId: "cli_1",
          catalogItemId: "cat_1",
          productId: "cat_1::",
          itemTitle: "Pikachu",
          itemSubtitle: null,
          selectedOptions: [],
          productSummary: null,
          quantity: 1,
        },
      ],
    } satisfies CreateCheckoutOrdersRequest;

    expectTypeOf(request).toMatchTypeOf<CreateCheckoutOrdersRequest>();
  });
});
