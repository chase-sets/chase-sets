import { describe, expect, it } from "vitest";
import {
  applyCartReadinessToLines,
  cartReadinessDecisionsFromSnapshot,
  cartReadinessLineHasFulfillment,
  createCartReadinessSnapshot,
  parseCartReadinessDecisionInput,
  validateCartReadinessSnapshot,
  type CartReadinessLine,
} from "./readiness";

const rawProductMeasureSnapshot = {
  catalogItemId: "cat_1",
  productId: "cat_1::form:raw",
  selectedOptions: [{ dimensionId: "form", optionId: "raw" }],
  measureVersion: "pm_test_raw_v1",
  unitLengthInches: 3.5,
  unitWidthInches: 2.5,
  unitHeightInches: 0.02,
  unitWeightOunces: 0.08,
  physicalFlags: ["raw-card"],
  stackBehavior: "stackable-thickness",
  source: "profile",
  confidence: "measured",
};

const readyLine: CartReadinessLine = {
  line_id: "cli_ready",
  catalog_catalog_item_id: "cat_1",
  product_id: "cat_1::form:raw",
  item_title: "Charizard",
  quantity: 1,
  fulfillment_mode: "locked-listing",
  locked_listing_id: "lst_current",
  seller_preference_id: null,
  availability_state: "available",
  seller_options: [
    {
      listing_id: "lst_current",
      seller_account_id: "acc_seller",
      seller_display_name: "Card Vault",
      price_amount: "25.00",
      available_quantity: 1,
      product_summary: "Raw",
      product_measure_snapshot: rawProductMeasureSnapshot,
    },
  ],
  updated_at: "2026-06-09T00:00:00.000Z",
};

describe("cart readiness snapshots", () => {
  it("marks a fully assigned cart ready for checkout", () => {
    const snapshot = createCartReadinessSnapshot([readyLine]);

    expect(snapshot).toMatchObject({
      schemaVersion: "checkout.cart-readiness.v1",
      source: "cart",
      status: "ready",
      includedLineIds: ["cli_ready"],
      unresolvedLineIds: [],
      fulfillmentGroups: [
        expect.objectContaining({
          lineIds: ["cli_ready"],
          listingIds: ["lst_current"],
          sellerAccountId: "acc_seller",
          sellerDisplayName: "Card Vault",
          itemCount: 1,
          packageCount: 1,
          downstreamReferenceStatus: "not-started",
        }),
      ],
    });
    expect(snapshot.snapshotId).toMatch(/^cr_/);
    expect(snapshot.sourceRevision).toBe("cr_vqnd8s");
    expect(snapshot.snapshotId).toBe("cr_13oh49v");
    expect(snapshot.fulfillmentGroups[0]?.groupId).toMatch(/^cfg_/);
    expect(snapshot.fulfillmentGroups[0]?.supportReference).toMatch(/^CSG-/);
    expect(cartReadinessLineHasFulfillment(readyLine)).toBe(true);
  });

  it("builds separate support-safe groups for multiple sellers before checkout", () => {
    const secondSellerLine: CartReadinessLine = {
      ...readyLine,
      line_id: "cli_second",
      locked_listing_id: "lst_second",
      seller_options: [
        {
          listing_id: "lst_second",
          seller_account_id: "acc_second_seller",
          seller_display_name: "Second Seller",
          price_amount: "10.00",
          available_quantity: 2,
          product_summary: "Raw",
          product_measure_snapshot: rawProductMeasureSnapshot,
        },
      ],
    };

    const snapshot = createCartReadinessSnapshot([readyLine, secondSellerLine]);

    expect(snapshot.status).toBe("ready");
    expect(snapshot.fulfillmentGroups).toHaveLength(2);
    expect(snapshot.fulfillmentGroups.map((group) => group.sellerAccountId).sort()).toEqual([
      "acc_second_seller",
      "acc_seller",
    ]);
    expect(snapshot.fulfillmentGroups.flatMap((group) => group.lineIds).sort()).toEqual(["cli_ready", "cli_second"]);
  });

  it("blocks checkout when fulfillment is unassigned", () => {
    const unassigned: CartReadinessLine = {
      ...readyLine,
      line_id: "cli_unassigned",
      fulfillment_mode: "optimize",
      locked_listing_id: null,
      seller_options: [],
    };

    const snapshot = createCartReadinessSnapshot([readyLine, unassigned]);

    expect(snapshot.status).toBe("needs-resolution");
    expect(snapshot.unresolvedLineIds).toEqual(["cli_unassigned"]);
    expect(snapshot.fulfillmentGroups).toEqual([]);
    expect(snapshot.lineOutcomes).toContainEqual({
      lineId: "cli_unassigned",
      outcome: "checkout",
      reason: "unassigned-fulfillment",
    });
  });

  it("allows unavailable lines to stay in the cart outside checkout", () => {
    const unavailable: CartReadinessLine = {
      ...readyLine,
      line_id: "cli_waiting",
      availability_state: "waiting-for-supply",
      seller_options: [],
    };

    const snapshot = createCartReadinessSnapshot([readyLine, unavailable], {
      lineOutcomes: [{ lineId: "cli_waiting", outcome: "save-for-later" }],
    });

    expect(snapshot.status).toBe("ready");
    expect(snapshot.includedLineIds).toEqual(["cli_ready"]);
    expect(snapshot.lineOutcomes).toContainEqual({
      lineId: "cli_waiting",
      outcome: "save-for-later",
      reason: "waiting-for-supply",
    });
  });

  it("honors save and remove decisions for ready lines before checkout starts", () => {
    const saved: CartReadinessLine = { ...readyLine, line_id: "cli_saved" };
    const removed: CartReadinessLine = { ...readyLine, line_id: "cli_removed" };

    const snapshot = createCartReadinessSnapshot([readyLine, saved, removed], {
      lineOutcomes: [
        { lineId: "cli_saved", outcome: "save-for-later" },
        { lineId: "cli_removed", outcome: "removed" },
      ],
    });

    expect(snapshot.status).toBe("ready");
    expect(snapshot.includedLineIds).toEqual(["cli_ready"]);
    expect(snapshot.lineOutcomes).toContainEqual({
      lineId: "cli_saved",
      outcome: "save-for-later",
      reason: "ready",
    });
    expect(snapshot.lineOutcomes).toContainEqual({
      lineId: "cli_removed",
      outcome: "removed",
      reason: "ready",
    });
    expect(applyCartReadinessToLines([readyLine, saved, removed], snapshot)).toEqual([readyLine]);
  });

  it("surfaces optional savings and applies an accepted fulfillment selection to checkout lines", () => {
    const expensiveLockedLine: CartReadinessLine = {
      ...readyLine,
      line_id: "cli_optimized",
      locked_listing_id: "lst_expensive",
      seller_options: [
        {
          listing_id: "lst_expensive",
          seller_account_id: "acc_expensive",
          seller_display_name: "Expensive Seller",
          price_amount: "30.00",
          available_quantity: 1,
          product_summary: "Raw",
          product_measure_snapshot: rawProductMeasureSnapshot,
        },
        {
          listing_id: "lst_lower",
          seller_account_id: "acc_lower",
          seller_display_name: "Lower Seller",
          price_amount: "24.00",
          available_quantity: 1,
          product_summary: "Raw",
          product_measure_snapshot: rawProductMeasureSnapshot,
        },
      ],
    };

    const proposed = createCartReadinessSnapshot([expensiveLockedLine]);
    const accepted = createCartReadinessSnapshot([expensiveLockedLine], {
      optimization: { decision: "accepted", lineId: "cli_optimized", listingId: "lst_lower" },
    });
    const checkoutLines = applyCartReadinessToLines([expensiveLockedLine], accepted);

    expect(proposed.optimization).toMatchObject({
      available: true,
      proposedLineId: "cli_optimized",
      proposedListingId: "lst_lower",
      currentListingId: "lst_expensive",
      savingsAmount: "6.00",
    });
    expect(accepted.status).toBe("ready");
    expect(accepted.optimization.decision).toBe("accepted");
    expect(checkoutLines[0]).toMatchObject({
      fulfillment_mode: "locked-listing",
      locked_listing_id: "lst_lower",
    });
  });

  it("locks Smart Match lines to the readiness-selected listing before checkout starts", () => {
    const smartMatchLine: CartReadinessLine = {
      ...readyLine,
      line_id: "cli_smart_match",
      fulfillment_mode: "optimize",
      locked_listing_id: null,
      seller_options: [
        { ...readyLine.seller_options[0]!, listing_id: "lst_high", price_amount: "30.00" },
        { ...readyLine.seller_options[0]!, listing_id: "lst_low", price_amount: "20.00" },
      ],
    };

    const snapshot = createCartReadinessSnapshot([smartMatchLine]);
    const checkoutLines = applyCartReadinessToLines([smartMatchLine], snapshot);

    expect(snapshot.fulfillmentGroups).toHaveLength(1);
    expect(snapshot.fulfillmentGroups[0]).toMatchObject({
      lineIds: ["cli_smart_match"],
      listingIds: ["lst_low"],
      sellerAccountId: "acc_seller",
    });
    expect(checkoutLines[0]).toMatchObject({
      fulfillment_mode: "locked-listing",
      locked_listing_id: "lst_low",
    });
  });

  it("records a declined optimization while preserving the current valid fulfillment selection", () => {
    const expensiveLockedLine: CartReadinessLine = {
      ...readyLine,
      line_id: "cli_declined",
      locked_listing_id: "lst_expensive",
      seller_options: [
        { ...readyLine.seller_options[0]!, listing_id: "lst_expensive", price_amount: "30.00" },
        { ...readyLine.seller_options[0]!, listing_id: "lst_lower", price_amount: "24.00" },
      ],
    };

    const snapshot = createCartReadinessSnapshot([expensiveLockedLine], {
      optimization: { decision: "declined", lineId: "cli_declined", listingId: "lst_lower" },
    });

    expect(snapshot.status).toBe("ready");
    expect(snapshot.optimization.decision).toBe("declined");
    expect(applyCartReadinessToLines([expensiveLockedLine], snapshot)[0]?.locked_listing_id).toBe("lst_expensive");
  });

  it("replays stored customer decisions when revalidating an active checkout session", () => {
    const expensiveLockedLine: CartReadinessLine = {
      ...readyLine,
      line_id: "cli_optimized",
      locked_listing_id: "lst_expensive",
      seller_options: [
        { ...readyLine.seller_options[0]!, listing_id: "lst_expensive", price_amount: "30.00" },
        { ...readyLine.seller_options[0]!, listing_id: "lst_lower", price_amount: "24.00" },
      ],
    };
    const saved: CartReadinessLine = { ...readyLine, line_id: "cli_saved" };
    const removed: CartReadinessLine = { ...readyLine, line_id: "cli_removed" };
    const currentLines = [expensiveLockedLine, saved, removed];

    for (const decision of ["accepted", "declined"] as const) {
      const snapshot = createCartReadinessSnapshot(currentLines, {
        lineOutcomes: [
          { lineId: "cli_saved", outcome: "save-for-later" },
          { lineId: "cli_removed", outcome: "removed" },
        ],
        optimization: { decision, lineId: "cli_optimized", listingId: "lst_lower" },
      });

      const decisions = cartReadinessDecisionsFromSnapshot(snapshot);

      expect(decisions).toEqual({
        lineOutcomes: [
          { lineId: "cli_removed", outcome: "removed" },
          { lineId: "cli_saved", outcome: "save-for-later" },
        ],
        optimization: { decision, lineId: "cli_optimized", listingId: "lst_lower" },
      });
      expect(
        validateCartReadinessSnapshot(currentLines, {
          snapshotId: snapshot.snapshotId,
          sourceRevision: snapshot.sourceRevision,
          decisions,
        }).valid,
      ).toBe(true);
    }
  });

  it("parses readiness decisions without promoting malformed outcomes", () => {
    expect(
      parseCartReadinessDecisionInput({
        line_outcomes: [
          { line_id: "cli_waiting", outcome: "save-for-later" },
          { line_id: "cli_drop", outcome: "removed" },
          { line_id: "cli_bad", outcome: "checkout" },
        ],
        optimization: { decision: "accepted", line_id: "cli_1", listing_id: "lst_lower" },
      }),
    ).toEqual({
      lineOutcomes: [
        { lineId: "cli_waiting", outcome: "save-for-later" },
        { lineId: "cli_drop", outcome: "removed" },
      ],
      optimization: { decision: "accepted", lineId: "cli_1", listingId: "lst_lower" },
    });
  });

  it("rejects stale readiness tokens when cart facts change", () => {
    const snapshot = createCartReadinessSnapshot([readyLine]);
    const changedLine = {
      ...readyLine,
      quantity: 2,
      seller_options: readyLine.seller_options.map((option) => ({
        ...option,
        available_quantity: 2,
      })),
    };

    expect(
      validateCartReadinessSnapshot([changedLine], {
        snapshotId: snapshot.snapshotId,
        sourceRevision: snapshot.sourceRevision,
      }),
    ).toMatchObject({
      valid: false,
      current: { status: "ready" },
    });
  });

  it("binds union readiness to the presented source while staying stable across a semantic copy relocation", () => {
    const unionLine: CartReadinessLine = {
      ...readyLine,
      item_subtitle: "Unlimited",
      selected_options: [{ dimensionId: "form", optionId: "raw" }],
      product_summary: "Raw card",
      seller_options: [
        readyLine.seller_options[0]!,
        {
          ...readyLine.seller_options[0]!,
          listing_id: "lst_alternate",
          price_amount: "30.00",
        },
      ],
    };
    const source = { accountId: " acc_buyer ", presentedAnonymousCartId: " anon_cart_a " };
    const beforeCopy = createCartReadinessSnapshot([unionLine], undefined, source);
    const duringCopy = createCartReadinessSnapshot(
      [{ ...unionLine, updated_at: "2026-07-01T00:00:00.000Z" }],
      undefined,
      source,
    );
    const afterCopy = createCartReadinessSnapshot(
      [
        {
          ...unionLine,
          seller_options: [...unionLine.seller_options].reverse(),
          updated_at: "2026-08-01T00:00:00.000Z",
        },
      ],
      undefined,
      source,
    );

    expect(duringCopy.sourceRevision).toBe(beforeCopy.sourceRevision);
    expect(afterCopy.sourceRevision).toBe(beforeCopy.sourceRevision);
    expect(afterCopy.snapshotId).toBe(beforeCopy.snapshotId);
    expect(
      createCartReadinessSnapshot([unionLine], undefined, {
        accountId: "acc_buyer",
        presentedAnonymousCartId: "anon_cart_b",
      }).sourceRevision,
    ).not.toBe(beforeCopy.sourceRevision);
    expect(createCartReadinessSnapshot([unionLine]).sourceRevision).not.toBe(beforeCopy.sourceRevision);
  });

  it.each([
    ["catalog item", { catalog_catalog_item_id: "cat_changed" }],
    ["product", { product_id: "cat_1::form:graded" }],
    ["title", { item_title: "Changed title" }],
    ["subtitle", { item_subtitle: "Changed subtitle" }],
    ["selected options", { selected_options: [{ dimensionId: "form", optionId: "graded" }] }],
    ["product summary", { product_summary: "Changed summary" }],
    ["quantity", { quantity: 2 }],
    ["fulfillment", { fulfillment_mode: "optimize", locked_listing_id: null }],
    ["seller preference", { seller_preference_id: "lst_preferred" }],
    ["availability", { availability_state: "changed" }],
    [
      "seller option",
      {
        seller_options: readyLine.seller_options.map((option) => ({
          ...option,
          available_quantity: option.available_quantity + 1,
        })),
      },
    ],
  ] as const)("changes the union revision when the winning line %s changes", (_label, change) => {
    const source = { accountId: "acc_buyer", presentedAnonymousCartId: "anon_cart_a" };
    const baseline = createCartReadinessSnapshot([readyLine], undefined, source);
    const changed = createCartReadinessSnapshot([{ ...readyLine, ...change }], undefined, source);

    expect(changed.sourceRevision).not.toBe(baseline.sourceRevision);
  });

  it("keeps a locked line ready and offers a Save-$X proposal when a cheaper option exists", () => {
    const lockedWithCheaperAlternative: CartReadinessLine = {
      ...readyLine,
      line_id: "cli_locked_cheaper",
      locked_listing_id: "lst_current",
      seller_options: [
        { ...readyLine.seller_options[0]!, listing_id: "lst_current", price_amount: "30.00" },
        { ...readyLine.seller_options[0]!, listing_id: "lst_cheaper", price_amount: "22.00" },
      ],
    };

    const snapshot = createCartReadinessSnapshot([lockedWithCheaperAlternative]);

    expect(cartReadinessLineHasFulfillment(lockedWithCheaperAlternative)).toBe(true);
    expect(snapshot.status).toBe("ready");
    expect(snapshot.lineOutcomes).toContainEqual({
      lineId: "cli_locked_cheaper",
      outcome: "checkout",
      reason: "ready",
    });
    expect(snapshot.optimization).toMatchObject({
      available: true,
      proposedLineId: "cli_locked_cheaper",
      proposedListingId: "lst_cheaper",
      currentListingId: "lst_current",
      savingsAmount: "8.00",
    });
  });

  it("does not report a locked line ready when its listing is gone from populated options", () => {
    const goneLockedLine: CartReadinessLine = {
      ...readyLine,
      line_id: "cli_gone",
      locked_listing_id: "lst_withdrawn",
      seller_options: [{ ...readyLine.seller_options[0]!, listing_id: "lst_other", price_amount: "19.00" }],
    };

    const snapshot = createCartReadinessSnapshot([readyLine, goneLockedLine]);

    expect(cartReadinessLineHasFulfillment(goneLockedLine)).toBe(false);
    expect(snapshot.status).toBe("needs-resolution");
    expect(snapshot.includedLineIds).toEqual(["cli_ready"]);
    expect(snapshot.unresolvedLineIds).toEqual(["cli_gone"]);
    expect(snapshot.lineOutcomes).toContainEqual({
      lineId: "cli_gone",
      outcome: "checkout",
      reason: "changed",
    });
    // A gone locked listing has no current price, so it yields no Save-$X proposal of its own.
    expect(snapshot.optimization.proposedLineId).not.toBe("cli_gone");
  });

  it("blocks a locked line while its selected listing is missing from projected supply", () => {
    const lockedWithoutProjectedOptions: CartReadinessLine = {
      ...readyLine,
      line_id: "cli_no_data",
      locked_listing_id: "lst_pinned",
      seller_options: [],
    };

    const snapshot = createCartReadinessSnapshot([lockedWithoutProjectedOptions]);

    expect(cartReadinessLineHasFulfillment(lockedWithoutProjectedOptions)).toBe(false);
    expect(snapshot.status).toBe("blocked");
    expect(snapshot.unresolvedLineIds).toEqual(["cli_no_data"]);
    expect(snapshot.fulfillmentGroups).toEqual([]);
    expect(snapshot.lineOutcomes).toContainEqual({
      lineId: "cli_no_data",
      outcome: "checkout",
      reason: "waiting-for-supply",
    });
  });

  it("blocks a priced and available listing when its shipping measure is missing", () => {
    const missingMeasureLine: CartReadinessLine = {
      ...readyLine,
      line_id: "cli_missing_measure",
      seller_options: [
        {
          ...readyLine.seller_options[0]!,
          product_measure_snapshot: null,
        },
      ],
    };

    const snapshot = createCartReadinessSnapshot([missingMeasureLine]);

    expect(cartReadinessLineHasFulfillment(missingMeasureLine)).toBe(false);
    expect(snapshot.status).toBe("blocked");
    expect(snapshot.unresolvedLineIds).toEqual(["cli_missing_measure"]);
    expect(snapshot.fulfillmentGroups).toEqual([]);
    expect(snapshot.lineOutcomes).toContainEqual({
      lineId: "cli_missing_measure",
      outcome: "checkout",
      reason: "shipping-measure-missing",
    });
  });

  it("marks a Smart Match line ready when active options exist", () => {
    const optimizeWithOptions: CartReadinessLine = {
      ...readyLine,
      line_id: "cli_optimize_ready",
      fulfillment_mode: "optimize",
      locked_listing_id: null,
      seller_options: [
        { ...readyLine.seller_options[0]!, listing_id: "lst_a", price_amount: "21.00" },
        { ...readyLine.seller_options[0]!, listing_id: "lst_b", price_amount: "18.00" },
      ],
    };

    const snapshot = createCartReadinessSnapshot([optimizeWithOptions]);

    expect(cartReadinessLineHasFulfillment(optimizeWithOptions)).toBe(true);
    expect(snapshot.status).toBe("ready");
    expect(snapshot.lineOutcomes).toContainEqual({
      lineId: "cli_optimize_ready",
      outcome: "checkout",
      reason: "ready",
    });
  });

  it("marks a Smart Match line ready when measured supply is split across listings", () => {
    const splitSupplyLine: CartReadinessLine = {
      ...readyLine,
      line_id: "cli_optimize_split_supply",
      quantity: 3,
      fulfillment_mode: "optimize",
      locked_listing_id: null,
      seller_options: [
        { ...readyLine.seller_options[0]!, listing_id: "lst_a", available_quantity: 2, price_amount: "21.00" },
        { ...readyLine.seller_options[0]!, listing_id: "lst_b", available_quantity: 1, price_amount: "18.00" },
      ],
    };

    const snapshot = createCartReadinessSnapshot([splitSupplyLine]);

    expect(cartReadinessLineHasFulfillment(splitSupplyLine)).toBe(true);
    expect(snapshot.status).toBe("ready");
    expect(snapshot.lineOutcomes).toContainEqual({
      lineId: "cli_optimize_split_supply",
      outcome: "checkout",
      reason: "ready",
    });
    expect(applyCartReadinessToLines([splitSupplyLine], snapshot)).toEqual([splitSupplyLine]);
  });

  it("marks split Smart Match supply unresolved when shipping measures are incomplete", () => {
    const splitSupplyMissingMeasureLine: CartReadinessLine = {
      ...readyLine,
      line_id: "cli_optimize_split_missing_measure",
      quantity: 3,
      fulfillment_mode: "optimize",
      locked_listing_id: null,
      seller_options: [
        { ...readyLine.seller_options[0]!, listing_id: "lst_a", available_quantity: 2, price_amount: "21.00" },
        {
          ...readyLine.seller_options[0]!,
          listing_id: "lst_b",
          available_quantity: 1,
          price_amount: "18.00",
          product_measure_snapshot: null,
        },
      ],
    };

    const snapshot = createCartReadinessSnapshot([splitSupplyMissingMeasureLine]);

    expect(cartReadinessLineHasFulfillment(splitSupplyMissingMeasureLine)).toBe(false);
    expect(snapshot.status).toBe("blocked");
    expect(snapshot.lineOutcomes).toContainEqual({
      lineId: "cli_optimize_split_missing_measure",
      outcome: "checkout",
      reason: "shipping-measure-missing",
    });
  });

  it("flags a Smart Match line needing attention when no active options exist", () => {
    const optimizeWithoutOptions: CartReadinessLine = {
      ...readyLine,
      line_id: "cli_optimize_empty",
      fulfillment_mode: "optimize",
      locked_listing_id: null,
      seller_options: [],
    };

    const snapshot = createCartReadinessSnapshot([readyLine, optimizeWithoutOptions]);

    expect(cartReadinessLineHasFulfillment(optimizeWithoutOptions)).toBe(false);
    expect(snapshot.unresolvedLineIds).toEqual(["cli_optimize_empty"]);
    expect(snapshot.lineOutcomes).toContainEqual({
      lineId: "cli_optimize_empty",
      outcome: "checkout",
      reason: "unassigned-fulfillment",
    });
  });

  it("rejects stale readiness when seller group facts change", () => {
    const snapshot = createCartReadinessSnapshot([readyLine]);
    const changedSellerLine: CartReadinessLine = {
      ...readyLine,
      seller_options: [
        {
          ...readyLine.seller_options[0]!,
          seller_account_id: "acc_new_seller",
          seller_display_name: "New Seller",
        },
      ],
    };

    const validation = validateCartReadinessSnapshot([changedSellerLine], {
      snapshotId: snapshot.snapshotId,
      sourceRevision: snapshot.sourceRevision,
    });

    expect(validation.valid).toBe(false);
    expect(validation.current.fulfillmentGroups[0]).toMatchObject({
      sellerAccountId: "acc_new_seller",
      sellerDisplayName: "New Seller",
    });
  });
});
