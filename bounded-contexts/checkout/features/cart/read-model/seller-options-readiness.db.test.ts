import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import { module as checkoutModule } from "../../../index";
import {
  applyCartReadinessToLines,
  cartReadinessDecisionsFromSnapshot,
  createCartReadinessSnapshot,
  validateCartReadinessSnapshot,
} from "../domain/readiness";
import { listCartLines, type CheckoutCartLineRow } from "./queries";

/**
 * DB-tier replacement for the former seller-options readiness interpreter test.
 * These cases seed the checkout projections and execute the production SQL
 * against Postgres before applying the readiness optimizer.
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
  product_measure_snapshot: Readonly<Record<string, unknown>> | null;
  status: string;
  seller_slug: string | null;
  seller_display_name: string | null;
}>;

type SeededSellerAccount = Readonly<{
  account_id: string;
  display_name: string;
  slug: string;
  average_rating?: string | null;
  review_count?: number;
}>;

const databaseBaseUrl = process.env.TEST_DATABASE_URL;
const describeDb = databaseBaseUrl ? describe : describe.skip;
const contextNames = ["checkout"] as const;
const buyerAccountId = "acc_buyer";
let pool: PgTransactionalPool;
let pools: Readonly<Record<(typeof contextNames)[number], PgTransactionalPool>> | undefined;

describeDb("seller-options readiness against the checkout read model", () => {
  beforeAll(async () => {
    const databaseUrls = createMultiContextTestDatabaseUrls(
      requireDatabaseBaseUrl(),
      contextNames,
      "seller_options_readiness",
    );
    await ensureMultiContextTestDatabases(requireDatabaseBaseUrl(), databaseUrls);
    pools = createMultiContextTestPools(databaseUrls);
    pool = pools.checkout;
  });

  beforeEach(async () => {
    await resetMultiContextTestSchemas({ checkout: pool });
    await pool.query(checkoutModule.schemaSql);
  });

  afterAll(async () => {
    if (pools) {
      await closeMultiContextTestPools(pools);
    }
  });

  it("marks an added locked listing ready and offers a Save-$X optimization the buyer can accept", async () => {
    await seedReadModel(
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

    const cartLines = await listCartLines(pool, buyerAccountId);
    expect(cartLines[0]?.seller_options.map((option) => option.listing_id)).toEqual(["lst_cheap", "lst_dear"]);

    const proposed = createCartReadinessSnapshot(cartLines);
    expect(proposed.status).toBe("ready");
    expect(proposed.unresolvedLineIds).toEqual([]);
    expect(proposed.lineOutcomes).toContainEqual({ lineId: "cli_charizard", outcome: "checkout", reason: "ready" });
    expect(proposed.optimization).toMatchObject({
      available: true,
      proposedLineId: "cli_charizard",
      proposedListingId: "lst_cheap",
      currentListingId: "lst_dear",
      savingsAmount: "6.00",
    });
    expect(proposed.customerSafeFacts).toContain("Save $6.00 by changing fulfillment before checkout.");

    const accepted = createCartReadinessSnapshot(cartLines, {
      optimization: { decision: "accepted", lineId: "cli_charizard", listingId: "lst_cheap" },
    });
    expect(accepted.status).toBe("ready");
    expect(accepted.optimization.decision).toBe("accepted");
    expect(applyCartReadinessToLines(cartLines, accepted)[0]).toMatchObject({
      fulfillment_mode: "locked-listing",
      locked_listing_id: "lst_cheap",
    });
    expect(accepted.fulfillmentGroups[0]).toMatchObject({
      lineIds: ["cli_charizard"],
      listingIds: ["lst_cheap"],
      sellerAccountId: "acc_bargain_bin",
    });
  });

  it("derives the checkout-session snapshot from the same seller_options and proposals as the cart", async () => {
    await seedReadModel(
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
    const cartLines = await listCartLines(pool, buyerAccountId);

    for (const decision of ["accepted", "declined"] as const) {
      const cartSnapshot = createCartReadinessSnapshot(cartLines, {
        optimization: { decision, lineId: "cli_charizard", listingId: "lst_cheap" },
      });
      const session = sessionSideReadiness(cartLines, cartSnapshot);
      expect(session.valid).toBe(true);
      expect(session.current).toEqual(cartSnapshot);
    }
  });

  it("fails the checkout-session parity check when the underlying seller_options change", async () => {
    await seedReadModel(
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
    const originalLines = await listCartLines(pool, buyerAccountId);
    const cartSnapshot = createCartReadinessSnapshot(originalLines, {
      optimization: { decision: "accepted", lineId: "cli_charizard", listingId: "lst_cheap" },
    });

    await clearReadModel();
    await seedReadModel(
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
    const repricedLines = await listCartLines(pool, buyerAccountId);

    const session = sessionSideReadiness(repricedLines, cartSnapshot);
    expect(session.valid).toBe(false);
    expect(session.current.optimization.savingsAmount).toBe("9.00");
  });

  it("does not mark locked or Smart Match lines ready when no active options are projected", async () => {
    await seedReadModel(
      [seededLine({ locked_listing_id: "lst_dear" })],
      [
        seededOption({ listing_id: "lst_withdrawn", status: "withdrawn" }),
        seededOption({ listing_id: "lst_paused", status: "paused" }),
      ],
    );
    const cartLines = await listCartLines(pool, buyerAccountId);
    expect(cartLines[0]?.seller_options).toEqual([]);
    const snapshot = createCartReadinessSnapshot(cartLines);
    expect(snapshot.status).toBe("blocked");
    expect(snapshot.unresolvedLineIds).toEqual(["cli_charizard"]);
    expect(snapshot.lineOutcomes).toContainEqual({
      lineId: "cli_charizard",
      outcome: "checkout",
      reason: "waiting-for-supply",
    });

    await clearReadModel();
    await seedReadModel(
      [seededLine({ fulfillment_mode: "optimize", locked_listing_id: null, seller_preference_id: null })],
      [seededOption({ listing_id: "lst_withdrawn", status: "withdrawn" })],
    );
    const optimizeLines = await listCartLines(pool, buyerAccountId);
    const optimizeSnapshot = createCartReadinessSnapshot(optimizeLines);
    expect(optimizeSnapshot.status).toBe("blocked");
    expect(optimizeSnapshot.unresolvedLineIds).toEqual(["cli_charizard"]);
    expect(optimizeSnapshot.lineOutcomes).toContainEqual({
      lineId: "cli_charizard",
      outcome: "checkout",
      reason: "unassigned-fulfillment",
    });
  });

  it("starts checkout readiness for an active locked marketplace listing before inventory counters project", async () => {
    const selectedListingId = "lst_active_waiting_projection";
    await seedReadModel(
      [
        seededLine({
          line_id: "cli_abra",
          catalog_catalog_item_id: "cat_abra",
          product_id: "cat_abra::form:raw:condition:excellent",
          item_title: "Abra",
          fulfillment_mode: "locked-listing",
          locked_listing_id: selectedListingId,
          seller_preference_id: selectedListingId,
        }),
      ],
      [
        seededOption({
          listing_id: selectedListingId,
          seller_account_id: "acc_m47_seller",
          product_id: "cat_abra::form:raw:condition:excellent",
          price_amount: "2.34",
          listing_quantity_cap: 1,
          supply_total_quantity: null,
          active_held_quantity: null,
          product_summary: "Raw / Excellent",
          seller_slug: "m47-seller",
          seller_display_name: "M47 Seller",
        }),
      ],
    );
    const cartLines = await listCartLines(pool, buyerAccountId);
    expect(cartLines[0]?.seller_options).toEqual([
      expect.objectContaining({
        listing_id: selectedListingId,
        price_amount: "2.34",
        available_quantity: 1,
      }),
    ]);
    const snapshot = createCartReadinessSnapshot(cartLines);
    expect(snapshot.status).toBe("ready");
    expect(snapshot.unresolvedLineIds).toEqual([]);
    expect(snapshot.lineOutcomes).toContainEqual({ lineId: "cli_abra", outcome: "checkout", reason: "ready" });
    expect(snapshot.fulfillmentGroups).toEqual([
      expect.objectContaining({
        lineIds: ["cli_abra"],
        listingIds: [selectedListingId],
        sellerAccountId: "acc_m47_seller",
      }),
    ]);
    expect(sessionSideReadiness(cartLines, snapshot)).toMatchObject({ valid: true, current: snapshot });
  });

  it("does not mark active seller supply ready before its product measure projects", async () => {
    const selectedListingId = "lst_missing_measure";
    await seedReadModel(
      [
        seededLine({
          line_id: "cli_abra_missing_measure",
          catalog_catalog_item_id: "cat_abra",
          product_id: "cat_abra::form:raw:condition:excellent",
          item_title: "Abra",
          fulfillment_mode: "locked-listing",
          locked_listing_id: selectedListingId,
          seller_preference_id: selectedListingId,
        }),
      ],
      [
        seededOption({
          listing_id: selectedListingId,
          seller_account_id: "acc_m47_seller",
          product_id: "cat_abra::form:raw:condition:excellent",
          price_amount: "2.34",
          listing_quantity_cap: 1,
          supply_total_quantity: null,
          active_held_quantity: null,
          product_summary: "Raw / Excellent",
          product_measure_snapshot: null,
          seller_slug: "m47-seller",
          seller_display_name: "M47 Seller",
        }),
      ],
    );
    const cartLines = await listCartLines(pool, buyerAccountId);
    expect(cartLines[0]?.seller_options).toEqual([
      expect.objectContaining({
        listing_id: selectedListingId,
        price_amount: "2.34",
        available_quantity: 1,
        product_measure_snapshot: null,
      }),
    ]);
    const snapshot = createCartReadinessSnapshot(cartLines);
    expect(snapshot.status).toBe("blocked");
    expect(snapshot.unresolvedLineIds).toEqual(["cli_abra_missing_measure"]);
    expect(snapshot.fulfillmentGroups).toEqual([]);
    expect(snapshot.lineOutcomes).toContainEqual({
      lineId: "cli_abra_missing_measure",
      outcome: "checkout",
      reason: "shipping-measure-missing",
    });
    expect(sessionSideReadiness(cartLines, snapshot)).toMatchObject({ valid: true, current: snapshot });
  });

  it("does not falsely report a locked listing ready when it is gone from non-empty options", async () => {
    await seedReadModel(
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
    const cartLines = await listCartLines(pool, buyerAccountId);
    expect(cartLines[0]?.seller_options.map((option) => option.listing_id)).toEqual(["lst_other"]);
    const snapshot = createCartReadinessSnapshot(cartLines);
    expect(snapshot.status).toBe("blocked");
    expect(snapshot.includedLineIds).toEqual([]);
    expect(snapshot.unresolvedLineIds).toEqual(["cli_gone"]);
    expect(snapshot.lineOutcomes).toContainEqual({ lineId: "cli_gone", outcome: "checkout", reason: "changed" });
    expect(sessionSideReadiness(cartLines, snapshot).current).toEqual(snapshot);
  });

  it("excludes a fully held listing from options so it is not falsely ready", async () => {
    await seedReadModel(
      [seededLine({ line_id: "cli_held", locked_listing_id: "lst_held", seller_preference_id: "lst_held" })],
      [
        seededOption({
          listing_id: "lst_held",
          listing_quantity_cap: 5,
          supply_total_quantity: 4,
          active_held_quantity: 4,
        }),
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
    const cartLines = await listCartLines(pool, buyerAccountId);
    expect(cartLines[0]?.seller_options.map((option) => option.listing_id)).toEqual(["lst_open"]);
    expect(cartLines[0]?.seller_options[0]).toMatchObject({ listing_id: "lst_open", available_quantity: 4 });
    const snapshot = createCartReadinessSnapshot(cartLines);
    expect(snapshot.status).toBe("blocked");
    expect(snapshot.lineOutcomes).toContainEqual({ lineId: "cli_held", outcome: "checkout", reason: "changed" });
  });

  it("executes the LATERAL seller-options join for a multi-seller cart and preserves readiness groups", async () => {
    await seedReadModel(
      [
        seededLine({
          line_id: "cli_blastoise",
          catalog_catalog_item_id: "cat_blastoise",
          product_id: "cat_blastoise::form:raw",
          item_title: "Blastoise",
          locked_listing_id: "lst_blastoise",
          seller_preference_id: "lst_blastoise",
          updated_at: "2026-06-17T00:00:00.000Z",
        }),
        seededLine({
          line_id: "cli_charizard",
          locked_listing_id: "lst_charizard",
          seller_preference_id: "lst_charizard",
          updated_at: "2026-06-16T00:00:00.000Z",
        }),
      ],
      [
        seededOption({
          listing_id: "lst_blastoise",
          product_id: "cat_blastoise::form:raw",
          seller_account_id: "acc_blue",
          seller_display_name: "Stale Blue Seller Snapshot",
        }),
        seededOption({
          listing_id: "lst_charizard",
          seller_account_id: "acc_red",
          seller_display_name: "Stale Red Seller Snapshot",
        }),
      ],
      [
        { account_id: "acc_blue", display_name: "Blue Seller", slug: "blue-seller" },
        { account_id: "acc_red", display_name: "Red Seller", slug: "red-seller" },
      ],
    );
    const cartLines = await listCartLines(pool, buyerAccountId);
    expect(cartLines.map((line) => line.line_id)).toEqual(["cli_blastoise", "cli_charizard"]);
    expect(cartLines.map((line) => line.seller_options[0]?.seller_account_id)).toEqual(["acc_blue", "acc_red"]);
    expect(cartLines.map((line) => line.seller_options[0]?.seller_display_name)).toEqual(["Blue Seller", "Red Seller"]);

    const snapshot = createCartReadinessSnapshot(cartLines);
    expect(snapshot.status).toBe("ready");
    expect(snapshot.includedLineIds).toEqual(["cli_blastoise", "cli_charizard"]);
    expect(snapshot.fulfillmentGroups).toHaveLength(2);
    expect(snapshot.fulfillmentGroups.map((group) => group.sellerAccountId).sort()).toEqual(["acc_blue", "acc_red"]);
  });

  it("executes the production union query with Account whole-row precedence and distinct same-product lines", async () => {
    const anonymousCartId = "anon_postgres_union";
    await seedReadModel(
      [
        seededLine({
          line_id: "cli_account_only",
          item_title: "Account only",
          locked_listing_id: "lst_account",
          seller_preference_id: "lst_account",
          updated_at: "2026-06-17T00:00:00.000Z",
        }),
        seededLine({
          line_id: "cli_shared",
          item_title: "Account winner",
          quantity: 1,
          locked_listing_id: "lst_account",
          seller_preference_id: "lst_account",
          updated_at: "2026-06-16T00:00:00.000Z",
        }),
        seededLine({
          buyer_account_id: anonymousCartId,
          line_id: "cli_shared",
          item_title: "Anonymous loser",
          quantity: 3,
          locked_listing_id: "lst_anonymous",
          seller_preference_id: "lst_anonymous",
          updated_at: "2026-06-30T00:00:00.000Z",
        }),
        seededLine({
          buyer_account_id: anonymousCartId,
          line_id: "cli_anonymous_only",
          item_title: "Anonymous only",
          locked_listing_id: "lst_anonymous",
          seller_preference_id: "lst_anonymous",
          updated_at: "2026-06-29T00:00:00.000Z",
        }),
      ],
      [
        seededOption({ listing_id: "lst_account", price_amount: "25.00" }),
        seededOption({ listing_id: "lst_anonymous", price_amount: "26.00" }),
      ],
    );

    const unionLines = await listCartLines(pool, buyerAccountId, anonymousCartId);

    expect(unionLines.map((line) => line.line_id)).toEqual(["cli_account_only", "cli_shared", "cli_anonymous_only"]);
    expect(unionLines.find((line) => line.line_id === "cli_shared")).toMatchObject({
      buyer_account_id: buyerAccountId,
      item_title: "Account winner",
      quantity: 1,
      locked_listing_id: "lst_account",
      seller_preference_id: "lst_account",
    });
    expect(unionLines.filter((line) => line.product_id === "cat_charizard::form:raw")).toHaveLength(3);
  });

  it("ties discovery add-to-cart selection to a ready, optimization-bearing snapshot through one SQL source", async () => {
    const selectedListingId = "lst_dear";
    await seedReadModel(
      [seededLine({ locked_listing_id: selectedListingId, seller_preference_id: selectedListingId })],
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
    const cartLines = await listCartLines(pool, buyerAccountId);
    const snapshot = createCartReadinessSnapshot(cartLines);
    expect(cartLines[0]).toMatchObject({
      line_id: "cli_charizard",
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
    expect(sessionSideReadiness(cartLines, snapshot).valid).toBe(true);
  });
});

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

async function seedReadModel(
  lines: readonly SeededCartLine[],
  options: readonly SeededSellerOption[],
  accounts: readonly SeededSellerAccount[] = [],
) {
  for (const account of accounts) {
    await pool.query(
      `INSERT INTO checkout_seller_accounts (account_id, display_name, slug, average_rating, review_count, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        account.account_id,
        account.display_name,
        account.slug,
        account.average_rating ?? null,
        account.review_count ?? 0,
        "2026-06-16T00:00:00.000Z",
      ],
    );
  }

  for (const line of lines) {
    await pool.query(
      `INSERT INTO checkout_cart_line_pages (
         buyer_account_id, line_id, catalog_catalog_item_id, product_id, item_language_code, item_title,
         quantity, fulfillment_mode, locked_listing_id, seller_preference_id, availability_state, created_at, updated_at
       ) VALUES ($1, $2, $3, $4, 'en', $5, $6, $7, $8, $9, $10, $11, $11)`,
      [
        line.buyer_account_id,
        line.line_id,
        line.catalog_catalog_item_id,
        line.product_id,
        line.item_title,
        line.quantity,
        line.fulfillment_mode,
        line.locked_listing_id,
        line.seller_preference_id,
        line.availability_state,
        line.updated_at,
      ],
    );
  }

  for (const option of options) {
    await pool.query(
      `INSERT INTO checkout_marketplace_seller_options (
         listing_id, seller_account_id, product_id, catalog_catalog_item_id, price_amount, listing_quantity_cap,
         product_summary, product_measure_snapshot, status, updated_at, seller_slug, seller_display_name,
         supply_total_quantity, active_held_quantity
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
      [
        option.listing_id,
        option.seller_account_id,
        option.product_id,
        option.product_id.split("::", 1)[0],
        option.price_amount,
        option.listing_quantity_cap,
        option.product_summary,
        option.product_measure_snapshot,
        option.status,
        "2026-06-16T00:00:00.000Z",
        option.seller_slug,
        option.seller_display_name,
        option.supply_total_quantity,
        option.active_held_quantity,
      ],
    );
  }
}

async function clearReadModel() {
  await pool.query("TRUNCATE checkout_cart_line_pages, checkout_marketplace_seller_options, checkout_seller_accounts");
}

function seededLine(overrides: Partial<SeededCartLine> = {}): SeededCartLine {
  return {
    buyer_account_id: buyerAccountId,
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

function productMeasureSnapshot(overrides: Partial<Readonly<Record<string, unknown>>> = {}) {
  return {
    catalogItemId: "cat_charizard",
    productId: "cat_charizard::form:raw",
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
    product_measure_snapshot: productMeasureSnapshot(),
    status: "active",
    seller_slug: "card-vault",
    seller_display_name: "Card Vault",
    ...overrides,
  };
}

function requireDatabaseBaseUrl(): string {
  if (!databaseBaseUrl) {
    throw new Error("TEST_DATABASE_URL is required for checkout seller-options readiness DB tests.");
  }
  return databaseBaseUrl;
}
