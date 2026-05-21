import { describe, expect, it, vi } from "vitest";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { getOrderingSupplyCandidateByListingId } from "./supply-queries";

describe("ordering supply queries", () => {
  it("requires seller listing availability when loading a locked listing", async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    const db = { query } as unknown as PgQueryable;

    const candidate = await getOrderingSupplyCandidateByListingId(db, "lst_1");

    expect(candidate).toBeNull();
    expect(query.mock.calls[0]?.[0]).toContain("listing.seller_listing_availability_status = 'available'");
  });
});
