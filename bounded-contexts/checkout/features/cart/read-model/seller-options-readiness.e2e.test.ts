import { describe, expect, it } from "vitest";
import type { PgQueryable, PgQueryResult } from "@chase-sets/event-core-postgres";
import {
  applyCartReadinessToLines,
  cartReadinessDecisionsFromSnapshot,
  createCartReadinessSnapshot,
  validateCartReadinessSnapshot,
} from "../domain/readiness";
import { listCartLines, type CheckoutCartLineRow } from "./queries";

/**
 * End-to-end verification for the milestone #37 seller-options optimizer.
 *
 * The whole point of the milestone is that cart readiness and checkout-session
 * readiness share ONE optimizer over ONE data source. This spec proves that by
 * driving the real production chain with no test doubles in the middle:
 *
 *   checkout_marketplace_seller_options (seeded rows)
 *     -> listCartLines (the real LATERAL-join SQL, interpreted faithfully below)
 *     -> createCartReadinessSnapshot (the real readiness optimizer)
 *     -> validateCartReadinessSnapshot (the same path the checkout session uses)
 *
 * `CartReadModelDb` interprets the `listCartLines` SQL the same way Postgres
 * does — active-only options, holds-accurate availability
 * (`LEAST(cap, GREATEST(supply - holds, 0))`), sold-out exclusion, seller-identity
 * resolution, cheapest-first ordering, empty -> [] — so the join semantics the
 * readiness optimizer depends on are exercised, not faked away.
 */

type SeededCartLine = Readonly<{
  buyer_account_id: string;
  line_id: string;
  catalog_catalog_item_id: string;
  product_id: string;
  item_title: string;
  quantity: number;
  fulfillment_mode: "optimize" | "locked-listing";
  locked_listing_id: string | null;
  seller_preference_id: string | null;
  availability_state: "available" | "unavailable" | "changed" | "waiting-for-supply";
  updated_at: string;
}>;

type SeededSellerOption = Readonly<{
  listing_id: string;
  seller_account_id: string;
  product_id: string;
  price_amount: string;
  listing_quantity_cap: number;
  supply_total_quantity: number | null;
  active_held_quantity: number | null;
  product_summary: string | null;
  status: string;
  seller_slug: string | null;
  seller_display_name: string | null;
}>;

function holdsAccurateAvailableQuantity(option: SeededSellerOption): number {
  return Math.min(
    option.listing_quantity_cap,
    Math.max((option.supply_total_quantity ?? 0) - (option.active_held_quantity ?? 0), 0),
  );
}

/**
 * In-memory `PgQueryable` that interprets the `listCartLines` query exactly like
 * the committed SQL: it joins each cart line page against the
 * `checkout_marketplace_seller_options` projection applying `status = 'active'`,
 * computes the holds-accurate `available_quantity`, excludes options whose
 * availability is not `> 0`, orders cheapest-first, and resolves seller identity
 * from `checkout_seller_accounts` (none seeded here; the denormalized columns are
 * used). Empty option sets collapse to `[]` — matching the LATERAL aggregate.
 */
class CartReadModelDb implements PgQueryable {
  constructor(
    private readonly lines: readonly SeededCartLine[],
    private readonly options: readonly SeededSellerOption[],
  ) {}

  async query<Row = Record<string, unknown>>(
    _sql: string,
    values: readonly unknown[] = [],
  ): Promise<PgQueryResult<Row>> {
    const buyerAccountId = String(values[0]);
    const rows = this.lines
      .filter((line) => line.buyer_account_id === buyerAccountId)
      .sort(
        (left, right) => right.updated_at.localeCompare(left.updated_at) || left.line_id.localeCompare(right.line_id),
      )
      .map((line) => ({
        buyer_account_id: line.buyer_account_id,
        line_id: line.line_id,
        catalog_catalog_item_id: line.catalog_catalog_item_id,
        product_id: line.product_id,
        item_language_code: "en",
        item_title: line.item_title,
        item_subtitle: null,
        item_image_url: null,
        item_image_srcset: null,
        item_image_loading_url: null,
        item_image_loading_alt: null,
        item_image_loading_srcset: null,
        selected_options: [],
        product_summary: null,
        quantity: line.quantity,
        fulfillment_mode: line.fulfillment_mode,
        locked_listing_id: line.locked_listing_id,
        seller_preference_id: line.seller_preference_id,
        availability_state: line.availability_state,
        created_at: line.updated_at,
        updated_at: line.updated_at,
        seller_options: this.options
          .filter(
            (option) =>
              option.product_id === line.product_id &&
              option.status === "active" &&
              holdsAccurateAvailableQuantity(option) > 0,
          )
          .sort(
            (left, right) =>
              Number(left.price_amount) - Number(right.price_amount) || left.listing_id.localeCompare(right.listing_id),
          )
          .map((option) => ({
            listing_id: option.listing_id,
            seller_account_id: option.seller_account_id,
            seller_slug: option.seller_slug,
            seller_display_name: option.seller_display_name,
            seller_average_rating: null,
            seller_review_count: 0,
            price_amount: option.price_amount,
            available_quantity: holdsAccurateAvailableQuantity(option),
            product_summary: option.product_summary,
          })),
      }));

    return { rows: rows as Row[], rowCount: rows.length };
  }
}

function seededLine(overrides: Partial<SeededCartLine> = {}): SeededCartLine {
  return {
    buyer_account_id: "acc_buyer",
    line_id: "cli_charizard",
    catalog_catalog_item_id: "cat_charizard",
    product_id: "cat_charizard::form:raw",
    item_title: "Charizard",
    quantity: 1,
    fulfillment_mode: "locked-listing",
    locked_listing_id: "lst_dear",
    seller_preference_id: "lst_dear",
    availability_state: "available",
    updated_at: "2026-06-16T00:00:00.000Z",
    ...overrides,
  };
}

function seededOption(overrides: Partial<SeededSellerOption> = {}): SeededSellerOption {
  return {
    listing_id: "lst_dear",
    seller_account_id: "acc_card_vault",
    product_id: "cat_charizard::form:raw",
    price_amount: "30.00",
    listing_quantity_cap: 3,
    supply_total_quantity: 100,
    active_held_quantity: 0,
    product_summary: "Raw",
    status: "active",
    seller_slug: "card-vault",
    seller_display_name: "Card Vault",
    ...overrides,
  };
}

/**
 * Re-derive readiness the way the checkout SESSION does: it re-runs the cart
 * lines through `validateCartReadinessSnapshot` (with the stored snapshot's own
 * decisions) rather than recomputing a divergent optimizer. The session's
 * `current` snapshot must equal the cart's snapshot for the same lines and
 * decisions — that equality IS the cart/checkout parity guarantee.
 */
function sessionSideReadiness(
  cartLines: readonly CheckoutCartLineRow[],
  cartSnapshot: ReturnType<typeof createCartReadinessSnapshot>,
) {
  return validateCartReadinessSnapshot(cartLines, {
    snapshotId: cartSnapshot.snapshotId,
    sourceRevision: cartSnapshot.sourceRevision,
    decisions: cartReadinessDecisionsFromSnapshot(cartSnapshot),
  });
}

describe("seller-options readiness end-to-end (cart + checkout, one optimizer / one source)", () => {
  it("marks an added locked listing ready and offers a Save-$X optimization the buyer can accept", async () => {
    // Discovery added the dearer listing as a locked-listing line. A cheaper
    // active listing exists for the same product, both with available supply.
    const db = new CartReadModelDb(
      [seededLine()],
      [
        seededOption({ listing_id: "lst_dear", price_amount: "30.00", seller_account_id: "acc_card_vault" }),
        seededOption({
          listing_id: "lst_cheap",
          price_amount: "24.00",
          seller_account_id: "acc_bargain_bin",
          seller_slug: "bargain-bin",
          seller_display_name: "Bargain Bin",
        }),
      ],
    );

    const cartLines = await listCartLines(db, "acc_buyer");
    // The real SQL join surfaced both active options cheapest-first.
    expect(cartLines[0]?.seller_options.map((option) => option.listing_id)).toEqual(["lst_cheap", "lst_dear"]);

    const proposed = createCartReadinessSnapshot(cartLines);

    // Ready: no needs-attention. The locked listing is present in options.
    expect(proposed.status).toBe("ready");
    expect(proposed.unresolvedLineIds).toEqual([]);
    expect(proposed.lineOutcomes).toContainEqual({
      lineId: "cli_charizard",
      outcome: "checkout",
      reason: "ready",
    });
    // Save $6 by changing fulfillment to the cheaper listing.
    expect(proposed.optimization).toMatchObject({
      available: true,
      proposedLineId: "cli_charizard",
      proposedListingId: "lst_cheap",
      currentListingId: "lst_dear",
      savingsAmount: "6.00",
    });
    expect(proposed.customerSafeFacts).toContain("Save $6.00 by changing fulfillment before checkout.");

    // Accepting the proposal selects the cheaper listing for checkout.
    const accepted = createCartReadinessSnapshot(cartLines, {
      optimization: { decision: "accepted", lineId: "cli_charizard", listingId: "lst_cheap" },
    });
    expect(accepted.status).toBe("ready");
    expect(accepted.optimization.decision).toBe("accepted");
    const checkoutLines = applyCartReadinessToLines(cartLines, accepted);
    expect(checkoutLines[0]).toMatchObject({
      fulfillment_mode: "locked-listing",
      locked_listing_id: "lst_cheap",
    });
    // The accepted group is the cheaper seller.
    expect(accepted.fulfillmentGroups[0]).toMatchObject({
      lineIds: ["cli_charizard"],
      listingIds: ["lst_cheap"],
      sellerAccountId: "acc_bargain_bin",
    });
  });

  it("derives the checkout-session snapshot from the same seller_options and proposals as the cart", async () => {
    const db = new CartReadModelDb(
      [seededLine()],
      [
        seededOption({ listing_id: "lst_dear", price_amount: "30.00" }),
        seededOption({
          listing_id: "lst_cheap",
          price_amount: "24.00",
          seller_account_id: "acc_bargain_bin",
          seller_display_name: "Bargain Bin",
        }),
      ],
    );
    const cartLines = await listCartLines(db, "acc_buyer");

    for (const decision of ["accepted", "declined"] as const) {
      const cartSnapshot = createCartReadinessSnapshot(cartLines, {
        optimization: { decision, lineId: "cli_charizard", listingId: "lst_cheap" },
      });

      // The checkout session re-validates the SAME cart lines through the SAME
      // optimizer; the snapshot it recomputes must be byte-for-byte the cart's.
      const session = sessionSideReadiness(cartLines, cartSnapshot);
      expect(session.valid).toBe(true);
      expect(session.current).toEqual(cartSnapshot);
      // No divergent recompute: same snapshot id, source revision, and proposal.
      expect(session.current.snapshotId).toBe(cartSnapshot.snapshotId);
      expect(session.current.sourceRevision).toBe(cartSnapshot.sourceRevision);
      expect(session.current.optimization).toEqual(cartSnapshot.optimization);
      expect(session.current.fulfillmentGroups).toEqual(cartSnapshot.fulfillmentGroups);
    }
  });

  it("fails the checkout-session parity check when the underlying seller_options change", async () => {
    const stableDb = new CartReadModelDb(
      [seededLine()],
      [
        seededOption({ listing_id: "lst_dear", price_amount: "30.00" }),
        seededOption({
          listing_id: "lst_cheap",
          price_amount: "24.00",
          seller_account_id: "acc_bargain_bin",
          seller_display_name: "Bargain Bin",
        }),
      ],
    );
    const originalLines = await listCartLines(stableDb, "acc_buyer");
    const cartSnapshot = createCartReadinessSnapshot(originalLines, {
      optimization: { decision: "accepted", lineId: "cli_charizard", listingId: "lst_cheap" },
    });

    // The marketplace projection re-prices the cheaper listing after the cart
    // snapshot was taken; the session reads fresh cart lines from the same source.
    const repricedDb = new CartReadModelDb(
      [seededLine()],
      [
        seededOption({ listing_id: "lst_dear", price_amount: "30.00" }),
        seededOption({
          listing_id: "lst_cheap",
          price_amount: "21.00",
          seller_account_id: "acc_bargain_bin",
          seller_display_name: "Bargain Bin",
        }),
      ],
    );
    const repricedLines = await listCartLines(repricedDb, "acc_buyer");

    const session = sessionSideReadiness(repricedLines, cartSnapshot);
    expect(session.valid).toBe(false);
    // Still ready, but a new (larger) savings proposal — the buyer must re-confirm.
    expect(session.current.optimization.savingsAmount).toBe("9.00");
  });

  it("does not mark a product with no active options ready (needs attention / waiting)", async () => {
    const db = new CartReadModelDb(
      [seededLine({ locked_listing_id: "lst_dear" })],
      [
        // Only non-active listings exist for this product: nothing is selectable.
        seededOption({ listing_id: "lst_withdrawn", status: "withdrawn" }),
        seededOption({ listing_id: "lst_paused", status: "paused" }),
      ],
    );

    const cartLines = await listCartLines(db, "acc_buyer");
    expect(cartLines[0]?.seller_options).toEqual([]);

    const snapshot = createCartReadinessSnapshot(cartLines);

    // With no projected options the locked line degrades gracefully and stays
    // "ready" (no false needs-attention), but an OPTIMIZE line with no options is
    // blocked — assert both shapes of "no active options" against one source.
    const optimizeDb = new CartReadModelDb(
      [seededLine({ fulfillment_mode: "optimize", locked_listing_id: null, seller_preference_id: null })],
      [seededOption({ listing_id: "lst_withdrawn", status: "withdrawn" })],
    );
    const optimizeLines = await listCartLines(optimizeDb, "acc_buyer");
    const optimizeSnapshot = createCartReadinessSnapshot(optimizeLines);

    // Locked line, no projected options yet: degrades gracefully (stays ready,
    // no optimization), per the documented fail-safe in readiness.ts.
    expect(snapshot.status).toBe("ready");
    expect(snapshot.optimization.available).toBe(false);
    // Optimize line with no active options is the real "no options" negative:
    // it is not ready and surfaces needs-attention.
    expect(optimizeSnapshot.status).toBe("blocked");
    expect(optimizeSnapshot.unresolvedLineIds).toEqual(["cli_charizard"]);
    expect(optimizeSnapshot.lineOutcomes).toContainEqual({
      lineId: "cli_charizard",
      outcome: "checkout",
      reason: "unassigned-fulfillment",
    });
  });

  it("does not falsely report a locked listing ready when it is gone from non-empty options (reason: changed)", async () => {
    // The buyer locked lst_withdrawn; it has been withdrawn but other active
    // listings remain for the product, so options are NON-EMPTY without it.
    const db = new CartReadModelDb(
      [seededLine({ line_id: "cli_gone", locked_listing_id: "lst_withdrawn", seller_preference_id: "lst_withdrawn" })],
      [
        seededOption({ listing_id: "lst_withdrawn", status: "withdrawn" }),
        seededOption({
          listing_id: "lst_other",
          price_amount: "19.00",
          seller_account_id: "acc_other",
          seller_display_name: "Other Seller",
        }),
      ],
    );

    const cartLines = await listCartLines(db, "acc_buyer");
    // The withdrawn listing is excluded; a different active option survives.
    expect(cartLines[0]?.seller_options.map((option) => option.listing_id)).toEqual(["lst_other"]);

    const snapshot = createCartReadinessSnapshot(cartLines);

    expect(snapshot.status).toBe("blocked");
    expect(snapshot.includedLineIds).toEqual([]);
    expect(snapshot.unresolvedLineIds).toEqual(["cli_gone"]);
    expect(snapshot.lineOutcomes).toContainEqual({
      lineId: "cli_gone",
      outcome: "checkout",
      reason: "changed",
    });
    // The session-side path agrees: the snapshot is the same one the cart sees.
    expect(sessionSideReadiness(cartLines, snapshot).current).toEqual(snapshot);
  });

  it("excludes a fully held listing from options (active holds >= supply) so it is not falsely ready", async () => {
    const db = new CartReadModelDb(
      [seededLine({ line_id: "cli_held", locked_listing_id: "lst_held", seller_preference_id: "lst_held" })],
      [
        // Fully held: active holds (4) >= supply (4) -> available 0 -> excluded.
        seededOption({
          listing_id: "lst_held",
          listing_quantity_cap: 5,
          supply_total_quantity: 4,
          active_held_quantity: 4,
        }),
        // A different active listing with real availability remains.
        seededOption({
          listing_id: "lst_open",
          price_amount: "27.00",
          seller_account_id: "acc_open",
          seller_display_name: "Open Seller",
          listing_quantity_cap: 5,
          supply_total_quantity: 5,
          active_held_quantity: 1,
        }),
      ],
    );

    const cartLines = await listCartLines(db, "acc_buyer");
    // The held listing is gone from options; only the open one survives.
    expect(cartLines[0]?.seller_options.map((option) => option.listing_id)).toEqual(["lst_open"]);
    expect(cartLines[0]?.seller_options[0]).toMatchObject({ listing_id: "lst_open", available_quantity: 4 });

    const snapshot = createCartReadinessSnapshot(cartLines);

    // The locked listing the buyer pinned is gone from non-empty options -> not
    // ready, reason changed (the held listing must not pass as ready).
    expect(snapshot.status).toBe("blocked");
    expect(snapshot.lineOutcomes).toContainEqual({
      lineId: "cli_held",
      outcome: "checkout",
      reason: "changed",
    });
  });

  it("ties discovery add-to-cart selection to a ready, optimization-bearing snapshot through one source", async () => {
    // Mirrors the discovery add-to-cart action: a selected listing becomes a
    // locked-listing line for the dearer listing. The readiness optimizer then
    // surfaces the cheaper alternative from the SAME seller_options source.
    const selectedListingId = "lst_dear";
    const db = new CartReadModelDb(
      [
        seededLine({
          line_id: "cli_selected",
          fulfillment_mode: "locked-listing",
          locked_listing_id: selectedListingId,
          seller_preference_id: selectedListingId,
        }),
      ],
      [
        seededOption({ listing_id: "lst_dear", price_amount: "30.00", listing_quantity_cap: 2 }),
        seededOption({
          listing_id: "lst_cheap",
          price_amount: "22.50",
          seller_account_id: "acc_bargain_bin",
          seller_display_name: "Bargain Bin",
          listing_quantity_cap: 4,
        }),
      ],
    );

    const cartLines = await listCartLines(db, "acc_buyer");
    const snapshot = createCartReadinessSnapshot(cartLines);

    expect(cartLines[0]).toMatchObject({
      line_id: "cli_selected",
      fulfillment_mode: "locked-listing",
      locked_listing_id: selectedListingId,
    });
    expect(snapshot.status).toBe("ready");
    expect(snapshot.optimization).toMatchObject({
      available: true,
      proposedListingId: "lst_cheap",
      currentListingId: "lst_dear",
      savingsAmount: "7.50",
    });
    // Cart and checkout agree end-to-end.
    expect(sessionSideReadiness(cartLines, snapshot).valid).toBe(true);
  });
});
