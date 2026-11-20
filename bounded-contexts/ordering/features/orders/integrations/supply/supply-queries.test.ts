import { describe, expect, it, vi } from "vitest";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import {
  getOrderingSupplyCandidateByListingId,
  hasAcceptedOfferSupplyInputs,
  listOrderingSupplyCandidates,
} from "./supply-queries";

describe("ordering supply queries", () => {
  it("requires no pending hold claims for the accepted Offer item independently of its version", async () => {
    const query = vi.fn(async (_sql: string) => ({ rows: [{ ready: false }] }));
    const db = { query } as unknown as PgQueryable;

    expect(await hasAcceptedOfferSupplyInputs(db, "lst_1", "inv_1", 2)).toBe(false);
    expect(await hasAcceptedOfferSupplyInputs(db, "lst_1", "inv_1")).toBe(false);

    const noPendingClaims = expect.stringMatching(
      /AND NOT EXISTS\s*\(\s*SELECT 1 FROM ordering_inventory_pending_hold_claims\s+WHERE item_id = \$2\s*\)/,
    );
    expect(query).toHaveBeenNthCalledWith(1, noPendingClaims, ["lst_1", "inv_1", 2]);
    expect(query).toHaveBeenNthCalledWith(2, noPendingClaims, ["lst_1", "inv_1", null]);
  });

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
