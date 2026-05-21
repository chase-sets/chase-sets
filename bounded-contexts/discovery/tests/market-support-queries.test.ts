import { describe, expect, it, vi } from "vitest";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { getDiscoveryPublicAccountBySlug } from "../support/market-support/queries";

describe("discovery public market queries", () => {
  it("hides seller listings when seller listing availability is off", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({
        rows: [
          {
            account_id: "acc_seller",
            seller_slug: "seller",
            seller_display_name: "Seller",
            status: "active",
            average_rating: "4.50",
            review_count: 2,
            updated_at: "2026-05-13T00:00:00.000Z",
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [
          {
            review_id: "rev_1",
            author_account_id: "acc_buyer",
            author_display_name: "Buyer One",
            author_role: "buyer",
            rating: 5,
            feedback: "Packed well and shipped quickly.",
            submitted_at: "2026-05-12T00:00:00.000Z",
            updated_at: "2026-05-12T00:00:00.000Z",
          },
        ],
      });
    const db = { query } as unknown as PgQueryable;

    const account = await getDiscoveryPublicAccountBySlug(db, "seller");

    expect(account?.listings).toEqual([]);
    expect(account?.recent_reviews).toEqual([
      expect.objectContaining({
        review_id: "rev_1",
        feedback: "Packed well and shipped quickly.",
      }),
    ]);
    expect(query.mock.calls[1]?.[0]).toContain("account.seller_listing_availability_status = 'available'");
    expect(query.mock.calls[2]?.[0]).toContain("FROM discovery_market_account_reviews AS review");
  });
});
