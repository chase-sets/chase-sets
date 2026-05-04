import { describe, expect, it } from "vitest";
import { createFeeQuoteFingerprint } from "../support/runtime-support/fee-quotes";

describe("marketplace fee quote fingerprints", () => {
  it("changes when only the shipping allowance rate changes", () => {
    const baseline = createFeeQuoteFingerprint({
      basis_amount: "20.00",
      marketplace_sales_fee_unit_amount: "1.00",
      seller_net_unit_amount: "19.00",
      shipping_allowance_percentage_bps: 500,
      schedule_id: "cts_default",
      agreement_id: null,
    });
    const changedAllowance = createFeeQuoteFingerprint({
      basis_amount: "20.00",
      marketplace_sales_fee_unit_amount: "1.00",
      seller_net_unit_amount: "19.00",
      shipping_allowance_percentage_bps: 750,
      schedule_id: "cts_default",
      agreement_id: null,
    });

    expect(changedAllowance).not.toBe(baseline);
  });
});
