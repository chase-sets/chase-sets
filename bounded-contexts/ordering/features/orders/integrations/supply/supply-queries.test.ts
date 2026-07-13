import { describe, expect, it, vi } from "vitest";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { getOrderingSupplyCandidateByListingId, listOrderingSupplyCandidates } from "./supply-queries";

describe("ordering supply queries", () => {
  it("requires seller listing availability and resolved terms when loading a locked listing", async () => {
    const query = vi.fn(async (_sql: string) => ({ rows: [] }));
    const db = { query } as unknown as PgQueryable;

    const candidate = await getOrderingSupplyCandidateByListingId(db, "lst_1");

    expect(candidate).toBeNull();
    expect(query.mock.calls[0]?.[0]).toContain("listing.seller_listing_availability_status = 'available'");
    expect(query.mock.calls[0]?.[0]).toContain("listing.terms_resolved_at IS NOT NULL");
  });

  it("excludes an at-capacity seller's locked listing (m127 #4882)", async () => {
    const query = vi.fn(async (_sql: string) => ({ rows: [] }));
    const db = { query } as unknown as PgQueryable;

    await getOrderingSupplyCandidateByListingId(db, "lst_1");

    expect(query.mock.calls[0]?.[0]).toContain(
      "capacity.max_open_orders IS NULL OR COALESCE(open_claims.open_count, 0) < capacity.max_open_orders",
    );
  });

  it("requires resolved terms when listing product supply candidates", async () => {
    const query = vi.fn(async (_sql: string) => ({ rows: [] }));
    const db = { query } as unknown as PgQueryable;

    const candidates = await listOrderingSupplyCandidates(db, {
      catalogItemId: "cat_1",
      productId: "cat_1::",
      itemTitle: "Test card",
      itemSubtitle: null,
      selectedOptions: [],
      productSummary: null,
      quantity: 1,
    });

    expect(candidates).toEqual([]);
    expect(query.mock.calls[0]?.[0]).toContain("listing.terms_resolved_at IS NOT NULL");
  });

  it("excludes at-capacity sellers from supply candidates (m127 #4882)", async () => {
    const query = vi.fn(async (_sql: string) => ({ rows: [] }));
    const db = { query } as unknown as PgQueryable;

    await listOrderingSupplyCandidates(db, {
      catalogItemId: "cat_1",
      productId: "cat_1::",
      itemTitle: "Test card",
      itemSubtitle: null,
      selectedOptions: [],
      productSummary: null,
      quantity: 1,
    });

    expect(query.mock.calls[0]?.[0]).toContain(
      "capacity.max_open_orders IS NULL OR COALESCE(open_claims.open_count, 0) < capacity.max_open_orders",
    );
  });
});
