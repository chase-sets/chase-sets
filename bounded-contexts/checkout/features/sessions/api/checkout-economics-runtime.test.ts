import { describe, expect, it } from "vitest";

import { CheckoutDomainError } from "../../../support/runtime-support/common";
import {
  assertNoUnsupportedCustomerEconomicsInput,
  findUnsupportedCustomerEconomicsInput,
  unsupportedCustomerEconomicsInputCode,
  unsupportedCustomerEconomicsInputKeys,
  unsupportedCustomerEconomicsInputMessage,
} from "./checkout-economics-runtime";

describe("checkout economics runtime", () => {
  it("detects customer-entered promo, discount, gift-card, and credit input keys", () => {
    for (const key of unsupportedCustomerEconomicsInputKeys) {
      expect(findUnsupportedCustomerEconomicsInput({ [key]: "SAVE10" }), key).toBe(key);
    }
  });

  it("ignores absent and empty unsupported economics placeholders", () => {
    for (const value of [undefined, null, "", "   ", false, [], {}]) {
      expect(findUnsupportedCustomerEconomicsInput({ promoCode: value }), String(value)).toBeNull();
    }

    expect(findUnsupportedCustomerEconomicsInput(null)).toBeNull();
    expect(findUnsupportedCustomerEconomicsInput(["SAVE10"])).toBeNull();
  });

  it("throws a launch-domain error for unsupported customer economics input", () => {
    expect(() => assertNoUnsupportedCustomerEconomicsInput({ gift_card_code: "GC123" })).toThrow(CheckoutDomainError);

    try {
      assertNoUnsupportedCustomerEconomicsInput({ gift_card_code: "GC123" });
    } catch (error) {
      expect(error).toBeInstanceOf(CheckoutDomainError);
      expect((error as CheckoutDomainError).code).toBe(unsupportedCustomerEconomicsInputCode);
      expect((error as Error).message).toBe(unsupportedCustomerEconomicsInputMessage);
    }
  });
});
