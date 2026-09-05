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
      actingOwnerKey: "acc_buyer",
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
      actingOwnerKey: "acc_buyer",
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
        actingOwnerKey: "acc_same",
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
    // The line is added while the cart is still anonymous, which is the only way
    // a claimed source stream ever gains one: after the claim the anonymous key
    // may no longer write, and the claimant's own adds address its Account
    // stream instead of this one.
    const unclaimed = decideCheckoutCart(anonymousCartWithOneLine(), {
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
    }).reduce(evolveCheckoutCart, anonymousCartWithOneLine());
    const claimed = decideCheckoutCart(unclaimed, claim()).reduce(evolveCheckoutCart, unclaimed);

    const afterQuantity = decideCheckoutCart(claimed, {
      type: "SetCartLineQuantity",
      actingOwnerKey: CLAIMANT,
      lineId: "cli_2" as never,
      quantity: 3,
    }).reduce(evolveCheckoutCart, claimed);
    const afterFulfillment = decideCheckoutCart(afterQuantity, {
      type: "SetCartLineFulfillment",
      actingOwnerKey: CLAIMANT,
      lineId: "cli_2" as never,
      fulfillmentMode: "optimize",
    }).reduce(evolveCheckoutCart, afterQuantity);
    const afterRemoval = decideCheckoutCart(afterFulfillment, {
      type: "RemoveCartLine",
      actingOwnerKey: CLAIMANT,
      lineId: "cli_2" as never,
    }).reduce(evolveCheckoutCart, afterFulfillment);
    const afterCheckout = decideCheckoutCart(afterRemoval, {
      type: "CheckoutCart",
      checkedOutAt: "2026-09-03T00:00:00.000Z",
    }).reduce(evolveCheckoutCart, afterRemoval);

    for (const state of [claimed, afterQuantity, afterFulfillment, afterRemoval, afterCheckout]) {
      expect(state.claimedByAccountId).toBe(CLAIMANT);
      expect(state.buyerAccountId).toBe(SOURCE);
    }
    expect(afterQuantity.lines.find((line) => line.lineId === "cli_2")?.quantity).toBe(3);
    expect(afterRemoval.lines.map((line) => line.lineId)).toEqual(["cli_1"]);
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

/**
 * Unmistakably synthetic claimed-cart identities. `anon_synthetic_claimed` is
 * the retained anonymous source key, `acc_synthetic_claimant` the Account that
 * claimed it, and `acc_synthetic_other_seller` an unrelated seller.
 */
const CLAIMED_SOURCE = "anon_synthetic_claimed";
const CLAIMANT_ACCOUNT = "acc_synthetic_claimant";
const OTHER_SELLER_ACCOUNT = "acc_synthetic_other_seller";
const OTHER_ACCOUNT = "acc_synthetic_bystander";

function claimedCartWithOneLine(): CheckoutCartState {
  const unclaimed = anonymousCartWithOneLine(CLAIMED_SOURCE);
  return decideCheckoutCart(unclaimed, {
    type: "ClaimCart",
    sourceOwnerKey: CLAIMED_SOURCE,
    accountId: CLAIMANT_ACCOUNT as never,
  }).reduce(evolveCheckoutCart, unclaimed);
}

function lockToSeller(actingOwnerKey: string, sellerAccountId: string): CheckoutCartCommand {
  return {
    type: "SetCartLineFulfillment",
    actingOwnerKey,
    lineId: "cli_1" as never,
    fulfillmentMode: "locked-listing",
    lockedListingId: "lst_selected",
    selectedListingSnapshot: {
      listingId: "lst_selected",
      sellerAccountId,
      priceAmount: "25.00",
      source: "account-cart-fulfillment",
    },
  } as CheckoutCartCommand;
}

describe("claimed cart write authorization", () => {
  it("authorizes the claimant and refuses the retained anonymous key on every mutation", () => {
    const claimed = claimedCartWithOneLine();
    const mutations: ReadonlyArray<(actingOwnerKey: string) => CheckoutCartCommand> = [
      (actingOwnerKey) =>
        ({ type: "SetCartLineQuantity", actingOwnerKey, lineId: "cli_1", quantity: 4 }) as CheckoutCartCommand,
      (actingOwnerKey) =>
        ({
          type: "SetCartLineFulfillment",
          actingOwnerKey,
          lineId: "cli_1",
          fulfillmentMode: "optimize",
        }) as CheckoutCartCommand,
      (actingOwnerKey) => ({ type: "RemoveCartLine", actingOwnerKey, lineId: "cli_1" }) as CheckoutCartCommand,
    ];

    for (const mutation of mutations) {
      expect(decideCheckoutCart(claimed, mutation(CLAIMANT_ACCOUNT))).toHaveLength(1);
      // The key that wrote every one of these lines no longer commands them.
      expect(() => decideCheckoutCart(claimed, mutation(CLAIMED_SOURCE))).toThrow(
        "Cart is owned by a different account.",
      );
      expect(() => decideCheckoutCart(claimed, mutation(OTHER_ACCOUNT))).toThrow(
        "Cart is owned by a different account.",
      );
    }

    // Add events retain their source identity, so neither the retained key nor
    // the effective claimant may add to the claimed source stream.
    for (const buyerAccountId of [CLAIMED_SOURCE, CLAIMANT_ACCOUNT]) {
      expect(() =>
        decideCheckoutCart(claimed, {
          type: "AddCartLine",
          buyerAccountId: buyerAccountId as never,
          lineId: `cli_smuggled_${buyerAccountId}` as never,
          catalogItemId: "cat_1",
          productId: "cat_1::" as never,
          itemTitle: "Charizard",
          itemSubtitle: null,
          itemImageUrl: null,
          selectedOptions: [],
          productSummary: null,
          quantity: 1,
        }),
      ).toThrow("Cart is owned by a different account.");
    }
    expect(claimed).toEqual(claimedCartWithOneLine());
  });

  it("refuses an unauthorized writer before it can learn whether the line exists", () => {
    const claimed = claimedCartWithOneLine();

    // A missing line and an unauthorized writer must stay distinguishable: a
    // line-id-total sweep absorbs the first and must never absorb the second.
    expect(() =>
      decideCheckoutCart(claimed, {
        type: "RemoveCartLine",
        actingOwnerKey: CLAIMED_SOURCE,
        lineId: "cli_absent" as never,
      }),
    ).toThrow("Cart is owned by a different account.");
    expect(() =>
      decideCheckoutCart(claimed, {
        type: "RemoveCartLine",
        actingOwnerKey: CLAIMANT_ACCOUNT,
        lineId: "cli_absent" as never,
      }),
    ).toThrow("Cart line not found.");
  });

  it("decides authorization from claim-evolved state alone, with no alias or projection input", () => {
    // The decider is a pure function of the event-sourced state: this is the
    // same refusal an alias-row deletion cannot undo.
    const replayed = evolveCheckoutCart(anonymousCartWithOneLine(CLAIMED_SOURCE), {
      type: "checkout.cart.claimed-by-account",
      data: { sourceOwnerKey: CLAIMED_SOURCE, accountId: CLAIMANT_ACCOUNT as never },
    } as never);

    expect(replayed.claimedByAccountId).toBe(CLAIMANT_ACCOUNT);
    expect(() =>
      decideCheckoutCart(replayed, {
        type: "SetCartLineQuantity",
        actingOwnerKey: CLAIMED_SOURCE,
        lineId: "cli_1" as never,
        quantity: 2,
      }),
    ).toThrow("Cart is owned by a different account.");
  });

  it("compares the own-listing invariant against the effective claimant, not the retained key", () => {
    const claimed = claimedCartWithOneLine();

    // Same seller as the claiming Account: refused with the existing message.
    expect(() => decideCheckoutCart(claimed, lockToSeller(CLAIMANT_ACCOUNT, CLAIMANT_ACCOUNT))).toThrow(
      "Accounts cannot add their own listings to cart.",
    );
    // Otherwise identical, different seller: exactly one event.
    const accepted = decideCheckoutCart(claimed, lockToSeller(CLAIMANT_ACCOUNT, OTHER_SELLER_ACCOUNT));
    expect(accepted).toHaveLength(1);
    expect(accepted[0]).toMatchObject({
      type: "checkout.cart.line-fulfillment-set",
      data: { lockedListingId: "lst_selected", selectedListingSnapshot: { sellerAccountId: OTHER_SELLER_ACCOUNT } },
    });
  });

  it("keeps unclaimed carts on their own identity for the own-listing invariant", () => {
    const unclaimedAnonymous = anonymousCartWithOneLine(CLAIMED_SOURCE);

    // Before the claim the same listing is lockable: the invariant follows the
    // effective owner, and this cart has no Account owner yet.
    expect(decideCheckoutCart(unclaimedAnonymous, lockToSeller(CLAIMED_SOURCE, CLAIMANT_ACCOUNT))).toHaveLength(1);

    // The pre-existing unclaimed Account refusal is untouched.
    const accountCart = decideCheckoutCart(initialCheckoutCartState, {
      type: "AddCartLine",
      buyerAccountId: CLAIMANT_ACCOUNT as never,
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
    expect(() => decideCheckoutCart(accountCart, lockToSeller(CLAIMANT_ACCOUNT, CLAIMANT_ACCOUNT))).toThrow(
      "Accounts cannot add their own listings to cart.",
    );
    expect(decideCheckoutCart(accountCart, lockToSeller(CLAIMANT_ACCOUNT, OTHER_SELLER_ACCOUNT))).toHaveLength(1);
  });

  it("leaves every no-claim mutation decision unchanged", () => {
    const anonymous = anonymousCartWithOneLine(CLAIMED_SOURCE);
    const account = decideCheckoutCart(initialCheckoutCartState, {
      type: "AddCartLine",
      buyerAccountId: CLAIMANT_ACCOUNT as never,
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

    for (const [owner, state] of [
      [CLAIMED_SOURCE, anonymous],
      [CLAIMANT_ACCOUNT, account],
    ] as const) {
      expect(
        decideCheckoutCart(state, {
          type: "SetCartLineQuantity",
          actingOwnerKey: owner,
          lineId: "cli_1" as never,
          quantity: 5,
        }),
      ).toEqual([{ type: "checkout.cart.line-quantity-set", data: { lineId: "cli_1", quantity: 5 } }]);
      expect(
        decideCheckoutCart(state, { type: "RemoveCartLine", actingOwnerKey: owner, lineId: "cli_1" as never }),
      ).toEqual([{ type: "checkout.cart.line-removed", data: { lineId: "cli_1" } }]);
      // An uninitialized stream still refuses with the missing-line message.
      expect(() =>
        decideCheckoutCart(initialCheckoutCartState, {
          type: "RemoveCartLine",
          actingOwnerKey: owner,
          lineId: "cli_1" as never,
        }),
      ).toThrow("Cart line not found.");
    }
  });
});
