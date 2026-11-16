import { describe, expect, it } from "vitest";

import {
  getCheckoutSellOfferMatch,
  getLatestSellListConfirmation,
  getSellPayoutReadiness,
  listSellListLines,
} from "./queries";
import { checkoutOwnerRuntimeFixture, fixtureLine } from "../api/owner-read.fixture";

describe("sell list confirmation queries", () => {
  it.each([1, "1", "2"])("compares normalized selected Offer and line versions: %s", async (version) => {
    const f = checkoutOwnerRuntimeFixture();
    f.setLines([{ ...fixtureLine, offer_stream_version: "1" as never, listing_stream_version: "1" as never }]);
    f.setOfferStreamVersion(version);
    const review = await f.services.loadCompositeReview("acc_seller");
    expect(review.offerReviews).toEqual([
      expect.objectContaining({ status: version === "2" ? "unavailable" : "ready" }),
    ]);
  });
  it.each(["bad", "9007199254740992"])("refuses malformed or unsafe Offer page versions: %s", async (version) => {
    const f = checkoutOwnerRuntimeFixture();
    f.setOfferStreamVersion(version);
    await expect(f.services.loadCompositeReview("acc_seller")).rejects.toThrow("Invalid Sell List stream version.");
  });
  it.each([null, 1, "1", "9007199254740991"])("normalizes nullable safe stream versions: %s", async (version) => {
    const db = {
      query: async () => ({
        rows: [{ ...fixtureLine, offer_stream_version: version, listing_stream_version: version }],
      }),
    };
    const [line] = await listSellListLines(db, "acc_seller");
    expect(line).toMatchObject({
      offer_stream_version: version === null ? null : Number(version),
      listing_stream_version: version === null ? null : Number(version),
    });
  });
  it.each(["9007199254740992", "bad", "", "1.5", "-1", 0])(
    "refuses malformed or unsafe stream versions: %s",
    async (version) => {
      for (const column of ["offer_stream_version", "listing_stream_version"]) {
        const db = { query: async () => ({ rows: [{ ...fixtureLine, [column]: version }] }) };
        await expect(listSellListLines(db, "acc_seller")).rejects.toThrow("Invalid Sell List stream version.");
      }
    },
  );
  it("uses the Checkout offer page stream fence for Sell List Matches", async () => {
    const queriedSql: string[] = [];
    const db = {
      query: async (sql: string) => {
        queriedSql.push(sql);
        return { rows: [] };
      },
    };

    await expect(getCheckoutSellOfferMatch(db, "acc_seller", "off_1")).resolves.toBeNull();
    expect(queriedSql[0]).toContain("offer.last_stream_version > 0");
    expect(queriedSql[0]).not.toContain("offer.offer_stream_version > 0");
  });

  it("reads only fresh confirmation pages", async () => {
    const queriedSql: string[] = [];
    const db = {
      query: async (sql: string) => {
        queriedSql.push(sql);
        return {
          rows: [
            {
              seller_account_id: "acc_seller",
              confirmation_id: "slc_1",
              confirmed_at: "2026-06-09T00:00:00.000Z",
              readiness_evidence: { snapshotId: "slr_ready" },
              seller_evidence: { shipFrom: { status: "ready" } },
              handoff_summary: { acceptedOfferCount: 1 },
            },
          ],
        };
      },
    };

    await expect(getLatestSellListConfirmation(db, "acc_seller")).resolves.toEqual({
      seller_account_id: "acc_seller",
      confirmation_id: "slc_1",
      confirmed_at: "2026-06-09T00:00:00.000Z",
      readiness_evidence: { snapshotId: "slr_ready" },
      seller_evidence: { shipFrom: { status: "ready" } },
      handoff_summary: { acceptedOfferCount: 1 },
    });
    expect(queriedSql.join("\n")).toContain("checkout_sell_list_confirmation_pages");
    expect(queriedSql.join("\n")).not.toContain("checkout_sell_list_execution_pages");
    expect(queriedSql.join("\n")).not.toContain("checkout_sell_list_receipt_pages");
  });

  it("does not query old receipt tables when no confirmation exists", async () => {
    const queriedSql: string[] = [];
    const db = {
      query: async (sql: string) => {
        queriedSql.push(sql);
        return { rows: [] };
      },
    };

    await expect(getLatestSellListConfirmation(db, "acc_seller")).resolves.toBeNull();
    expect(queriedSql).toHaveLength(1);
    expect(queriedSql[0]).toContain("checkout_sell_list_confirmation_pages");
    expect(queriedSql[0]).not.toContain("checkout_sell_list_execution_pages");
    expect(queriedSql[0]).not.toContain("checkout_sell_list_receipt_pages");
  });

  it("reads Checkout-owned sell payout readiness rows", async () => {
    const db = {
      query: async () => ({
        rows: [
          {
            account_id: "acc_seller",
            status: "restricted",
            missing_requirements: ["external_account"],
            updated_at: "2026-06-09T00:00:00.000Z",
          },
        ],
      }),
    };

    await expect(getSellPayoutReadiness(db, "acc_seller")).resolves.toEqual({
      account_id: "acc_seller",
      status: "restricted",
      missing_requirements: ["external_account"],
      updated_at: "2026-06-09T00:00:00.000Z",
    });
  });

  it("returns setup-required payout readiness when no local row exists yet", async () => {
    const db = {
      query: async () => ({ rows: [] }),
    };

    await expect(getSellPayoutReadiness(db, "acc_seller")).resolves.toEqual({
      account_id: "acc_seller",
      status: "not-started",
      missing_requirements: ["provider-onboarding", "seller-agreement"],
      updated_at: null,
    });
  });
});
