import { describe, expect, it } from "vitest";
import { isSellerAttentionItem, type SellerAttentionContext } from "@chase-sets/seller-attention-queue";
import {
  createOfferResponseAttentionSource,
  toOfferResponseAttentionItems,
  type OfferResponseAttentionRow,
} from "./seller-attention-source";

const CONTEXT: SellerAttentionContext = { accountId: "acct-1", now: "2026-07-14T12:00:00.000Z" };

function row(overrides: Partial<OfferResponseAttentionRow> = {}): OfferResponseAttentionRow {
  return {
    offerId: "offer-1",
    reference: "OF-1",
    expiresAt: "2026-07-15T12:00:00.000Z",
    observedAt: "2026-07-13T00:00:00.000Z",
    ...overrides,
  };
}

describe("toOfferResponseAttentionItems", () => {
  it("maps an awaiting offer to a warning item deep-linking to the sell list, keyed to its expiry", () => {
    const [item] = toOfferResponseAttentionItems([row()]);
    expect(item.severity).toBe("warning");
    expect(item.dueAt).toBe("2026-07-15T12:00:00.000Z");
    expect(item.deepLink).toEqual({ surface: "sell-list", href: "/account/desk/offers" });
    expect(isSellerAttentionItem(item, "offer-response")).toBe(true);
  });

  it("leaves dueAt null when the offer has no expiry", () => {
    const [item] = toOfferResponseAttentionItems([row({ expiresAt: null })]);
    expect(item.dueAt).toBeNull();
  });
});

describe("createOfferResponseAttentionSource", () => {
  it("loads rows through the injected query", async () => {
    const source = createOfferResponseAttentionSource({ loadOfferResponseRows: async () => [row()] });
    expect(source.id).toBe("offer-response");
    expect(await source.load(CONTEXT)).toHaveLength(1);
  });
});
