import { describe, expect, it } from "vitest";
import {
  returnLabelCostPayerForFlow,
  returnLabelRemedyIdForSupportRequest,
  returnShipmentIdForSupportRequest,
} from "./support-return-label-policy";

describe("support return-label policy", () => {
  it.each(["product-not-as-described", "product-damaged", "wrong-product-received", "authenticity-concern"])(
    "charges seller-fault flow %s to the seller",
    (flowType) => {
      expect(returnLabelCostPayerForFlow(flowType)).toBe("seller");
    },
  );

  it("deducts buyer-remorse return postage from the buyer refund", () => {
    expect(returnLabelCostPayerForFlow("return-request")).toBe("buyer");
  });

  it("rejects flows that do not authorize automatic return labels", () => {
    expect(() => returnLabelCostPayerForFlow("product-not-received")).toThrow(
      "does not authorize an automatic return label",
    );
  });

  it("derives stable return and authorization ids from the support case", () => {
    expect(returnShipmentIdForSupportRequest("sup_01JZ6DKP7S7Z4AZ5N5E6K7M8N9")).toBe("rsh_01JZ6DKP7S7Z4AZ5N5E6K7M8N9");
    expect(returnLabelRemedyIdForSupportRequest("sup_01JZ6DKP7S7Z4AZ5N5E6K7M8N9")).toBe(
      "rmd_01JZ6DKP7S7Z4AZ5N5E6K7M8N9",
    );
  });
});
