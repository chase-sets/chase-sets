import { describe, expect, it, vi } from "vitest";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { getDiscoveryPublicSellerBySlug } from "../support/market-support/queries";

describe("discovery public market queries", () => {
  it("hides seller listings when seller listing availability is off", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({
        rows: [{
          account_id: "acc_seller",
          seller_slug: "seller",
          seller_display_name: "Seller",
          status: "active",
          updated_at: "2026-05-13T00:00:00.000Z",
        }],
      })
      .mockResolvedValueOnce({ rows: [] });
    const db = { query } as unknown as PgQueryable;

    const seller = await getDiscoveryPublicSellerBySlug(db, "seller");

    expect(seller?.listings).toEqual([]);
    expect(query.mock.calls[1]?.[0]).toContain(
      "account.seller_listing_availability_status = 'available'",
    );
  });
});
