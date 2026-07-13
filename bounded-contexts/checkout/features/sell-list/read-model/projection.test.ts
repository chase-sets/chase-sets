import { describe, expect, it } from "vitest";
import type { TransportEvent } from "@chase-sets/event-core/transport";
import { buildTransportEvent } from "@chase-sets/event-core/test-support";
import type { PgQueryable, PgQueryResult } from "@chase-sets/event-core-postgres";
import { buildCheckoutSellListProjectionHandlers } from "./projection";

type SellListLineRow = {
  seller_account_id: string;
  line_id: string;
  line_type: string;
  offer_id: string | null;
  quantity: number;
};

type PayoutReadinessRow = {
  account_id: string;
  status: string;
  missing_requirements: unknown;
  updated_at: string | null;
  last_stream_version: number;
};

class SellListProjectionDb implements PgQueryable {
  public readonly lines = new Map<string, SellListLineRow>();
  public readonly payoutReadiness = new Map<string, PayoutReadinessRow>();

  async query<Row = Record<string, unknown>>(
    sql: string,
    values: readonly unknown[] = [],
  ): Promise<PgQueryResult<Row>> {
    if (sql.includes("INSERT INTO checkout_sell_list_line_pages")) {
      const row = {
        seller_account_id: String(values[0]),
        line_id: String(values[1]),
        line_type: String(values[2]),
        offer_id: values[3] === null ? null : String(values[3]),
        quantity: Number(values[13]),
      };
      if (sql.includes("ON CONFLICT (seller_account_id, offer_id)") && row.offer_id) {
        const existing = [...this.lines.values()].find(
          (line) => line.seller_account_id === row.seller_account_id && line.offer_id === row.offer_id,
        );
        if (existing) {
          this.lines.delete(this.key(existing.seller_account_id, existing.line_id));
        }
      }
      if (
        sql.includes("ON CONFLICT (seller_account_id, offer_id)") &&
        row.offer_id &&
        this.lines.has(this.key(row.seller_account_id, row.line_id))
      ) {
        throw new Error('duplicate key value violates unique constraint "checkout_sell_list_line_pages_pkey"');
      }
      this.lines.set(this.key(row.seller_account_id, row.line_id), row);
      return { rows: [], rowCount: 1 };
    }

    if (sql.includes("INSERT INTO checkout_sell_list_confirmation_pages")) {
      return { rows: [], rowCount: 1 };
    }

    if (sql.includes("INSERT INTO checkout_sell_payout_readiness_pages")) {
      const accountId = String(values[0]);
      const existing = this.payoutReadiness.get(accountId);
      const nextVersion = Number(values[4]);
      if (existing && existing.last_stream_version >= nextVersion) {
        return { rows: [], rowCount: 0 };
      }
      this.payoutReadiness.set(accountId, {
        account_id: accountId,
        status: String(values[1]),
        missing_requirements: JSON.parse(String(values[2] ?? "[]")),
        updated_at: values[3] === null ? null : String(values[3]),
        last_stream_version: nextVersion,
      });
      return { rows: [], rowCount: 1 };
    }

    if (sql.includes("INSERT INTO checkout_sell_offer_pages") || sql.includes("UPDATE checkout_sell_offer_pages")) {
      return { rows: [], rowCount: 1 };
    }

    if (sql.includes("UPDATE checkout_sell_list_line_pages") && sql.includes("SET quantity")) {
      if (sql.includes("WHERE seller_account_id = $1")) {
        const row = this.lines.get(this.key(String(values[0]), String(values[1])));
        if (row) {
          row.quantity = Number(values[2]);
        }
        return { rows: [], rowCount: row ? 1 : 0 };
      }

      let affected = 0;
      for (const row of this.lines.values()) {
        if (row.line_id === String(values[0])) {
          row.quantity = Number(values[1]);
          affected++;
        }
      }
      return { rows: [], rowCount: affected };
    }

    if (sql.includes("DELETE FROM checkout_sell_list_line_pages")) {
      if (sql.includes("OR offer_id = $3")) {
        let affected = 0;
        for (const row of [...this.lines.values()]) {
          if (
            row.seller_account_id === String(values[0]) &&
            (row.line_id === String(values[1]) || row.offer_id === String(values[2])) &&
            !(row.line_id === String(values[1]) && row.offer_id === String(values[2]))
          ) {
            this.lines.delete(this.key(row.seller_account_id, row.line_id));
            affected++;
          }
        }
        return { rows: [], rowCount: affected };
      }

      if (sql.includes("line_type = 'selected-offer'")) {
        let affected = 0;
        for (const row of [...this.lines.values()]) {
          if (
            row.seller_account_id === String(values[0]) &&
            row.line_type === "selected-offer" &&
            row.offer_id === String(values[1])
          ) {
            this.lines.delete(this.key(row.seller_account_id, row.line_id));
            affected++;
          }
        }
        return { rows: [], rowCount: affected };
      }

      if (sql.includes("WHERE seller_account_id = $1")) {
        if (Array.isArray(values[1])) {
          let affected = 0;
          for (const lineId of values[1]) {
            if (this.lines.delete(this.key(String(values[0]), String(lineId)))) {
              affected++;
            }
          }
          return { rows: [], rowCount: affected };
        }

        const deleted = this.lines.delete(this.key(String(values[0]), String(values[1])));
        return { rows: [], rowCount: deleted ? 1 : 0 };
      }

      let affected = 0;
      for (const row of [...this.lines.values()]) {
        if (row.line_id === String(values[0])) {
          this.lines.delete(this.key(row.seller_account_id, row.line_id));
          affected++;
        }
      }
      return { rows: [], rowCount: affected };
    }

    throw new Error(`Unexpected query: ${sql}`);
  }

  getLine(sellerAccountId: string, lineId: string) {
    return this.lines.get(this.key(sellerAccountId, lineId));
  }

  getPayoutReadiness(accountId: string) {
    return this.payoutReadiness.get(accountId);
  }

  private key(sellerAccountId: string, lineId: string) {
    return `${sellerAccountId}:${lineId}`;
  }
}

function event(type: string, streamId: string, data: Record<string, unknown>): TransportEvent {
  return buildTransportEvent(type, data, {
    id: "evt_1",
    streamId,
    tenantId: "tnt_1",
    audit: { performedByUserId: "usr_1", forAccountId: "acc_1" },
    timing: { occurredAt: "2026-06-22T00:00:00.000Z", recordedAt: "2026-06-22T00:00:00.000Z" },
  });
}

function lineAddedEvent(
  sellerAccountId: string,
  lineId: string,
  quantity = 1,
  overrides: Partial<Record<string, unknown>> = {},
) {
  return event("checkout.sell-list.line-added", `checkout.sell-list-${sellerAccountId}`, {
    sellerAccountId,
    lineId,
    lineType: "product",
    offerId: null,
    buyerAccountId: null,
    buyerDisplayName: null,
    offerPriceAmount: null,
    catalogItemId: "cat_1",
    productId: "cat_1::condition:raw",
    itemTitle: "Charizard",
    itemSubtitle: null,
    selectedOptions: [{ dimensionId: "condition", optionId: "raw" }],
    productSummary: "Raw",
    quantity,
    fallbackMode: "create-listing",
    minimumListingPriceAmount: "10.00",
    ...overrides,
  });
}

describe("checkout Sell List projection", () => {
  it("removes only the source owner line when guest Sell List lines are merged into an account", async () => {
    const db = new SellListProjectionDb();
    const handlers = buildCheckoutSellListProjectionHandlers(db);
    const lineId = "sll_shared";

    await handlers["checkout.sell-list.line-added"]!(lineAddedEvent("guest_1", lineId));
    await handlers["checkout.sell-list.line-added"]!(lineAddedEvent("acc_1", lineId));
    await handlers["checkout.sell-list.line-removed"]!(
      event("checkout.sell-list.line-removed", "checkout.sell-list-guest_1", {
        sellerAccountId: "guest_1",
        lineId,
      }),
    );

    expect(db.getLine("guest_1", lineId)).toBeUndefined();
    expect(db.getLine("acc_1", lineId)).toMatchObject({ quantity: 1 });
  });

  it("scopes legacy line removals by the event stream owner", async () => {
    const db = new SellListProjectionDb();
    const handlers = buildCheckoutSellListProjectionHandlers(db);
    const lineId = "sll_shared";

    await handlers["checkout.sell-list.line-added"]!(lineAddedEvent("guest_1", lineId));
    await handlers["checkout.sell-list.line-added"]!(lineAddedEvent("acc_1", lineId));
    await handlers["checkout.sell-list.line-removed"]!(
      event("checkout.sell-list.line-removed", "checkout.sell-list-guest_1", { lineId }),
    );

    expect(db.getLine("guest_1", lineId)).toBeUndefined();
    expect(db.getLine("acc_1", lineId)).toMatchObject({ quantity: 1 });
  });

  it("sets quantity only on the owner row that emitted the line event", async () => {
    const db = new SellListProjectionDb();
    const handlers = buildCheckoutSellListProjectionHandlers(db);
    const lineId = "sll_shared";

    await handlers["checkout.sell-list.line-added"]!(lineAddedEvent("guest_1", lineId));
    await handlers["checkout.sell-list.line-added"]!(lineAddedEvent("acc_1", lineId));
    await handlers["checkout.sell-list.line-quantity-set"]!(
      event("checkout.sell-list.line-quantity-set", "checkout.sell-list-acc_1", {
        sellerAccountId: "acc_1",
        lineId,
        quantity: 3,
      }),
    );

    expect(db.getLine("guest_1", lineId)).toMatchObject({ quantity: 1 });
    expect(db.getLine("acc_1", lineId)).toMatchObject({ quantity: 3 });
  });

  it("removes the seller selected-offer line when Marketplace accepts that offer", async () => {
    const db = new SellListProjectionDb();
    const handlers = buildCheckoutSellListProjectionHandlers(db);

    await handlers["checkout.sell-list.line-added"]!(
      lineAddedEvent("acc_seller", "sll_selected", 1, {
        lineType: "selected-offer",
        offerId: "off_accepted",
        fallbackMode: "none",
      }),
    );
    await handlers["checkout.sell-list.line-added"]!(
      lineAddedEvent("acc_other", "sll_other", 1, {
        lineType: "selected-offer",
        offerId: "off_accepted",
        fallbackMode: "none",
      }),
    );
    await handlers["checkout.sell-list.line-added"]!(
      lineAddedEvent("acc_seller", "sll_product", 1, {
        lineType: "product",
        offerId: null,
      }),
    );

    await handlers["marketplace.offer.accepted"]!(
      event("marketplace.offer.accepted", "marketplace.offer-off_accepted", {
        offerId: "off_accepted",
        sellerAccountId: "acc_seller",
      }),
    );

    expect(db.getLine("acc_seller", "sll_selected")).toBeUndefined();
    expect(db.getLine("acc_other", "sll_other")).toMatchObject({ offer_id: "off_accepted" });
    expect(db.getLine("acc_seller", "sll_product")).toMatchObject({ line_type: "product" });
  });

  it("upserts selected-offer lines by seller and offer to keep replay idempotent", async () => {
    const db = new SellListProjectionDb();
    const handlers = buildCheckoutSellListProjectionHandlers(db);

    await handlers["checkout.sell-list.line-added"]!(
      lineAddedEvent("acc_seller", "sll_original", 1, {
        lineType: "selected-offer",
        offerId: "off_duplicate",
        fallbackMode: "none",
      }),
    );
    await handlers["checkout.sell-list.line-added"]!(
      lineAddedEvent("acc_seller", "sll_retry", 1, {
        lineType: "selected-offer",
        offerId: "off_duplicate",
        fallbackMode: "none",
      }),
    );

    expect(db.getLine("acc_seller", "sll_original")).toBeUndefined();
    expect(db.getLine("acc_seller", "sll_retry")).toMatchObject({
      line_type: "selected-offer",
      offer_id: "off_duplicate",
      quantity: 1,
    });
  });

  it("replaces a stale product row when selected-offer replay reuses the line id", async () => {
    const db = new SellListProjectionDb();
    const handlers = buildCheckoutSellListProjectionHandlers(db);

    await handlers["checkout.sell-list.line-added"]!(lineAddedEvent("acc_seller", "sll_reused", 1));
    await handlers["checkout.sell-list.line-added"]!(
      lineAddedEvent("acc_seller", "sll_reused", 1, {
        lineType: "selected-offer",
        offerId: "off_reused",
        fallbackMode: "none",
      }),
    );

    expect(db.getLine("acc_seller", "sll_reused")).toMatchObject({
      line_type: "selected-offer",
      offer_id: "off_reused",
      quantity: 1,
    });
    expect(db.lines.size).toBe(1);
  });

  it("replaces a stale selected-offer row when replay reuses the line id with a new offer", async () => {
    const db = new SellListProjectionDb();
    const handlers = buildCheckoutSellListProjectionHandlers(db);

    await handlers["checkout.sell-list.line-added"]!(
      lineAddedEvent("acc_seller", "sll_reused", 1, {
        lineType: "selected-offer",
        offerId: "off_old",
        fallbackMode: "none",
      }),
    );
    await handlers["checkout.sell-list.line-added"]!(
      lineAddedEvent("acc_seller", "sll_reused", 1, {
        lineType: "selected-offer",
        offerId: "off_new",
        fallbackMode: "none",
      }),
    );

    expect(db.getLine("acc_seller", "sll_reused")).toMatchObject({
      line_type: "selected-offer",
      offer_id: "off_new",
      quantity: 1,
    });
    expect(db.lines.size).toBe(1);
  });

  it("mirrors Settlement payout readiness into the Checkout sell projection", async () => {
    const db = new SellListProjectionDb();
    const handlers = buildCheckoutSellListProjectionHandlers(db);

    await handlers["settlement.payout-readiness.recorded"]!(
      event("settlement.payout-readiness.recorded", "settlement.payout-readiness-acc_seller", {
        accountId: "acc_seller",
        status: "restricted",
        missingRequirements: ["external_account"],
        recordedAt: "2026-06-22T00:02:00.000Z",
      }),
    );

    expect(db.getPayoutReadiness("acc_seller")).toEqual({
      account_id: "acc_seller",
      status: "restricted",
      missing_requirements: ["external_account"],
      updated_at: "2026-06-22T00:02:00.000Z",
      last_stream_version: 1,
    });
  });

  it("removes completed selected-offer lines from checkout confirmation events", async () => {
    const db = new SellListProjectionDb();
    const handlers = buildCheckoutSellListProjectionHandlers(db);

    await handlers["checkout.sell-list.line-added"]!(
      lineAddedEvent("acc_seller", "sll_selected", 1, {
        lineType: "selected-offer",
        offerId: "off_1",
        fallbackMode: "none",
      }),
    );

    await handlers["checkout.sell-list.checkout-confirmed"]!(
      event("checkout.sell-list.checkout-confirmed", "checkout.sell-list-acc_seller", {
        sellerAccountId: "acc_seller",
        confirmationId: "slc_chk_1",
        confirmedAt: "2026-06-22T00:01:00.000Z",
        completedLineIds: ["sll_selected"],
        remainingLineQuantities: [],
        readinessEvidence: {},
        sellerEvidence: {},
        handoffSummary: {},
      }),
    );

    expect(db.getLine("acc_seller", "sll_selected")).toBeUndefined();
  });
});
