import { describe, expect, it, vi } from "vitest";
import { createInMemoryEventStore } from "@chase-sets/event-core/test-support";
import type { PgQueryable, PgQueryResult } from "@chase-sets/event-core-postgres";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import { createCheckoutCartRuntime } from "./runtime";
import { CART_SELLER_OPTIONS_PER_LINE_LIMIT, type CheckoutCartLineRow } from "../read-model/queries";

const context: EventStoreContext = {
  tenantId: "tnt_test" as never,
  audit: {
    performedByUserId: "usr_buyer" as never,
    forAccountId: "acc_buyer" as never,
  },
};

function readyLine(overrides: Partial<CheckoutCartLineRow> = {}): CheckoutCartLineRow {
  return {
    buyer_account_id: "acc_buyer",
    line_id: "cli_account",
    catalog_catalog_item_id: "cat_1",
    product_id: "cat_1::",
    item_language_code: "en",
    item_title: "Charizard",
    item_subtitle: null,
    item_image_url: null,
    item_image_srcset: null,
    item_image_loading_url: null,
    item_image_loading_alt: null,
    item_image_loading_srcset: null,
    selected_options: [],
    product_summary: null,
    quantity: 1,
    fulfillment_mode: "locked-listing",
    locked_listing_id: "lst_1",
    selected_listing_id: null,
    selected_listing_seller_account_id: null,
    selected_listing_seller_display_name: null,
    selected_listing_seller_slug: null,
    selected_listing_price_amount: null,
    selected_listing_snapshot_source: null,
    selected_listing_snapshot_captured_at: null,
    seller_preference_id: null,
    availability_state: "available",
    seller_options: [
      {
        listing_id: "lst_1",
        seller_account_id: "acc_seller",
        seller_slug: "seller",
        seller_display_name: "Card Vault",
        seller_average_rating: null,
        seller_review_count: 0,
        price_amount: "25.00",
        available_quantity: 1,
        product_summary: null,
        product_measure_snapshot: { measureVersion: "pm_1" },
      },
    ],
    created_at: "2026-06-09T00:00:00.000Z",
    updated_at: "2026-06-09T00:00:00.000Z",
    ...overrides,
  };
}

describe("checkout cart runtime", () => {
  it("marks the Cart handler set as Inline Apply eligible", () => {
    const { eventStore } = createInMemoryEventStore();
    const runtime = createCheckoutCartRuntime({
      eventStore,
      checkpointStore: {} as never,
      db: {
        query: vi.fn(async () => ({ rows: [] })),
      },
    });

    expect(runtime.projectors).toEqual([
      expect.objectContaining({
        projectionName: "checkout.cart-projection",
        inlineApply: true,
      }),
    ]);
  });

  it("creates union readiness from one resolved Account-first query and binds the presented source", async () => {
    const resolvedLines = [
      readyLine({ line_id: "cli_account", product_id: "cat_same::" }),
      readyLine({
        buyer_account_id: "anon_cart_a",
        line_id: "cli_anonymous",
        product_id: "cat_same::",
      }),
    ];
    const query = vi.fn(async () => ({ rows: resolvedLines, rowCount: resolvedLines.length }));
    const { eventStore } = createInMemoryEventStore();
    const runtime = createCheckoutCartRuntime({
      eventStore,
      checkpointStore: {} as never,
      db: { query },
    });

    const withSourceA = await runtime.createReadinessSnapshot({
      accountId: "acc_buyer",
      presentedAnonymousCartId: "anon_cart_a",
    });
    const withSourceB = await runtime.createReadinessSnapshot({
      accountId: "acc_buyer",
      presentedAnonymousCartId: "anon_cart_b",
    });

    expect(query).toHaveBeenCalledTimes(2);
    expect(query).toHaveBeenNthCalledWith(1, expect.stringContaining("WHERE ranked_line.owner_line_rank = 1"), [
      "acc_buyer",
      "anon_cart_a",
      CART_SELLER_OPTIONS_PER_LINE_LIMIT,
      true,
    ]);
    expect(withSourceA.includedLineIds).toEqual(["cli_account", "cli_anonymous"]);
    expect(withSourceA.lineCount).toBe(2);
    expect(withSourceB.sourceRevision).not.toBe(withSourceA.sourceRevision);
    expect(withSourceB.snapshotId).not.toBe(withSourceA.snapshotId);
  });
});

type ClaimRow = { source_owner_key: string; account_id: string };

/**
 * Records every statement the Cart runtime issues and interprets the three
 * tables it touches: the catalog snapshot, the cart-line resolver (by the exact
 * requested-owner parameters, so an own-key probe is distinguishable from a
 * union read) and the claims alias with its immutable insert plus read-back.
 */
class CartRuntimeDb implements PgQueryable {
  public readonly calls: Array<{ sql: string; values: readonly unknown[] }> = [];
  public readonly claims = new Map<string, ClaimRow>();
  public failAliasInsert = false;

  constructor(
    private readonly lines: readonly Partial<CheckoutCartLineRow>[] = [],
    private readonly claimSeeds: readonly ClaimRow[] = [],
  ) {
    for (const claim of claimSeeds) {
      this.claims.set(claim.source_owner_key, { ...claim });
    }
  }

  get cartLineQueries() {
    return this.calls.filter((call) => call.sql.includes("WITH requested_owners AS"));
  }

  get aliasWrites() {
    return this.calls.filter((call) => call.sql.includes("INSERT INTO checkout_cart_claims"));
  }

  async query<Row = Record<string, unknown>>(
    sql: string,
    values: readonly unknown[] = [],
  ): Promise<PgQueryResult<Row>> {
    this.calls.push({ sql, values });

    if (sql.includes("FROM checkout_catalog_items")) {
      return {
        rows: [
          {
            catalog_item_id: String(values[0]),
            language_code: "en",
            status: "active",
            product_schema: null,
          },
        ] as Row[],
        rowCount: 1,
      };
    }

    if (sql.includes("WITH requested_owners AS")) {
      const ownerKey = String(values[0]);
      const includeClaimedOwners = Boolean(values[3]);
      const owners = new Set<string>([ownerKey]);
      if (includeClaimedOwners && ownerKey.startsWith("acc_")) {
        for (const claim of this.claims.values()) {
          if (claim.account_id === ownerKey) {
            owners.add(claim.source_owner_key);
          }
        }
      }
      if (values[1] !== null && values[1] !== undefined) {
        owners.add(String(values[1]));
      }

      const rows = this.lines.filter((line) => owners.has(String(line.buyer_account_id)));
      return { rows: rows as Row[], rowCount: rows.length };
    }

    if (sql.includes("INSERT INTO checkout_cart_claims")) {
      if (this.failAliasInsert) {
        throw new Error("alias write failed");
      }
      const sourceOwnerKey = String(values[0]);
      if (!this.claims.has(sourceOwnerKey)) {
        this.claims.set(sourceOwnerKey, { source_owner_key: sourceOwnerKey, account_id: String(values[1]) });
      }
      return { rows: [], rowCount: 1 };
    }

    if (sql.includes("FROM checkout_cart_claims AS claim")) {
      const claim = this.claims.get(String(values[0]));
      return { rows: (claim ? [claim] : []) as Row[], rowCount: claim ? 1 : 0 };
    }

    throw new Error(`Unexpected query: ${sql}`);
  }
}

function createClaimRuntime(db: CartRuntimeDb) {
  const store = createInMemoryEventStore();
  const runtime = createCheckoutCartRuntime({
    eventStore: store.eventStore,
    checkpointStore: {} as never,
    db,
  });
  const eventsOn = (streamId: string) => (store.streams.get(streamId) ?? []).map((event) => event.eventType);

  return { runtime, store, eventsOn };
}

describe("checkout cart claim service", () => {
  const source = "anon_cart_a";
  const account = "acc_buyer" as never;
  const sourceStream = `checkout.cart-${source}`;
  const accountStream = `checkout.cart-${account}`;

  it("appends one claim event to the source stream, none to the Account stream, and copies no lines", async () => {
    const db = new CartRuntimeDb([readyLine({ buyer_account_id: source, line_id: "cli_source" })]);
    const { runtime, store, eventsOn } = createClaimRuntime(db);

    const result = await runtime.claimCart({ sourceOwnerKey: source, accountId: account }, context);

    expect(eventsOn(sourceStream)).toEqual(["checkout.cart.claimed-by-account"]);
    expect(eventsOn(accountStream)).toEqual([]);
    expect(store.readAllEvents().filter((event) => event.eventType === "checkout.cart.line-added")).toEqual([]);
    expect(result).toEqual({ version: 1 });
    expect(db.claims.get(source)).toEqual({ source_owner_key: source, account_id: account });
  });

  it("reads the claim back in the same request without advancing any claim projection", async () => {
    const db = new CartRuntimeDb([readyLine({ buyer_account_id: source, line_id: "cli_source" })]);
    const { runtime } = createClaimRuntime(db);

    expect(await runtime.listCartLines(account)).toEqual([]);
    await runtime.claimCart({ sourceOwnerKey: source, accountId: account }, context);

    // The claim is readable purely from the synchronous alias plus the already
    // projected line pages: no projector ran, and no freshness wait was added.
    expect((await runtime.listCartLines(account)).map((line) => line.line_id)).toEqual(["cli_source"]);
    // Nothing wrote to the line-page projection: the claim became readable from
    // the synchronous alias alone, with no projector invocation in between.
    expect(
      db.calls.filter(
        (call) => /INSERT INTO|UPDATE |DELETE FROM/.test(call.sql) && call.sql.includes("checkout_cart_line_pages"),
      ),
    ).toEqual([]);
    expect(db.aliasWrites).toHaveLength(1);
  });

  it("reconciles the alias on a same-account retry without appending a second event", async () => {
    const db = new CartRuntimeDb();
    const { runtime, eventsOn } = createClaimRuntime(db);

    const first = await runtime.claimCart({ sourceOwnerKey: source, accountId: account }, context);
    // Simulate a committed event whose alias never landed.
    db.claims.delete(source);

    const retry = await runtime.claimCart({ sourceOwnerKey: source, accountId: account }, context);
    const steady = await runtime.claimCart({ sourceOwnerKey: source, accountId: account }, context);

    expect(eventsOn(sourceStream)).toEqual(["checkout.cart.claimed-by-account"]);
    expect(retry.version).toBe(first.version);
    expect(steady.version).toBe(first.version);
    expect(db.claims.get(source)).toEqual({ source_owner_key: source, account_id: account });
    // Every call reconciles, including the two that appended nothing.
    expect(db.aliasWrites).toHaveLength(3);
  });

  it("does not report success when the alias write fails", async () => {
    const db = new CartRuntimeDb();
    db.failAliasInsert = true;
    const { runtime, eventsOn } = createClaimRuntime(db);

    await expect(runtime.claimCart({ sourceOwnerKey: source, accountId: account }, context)).rejects.toThrow(
      "alias write failed",
    );

    // The event is authoritative and stays committed; the operation is an
    // explicitly incomplete request that a retry repairs.
    expect(eventsOn(sourceStream)).toEqual(["checkout.cart.claimed-by-account"]);
    expect(db.claims.size).toBe(0);

    db.failAliasInsert = false;
    await runtime.claimCart({ sourceOwnerKey: source, accountId: account }, context);
    expect(eventsOn(sourceStream)).toEqual(["checkout.cart.claimed-by-account"]);
    expect(db.claims.get(source)).toEqual({ source_owner_key: source, account_id: account });
  });

  it("refuses a second account and never overwrites the committed alias", async () => {
    const db = new CartRuntimeDb();
    const { runtime, eventsOn } = createClaimRuntime(db);

    await runtime.claimCart({ sourceOwnerKey: source, accountId: account }, context);

    await expect(
      runtime.claimCart({ sourceOwnerKey: source, accountId: "acc_other" as never }, context),
    ).rejects.toThrow("Cart is already claimed by a different account.");
    expect(eventsOn(sourceStream)).toEqual(["checkout.cart.claimed-by-account"]);
    expect(db.claims.get(source)).toEqual({ source_owner_key: source, account_id: account });
  });

  it("fails a claim whose alias is already held by another account rather than reporting success", async () => {
    const db = new CartRuntimeDb([], [{ source_owner_key: source, account_id: "acc_first" }]);
    const { runtime } = createClaimRuntime(db);

    await expect(runtime.claimCart({ sourceOwnerKey: source, accountId: account }, context)).rejects.toThrow(
      "Cart claim alias is held by a different account.",
    );
    expect(db.claims.get(source)).toEqual({ source_owner_key: source, account_id: "acc_first" });
  });

  it("refuses malformed identities before any event or alias write", async () => {
    const invalid: Array<{ sourceOwnerKey: unknown; accountId: unknown; message: RegExp }> = [
      { sourceOwnerKey: "acc_buyer", accountId: account, message: /exact anonymous cart key/ },
      { sourceOwnerKey: "anon_", accountId: account, message: /exact anonymous cart key/ },
      { sourceOwnerKey: " anon_cart_a", accountId: account, message: /exact anonymous cart key/ },
      { sourceOwnerKey: "anon_cart_a ", accountId: account, message: /exact anonymous cart key/ },
      { sourceOwnerKey: "anon_cart a", accountId: account, message: /exact anonymous cart key/ },
      { sourceOwnerKey: "", accountId: account, message: /exact anonymous cart key/ },
      { sourceOwnerKey: undefined, accountId: account, message: /exact anonymous cart key/ },
      { sourceOwnerKey: 42, accountId: account, message: /exact anonymous cart key/ },
      { sourceOwnerKey: source, accountId: "anon_cart_b", message: /exact account id/ },
      { sourceOwnerKey: source, accountId: "acc_", message: /exact account id/ },
      { sourceOwnerKey: source, accountId: "acc_buyer ", message: /exact account id/ },
      { sourceOwnerKey: source, accountId: null, message: /exact account id/ },
      { sourceOwnerKey: source, accountId: source, message: /exact account id/ },
    ];
    const db = new CartRuntimeDb();
    const { runtime, store } = createClaimRuntime(db);

    for (const candidate of invalid) {
      await expect(
        runtime.claimCart(
          { sourceOwnerKey: candidate.sourceOwnerKey as string, accountId: candidate.accountId as never },
          context,
        ),
      ).rejects.toThrow(candidate.message);
    }

    expect(store.readAllEvents()).toEqual([]);
    expect(db.aliasWrites).toEqual([]);
  });

  it("accepts prefix-compatible synthetic and generated identifiers", async () => {
    const db = new CartRuntimeDb();
    const { runtime, store } = createClaimRuntime(db);

    await runtime.claimCart({ sourceOwnerKey: "anon_cart_a", accountId: "acc_buyer" as never }, context);
    await runtime.claimCart(
      {
        sourceOwnerKey: "anon_01J8Z5X6Q0K7Y2N3M4P5R6S7T8",
        accountId: "acc_01J8Z5X6Q0K7Y2N3M4P5R6S7T9" as never,
      },
      context,
    );

    expect(
      store
        .readAllEvents()
        .map((event) => event.streamId)
        .sort(),
    ).toEqual(["checkout.cart-anon_01J8Z5X6Q0K7Y2N3M4P5R6S7T8", "checkout.cart-anon_cart_a"]);
  });
});

describe("checkout cart addLine own-key probe", () => {
  const claimedSource = "anon_cart_a";
  const account = "acc_buyer" as never;

  function addLineParams() {
    return {
      accountId: account,
      catalogItemId: "cat_1",
      productId: "cat_1::",
      itemTitle: "Charizard",
      itemSubtitle: null,
      itemImageUrl: null,
      selectedOptions: [],
      productSummary: null,
      quantity: 2,
    };
  }

  it("does not merge into a claimed-stream line", async () => {
    const db = new CartRuntimeDb(
      [
        readyLine({
          buyer_account_id: claimedSource,
          line_id: "cli_claimed",
          catalog_catalog_item_id: "cat_1",
          product_id: "cat_1::",
          fulfillment_mode: "optimize",
          locked_listing_id: null,
          seller_preference_id: null,
          quantity: 1,
        }),
      ],
      [{ source_owner_key: claimedSource, account_id: account }],
    );
    const { runtime, store, eventsOn } = createClaimRuntime(db);

    const result = await runtime.addLine(addLineParams(), context);

    // The probe asked for the Account key only, with claim expansion off.
    expect(db.cartLineQueries.map((call) => call.values)).toEqual([
      [account, null, CART_SELLER_OPTIONS_PER_LINE_LIMIT, false],
    ]);
    expect(result.status).toBe("added");
    expect(result.lineId).not.toBe("cli_claimed");
    expect(eventsOn(`checkout.cart-${account}`)).toEqual(["checkout.cart.line-added"]);
    expect(eventsOn(`checkout.cart-${claimedSource}`)).toEqual([]);
    expect(store.readAllEvents().filter((event) => event.eventType === "checkout.cart.line-quantity-set")).toEqual([]);
  });

  it("still merges quantity into a matching line the Account holds itself", async () => {
    const db = new CartRuntimeDb([
      readyLine({
        buyer_account_id: account,
        line_id: "cli_own",
        catalog_catalog_item_id: "cat_1",
        product_id: "cat_1::",
        fulfillment_mode: "optimize",
        locked_listing_id: null,
        seller_preference_id: null,
        quantity: 1,
      }),
    ]);
    const { runtime, eventsOn } = createClaimRuntime(db);

    // Seed the Account aggregate so SetCartLineQuantity has a line to address.
    await runtime.commandHandler({
      streamId: `checkout.cart-${account}`,
      command: {
        type: "AddCartLine",
        buyerAccountId: account,
        lineId: "cli_own" as never,
        catalogItemId: "cat_1",
        productId: "cat_1::",
        itemTitle: "Charizard",
        itemSubtitle: null,
        itemImageUrl: null,
        selectedOptions: [],
        productSummary: null,
        quantity: 1,
      },
      context,
    });

    const result = await runtime.addLine(addLineParams(), context);

    expect(result).toMatchObject({ lineId: "cli_own", status: "merged" });
    expect(eventsOn(`checkout.cart-${account}`)).toEqual([
      "checkout.cart.line-added",
      "checkout.cart.line-quantity-set",
    ]);
  });

  it("keeps anonymous own-key add behaviour unchanged", async () => {
    const db = new CartRuntimeDb([
      readyLine({
        buyer_account_id: claimedSource,
        line_id: "cli_anon",
        catalog_catalog_item_id: "cat_1",
        product_id: "cat_1::",
        fulfillment_mode: "optimize",
        locked_listing_id: null,
        seller_preference_id: null,
        quantity: 1,
      }),
    ]);
    const { runtime } = createClaimRuntime(db);

    await runtime.commandHandler({
      streamId: `checkout.cart-${claimedSource}`,
      command: {
        type: "AddCartLine",
        buyerAccountId: claimedSource as never,
        lineId: "cli_anon" as never,
        catalogItemId: "cat_1",
        productId: "cat_1::",
        itemTitle: "Charizard",
        itemSubtitle: null,
        itemImageUrl: null,
        selectedOptions: [],
        productSummary: null,
        quantity: 1,
      },
      context,
    });

    const result = await runtime.addLine({ ...addLineParams(), accountId: claimedSource as never }, context);

    expect(result).toMatchObject({ lineId: "cli_anon", status: "merged" });
    expect(db.cartLineQueries.map((call) => call.values)).toEqual([
      [claimedSource, null, CART_SELLER_OPTIONS_PER_LINE_LIMIT, false],
    ]);
  });
});
