import { describe, expect, it, vi } from "vitest";
import { createInMemoryEventStore } from "@chase-sets/event-core/test-support";
import type { PgQueryable, PgQueryResult } from "@chase-sets/event-core-postgres";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import { createCheckoutCartRuntime } from "./runtime";
import { evolveCheckoutCart, initialCheckoutCartState } from "../domain/domain";
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

  get claimedOwnerLookups() {
    return this.calls.filter((call) => call.sql.includes("WHERE claim.account_id = $1"));
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

    // The claimed-owner enumeration and the single-key alias read-back both
    // select from the claims table; the account-keyed predicate is what tells
    // them apart.
    if (sql.includes("WHERE claim.account_id = $1")) {
      const accountId = String(values[0]);
      const rows = [...this.claims.values()]
        .filter((claim) => claim.account_id === accountId)
        .map((claim) => ({ source_owner_key: claim.source_owner_key }))
        .sort((left, right) => (left.source_owner_key < right.source_owner_key ? -1 : 1));
      return { rows: rows as Row[], rowCount: rows.length };
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

/**
 * Claimed-stream mutation harness over unmistakably synthetic identities:
 * `anon_synthetic_claimed` is the retained anonymous source key and
 * `acc_synthetic_claimant` the Account that claimed it.
 */
const CLAIMED_SOURCE = "anon_synthetic_claimed";
const SECOND_SOURCE = "anon_synthetic_claimed_second";
const CLAIMANT = "acc_synthetic_claimant" as never;
const BYSTANDER = "acc_synthetic_bystander" as never;
const OTHER_SELLER = "acc_synthetic_other_seller";

function claimedLine(ownerKey: string, lineId: string, overrides: Partial<CheckoutCartLineRow> = {}) {
  return readyLine({
    buyer_account_id: ownerKey,
    line_id: lineId,
    fulfillment_mode: "optimize",
    locked_listing_id: null,
    seller_preference_id: null,
    ...overrides,
  });
}

/**
 * Seeds the anonymous source aggregates with real line history, then claims
 * them, so every authorization decision below reads claim-evolved state rather
 * than a fixture flag.
 */
async function claimedCartRuntime(
  lines: readonly Partial<CheckoutCartLineRow>[],
  seeds: readonly { ownerKey: string; lineIds: readonly string[]; claimedBy?: string }[],
) {
  const db = new CartRuntimeDb(lines);
  const harness = createClaimRuntime(db);
  for (const seed of seeds) {
    for (const lineId of seed.lineIds) {
      await harness.runtime.commandHandler({
        streamId: `checkout.cart-${seed.ownerKey}`,
        command: {
          type: "AddCartLine",
          buyerAccountId: seed.ownerKey as never,
          lineId: lineId as never,
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
    }
    if (seed.claimedBy) {
      await harness.runtime.claimCart({ sourceOwnerKey: seed.ownerKey, accountId: seed.claimedBy as never }, context);
    }
  }

  const cartState = async (ownerKey: string) =>
    (await harness.store.eventStore.readStream({ streamId: `checkout.cart-${ownerKey}` })).reduce(
      (state, event) => evolveCheckoutCart(state, { type: event.eventType, data: event.payload } as never),
      initialCheckoutCartState,
    );
  const versionOf = async (ownerKey: string) =>
    (await harness.store.eventStore.readStream({ streamId: `checkout.cart-${ownerKey}` })).length;

  return { db, ...harness, cartState, versionOf };
}

describe("claimed cart mutation routing", () => {
  it("routes quantity to the claimed source stream and appends nothing to the Account stream", async () => {
    const h = await claimedCartRuntime(
      [claimedLine(CLAIMED_SOURCE, "cli_claimed")],
      [{ ownerKey: CLAIMED_SOURCE, lineIds: ["cli_claimed"], claimedBy: CLAIMANT }],
    );
    const before = { claimed: await h.versionOf(CLAIMED_SOURCE), account: await h.versionOf(CLAIMANT) };

    const result = await h.runtime.setLineQuantity(
      { accountId: CLAIMANT, lineId: "cli_claimed" as never, quantity: 4 },
      context,
    );

    expect(await h.versionOf(CLAIMED_SOURCE)).toBe(before.claimed + 1);
    expect(await h.versionOf(CLAIMANT)).toBe(before.account);
    expect(h.eventsOn(`checkout.cart-${CLAIMED_SOURCE}`)).toEqual([
      "checkout.cart.line-added",
      "checkout.cart.claimed-by-account",
      "checkout.cart.line-quantity-set",
    ]);
    expect(h.eventsOn(`checkout.cart-${CLAIMANT}`)).toEqual([]);
    expect((await h.cartState(CLAIMED_SOURCE)).lines[0]?.quantity).toBe(4);
    expect(result.version).toBe(before.claimed + 1);
  });

  it("routes fulfillment to the claimed source stream and refuses the claimant's own listing", async () => {
    const h = await claimedCartRuntime(
      [claimedLine(CLAIMED_SOURCE, "cli_claimed")],
      [{ ownerKey: CLAIMED_SOURCE, lineIds: ["cli_claimed"], claimedBy: CLAIMANT }],
    );
    const lock = (sellerAccountId: string) => ({
      accountId: CLAIMANT,
      lineId: "cli_claimed" as never,
      fulfillmentMode: "locked-listing" as const,
      lockedListingId: "lst_selected",
      selectedListingSnapshot: {
        listingId: "lst_selected",
        sellerAccountId,
        priceAmount: "25.00",
        source: "account-cart-fulfillment",
      },
    });
    const before = await h.versionOf(CLAIMED_SOURCE);

    // The retained anonymous key is not the buyer here; the claimant is.
    await expect(h.runtime.setLineFulfillment(lock(String(CLAIMANT)), context)).rejects.toThrow(
      "Accounts cannot add their own listings to cart.",
    );
    expect(await h.versionOf(CLAIMED_SOURCE)).toBe(before);

    await h.runtime.setLineFulfillment(lock(OTHER_SELLER), context);

    expect(await h.versionOf(CLAIMED_SOURCE)).toBe(before + 1);
    expect(await h.versionOf(CLAIMANT)).toBe(0);
    expect((await h.cartState(CLAIMED_SOURCE)).lines[0]).toMatchObject({
      fulfillmentMode: "locked-listing",
      lockedListingId: "lst_selected",
      selectedListingSnapshot: { sellerAccountId: OTHER_SELLER },
    });
  });

  it("targets only the account-first winner when one line id sits on both streams", async () => {
    // Both owners hold the same line id. The Account's own row is offered
    // first, as the union's account-first precedence resolves it against real
    // PostgreSQL in `seller-options-readiness.db.test.ts`.
    const h = await claimedCartRuntime(
      [claimedLine(String(CLAIMANT), "cli_shared"), claimedLine(CLAIMED_SOURCE, "cli_shared")],
      [
        { ownerKey: CLAIMED_SOURCE, lineIds: ["cli_shared"], claimedBy: CLAIMANT },
        { ownerKey: String(CLAIMANT), lineIds: ["cli_shared"] },
      ],
    );
    const before = { claimed: await h.versionOf(CLAIMED_SOURCE), account: await h.versionOf(String(CLAIMANT)) };

    await h.runtime.setLineQuantity({ accountId: CLAIMANT, lineId: "cli_shared" as never, quantity: 9 }, context);

    expect(await h.versionOf(String(CLAIMANT))).toBe(before.account + 1);
    expect(await h.versionOf(CLAIMED_SOURCE)).toBe(before.claimed);
    expect((await h.cartState(String(CLAIMANT))).lines[0]?.quantity).toBe(9);
    expect((await h.cartState(CLAIMED_SOURCE)).lines[0]?.quantity).toBe(1);
  });

  it("keeps a no-claim Account and a no-claim anonymous key on their own streams", async () => {
    const h = await claimedCartRuntime(
      [claimedLine(String(BYSTANDER), "cli_account_only"), claimedLine(SECOND_SOURCE, "cli_anonymous_only")],
      [
        { ownerKey: String(BYSTANDER), lineIds: ["cli_account_only"] },
        { ownerKey: SECOND_SOURCE, lineIds: ["cli_anonymous_only"] },
      ],
    );

    await h.runtime.setLineQuantity(
      { accountId: BYSTANDER, lineId: "cli_account_only" as never, quantity: 3 },
      context,
    );
    await h.runtime.setLineQuantity(
      { accountId: SECOND_SOURCE as never, lineId: "cli_anonymous_only" as never, quantity: 6 },
      context,
    );

    expect(h.eventsOn(`checkout.cart-${BYSTANDER}`)).toEqual([
      "checkout.cart.line-added",
      "checkout.cart.line-quantity-set",
    ]);
    expect(h.eventsOn(`checkout.cart-${SECOND_SOURCE}`)).toEqual([
      "checkout.cart.line-added",
      "checkout.cart.line-quantity-set",
    ]);
    // An anonymous owner never enumerates claimed keys.
    expect(h.db.claimedOwnerLookups.map((call) => call.values)).toEqual([]);
  });
});

describe("claimed cart line-id-total removal", () => {
  it("clears a duplicated line id from the Account and every claimed key, then no-ops on retry", async () => {
    const h = await claimedCartRuntime(
      [claimedLine(String(CLAIMANT), "cli_everywhere")],
      [
        { ownerKey: CLAIMED_SOURCE, lineIds: ["cli_everywhere"], claimedBy: CLAIMANT },
        { ownerKey: SECOND_SOURCE, lineIds: ["cli_everywhere"], claimedBy: CLAIMANT },
        { ownerKey: String(CLAIMANT), lineIds: ["cli_everywhere"] },
      ],
    );

    const first = await h.runtime.removeLine({ accountId: CLAIMANT, lineId: "cli_everywhere" as never }, context);

    for (const owner of [String(CLAIMANT), CLAIMED_SOURCE, SECOND_SOURCE]) {
      expect((await h.cartState(owner)).lines).toEqual([]);
      expect(h.eventsOn(`checkout.cart-${owner}`).filter((type) => type === "checkout.cart.line-removed")).toHaveLength(
        1,
      );
    }
    const afterFirst = await Promise.all(
      [String(CLAIMANT), CLAIMED_SOURCE, SECOND_SOURCE].map((owner) => h.versionOf(owner)),
    );

    const second = await h.runtime.removeLine({ accountId: CLAIMANT, lineId: "cli_everywhere" as never }, context);

    expect(
      await Promise.all([String(CLAIMANT), CLAIMED_SOURCE, SECOND_SOURCE].map((owner) => h.versionOf(owner))),
    ).toEqual(afterFirst);
    // The idempotent repeat reports no stream write rather than inventing one.
    expect(first.version).toBeGreaterThan(0);
    expect(second).toEqual({ lineId: "cli_everywhere", version: 0 });
    // Both claimed keys are addressed, smallest first, on each call.
    expect(h.db.claimedOwnerLookups.map((call) => call.values)).toEqual([[CLAIMANT], [CLAIMANT]]);
  });

  it("removes a claimed-only line while leaving unrelated claimed lines untouched", async () => {
    const h = await claimedCartRuntime(
      [claimedLine(CLAIMED_SOURCE, "cli_target")],
      [
        { ownerKey: CLAIMED_SOURCE, lineIds: ["cli_target"], claimedBy: CLAIMANT },
        { ownerKey: SECOND_SOURCE, lineIds: ["cli_survivor"], claimedBy: CLAIMANT },
      ],
    );

    await h.runtime.removeLine({ accountId: CLAIMANT, lineId: "cli_target" as never }, context);

    expect((await h.cartState(CLAIMED_SOURCE)).lines).toEqual([]);
    expect((await h.cartState(SECOND_SOURCE)).lines.map((line) => line.lineId)).toEqual(["cli_survivor"]);
  });

  it("propagates an ownership refusal from a source the acting owner does not own", async () => {
    const h = await claimedCartRuntime(
      [claimedLine(CLAIMED_SOURCE, "cli_target")],
      [{ ownerKey: CLAIMED_SOURCE, lineIds: ["cli_target"], claimedBy: BYSTANDER }],
    );
    // A stale alias row naming the wrong Account must not be laundered into a
    // silent success by the missing-line absorption.
    h.db.claims.set(CLAIMED_SOURCE, { source_owner_key: CLAIMED_SOURCE, account_id: String(CLAIMANT) });

    await expect(h.runtime.removeLine({ accountId: CLAIMANT, lineId: "cli_target" as never }, context)).rejects.toThrow(
      "Cart is owned by a different account.",
    );
    expect((await h.cartState(CLAIMED_SOURCE)).lines.map((line) => line.lineId)).toEqual(["cli_target"]);
  });

  it("keeps unclaimed removal on the acting stream alone", async () => {
    const h = await claimedCartRuntime(
      [claimedLine(SECOND_SOURCE, "cli_anonymous_only")],
      [{ ownerKey: SECOND_SOURCE, lineIds: ["cli_anonymous_only"] }],
    );

    const result = await h.runtime.removeLine(
      { accountId: SECOND_SOURCE as never, lineId: "cli_anonymous_only" as never },
      context,
    );

    expect(result).toEqual({ lineId: "cli_anonymous_only", version: 2 });
    expect(h.eventsOn(`checkout.cart-${SECOND_SOURCE}`)).toEqual([
      "checkout.cart.line-added",
      "checkout.cart.line-removed",
    ]);
    expect(h.db.claimedOwnerLookups).toEqual([]);
  });
});

describe("claimed cart write refusal surfaces", () => {
  async function claimedHarness() {
    return claimedCartRuntime(
      [claimedLine(CLAIMED_SOURCE, "cli_claimed")],
      [{ ownerKey: CLAIMED_SOURCE, lineIds: ["cli_claimed"], claimedBy: CLAIMANT }],
    );
  }

  const addParams = (accountId: string) => ({
    accountId: accountId as never,
    catalogItemId: "cat_2",
    productId: "cat_2::",
    itemTitle: "Blastoise",
    itemSubtitle: null,
    itemImageUrl: null,
    selectedOptions: [],
    productSummary: null,
    quantity: 1,
  });

  it("refuses all five anonymous write surfaces once the key is claimed", async () => {
    const h = await claimedHarness();
    const before = await h.versionOf(CLAIMED_SOURCE);
    const refusal = "Cart is owned by a different account.";

    await expect(h.runtime.addLine(addParams(CLAIMED_SOURCE), context)).rejects.toThrow(refusal);
    await expect(
      h.runtime.addLines(
        { accountId: CLAIMED_SOURCE as never, lines: [{ ...addParams(CLAIMED_SOURCE) }] as never },
        context,
      ),
    ).rejects.toThrow(refusal);
    await expect(
      h.runtime.setLineQuantity(
        { accountId: CLAIMED_SOURCE as never, lineId: "cli_claimed" as never, quantity: 2 },
        context,
      ),
    ).rejects.toThrow(refusal);
    await expect(
      h.runtime.setLineFulfillment(
        { accountId: CLAIMED_SOURCE as never, lineId: "cli_claimed" as never, fulfillmentMode: "optimize" },
        context,
      ),
    ).rejects.toThrow(refusal);
    await expect(
      h.runtime.removeLine({ accountId: CLAIMED_SOURCE as never, lineId: "cli_claimed" as never }, context),
    ).rejects.toThrow(refusal);

    expect(await h.versionOf(CLAIMED_SOURCE)).toBe(before);
    expect(h.db.claims.get(CLAIMED_SOURCE)).toEqual({
      source_owner_key: CLAIMED_SOURCE,
      account_id: String(CLAIMANT),
    });
  });

  it("still refuses the anonymous key after the alias row is deleted", async () => {
    const h = await claimedHarness();
    const before = await h.versionOf(CLAIMED_SOURCE);
    // Authorization is the claimed stream's own event history; the alias is a
    // routing index that can vanish without granting anything back.
    h.db.claims.delete(CLAIMED_SOURCE);

    await expect(
      h.runtime.setLineQuantity(
        { accountId: CLAIMED_SOURCE as never, lineId: "cli_claimed" as never, quantity: 2 },
        context,
      ),
    ).rejects.toThrow("Cart is owned by a different account.");
    await expect(
      h.runtime.removeLine({ accountId: CLAIMED_SOURCE as never, lineId: "cli_claimed" as never }, context),
    ).rejects.toThrow("Cart is owned by a different account.");
    expect(await h.versionOf(CLAIMED_SOURCE)).toBe(before);
    expect(h.db.claims.size).toBe(0);
  });

  it("refuses an Account that has not claimed the key, leaving claim rows and both versions intact", async () => {
    const h = await claimedHarness();
    const before = { claimed: await h.versionOf(CLAIMED_SOURCE), bystander: await h.versionOf(String(BYSTANDER)) };

    // The bystander sees no claimed row, so routing falls back to its own
    // stream and the aggregate refuses there.
    await expect(
      h.runtime.setLineQuantity({ accountId: BYSTANDER, lineId: "cli_claimed" as never, quantity: 2 }, context),
    ).rejects.toThrow("Cart line not found.");
    await expect(
      h.runtime.setLineFulfillment(
        { accountId: BYSTANDER, lineId: "cli_claimed" as never, fulfillmentMode: "optimize" },
        context,
      ),
    ).rejects.toThrow("Cart line not found.");
    expect(await h.runtime.removeLine({ accountId: BYSTANDER, lineId: "cli_claimed" as never }, context)).toEqual({
      lineId: "cli_claimed",
      version: 0,
    });

    expect(await h.versionOf(CLAIMED_SOURCE)).toBe(before.claimed);
    expect(await h.versionOf(String(BYSTANDER))).toBe(before.bystander);
    expect(h.db.claims.get(CLAIMED_SOURCE)).toEqual({
      source_owner_key: CLAIMED_SOURCE,
      account_id: String(CLAIMANT),
    });
    expect((await h.cartState(CLAIMED_SOURCE)).lines.map((line) => line.lineId)).toEqual(["cli_claimed"]);
  });
});

describe("claimed cart per-stream concurrency", () => {
  it("commits exactly one event when the claimant and the retained key race the same stream", async () => {
    const h = await claimedCartRuntime(
      [claimedLine(CLAIMED_SOURCE, "cli_claimed")],
      [{ ownerKey: CLAIMED_SOURCE, lineIds: ["cli_claimed"], claimedBy: CLAIMANT }],
    );
    const before = await h.versionOf(CLAIMED_SOURCE);

    const [claimant, anonymous] = await Promise.allSettled([
      h.runtime.setLineQuantity({ accountId: CLAIMANT, lineId: "cli_claimed" as never, quantity: 7 }, context),
      h.runtime.setLineQuantity(
        { accountId: CLAIMED_SOURCE as never, lineId: "cli_claimed" as never, quantity: 8 },
        context,
      ),
    ]);

    expect(claimant.status).toBe("fulfilled");
    expect(anonymous.status).toBe("rejected");
    expect((anonymous as PromiseRejectedResult).reason.message).toBe("Cart is owned by a different account.");
    expect(await h.versionOf(CLAIMED_SOURCE)).toBe(before + 1);
    expect((await h.cartState(CLAIMED_SOURCE)).lines[0]?.quantity).toBe(7);
  });

  it("serializes two claimant writes through expected-version conflict and converges on one retry", async () => {
    const h = await claimedCartRuntime(
      [claimedLine(CLAIMED_SOURCE, "cli_a"), claimedLine(CLAIMED_SOURCE, "cli_b")],
      [{ ownerKey: CLAIMED_SOURCE, lineIds: ["cli_a", "cli_b"], claimedBy: CLAIMANT }],
    );
    // Both writers loaded the claimed stream at this version, targeting
    // different lines of it.
    const loadedVersion = await h.versionOf(CLAIMED_SOURCE);

    const winner = await h.runtime.setLineQuantity(
      { accountId: CLAIMANT, lineId: "cli_b" as never, quantity: 3 },
      context,
    );
    // The loser appends at its own now-stale loaded version.
    const conflict = await h.runtime
      .commandHandler({
        streamId: `checkout.cart-${CLAIMED_SOURCE}`,
        expectedVersion: loadedVersion,
        command: { type: "SetCartLineQuantity", actingOwnerKey: CLAIMANT, lineId: "cli_a" as never, quantity: 2 },
        context,
      })
      .then(
        () => null,
        (error: unknown) => error,
      );

    expect(winner.version).toBe(loadedVersion + 1);
    // A real rejection carrying the store's own conflict code, not a lost write.
    expect(conflict).toMatchObject({ code: "concurrency_conflict" });
    expect(await h.versionOf(CLAIMED_SOURCE)).toBe(loadedVersion + 1);

    const retried = await h.runtime.setLineQuantity(
      { accountId: CLAIMANT, lineId: "cli_a" as never, quantity: 2 },
      context,
    );

    expect(retried.version).toBe(loadedVersion + 2);
    const lines = (await h.cartState(CLAIMED_SOURCE)).lines;
    expect(lines.find((line) => line.lineId === "cli_a")?.quantity).toBe(2);
    expect(lines.find((line) => line.lineId === "cli_b")?.quantity).toBe(3);
  });
});

describe("checkout cart post-claim read authority runtime", () => {
  const SOURCE = "anon_synthetic_claimed";
  const OWNER = "acc_synthetic_owner";
  const OTHER = "acc_synthetic_other";

  function authorityDb(rowsFor: (requestedOwners: readonly string[]) => CheckoutCartLineRow[] = () => []) {
    return {
      query: vi.fn(async (sql: string, values: readonly unknown[] = []) => {
        if (sql.includes("WHERE claim.account_id = $1")) {
          return { rows: [], rowCount: 0 };
        }
        if (sql.includes("WITH requested_owners")) {
          const requested = [values[0], values[1]].filter((value): value is string => typeof value === "string");
          const rows = rowsFor(requested);
          return { rows, rowCount: rows.length };
        }
        throw new Error(`unexpected SQL: ${sql}`);
      }),
    };
  }

  async function claimedRuntime(db: ReturnType<typeof authorityDb> = authorityDb()) {
    const memory = createInMemoryEventStore();
    const runtime = createCheckoutCartRuntime({ eventStore: memory.eventStore, checkpointStore: {} as never, db });
    await runtime.commandHandler({
      streamId: `checkout.cart-${SOURCE}`,
      context,
      command: { type: "ClaimCart", sourceOwnerKey: SOURCE, accountId: OWNER as never },
    });
    return { memory, runtime };
  }

  it("returns each authority outcome from complete aggregate state", async () => {
    const { runtime } = await claimedRuntime();

    await expect(
      runtime.resolveCartSourceAuthority({ actingOwnerKey: OWNER, presentedAnonymousCartId: SOURCE }),
    ).resolves.toEqual({ status: "accepted", acceptedVia: "account" });
    await expect(
      runtime.resolveCartSourceAuthority({ actingOwnerKey: OTHER, presentedAnonymousCartId: SOURCE }),
    ).resolves.toEqual({ status: "refused", clearRetainedAnonymousCartCookie: true });
    await expect(
      runtime.resolveCartSourceAuthority({ actingOwnerKey: OTHER, presentedAnonymousCartId: "anon_synthetic_free" }),
    ).resolves.toEqual({ status: "accepted", acceptedVia: "possession" });
  });

  it("never consults the claim alias while deciding authority", async () => {
    // A claim event is committed and the alias table is empty -- the
    // event-first, alias-absent window #5731 deliberately leaves open. The
    // claimant must still be admitted and the stranger must still be refused.
    const db = authorityDb();
    const { runtime } = await claimedRuntime(db);
    const aliasCallsBefore = db.query.mock.calls.length;

    await expect(
      runtime.resolveCartSourceAuthority({ actingOwnerKey: OWNER, presentedAnonymousCartId: SOURCE }),
    ).resolves.toEqual({ status: "accepted", acceptedVia: "account" });
    await expect(
      runtime.resolveCartSourceAuthority({ actingOwnerKey: OTHER, presentedAnonymousCartId: SOURCE }),
    ).resolves.toEqual({ status: "refused", clearRetainedAnonymousCartCookie: true });

    // Not one database round trip was needed to decide either answer.
    expect(db.query.mock.calls.length).toBe(aliasCallsBefore);
  });

  it("reports a store failure as retryable indeterminate and re-reads authority on the next attempt", async () => {
    const memory = createInMemoryEventStore();
    let failNextRead = false;
    const failingEventStore = {
      ...memory.eventStore,
      readStream: async (input: Parameters<typeof memory.eventStore.readStream>[0]) => {
        if (failNextRead) {
          failNextRead = false;
          throw new Error("event store unavailable");
        }
        return memory.eventStore.readStream(input);
      },
    };
    const runtime = createCheckoutCartRuntime({
      eventStore: failingEventStore,
      checkpointStore: {} as never,
      db: authorityDb(),
    });
    await runtime.commandHandler({
      streamId: `checkout.cart-${SOURCE}`,
      context,
      command: { type: "ClaimCart", sourceOwnerKey: SOURCE, accountId: OWNER as never },
    });

    failNextRead = true;
    const first = await runtime.resolveCartSourceAuthority({
      actingOwnerKey: OTHER,
      presentedAnonymousCartId: SOURCE,
    });
    const retry = await runtime.resolveCartSourceAuthority({
      actingOwnerKey: OTHER,
      presentedAnonymousCartId: SOURCE,
    });
    const claimantRetry = await runtime.resolveCartSourceAuthority({
      actingOwnerKey: OWNER,
      presentedAnonymousCartId: SOURCE,
    });

    expect(first).toEqual({ status: "indeterminate" });
    // Indeterminate carries no cookie-clear classification, is not a refusal,
    // and is not remembered: the retry re-reads authority and decides.
    expect(first).not.toEqual({ status: "refused", clearRetainedAnonymousCartCookie: true });
    expect(Object.hasOwn(first, "clearRetainedAnonymousCartCookie")).toBe(false);
    expect(retry).toEqual({ status: "refused", clearRetainedAnonymousCartCookie: true });
    expect(claimantRetry).toEqual({ status: "accepted", acceptedVia: "account" });
  });

  it("goes red against a bypass that treats a failed authority read as an unclaimed cart", async () => {
    const memory = createInMemoryEventStore();
    const runtime = createCheckoutCartRuntime({
      eventStore: {
        ...memory.eventStore,
        readStream: async () => {
          throw new Error("event store unavailable");
        },
      },
      checkpointStore: {} as never,
      db: authorityDb(() => [readyLine({ buyer_account_id: SOURCE, line_id: "cli_claimed" })]),
    });

    const authority = await runtime.resolveCartSourceAuthority({
      actingOwnerKey: OTHER,
      presentedAnonymousCartId: SOURCE,
    });
    const lines = await runtime.listAuthorizedCartLines({ accountId: SOURCE });
    const bypassed =
      authority.status === "indeterminate" ? { status: "accepted", acceptedVia: "possession" } : authority;

    expect(authority).toEqual({ status: "indeterminate" });
    expect(bypassed).not.toEqual(authority);
    // Fail-closed all the way through the read: an unreadable authority yields
    // no line, even though the projection is holding one.
    expect(lines).toEqual([]);
  });

  it("contributes the claimant's own claimed source exactly once when it is also presented", async () => {
    const db = authorityDb((requested) =>
      requested.includes(SOURCE) ? [readyLine({ buyer_account_id: SOURCE, line_id: "cli_shared" })] : [],
    );
    const { runtime } = await claimedRuntime(db);

    const presented = await runtime.createReadinessSnapshot({
      accountId: OWNER,
      presentedAnonymousCartId: SOURCE,
    });
    const unionCall = db.query.mock.calls.at(-1);

    // One resolved union query, with the presented key passed through as the
    // single presented owner. The read model dedups a key that is both claimed
    // and presented, so the snapshot reflects one contribution of that source.
    expect(unionCall?.[1]?.[0]).toBe(OWNER);
    expect(unionCall?.[1]?.[1]).toBe(SOURCE);
    expect(presented.includedLineIds).toEqual(["cli_shared"]);
    expect(presented.lineCount).toBe(1);
  });

  it("drops a foreign presented source from readiness and keeps the acting Account revision", async () => {
    const db = authorityDb((requested) => {
      const rows: CheckoutCartLineRow[] = [];
      if (requested.includes(OTHER)) {
        rows.push(readyLine({ buyer_account_id: OTHER, line_id: "cli_own" }));
      }
      if (requested.includes(SOURCE)) {
        rows.push(readyLine({ buyer_account_id: SOURCE, line_id: "cli_claimed" }));
      }
      return rows;
    });
    const { runtime } = await claimedRuntime(db);

    const withForeignKey = await runtime.createReadinessSnapshot({
      accountId: OTHER,
      presentedAnonymousCartId: SOURCE,
    });
    const accountOnly = await runtime.createReadinessSnapshot({ accountId: OTHER });

    // Same snapshot id and source revision as the Account-only read: the
    // refused key contributed nothing, so it cannot even shift the revision.
    expect(withForeignKey).toEqual(accountOnly);
    expect(withForeignKey.includedLineIds).toEqual(["cli_own"]);
  });

  it("returns the unclaimed-empty readiness snapshot for a guest whose cart was claimed", async () => {
    const db = authorityDb((requested) =>
      requested.includes(SOURCE) ? [readyLine({ buyer_account_id: SOURCE, line_id: "cli_claimed" })] : [],
    );
    const { runtime } = await claimedRuntime(db);

    const refused = await runtime.createReadinessSnapshot({ accountId: SOURCE });
    const unclaimedEmpty = await runtime.createReadinessSnapshot({ accountId: "anon_synthetic_absent" });

    expect(refused).toEqual(unclaimedEmpty);
    expect(refused.status).toBe("blocked");
    expect(refused.includedLineIds).toEqual([]);
    expect(await runtime.listAuthorizedCartLines({ accountId: SOURCE })).toEqual([]);
  });

  it("keeps the raw union read available to internal write routing", async () => {
    const db = authorityDb((requested) =>
      requested.includes(SOURCE) ? [readyLine({ buyer_account_id: SOURCE, line_id: "cli_claimed" })] : [],
    );
    const { runtime } = await claimedRuntime(db);

    // #7121 mutation routing still needs to see which stream holds a line, so
    // the internal read keeps its provenance. Only the authorized read narrows.
    const internal = await runtime.listCartLines(SOURCE);

    expect(internal.map((line) => line.buyer_account_id)).toEqual([SOURCE]);
    expect(await runtime.listAuthorizedCartLines({ accountId: SOURCE })).toEqual([]);
  });
});
