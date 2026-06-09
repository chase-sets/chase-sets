import { describe, expect, it } from "vitest";
import {
  applyCartReadinessToLines,
  cartReadinessLineHasFulfillment,
  createCartReadinessSnapshot,
  parseCartReadinessDecisionInput,
  validateCartReadinessSnapshot,
  type CartReadinessLine,
} from "./readiness";

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
    });
    expect(snapshot.snapshotId).toMatch(/^cr_/);
    expect(cartReadinessLineHasFulfillment(readyLine)).toBe(true);
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

  it("surfaces optional savings and applies an accepted proposed allocation to checkout lines", () => {
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
        },
        {
          listing_id: "lst_lower",
          seller_account_id: "acc_lower",
          seller_display_name: "Lower Seller",
          price_amount: "24.00",
          available_quantity: 1,
          product_summary: "Raw",
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

  it("records a declined optimization while preserving the current valid allocation", () => {
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
});
