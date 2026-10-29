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
    expect(item.deepLink).toEqual({ surface: "listing", href: "/account/listings/listing-1" });
    expect(item.dueAt).toBeNull();
    expect(isSellerAttentionItem(item, "listing-action")).toBe(true);
  });
});

describe("createListingActionAttentionSourceFromReadModel", () => {
  it("keeps the durable blocked-capacity condition and Listing link without publishing from a read", async () => {
    const query = vi.fn(async () => ({
      rows: [
        {
          listing_id: "lst_capacity",
          item_title: "Lugia",
          status: "paused",
          pause_reason: "inventory-capacity",
          inventory_capacity_recovery_block: "evidence-incomplete",
          updated_at: "2026-10-28T00:00:00.000Z",
        },
      ],
    }));
    const items = await createListingActionAttentionSourceFromReadModel({ query } as never).load(CONTEXT);
    expect(items).toHaveLength(1);
    expect(items[0]?.summary.params.action).toBe("inventory-capacity:evidence-incomplete");
    expect(items[0]?.deepLink.href).toBe("/account/listings/lst_capacity");
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0]).toBeDefined();
  });
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
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining(
        "pause_reason IS DISTINCT FROM 'inventory-capacity' OR inventory_capacity_recovery_block IS NOT NULL",
      ),
      ["acct-1"],
    );
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
