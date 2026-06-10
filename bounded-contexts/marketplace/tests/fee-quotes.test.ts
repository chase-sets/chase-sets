import { describe, expect, it } from "vitest";
import { createFeeQuoteFingerprint, quotePublicStandardMarketplaceTerms } from "../support/runtime-support/fee-quotes";

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

describe("marketplace public standard terms previews", () => {
  it("maps Commercial Terms standard schedule output to display-safe public fields", async () => {
    const preview = await quotePublicStandardMarketplaceTerms(
      {
        resolveListingTerms: async () => {
          throw new Error("Account-specific listing terms should not be used.");
        },
        resolveOrderTerms: async () => {
          throw new Error("Order terms should not be used.");
        },
        resolvePublicStandardListingTerms: async () => ({
          accountType: "personal",
          basisAmount: "380.00",
          marketplaceSalesFeeUnitAmount: "34.35",
          sellerNetUnitAmount: "345.65",
          shippingAllowancePercentageBps: 500,
          scheduleId: "cts_seed_personal_default",
          scheduleLabel: "Personal Default",
          scheduleUpdatedAt: "2026-04-16T10:00:00.000Z",
          resolvedAt: "2026-05-05T16:36:36.000Z",
        }),
      },
      { priceAmount: "380.00" },
    );

    expect(preview).toEqual({
      account_type: "personal",
      basis_amount: "380.00",
      marketplace_sales_fee_unit_amount: "34.35",
      seller_net_unit_amount: "345.65",
      shipping_allowance_percentage_bps: 500,
      source_kind: "public-standard-seller-terms",
      source_label: "Standard seller terms",
      schedule_label: "Personal Default",
      source_updated_at: "2026-04-16T10:00:00.000Z",
      resolved_at: "2026-05-05T16:36:36.000Z",
    });
    expect(preview).not.toHaveProperty("fee_quote_fingerprint");
    expect(preview).not.toHaveProperty("schedule_id");
    expect(preview).not.toHaveProperty("agreement_id");
  });
});
