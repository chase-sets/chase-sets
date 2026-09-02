import { describe, expect, it, vi } from "vitest";
import { createInMemoryEventStore } from "@chase-sets/event-core/test-support";
import { createCheckoutCartRuntime } from "./runtime";
import { CART_SELLER_OPTIONS_PER_LINE_LIMIT, type CheckoutCartLineRow } from "../read-model/queries";

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
    ]);
    expect(withSourceA.includedLineIds).toEqual(["cli_account", "cli_anonymous"]);
    expect(withSourceA.lineCount).toBe(2);
    expect(withSourceB.sourceRevision).not.toBe(withSourceA.sourceRevision);
    expect(withSourceB.snapshotId).not.toBe(withSourceA.snapshotId);
  });
});
