import { describe, expect, it, vi } from "vitest";
import type { TransportEvent } from "@chase-sets/event-core/transport";
import { buildTransportEvent } from "@chase-sets/event-core/test-support";
import type { PgQueryable, PgQueryResult } from "@chase-sets/event-core-postgres";
import { buildCheckoutCartProjectionHandlers } from "./projection";

describe("checkout cart projection database", () => {
  it("uses the transaction-scoped projection database when the runner provides one", async () => {
    const baseDb = {
      query: vi.fn(async (_sql: string, _values?: readonly unknown[]) => ({ rows: [] })),
    };
    const transactionDb = {
      query: vi.fn(async (_sql: string, _values?: readonly unknown[]) => ({ rows: [] })),
    };
    const handlers = buildCheckoutCartProjectionHandlers(baseDb);

    await handlers["checkout.cart.line-quantity-set"]?.(
      event("checkout.cart.line-quantity-set", "acc_buyer", { lineId: "cli_1", quantity: 2 }),
      { db: transactionDb },
    );

    expect(transactionDb.query).toHaveBeenCalledTimes(1);
    expect(String(transactionDb.query.mock.calls[0]?.[0])).toContain("UPDATE checkout_cart_line_pages");
    expect(baseDb.query).not.toHaveBeenCalled();
  });
});

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

type CartClaimRow = {
  source_owner_key: string;
  account_id: string;
};

/**
 * In-memory `checkout_cart_claims` interpreter: it honours the immutable
 * `ON CONFLICT DO NOTHING` insert and the read-back the reconciliation helper
 * performs, so a conflicting mapping is observable rather than overwritten.
 */
class CartClaimProjectionDb implements PgQueryable {
  public readonly claims = new Map<string, CartClaimRow>();
  public readonly sqlLog: string[] = [];

  seed(claim: CartClaimRow): void {
    this.claims.set(claim.source_owner_key, { ...claim });
  }

  async query<Row = Record<string, unknown>>(
    sql: string,
    values: readonly unknown[] = [],
  ): Promise<PgQueryResult<Row>> {
    this.sqlLog.push(sql);

    if (sql.includes("INSERT INTO checkout_cart_claims")) {
      const sourceOwnerKey = String(values[0]);
      const inserted = !this.claims.has(sourceOwnerKey);
      if (inserted) {
        this.claims.set(sourceOwnerKey, { source_owner_key: sourceOwnerKey, account_id: String(values[1]) });
      }
      return { rows: [], rowCount: inserted ? 1 : 0 };
    }

    if (sql.includes("FROM checkout_cart_claims AS claim")) {
      const claim = this.claims.get(String(values[0]));
      return { rows: (claim ? [claim] : []) as Row[], rowCount: claim ? 1 : 0 };
    }

    throw new Error(`Unexpected query: ${sql}`);
  }
}

function claimEvent(
  sourceOwnerKey: string,
  data: Record<string, unknown> = { sourceOwnerKey, accountId: "acc_buyer" },
): TransportEvent {
  return buildTransportEvent("checkout.cart.claimed-by-account", data, {
    id: "evt_claim",
    streamId: `checkout.cart-${sourceOwnerKey}`,
    tenantId: "tnt_1",
    audit: { performedByUserId: "usr_1", forAccountId: "acc_buyer" },
    timing: { occurredAt: "2026-09-03T00:00:00.000Z", recordedAt: "2026-09-03T00:00:00.000Z" },
  });
}

describe("checkout cart claim projection", () => {
  it("reconstructs the exact claim pair and stays idempotent across repeated replay", async () => {
    const db = new CartClaimProjectionDb();
    const handlers = buildCheckoutCartProjectionHandlers(db);

    await handlers["checkout.cart.claimed-by-account"]!(claimEvent("anon_cart_a"));
    await handlers["checkout.cart.claimed-by-account"]!(claimEvent("anon_cart_a"));

    expect([...db.claims.values()]).toEqual([{ source_owner_key: "anon_cart_a", account_id: "acc_buyer" }]);
  });

  it("restores a claim whose event committed without its alias", async () => {
    const db = new CartClaimProjectionDb();
    const handlers = buildCheckoutCartProjectionHandlers(db);

    expect(db.claims.size).toBe(0);
    await handlers["checkout.cart.claimed-by-account"]!(claimEvent("anon_cart_a"));

    expect(db.claims.get("anon_cart_a")).toEqual({ source_owner_key: "anon_cart_a", account_id: "acc_buyer" });
  });

  it("uses the supplied projection transaction and never the fallback pool", async () => {
    const baseDb = new CartClaimProjectionDb();
    const transactionDb = new CartClaimProjectionDb();
    const handlers = buildCheckoutCartProjectionHandlers(baseDb);

    await handlers["checkout.cart.claimed-by-account"]!(claimEvent("anon_cart_a"), { db: transactionDb });

    expect(transactionDb.claims.get("anon_cart_a")).toEqual({
      source_owner_key: "anon_cart_a",
      account_id: "acc_buyer",
    });
    expect(baseDb.sqlLog).toEqual([]);
    expect(baseDb.claims.size).toBe(0);
  });

  it("fails closed on a contradictory alias instead of reassigning ownership", async () => {
    const db = new CartClaimProjectionDb();
    db.seed({ source_owner_key: "anon_cart_a", account_id: "acc_first" });
    const handlers = buildCheckoutCartProjectionHandlers(db);

    await expect(handlers["checkout.cart.claimed-by-account"]!(claimEvent("anon_cart_a"))).rejects.toThrow(
      "Cart claim alias is held by a different account.",
    );
    expect(db.claims.get("anon_cart_a")).toEqual({ source_owner_key: "anon_cart_a", account_id: "acc_first" });
  });

  it("fails closed when the event identity does not match the stream it lives on", async () => {
    const db = new CartClaimProjectionDb();
    const handlers = buildCheckoutCartProjectionHandlers(db);

    await expect(
      handlers["checkout.cart.claimed-by-account"]!(
        claimEvent("anon_cart_a", { sourceOwnerKey: "anon_cart_b", accountId: "acc_buyer" }),
      ),
    ).rejects.toThrow("Cart claim event source does not match its stream.");
    expect(db.claims.size).toBe(0);
    expect(db.sqlLog).toEqual([]);
  });

  it("fails closed on a malformed historical event", async () => {
    const db = new CartClaimProjectionDb();
    const handlers = buildCheckoutCartProjectionHandlers(db);

    for (const data of [
      {},
      { sourceOwnerKey: "anon_cart_a" },
      { sourceOwnerKey: "anon_cart_a", accountId: "anon_cart_b" },
      { sourceOwnerKey: " anon_cart_a", accountId: "acc_buyer" },
      { sourceOwnerKey: "anon_cart_a", accountId: 42 },
    ]) {
      await expect(handlers["checkout.cart.claimed-by-account"]!(claimEvent("anon_cart_a", data))).rejects.toThrow(
        /Cart claim (source|account) must be an exact/,
      );
    }

    expect(db.claims.size).toBe(0);
    expect(db.sqlLog).toEqual([]);
  });

  it("leaves the line-page projection untouched", async () => {
    const db = new CartClaimProjectionDb();
    const handlers = buildCheckoutCartProjectionHandlers(db);

    await handlers["checkout.cart.claimed-by-account"]!(claimEvent("anon_cart_a"));

    expect(db.sqlLog.some((sql) => sql.includes("checkout_cart_line_pages"))).toBe(false);
  });
});
