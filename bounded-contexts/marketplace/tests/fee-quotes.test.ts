import { describe, expect, it } from "vitest";
import {
  createFeeQuoteFingerprint,
  openMarketplaceListingTermsSession,
  quoteMarketplaceTerms,
  quotePublicStandardMarketplaceTerms,
} from "../support/runtime-support/fee-quotes";

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
        openListingTermsSession: async () => {
          throw new Error("A listing-terms session should not be opened for a public standard preview.");
        },
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

describe("marketplace listing-terms session (m113 #4327 per-account terms session)", () => {
  /**
   * A fake resolver that computes the same 8.50% + $0.10 fee formula
   * whether asked per-listing (`resolveListingTerms`) or via a session
   * (`openListingTermsSession`), and counts how many times each is called
   * -- the round-trip-reduction proof this ticket's ACs ask for.
   */
  function fakeSessionResolver() {
    let resolveListingTermsCalls = 0;
    let openSessionCalls = 0;

    function quoteAmount(accountId: string, priceAmount: string) {
      const cents = Math.round(Number(priceAmount) * 100);
      const feeCents = Math.ceil(cents * 0.085) + 10;
      const feeAmount = (feeCents / 100).toFixed(2);
      const netAmount = ((cents - feeCents) / 100).toFixed(2);

      return {
        accountId,
        accountType: "business" as const,
        basisAmount: priceAmount,
        marketplaceSalesFeeUnitAmount: feeAmount,
        sellerNetUnitAmount: netAmount,
        shippingAllowancePercentageBps: 500,
        scheduleId: "cts_fake",
        agreementId: null,
        resolvedAt: "2026-07-09T00:00:00.000Z",
      };
    }

    return {
      counts: () => ({ resolveListingTermsCalls, openSessionCalls }),
      resolver: {
        resolveListingTerms: async ({ accountId, amount }: { accountId: string; amount: string }) => {
          resolveListingTermsCalls += 1;
          return quoteAmount(accountId, amount);
        },
        resolveOrderTerms: async () => {
          throw new Error("Order terms should not be used.");
        },
        resolvePublicStandardListingTerms: async () => {
          throw new Error("Public standard terms should not be used.");
        },
        openListingTermsSession: async ({ accountId }: { accountId: string }) => {
          openSessionCalls += 1;
          return {
            accountId,
            accountType: "business" as const,
            scheduleId: "cts_fake",
            agreementId: null,
            resolvedAt: "2026-07-09T00:00:00.000Z",
            quote: (amount: string) => quoteAmount(accountId, amount),
          };
        },
      },
    };
  }

  it("quotes byte-identical fee-quote previews (fingerprint included) to per-price quoteMarketplaceTerms", async () => {
    const { resolver } = fakeSessionResolver();
    const session = await openMarketplaceListingTermsSession(resolver, { accountId: "acc_seller" });

    for (const priceAmount of ["0.10", "1.00", "9.99", "20.00", "199.99", "1000.00"]) {
      const individual = await quoteMarketplaceTerms(resolver, { accountId: "acc_seller", priceAmount });
      const sessionQuote = session.quote(priceAmount);

      expect(sessionQuote).toEqual(individual);
      expect(sessionQuote.fee_quote_fingerprint).toBe(individual.fee_quote_fingerprint);
    }
  });

  it("resolves the account's schedule/agreement once for the whole batch instead of once per listing", async () => {
    const { resolver, counts } = fakeSessionResolver();
    const session = await openMarketplaceListingTermsSession(resolver, { accountId: "acc_seller" });

    for (const priceAmount of ["10.00", "20.00", "30.00", "40.00", "50.00"]) {
      session.quote(priceAmount);
    }

    expect(counts()).toEqual({ resolveListingTermsCalls: 0, openSessionCalls: 1 });
  });
});
