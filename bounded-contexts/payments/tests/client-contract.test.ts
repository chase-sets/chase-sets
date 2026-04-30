import { describe, expectTypeOf, it } from "vitest";
import type { CreateBuyerPaymentRequest } from "../client";

describe("payments client request contracts", () => {
  it("types checkout-sourced buyer payment requests", () => {
    const request = {
      orderIds: ["ord_1"],
      sourceContext: "checkout",
      sourceReferenceId: "chk_1",
    } satisfies CreateBuyerPaymentRequest;

    expectTypeOf(request).toMatchTypeOf<CreateBuyerPaymentRequest>();
  });
});
