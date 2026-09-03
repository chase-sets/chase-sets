import { describe, expect, it } from "vitest";
import {
  decideCheckoutCart,
  evolveCheckoutCart,
  initialCheckoutCartState,
  type CheckoutCartCommand,
  type CheckoutCartState,
} from "./domain";

describe("checkout cart domain", () => {
  it("adds, updates, removes, and clears cart lines on checkout", () => {
    const added = decideCheckoutCart(initialCheckoutCartState, {
      type: "AddCartLine",
      buyerAccountId: "acc_buyer" as never,
      lineId: "cli_1" as never,
      catalogItemId: "cat_1",
      productId: "cat_1::" as never,
      itemLanguageCode: "ja",
      itemTitle: "Charizard",
      itemSubtitle: "Base Set",
      itemImageUrl: null,
      selectedOptions: [{ dimensionId: "form", optionId: "raw" }],
      productSummary: "Form: Raw",
      quantity: 1,
    });
    const addedState = added.reduce(evolveCheckoutCart, initialCheckoutCartState);
    const updated = decideCheckoutCart(addedState, {
      type: "SetCartLineQuantity",
      lineId: "cli_1" as never,
      quantity: 2,
    });
    const updatedState = updated.reduce(evolveCheckoutCart, addedState);

    expect(updatedState.lines).toHaveLength(1);
    expect(added[0]).toMatchObject({ data: { itemLanguageCode: "ja" } });
    expect(addedState.lines[0]?.itemLanguageCode).toBe("ja");
    expect(updatedState.lines[0]?.quantity).toBe(2);

    const removed = decideCheckoutCart(updatedState, {
      type: "RemoveCartLine",
      lineId: "cli_1" as never,
    });
    const removedState = removed.reduce(evolveCheckoutCart, updatedState);
    expect(removedState.lines).toHaveLength(0);

    const repopulated = decideCheckoutCart(removedState, {
      type: "AddCartLine",
      buyerAccountId: "acc_buyer" as never,
      lineId: "cli_2" as never,
      catalogItemId: "cat_1",
      productId: "cat_1::" as never,
      itemTitle: "Charizard",
      itemSubtitle: null,
      itemImageUrl: null,
      selectedOptions: [],
      productSummary: null,
      quantity: 1,
    }).reduce(evolveCheckoutCart, removedState);

    const checkedOut = decideCheckoutCart(repopulated, {
      type: "CheckoutCart",
      checkedOutAt: "2026-03-31T00:00:00.000Z",
    }).reduce(evolveCheckoutCart, repopulated);

    expect(checkedOut.lines).toEqual([]);
    expect(checkedOut.lastCheckedOutAt).toBe("2026-03-31T00:00:00.000Z");
  });

  it("persists selected listing snapshots on locked cart lines", () => {
    const [event] = decideCheckoutCart(initialCheckoutCartState, {
      type: "AddCartLine",
      buyerAccountId: "acc_buyer" as never,
      lineId: "cli_1" as never,
      catalogItemId: "cat_1",
      productId: "cat_1::" as never,
      itemTitle: "Charizard",
      itemSubtitle: null,
      itemImageUrl: null,
      selectedOptions: [],
      productSummary: null,
      quantity: 1,
      fulfillmentMode: "locked-listing",
      lockedListingId: "lst_selected",
      sellerPreferenceId: "lst_selected",
      selectedListingSnapshot: {
        listingId: "lst_selected",
        sellerAccountId: "acc_seller",
        sellerDisplayName: "Card Vault",
        sellerSlug: "card-vault",
        priceAmount: "25",
        source: "discovery.item-detail.add-to-cart",
      },
    });
    const state = event ? evolveCheckoutCart(initialCheckoutCartState, event) : initialCheckoutCartState;

    expect(event).toMatchObject({
      data: {
        lockedListingId: "lst_selected",
        selectedListingSnapshot: {
          listingId: "lst_selected",
          sellerAccountId: "acc_seller",
          sellerDisplayName: "Card Vault",
          sellerSlug: "card-vault",
          priceAmount: "25.00",
          source: "discovery.item-detail.add-to-cart",
        },
      },
    });
    expect(state.lines[0]?.selectedListingSnapshot).toMatchObject({
      listingId: "lst_selected",
      priceAmount: "25.00",
    });
  });

  it("rejects adding the buyer account's own listing to cart", () => {
    expect(() =>
      decideCheckoutCart(initialCheckoutCartState, {
        type: "AddCartLine",
        buyerAccountId: "acc_same" as never,
        lineId: "cli_1" as never,
        catalogItemId: "cat_1",
        productId: "cat_1::" as never,
        itemTitle: "Charizard",
        itemSubtitle: null,
        itemImageUrl: null,
        selectedOptions: [],
        productSummary: null,
        quantity: 1,
        fulfillmentMode: "locked-listing",
        lockedListingId: "lst_selected",
        selectedListingSnapshot: {
          listingId: "lst_selected",
          sellerAccountId: "acc_same",
          priceAmount: "25.00",
          source: "discovery.item-detail.add-to-cart",
        },
      }),
    ).toThrow("Accounts cannot add their own listings to cart.");
  });

  it("rejects locking an existing cart line to the buyer account's own listing", () => {
    const addedState = decideCheckoutCart(initialCheckoutCartState, {
      type: "AddCartLine",
      buyerAccountId: "acc_same" as never,
      lineId: "cli_1" as never,
      catalogItemId: "cat_1",
      productId: "cat_1::" as never,
      itemTitle: "Charizard",
      itemSubtitle: null,
      itemImageUrl: null,
      selectedOptions: [],
      productSummary: null,
      quantity: 1,
    }).reduce(evolveCheckoutCart, initialCheckoutCartState);

    expect(() =>
      decideCheckoutCart(addedState, {
        type: "SetCartLineFulfillment",
        lineId: "cli_1" as never,
        fulfillmentMode: "locked-listing",
        lockedListingId: "lst_selected",
        selectedListingSnapshot: {
          listingId: "lst_selected",
          sellerAccountId: "acc_same",
          priceAmount: "25.00",
          source: "account-cart-fulfillment",
        },
      }),
    ).toThrow("Accounts cannot add their own listings to cart.");
  });

  it("rejects invalid cart line operations", () => {
    expect(() =>
      decideCheckoutCart(initialCheckoutCartState, {
        type: "AddCartLine",
        buyerAccountId: "acc_buyer" as never,
        lineId: "cli_1" as never,
        catalogItemId: "cat_1",
        productId: "cat_1::" as never,
        itemTitle: "Charizard",
        itemSubtitle: null,
        itemImageUrl: null,
        selectedOptions: [],
        productSummary: null,
        quantity: 0,
      }),
    ).toThrow("Cart quantity must be a positive whole number.");

    expect(() =>
      decideCheckoutCart(initialCheckoutCartState, {
        type: "CheckoutCart",
        checkedOutAt: "2026-03-31T00:00:00.000Z",
      }),
    ).toThrow("Cart has not been initialized.");

    expect(() =>
      decideCheckoutCart(initialCheckoutCartState, {
        type: "AddCartLine",
        buyerAccountId: "acc_buyer" as never,
        lineId: "cli_2" as never,
        catalogItemId: "cat_1",
        productId: "cat_1::" as never,
        itemTitle: "Charizard",
        itemSubtitle: null,
        itemImageUrl: null,
        selectedOptions: [],
        productSummary: null,
        quantity: 1,
        fulfillmentMode: "locked-listing",
        lockedListingId: "lst_selected",
        selectedListingSnapshot: {
          listingId: "lst_other",
          priceAmount: "25.00",
          source: "discovery.item-detail.add-to-cart",
        },
      }),
    ).toThrow("Selected listing snapshot must match the locked listing.");
  });
});

const SOURCE = "anon_cart_a";
const CLAIMANT = "acc_buyer" as never;

function claim(overrides: Partial<{ sourceOwnerKey: unknown; accountId: unknown }> = {}) {
  return {
    type: "ClaimCart",
    sourceOwnerKey: SOURCE,
    accountId: CLAIMANT,
    ...overrides,
  } as CheckoutCartCommand;
}

function anonymousCartWithOneLine(sourceOwnerKey = SOURCE): CheckoutCartState {
  return decideCheckoutCart(initialCheckoutCartState, {
    type: "AddCartLine",
    buyerAccountId: sourceOwnerKey as never,
    lineId: "cli_1" as never,
    catalogItemId: "cat_1",
    productId: "cat_1::" as never,
    itemTitle: "Charizard",
    itemSubtitle: null,
    itemImageUrl: null,
    selectedOptions: [],
    productSummary: null,
    quantity: 1,
  }).reduce(evolveCheckoutCart, initialCheckoutCartState);
}

describe("checkout cart claim", () => {
  it("claims an unclaimed anonymous cart with exactly one event and no line copies", () => {
    const unclaimed = anonymousCartWithOneLine();

    const events = decideCheckoutCart(unclaimed, claim());
    const claimed = events.reduce(evolveCheckoutCart, unclaimed);

    expect(events).toEqual([
      {
        type: "checkout.cart.claimed-by-account",
        data: { sourceOwnerKey: SOURCE, accountId: CLAIMANT },
      },
    ]);
    expect(events.filter((event) => event.type === "checkout.cart.line-added")).toEqual([]);
    expect(claimed.claimedByAccountId).toBe(CLAIMANT);
    // Claiming moves ownership, never lines: the source keeps its own identity
    // and its existing line set is untouched.
    expect(claimed.buyerAccountId).toBe(SOURCE);
    expect(claimed.lines).toEqual(unclaimed.lines);
  });

  it("claims a valid uninitialized anonymous stream and establishes its source identity", () => {
    const events = decideCheckoutCart(initialCheckoutCartState, claim());
    const claimed = events.reduce(evolveCheckoutCart, initialCheckoutCartState);

    expect(events).toHaveLength(1);
    expect(claimed.buyerAccountId).toBe(SOURCE);
    expect(claimed.claimedByAccountId).toBe(CLAIMANT);
    expect(claimed.lines).toEqual([]);
  });

  it("returns zero events when the same account re-claims, and refuses a second account", () => {
    const unclaimed = anonymousCartWithOneLine();
    const claimed = decideCheckoutCart(unclaimed, claim()).reduce(evolveCheckoutCart, unclaimed);

    expect(decideCheckoutCart(claimed, claim())).toEqual([]);
    expect(() => decideCheckoutCart(claimed, claim({ accountId: "acc_other" }))).toThrow(
      "Cart is already claimed by a different account.",
    );
  });

  it("treats a pre-feature snapshot without a claim field as unclaimed", () => {
    // A cached aggregate snapshot written before Cart Claim has no claim field
    // at all. An absent field is an unclaimed cart, not a refusal.
    const legacySnapshot = {
      buyerAccountId: SOURCE,
      lines: [],
      lastCheckedOutAt: null,
    } as unknown as CheckoutCartState;

    const events = decideCheckoutCart(legacySnapshot, claim());

    expect(events).toHaveLength(1);
    expect(events.reduce(evolveCheckoutCart, legacySnapshot).claimedByAccountId).toBe(CLAIMANT);
  });

  it("refuses a claim addressed at an initialized stream owned by a different source", () => {
    const otherSource = anonymousCartWithOneLine("anon_cart_b");

    expect(() => decideCheckoutCart(otherSource, claim())).toThrow(
      "Cart claim source does not match the cart stream owner.",
    );
  });

  it("refuses malformed, padded, whitespace-bearing, bare-prefix, wrong-prefix and self identities", () => {
    const sourceRejections: unknown[] = [
      undefined,
      null,
      42,
      { sourceOwnerKey: SOURCE },
      "",
      "   ",
      "anon_",
      " anon_cart_a",
      "anon_cart_a ",
      "anon_cart a",
      "anon_cart\ta",
      "anon_cart\na",
      "acc_buyer",
      "cart_a",
      "ANON_cart_a",
    ];
    for (const sourceOwnerKey of sourceRejections) {
      expect(() => decideCheckoutCart(initialCheckoutCartState, claim({ sourceOwnerKey }))).toThrow(
        "Cart claim source must be an exact anonymous cart key.",
      );
    }

    const accountRejections: unknown[] = [
      undefined,
      null,
      42,
      "",
      "   ",
      "acc_",
      " acc_buyer",
      "acc_buyer ",
      "acc_bu yer",
      "anon_cart_a",
      "buyer",
      "ACC_buyer",
    ];
    for (const accountId of accountRejections) {
      expect(() => decideCheckoutCart(initialCheckoutCartState, claim({ accountId }))).toThrow(
        "Cart claim account must be an exact account id.",
      );
    }

    // Prefix-compatible synthetic and generated identifiers stay valid; no
    // strict-ULID rule is introduced here.
    for (const sourceOwnerKey of ["anon_cart_a", "anon_01J8Z5X6Q0K7Y2N3M4P5R6S7T8"]) {
      expect(decideCheckoutCart(initialCheckoutCartState, claim({ sourceOwnerKey }))).toHaveLength(1);
    }
    for (const accountId of ["acc_buyer", "acc_01J8Z5X6Q0K7Y2N3M4P5R6S7T8"]) {
      expect(decideCheckoutCart(initialCheckoutCartState, claim({ accountId }))).toHaveLength(1);
    }
  });

  it("refuses a self-claim outright", () => {
    // The exact prefixes already make source and claimant disjoint; this proves
    // the identity comparison itself is present rather than implied.
    expect(() =>
      decideCheckoutCart(initialCheckoutCartState, {
        type: "ClaimCart",
        sourceOwnerKey: "anon_same",
        accountId: "anon_same",
      } as unknown as CheckoutCartCommand),
    ).toThrow("Cart claim account must be an exact account id.");
  });

  it("retains claim state through added, quantity, fulfillment, removal and checkout evolutions", () => {
    const unclaimed = anonymousCartWithOneLine();
    const claimed = decideCheckoutCart(unclaimed, claim()).reduce(evolveCheckoutCart, unclaimed);

    const afterAdd = decideCheckoutCart(claimed, {
      type: "AddCartLine",
      buyerAccountId: SOURCE as never,
      lineId: "cli_2" as never,
      catalogItemId: "cat_2",
      productId: "cat_2::" as never,
      itemTitle: "Blastoise",
      itemSubtitle: null,
      itemImageUrl: null,
      selectedOptions: [],
      productSummary: null,
      quantity: 1,
    }).reduce(evolveCheckoutCart, claimed);
    const afterQuantity = decideCheckoutCart(afterAdd, {
      type: "SetCartLineQuantity",
      lineId: "cli_2" as never,
      quantity: 3,
    }).reduce(evolveCheckoutCart, afterAdd);
    const afterFulfillment = decideCheckoutCart(afterQuantity, {
      type: "SetCartLineFulfillment",
      lineId: "cli_2" as never,
      fulfillmentMode: "optimize",
    }).reduce(evolveCheckoutCart, afterQuantity);
    const afterRemoval = decideCheckoutCart(afterFulfillment, {
      type: "RemoveCartLine",
      lineId: "cli_2" as never,
    }).reduce(evolveCheckoutCart, afterFulfillment);
    const afterCheckout = decideCheckoutCart(afterRemoval, {
      type: "CheckoutCart",
      checkedOutAt: "2026-09-03T00:00:00.000Z",
    }).reduce(evolveCheckoutCart, afterRemoval);

    for (const state of [afterAdd, afterQuantity, afterFulfillment, afterRemoval, afterCheckout]) {
      expect(state.claimedByAccountId).toBe(CLAIMANT);
      expect(state.buyerAccountId).toBe(SOURCE);
    }
    // Clearing empties the lines and leaves ownership in place; the cleared cart
    // is still claimable-idempotent and still refuses a second account.
    expect(afterCheckout.lines).toEqual([]);
    expect(decideCheckoutCart(afterCheckout, claim())).toEqual([]);
    expect(() => decideCheckoutCart(afterCheckout, claim({ accountId: "acc_other" }))).toThrow(
      "Cart is already claimed by a different account.",
    );
  });

  it("replays an old history with no claim event as unclaimed", () => {
    const replayed = anonymousCartWithOneLine();

    expect(replayed.claimedByAccountId).toBeNull();
    expect(initialCheckoutCartState.claimedByAccountId).toBeNull();
  });

  it("claims an already-cleared cart", () => {
    const populated = anonymousCartWithOneLine();
    const cleared = decideCheckoutCart(populated, {
      type: "CheckoutCart",
      checkedOutAt: "2026-09-03T00:00:00.000Z",
    }).reduce(evolveCheckoutCart, populated);

    const claimed = decideCheckoutCart(cleared, claim()).reduce(evolveCheckoutCart, cleared);

    expect(cleared.lines).toEqual([]);
    expect(claimed.claimedByAccountId).toBe(CLAIMANT);
    expect(claimed.lines).toEqual([]);
  });
});
