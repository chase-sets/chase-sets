import { describe, expect, it, vi } from "vitest";
import { isSellerAttentionItem, type SellerAttentionContext } from "@chase-sets/seller-attention-queue";
import {
  createListingActionAttentionSource,
  createListingActionAttentionSourceFromReadModel,
  toListingActionAttentionItems,
  type ListingActionAttentionRow,
} from "./seller-attention-source";

const CONTEXT: SellerAttentionContext = { accountId: "acct-1", now: "2026-07-14T12:00:00.000Z" };

function row(overrides: Partial<ListingActionAttentionRow> = {}): ListingActionAttentionRow {
  return {
    listingId: "listing-1",
    reference: "LS-1",
    action: "unavailable",
    observedAt: "2026-07-13T00:00:00.000Z",
    ...overrides,
  };
}

describe("toListingActionAttentionItems", () => {
  it("maps a listing to an info item deep-linking to the listing surface", () => {
    const [item] = toListingActionAttentionItems([row()]);
    expect(item.severity).toBe("info");
    expect(item.summary).toEqual({
      code: "listing-needs-action",
      params: { reference: "LS-1", action: "unavailable" },
    });
    expect(item.deepLink).toEqual({ surface: "listing", href: "/account/desk/listings/listing-1" });
    expect(item.dueAt).toBeNull();
    expect(isSellerAttentionItem(item, "listing-action")).toBe(true);
  });
});

describe("createListingActionAttentionSourceFromReadModel", () => {
  it("loads draft and paused listings for only the requested seller account", async () => {
    const query = vi.fn(async () => ({
      rows: [
        {
          listing_id: "listing-1",
          item_title: "Charizard",
          status: "paused",
          updated_at: "2026-07-13T00:00:00.000Z",
        },
      ],
    }));

    const items = await createListingActionAttentionSourceFromReadModel({ query } as never).load(CONTEXT);

    expect(query).toHaveBeenCalledWith(expect.stringContaining("status IN ('draft', 'paused')"), ["acct-1"]);
    expect(items[0]?.summary.params).toEqual({ reference: "Charizard", action: "paused" });
  });
});

describe("createListingActionAttentionSource", () => {
  it("loads rows through the injected query", async () => {
    const source = createListingActionAttentionSource({ loadListingActionRows: async () => [row()] });
    expect(source.id).toBe("listing-action");
    expect(await source.load(CONTEXT)).toHaveLength(1);
  });
});
