import { describe, expect, it, vi } from "vitest";
import { buildTransportEvent } from "@chase-sets/event-core/test-support";
import { omitPrivateOfferResponseFields, publicOfferListResponse } from "../../offers/api/response-shape";
import { buildMarketplaceOfferProjectionHandlers } from "../../offers/read-model/projection";
import { buildBuyerOfferPolicyProjectionHandlers } from "./projection";

describe("private policy serialization and projection isolation", () => {
  it("public demand, seller reads and MCP shared serializers discard policy authority", () => {
    const offer = {
      offer_id: "off_one",
      price_amount: "10.00",
      buyerOfferPolicyId: "bop_private",
      buyer_offer_policy_id: "bop_private",
      authority: { offers: ["off_secret"], adjustmentBps: -2500 },
      preview: { previewId: "secret" },
      maximumUnitItemAmount: "100.00",
      adjustmentBps: -2500,
      itemCommitmentAllowance: "1000.00",
      consumedItemAmount: "20.00",
      remainingItemAllowance: "980.00",
    };
    const expected = { offer_id: "off_one", price_amount: "10.00" };
    expect(omitPrivateOfferResponseFields(offer)).toEqual(expected);
    expect(publicOfferListResponse({ items: [offer], total: 1 })).toEqual({ items: [expected], total: 1 });
  });
  it("public projections see only the Offer version, never private policy authority or membership", async () => {
    const db = { query: vi.fn(async () => ({ rows: [] })) };
    const publicHandlers = buildMarketplaceOfferProjectionHandlers(db);
    for (const name of Object.keys(buildBuyerOfferPolicyProjectionHandlers(db)).filter(
      (name) => name !== "marketplace.offer.buyer-policy-bound",
    ))
      expect(publicHandlers[name]).toBeUndefined();
    await publicHandlers["marketplace.offer.buyer-policy-bound"]!(
      buildTransportEvent(
        "marketplace.offer.buyer-policy-bound",
        { offerId: "off_one", policyId: "bop_private", buyerAccountId: "acc_buyer" },
        { streamVersion: 2 },
      ),
    );
    expect(db.query).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("SET last_stream_version = $2"), [
      "off_one",
      2,
    ]);
  });
});
