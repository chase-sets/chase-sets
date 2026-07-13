import { describe, expect, it } from "vitest";
import type { TransportEvent } from "@chase-sets/event-core/transport";
import { buildTransportEvent } from "@chase-sets/event-core/test-support";
import type { PgQueryable, PgQueryResult } from "@chase-sets/event-core-postgres";
import { buildCheckoutCartProjectionHandlers } from "./projection";

type CartLineRow = {
  buyer_account_id: string;
  line_id: string;
  quantity: number;
  fulfillment_mode: string;
  locked_listing_id: string | null;
  selected_listing_id: string | null;
};

class CartProjectionDb implements PgQueryable {
  public readonly lines = new Map<string, CartLineRow>();
  public readonly sqlLog: string[] = [];

  seed(line: CartLineRow): void {
    this.lines.set(this.key(line.buyer_account_id, line.line_id), { ...line });
  }

  async query<Row = Record<string, unknown>>(
    sql: string,
    values: readonly unknown[] = [],
  ): Promise<PgQueryResult<Row>> {
    this.sqlLog.push(sql);

    if (sql.includes("SET quantity = $3")) {
      const row = this.lines.get(this.key(String(values[0]), String(values[1])));
      if (row) {
        row.quantity = Number(values[2]);
      }
      return { rows: [], rowCount: row ? 1 : 0 };
    }

    if (sql.includes("SET fulfillment_mode = $3")) {
      const row = this.lines.get(this.key(String(values[0]), String(values[1])));
      if (row) {
        row.fulfillment_mode = String(values[2]);
        row.locked_listing_id = values[3] === null ? null : String(values[3]);
        row.selected_listing_id = values[4] === null ? null : String(values[4]);
      }
      return { rows: [], rowCount: row ? 1 : 0 };
    }

    if (sql.includes("DELETE FROM checkout_cart_line_pages")) {
      const deleted = this.lines.delete(this.key(String(values[0]), String(values[1])));
      return { rows: [], rowCount: deleted ? 1 : 0 };
    }

    throw new Error(`Unexpected query: ${sql}`);
  }

  private key(buyerAccountId: string, lineId: string) {
    return `${buyerAccountId}:${lineId}`;
  }
}

function event(type: string, buyerAccountId: string, data: Record<string, unknown>): TransportEvent {
  return buildTransportEvent(type, data, {
    id: "evt_1",
    streamId: `checkout.cart-${buyerAccountId}`,
    tenantId: "tnt_1",
    audit: { performedByUserId: "usr_1", forAccountId: buyerAccountId },
    timing: { occurredAt: "2026-07-03T00:00:00.000Z", recordedAt: "2026-07-03T00:00:00.000Z" },
  });
}

function seedLine(buyerAccountId: string): CartLineRow {
  return {
    buyer_account_id: buyerAccountId,
    line_id: "cli_shared",
    quantity: 1,
    fulfillment_mode: "optimize",
    locked_listing_id: null,
    selected_listing_id: null,
  };
}

describe("checkout cart projection", () => {
  it("qualifies line mutations by buyer account and line id", async () => {
    const db = new CartProjectionDb();
    db.seed(seedLine("acc_buyer"));
    db.seed(seedLine("acc_other"));
    const handlers = buildCheckoutCartProjectionHandlers(db);

    await handlers["checkout.cart.line-quantity-set"]!(
      event("checkout.cart.line-quantity-set", "acc_buyer", { lineId: "cli_shared", quantity: 4 }),
    );
    await handlers["checkout.cart.line-fulfillment-set"]!(
      event("checkout.cart.line-fulfillment-set", "acc_buyer", {
        lineId: "cli_shared",
        fulfillmentMode: "locked-listing",
        lockedListingId: "lst_1",
        sellerPreferenceId: null,
        selectedListingSnapshot: {
          listingId: "lst_1",
          sellerAccountId: "acc_seller",
          sellerDisplayName: "Seller",
          sellerSlug: "seller",
          priceAmount: "12.00",
          source: "test",
        },
        availabilityState: "available",
      }),
    );
    await handlers["checkout.cart.line-removed"]!(
      event("checkout.cart.line-removed", "acc_buyer", { lineId: "cli_shared" }),
    );

    expect(db.lines.get("acc_buyer:cli_shared")).toBeUndefined();
    expect(db.lines.get("acc_other:cli_shared")).toMatchObject({
      buyer_account_id: "acc_other",
      line_id: "cli_shared",
      quantity: 1,
      fulfillment_mode: "optimize",
      locked_listing_id: null,
    });
    expect(db.sqlLog).toEqual([
      expect.stringContaining("WHERE buyer_account_id = $1\n           AND line_id = $2"),
      expect.stringContaining("WHERE buyer_account_id = $1\n           AND line_id = $2"),
      expect.stringContaining("WHERE buyer_account_id = $1\n           AND line_id = $2"),
    ]);
  });
});
