import { describe, expect, it, vi } from "vitest";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { getDiscoveryPublicAccountBySlug } from "../support/market-support/queries";

function activeAccountRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    account_id: "acc_seller",
    seller_slug: "seller",
    seller_display_name: "Seller",
    status: "active",
    created_at: "2026-01-01T00:00:00.000Z",
    average_rating_as_seller: "4.50",
    review_count_as_seller: 2,
    rating_1_count_as_seller: 0,
    rating_2_count_as_seller: 0,
    rating_3_count_as_seller: 0,
    rating_4_count_as_seller: 1,
    rating_5_count_as_seller: 1,
    average_rating_as_buyer: null,
    review_count_as_buyer: 0,
    rating_1_count_as_buyer: 0,
    rating_2_count_as_buyer: 0,
    rating_3_count_as_buyer: 0,
    rating_4_count_as_buyer: 0,
    rating_5_count_as_buyer: 0,
    updated_at: "2026-05-13T00:00:00.000Z",
    ...overrides,
  };
}

describe("discovery public market queries", () => {
  it("hides seller listings when seller listing availability is off", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [activeAccountRow()] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ count: "1" }] })
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
    expect(account?.reviews.total).toBe(1);
    expect(account?.reviews.items).toEqual([
      expect.objectContaining({
        review_id: "rev_1",
        feedback: "Packed well and shipped quickly.",
      }),
    ]);
    expect(query.mock.calls[1]?.[0]).toContain("account.seller_listing_availability_status = 'available'");
    expect(query.mock.calls[2]?.[0]).toContain("FROM discovery_market_account_reviews AS review");
    expect(query.mock.calls[3]?.[0]).toContain("FROM discovery_market_account_reviews AS review");
  });

  it("only counts and returns revealed reviews (double-blind reveal)", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [activeAccountRow()] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ count: "0" }] })
      .mockResolvedValueOnce({ rows: [] });
    const db = { query } as unknown as PgQueryable;

    await getDiscoveryPublicAccountBySlug(db, "seller");

    expect(query.mock.calls[2]?.[0]).toContain("revealed_at IS NOT NULL");
    expect(query.mock.calls[3]?.[0]).toContain("revealed_at IS NOT NULL");
  });

  it("filters the review list by the inverted author role for a role dimension", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [activeAccountRow()] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ count: "0" }] })
      .mockResolvedValueOnce({ rows: [] });
    const db = { query } as unknown as PgQueryable;

    // "As seller" reviews were authored by buyers reviewing this account in
    // the seller role -- the inversion rule (a review's author_role is the
    // AUTHOR's role, never the subject's).
    await getDiscoveryPublicAccountBySlug(db, "seller", { reviewRole: "seller" });

    expect(query.mock.calls[2]?.[0]).toContain("author_role = $2");
    expect(query.mock.calls[2]?.[1]).toEqual(["acc_seller", "buyer"]);
    expect(query.mock.calls[3]?.[0]).toContain("author_role = $2");
    expect(query.mock.calls[3]?.[1]).toEqual(["acc_seller", "buyer", 10, 0]);
  });

  it("paginates the review list with limit/offset", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [activeAccountRow()] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ count: "42" }] })
      .mockResolvedValueOnce({ rows: [] });
    const db = { query } as unknown as PgQueryable;

    const account = await getDiscoveryPublicAccountBySlug(db, "seller", { reviewLimit: 5, reviewOffset: 10 });

    expect(account?.reviews.total).toBe(42);
    expect(query.mock.calls[3]?.[1]).toEqual(["acc_seller", 5, 10]);
  });

  it("returns a minimal profile with no listings or reviews for a suspended account", async () => {
    const query = vi.fn().mockResolvedValueOnce({
      rows: [activeAccountRow({ status: "suspended" })],
    });
    const db = { query } as unknown as PgQueryable;

    const account = await getDiscoveryPublicAccountBySlug(db, "seller");

    expect(account?.status).toBe("suspended");
    expect(account?.listings).toEqual([]);
    expect(account?.reviews).toEqual({ items: [], total: 0 });
    expect(account?.active_listing_count).toBe(0);
    // Only the single account lookup query runs -- no listings/reviews round
    // trip for a non-active account (privacy pass, m108 #4268).
    expect(query).toHaveBeenCalledTimes(1);
  });

  it("returns null when no account matches the slug", async () => {
    const query = vi.fn().mockResolvedValueOnce({ rows: [] });
    const db = { query } as unknown as PgQueryable;

    const account = await getDiscoveryPublicAccountBySlug(db, "unknown-seller");

    expect(account).toBeNull();
  });
});
