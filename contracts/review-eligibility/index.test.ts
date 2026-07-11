import { describe, expect, it } from "vitest";
import { decideReviewEligibility, normalizeResolutionContext, type SupportRequestSnapshot } from "./index";

const DELIVERED_AT = "2026-04-03T00:00:00.000Z";
const RESOLVED_AT = "2026-04-06T00:00:00.000Z";

function resolved(resolutionType: string, flowType: string | null = "product-not-as-described") {
  return {
    status: "resolved",
    resolutionType,
    flowType,
    resolvedAt: RESOLVED_AT,
  } satisfies SupportRequestSnapshot;
}

// The full m85 resolution-class × direction matrix (issue #4266). The m85
// dispute-self-service taxonomy is the source of truth — every resolution
// type it defines appears exactly once below, plus the flow-dependent
// cancel-order split. `buyer` = buyer→seller direction, `seller` =
// seller→buyer direction, `context` = the buyer review's neutral marker.
const matrix: ReadonlyArray<{
  name: string;
  supportRequests: readonly SupportRequestSnapshot[];
  buyer: boolean;
  seller: boolean;
  context: string | null;
}> = [
  {
    name: "no support request",
    supportRequests: [],
    buyer: true,
    seller: true,
    context: null,
  },
  {
    name: "open support request suppresses both directions",
    supportRequests: [{ status: "open", resolutionType: null, flowType: null, resolvedAt: null }],
    buyer: false,
    seller: false,
    context: null,
  },
  {
    name: "cancelled support request restores both directions",
    supportRequests: [{ status: "cancelled", resolutionType: null, flowType: null, resolvedAt: null }],
    buyer: true,
    seller: true,
    context: null,
  },
  {
    name: "no-action restores both directions (includes buyer-at-fault outcomes such as a defeated INR claim)",
    supportRequests: [resolved("no-action")],
    buyer: true,
    seller: true,
    context: null,
  },
  {
    name: "support-reviewed restores both directions",
    supportRequests: [resolved("support-reviewed")],
    buyer: true,
    seller: true,
    context: null,
  },
  {
    name: "replacement restores both directions (transaction made whole and completed by delivery)",
    supportRequests: [resolved("replacement")],
    buyer: true,
    seller: true,
    context: null,
  },
  {
    name: "full-refund restores buyer→seller only, with the refund marker",
    supportRequests: [resolved("full-refund")],
    buyer: true,
    seller: false,
    context: "resolved-via-refund",
  },
  {
    name: "partial-refund restores buyer→seller only, with the refund marker",
    supportRequests: [resolved("partial-refund")],
    buyer: true,
    seller: false,
    context: "resolved-via-refund",
  },
  {
    name: "return-for-refund restores buyer→seller only, with the refund marker",
    supportRequests: [resolved("return-for-refund", "return-request")],
    buyer: true,
    seller: false,
    context: "resolved-via-refund",
  },
  {
    name: "cancel-order via seller-cannot-fulfill (seller-caused) restores buyer→seller only, with the refund marker",
    supportRequests: [resolved("cancel-order", "seller-cannot-fulfill")],
    buyer: true,
    seller: false,
    context: "resolved-via-refund",
  },
  {
    name: "cancel-order via buyer-cancel-request (consensual) restores neither direction",
    supportRequests: [resolved("cancel-order", "buyer-cancel-request")],
    buyer: false,
    seller: false,
    context: null,
  },
  {
    name: "cancel-order with unknown flow (pre-flow_type rows) conservatively restores neither direction",
    supportRequests: [resolved("cancel-order", null)],
    buyer: false,
    seller: false,
    context: null,
  },
];

describe("review eligibility policy", () => {
  describe("resolution class × direction matrix (delivered order)", () => {
    for (const entry of matrix) {
      it(entry.name, () => {
        const decision = decideReviewEligibility({
          deliveredAt: DELIVERED_AT,
          supportRequests: entry.supportRequests,
        });

        expect(decision.buyerToSeller.eligible).toBe(entry.buyer);
        expect(decision.buyerToSeller.resolutionContext).toBe(entry.context);
        expect(decision.buyerToSeller.eligibleAt).toBe(entry.buyer ? DELIVERED_AT : null);
        expect(decision.sellerToBuyer.eligible).toBe(entry.seller);
        expect(decision.sellerToBuyer.resolutionContext).toBeNull();
        expect(decision.sellerToBuyer.eligibleAt).toBe(entry.seller ? DELIVERED_AT : null);
      });
    }
  });

  it("requires a delivered shipment for every restoration except a seller-caused cancellation", () => {
    const undeliveredBenign = decideReviewEligibility({
      deliveredAt: null,
      supportRequests: [resolved("no-action")],
    });
    expect(undeliveredBenign.buyerToSeller.eligible).toBe(false);
    expect(undeliveredBenign.sellerToBuyer.eligible).toBe(false);

    const undeliveredRefund = decideReviewEligibility({
      deliveredAt: null,
      supportRequests: [resolved("full-refund")],
    });
    expect(undeliveredRefund.buyerToSeller.eligible).toBe(false);
    expect(undeliveredRefund.sellerToBuyer.eligible).toBe(false);
  });

  it("keys buyer eligibility to the resolution timestamp when a seller-caused cancellation prevented delivery", () => {
    const decision = decideReviewEligibility({
      deliveredAt: null,
      supportRequests: [resolved("cancel-order", "seller-cannot-fulfill")],
    });

    expect(decision.buyerToSeller).toEqual({
      eligible: true,
      eligibleAt: RESOLVED_AT,
      resolutionContext: "resolved-via-refund",
    });
    expect(decision.sellerToBuyer.eligible).toBe(false);
  });

  it("suppresses both directions while any of multiple support requests is still open", () => {
    const decision = decideReviewEligibility({
      deliveredAt: DELIVERED_AT,
      supportRequests: [
        resolved("no-action"),
        { status: "open", resolutionType: null, flowType: null, resolvedAt: null },
      ],
    });

    expect(decision.buyerToSeller.eligible).toBe(false);
    expect(decision.sellerToBuyer.eligible).toBe(false);
  });

  it("keeps the refund marker and the seller suppression sticky when a later request resolves benignly", () => {
    const decision = decideReviewEligibility({
      deliveredAt: DELIVERED_AT,
      supportRequests: [resolved("full-refund"), resolved("no-action")],
    });

    expect(decision.buyerToSeller).toEqual({
      eligible: true,
      eligibleAt: DELIVERED_AT,
      resolutionContext: "resolved-via-refund",
    });
    expect(decision.sellerToBuyer.eligible).toBe(false);
  });

  it("normalizes unknown resolution contexts to null", () => {
    expect(normalizeResolutionContext("resolved-via-refund")).toBe("resolved-via-refund");
    expect(normalizeResolutionContext("something-else")).toBeNull();
    expect(normalizeResolutionContext(null)).toBeNull();
    expect(normalizeResolutionContext(undefined)).toBeNull();
  });
});
