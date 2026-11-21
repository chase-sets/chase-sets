import { describe, expect, it, vi } from "vitest";
import {
  aggregateSellerAttentionQueue,
  isSellerAttentionItem,
  type SellerAttentionContext,
} from "@chase-sets/seller-attention-queue";
import {
  createOfferResponseAttentionSource,
  createOfferResponseAttentionSourceFromReadModel,
  toOfferResponseAttentionItems,
  type OfferResponseAttentionRow,
} from "./seller-attention-source";

const CONTEXT: SellerAttentionContext = { accountId: "acct-1", now: "2026-07-14T12:00:00.000Z" };

// node-postgres hands back a timestamptz column as a Date unless the query reads
// it as text; this fake answers the same way for the column it is asked about.
function pgTimestamp(sql: string, column: string, iso: string): string | Date {
  return sql.includes(`to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`) ? iso : new Date(iso);
}

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

describe("createOfferResponseAttentionSourceFromReadModel", () => {
  it("loads submitted, non-declined offers matched to the seller's active listings", async () => {
    const query = vi.fn(async () => ({
      rows: [
        {
          offer_id: "offer-1",
          item_title: "Charizard",
          observed_at: "2026-07-13T00:00:00.000Z",
        },
      ],
    }));

    const items = await createOfferResponseAttentionSourceFromReadModel({ query } as never).load(CONTEXT);

    expect(query).toHaveBeenCalledWith(expect.stringContaining("listing.account_id = $1"), ["acct-1"]);
    expect(items[0]?.summary.params).toEqual({ reference: "Charizard" });
  });

  it("reads the offer's time as ISO text, so the queue keeps the offer", async () => {
    const query = vi.fn(async (sql: string) => ({
      rows: [
        {
          offer_id: "offer-1",
          item_title: "Charizard",
          observed_at: pgTimestamp(sql, "offer.created_at", "2026-07-13T00:00:00.000Z"),
        },
      ],
    }));

    const queue = await aggregateSellerAttentionQueue(
      [createOfferResponseAttentionSourceFromReadModel({ query } as never)],
      CONTEXT,
    );

    expect(queue.sources).toEqual([{ id: "offer-response", status: "available", itemCount: 1 }]);
    expect(queue.items[0]?.observedAt).toBe("2026-07-13T00:00:00.000Z");
  });
});

describe("createOfferResponseAttentionSource", () => {
  it("loads rows through the injected query", async () => {
    const source = createOfferResponseAttentionSource({ loadOfferResponseRows: async () => [row()] });
    expect(source.id).toBe("offer-response");
    expect(await source.load(CONTEXT)).toHaveLength(1);
  });
});
