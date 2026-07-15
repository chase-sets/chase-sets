import { describe, expect, it } from "vitest";
import {
  MARKETPLACE_SALES_FEE_SCHEDULE_LAUNCH_POLICY_VALUE,
  decodeMarketplaceSalesFeeSchedulePolicyValue,
  quoteMarketplaceSalesFee,
} from "./policy";

describe("marketplace sales fee schedule policy", () => {
  it("declares the single ratified launch schedule", () => {
    expect(MARKETPLACE_SALES_FEE_SCHEDULE_LAUNCH_POLICY_VALUE).toEqual({
      label: "Standard seller terms",
      marketplaceSalesFeePercentageBps: 500,
      marketplaceSalesFeeFixedAmount: "0.00",
      marketplaceSalesFeeCapAmount: "25.00",
      shippingAllowancePercentageBps: 500,
    });
  });

  it.each([
    ["5.00", "0.25"],
    ["100.00", "5.00"],
    ["500.00", "25.00"],
    ["1000.00", "25.00"],
  ])("quotes %s at %s", (basisAmount, expectedFee) => {
    expect(quoteMarketplaceSalesFee(basisAmount, MARKETPLACE_SALES_FEE_SCHEDULE_LAUNCH_POLICY_VALUE)).toBe(expectedFee);
  });

  it("normalizes money values as decimal strings", () => {
    expect(
      decodeMarketplaceSalesFeeSchedulePolicyValue({
        ...MARKETPLACE_SALES_FEE_SCHEDULE_LAUNCH_POLICY_VALUE,
        marketplaceSalesFeeFixedAmount: "0",
        marketplaceSalesFeeCapAmount: "25",
      }),
    ).toMatchObject({ marketplaceSalesFeeFixedAmount: "0.00", marketplaceSalesFeeCapAmount: "25.00" });
  });

  it("rejects policy money values above the shared money ceiling", () => {
    expect(() =>
      decodeMarketplaceSalesFeeSchedulePolicyValue({
        ...MARKETPLACE_SALES_FEE_SCHEDULE_LAUNCH_POLICY_VALUE,
        marketplaceSalesFeeFixedAmount: "10000000000.00",
      }),
    ).toThrow();
  });
});
