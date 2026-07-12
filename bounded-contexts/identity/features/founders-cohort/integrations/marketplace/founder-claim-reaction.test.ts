import { describe, expect, it, vi } from "vitest";
import { buildFounderClaimReactionHandlers } from "./founder-claim-reaction";

const eventBase = {
  tenantId: "tnt_test",
  audit: { performedByUserId: "usr_test", forAccountId: "acc_test" },
  trace: {},
  timing: { occurredAt: "2026-07-12T12:00:00.000Z", recordedAt: "2026-07-12T12:00:01.000Z" },
};

describe("founder claim marketplace reaction", () => {
  it("claims for the account that creates a listing", async () => {
    const claim = vi.fn();
    const handlers = buildFounderClaimReactionHandlers(claim);
    await handlers["marketplace.listing.created"]!({
      ...eventBase,
      data: { listingId: "lst_1", accountId: "acc_seller" },
    } as never);

    expect(claim).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: "acc_seller", qualifyingActType: "listing-created" }),
      expect.any(Object),
    );
  });

  it("claims only for the account that makes an offer, never the account receiving it", async () => {
    const claim = vi.fn();
    const handlers = buildFounderClaimReactionHandlers(claim);
    await handlers["marketplace.offer.submitted"]!({
      ...eventBase,
      data: { offerId: "ofr_1", buyerAccountId: "acc_maker", sellerAccountId: "acc_receiver" },
    } as never);

    expect(claim).toHaveBeenCalledOnce();
    expect(claim).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: "acc_maker", qualifyingActType: "offer-submitted" }),
      expect.any(Object),
    );
    expect(claim).not.toHaveBeenCalledWith(expect.objectContaining({ accountId: "acc_receiver" }), expect.anything());
  });
});
