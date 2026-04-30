import { describe, expectTypeOf, it } from "vitest";
import type { CreateAccountPaymentRequest } from "../client";

describe("payments client request contracts", () => {
  it("types checkout-sourced buyer payment requests", () => {
    const request = {
      orderIds: ["ord_1"],
      sourceContext: "checkout",
      sourceReferenceId: "chk_1",
    } satisfies CreateAccountPaymentRequest;

    expectTypeOf(request).toMatchTypeOf<CreateAccountPaymentRequest>();
  });
});
