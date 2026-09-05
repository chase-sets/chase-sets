import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createPgPool,
  createPostgresEventStore,
  withPgTransaction,
  type PgQueryable,
  type PgTransactionalPool,
} from "@chase-sets/event-core-postgres";
import { createAggregateCommandHandler } from "@chase-sets/event-core/aggregate-command-handler";
import { createPassthroughDomainEventCodec } from "@chase-sets/event-core/codec";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import { buildTransportEvent } from "@chase-sets/event-core/test-support";
import { bootstrapContextDatabase } from "@chase-sets/bounded-context-runtime";
import { createId } from "@chase-sets/primitives/typed-ids";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import { module as checkoutModule } from "../../../index";
import { createCheckoutCartRuntime } from "../api/runtime";
import {
  decideCheckoutCart,
  evolveCheckoutCart,
  initialCheckoutCartState,
  requireCheckoutCartClaimIdentity,
  type CheckoutCartEvent,
} from "../domain/domain";
import {
  applyCartReadinessToLines,
  cartReadinessDecisionsFromSnapshot,
  createCartReadinessSnapshot,
  validateCartReadinessSnapshot,
} from "../domain/readiness";
import { buildCheckoutCartProjectionHandlers } from "./projection";
import { listCartLines, listOwnCartLines, type CheckoutCartLineRow } from "./queries";
import { checkoutCartSchemaMigrations, checkoutCartSchemaSql } from "./schema";

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
let checkoutDatabaseUrl: string;

const context: EventStoreContext = {
  tenantId: "tnt_test" as never,
  audit: {
    performedByUserId: "usr_buyer" as never,
    forAccountId: "acc_buyer" as never,
  },
};

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
    checkoutDatabaseUrl = databaseUrls.checkout;
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
        seededLine({ buyer_account_id: "acc_foreign", line_id: "cli_foreign" }),
        seededLine({ buyer_account_id: "anon_unpresented", line_id: "cli_unpresented" }),
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
    expect((await listCartLines(pool, buyerAccountId)).map((line) => line.line_id)).toEqual([
      "cli_account_only",
      "cli_shared",
    ]);

    const source = { accountId: buyerAccountId, presentedAnonymousCartId: anonymousCartId };
    const before = createCartReadinessSnapshot(unionLines, undefined, source);
    await pool.query(
      `UPDATE checkout_cart_line_pages SET item_title = 'Changed losing row', quantity = 2,
         product_id = 'cat_loser::', locked_listing_id = 'lst_loser', updated_at = '2026-07-01'
       WHERE buyer_account_id = $1 AND line_id = 'cli_shared'`,
      [anonymousCartId],
    );
    const afterLosingChange = createCartReadinessSnapshot(
      await listCartLines(pool, buyerAccountId, anonymousCartId),
      undefined,
      source,
    );
    expect(afterLosingChange).toEqual(before);

    await pool.query("DELETE FROM checkout_cart_line_pages WHERE buyer_account_id = $1 AND line_id = 'cli_shared'", [
      buyerAccountId,
    ]);
    const newlyWinningLines = await listCartLines(pool, buyerAccountId, anonymousCartId);
    expect(newlyWinningLines.find((line) => line.line_id === "cli_shared")).toMatchObject({
      buyer_account_id: anonymousCartId,
      item_title: "Changed losing row",
      product_id: "cat_loser::",
      quantity: 2,
    });
    const afterWinnerChange = createCartReadinessSnapshot(newlyWinningLines, undefined, source);
    expect(afterWinnerChange.sourceRevision).not.toBe(before.sourceRevision);
    expect(afterWinnerChange.snapshotId).not.toBe(before.snapshotId);
  });

  it("keeps union identity through real SQL copy relocation and orders equal-time lines by ID within each owner", async () => {
    const anonymousCartId = "anon_relocation";
    const moving = seededLine({ buyer_account_id: anonymousCartId, line_id: "cli_moving" });
    await seedReadModel(
      [
        seededLine({ line_id: "cli_b" }),
        seededLine({ line_id: "cli_a" }),
        moving,
        seededLine({ buyer_account_id: anonymousCartId, line_id: "cli_z" }),
      ],
      [seededOption()],
    );
    const source = { accountId: buyerAccountId, presentedAnonymousCartId: anonymousCartId };
    const beforeLines = await listCartLines(pool, buyerAccountId, anonymousCartId);
    expect(beforeLines.map((line) => line.line_id)).toEqual(["cli_a", "cli_b", "cli_moving", "cli_z"]);
    const before = createCartReadinessSnapshot(beforeLines, undefined, source);

    await seedReadModel(
      [
        {
          ...moving,
          buyer_account_id: buyerAccountId,
          updated_at: "2026-07-01T00:00:00.000Z",
        },
      ],
      [],
    );
    const duringLines = await listCartLines(pool, buyerAccountId, anonymousCartId);
    expect(duringLines.map((line) => line.line_id)).toEqual(["cli_moving", "cli_a", "cli_b", "cli_z"]);
    expect(duringLines.find((line) => line.line_id === "cli_moving")?.buyer_account_id).toBe(buyerAccountId);
    const during = createCartReadinessSnapshot(duringLines, undefined, source);
    await pool.query("DELETE FROM checkout_cart_line_pages WHERE buyer_account_id = $1 AND line_id = $2", [
      anonymousCartId,
      moving.line_id,
    ]);
    const after = createCartReadinessSnapshot(
      await listCartLines(pool, buyerAccountId, anonymousCartId),
      undefined,
      source,
    );
    expect(during).toEqual(before);
    expect(after).toEqual(before);
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

// Frozen pre-claim Cart SQL from ded0c96f223322eaceb7996ec187a140e18f1896.
// Standalone migration tests must not execute current boot SQL first.
const parentCartSchemaSql = `
CREATE TABLE IF NOT EXISTS checkout_cart_line_pages (
  buyer_account_id text NOT NULL,
  line_id text NOT NULL,
  catalog_catalog_item_id text NOT NULL,
  product_id text NOT NULL,
  item_language_code text NULL,
  item_title text NOT NULL,
  item_subtitle text NULL,
  item_image_url text NULL,
  item_image_srcset text NULL,
  item_image_loading_url text NULL,
  item_image_loading_alt text NULL,
  item_image_loading_srcset text NULL,
  selected_options jsonb NOT NULL DEFAULT '[]'::jsonb,
  product_summary text NULL,
  quantity integer NOT NULL CHECK (quantity > 0),
  fulfillment_mode text NOT NULL DEFAULT 'optimize',
  locked_listing_id text NULL,
  selected_listing_id text NULL,
  selected_listing_seller_account_id text NULL,
  selected_listing_seller_display_name text NULL,
  selected_listing_seller_slug text NULL,
  selected_listing_price_amount numeric(12, 2) NULL,
  selected_listing_snapshot_source text NULL,
  selected_listing_snapshot_captured_at timestamptz NULL,
  seller_preference_id text NULL,
  availability_state text NOT NULL DEFAULT 'available',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (buyer_account_id, line_id)
);

ALTER TABLE checkout_cart_line_pages
  ADD COLUMN IF NOT EXISTS selected_listing_id text NULL,
  ADD COLUMN IF NOT EXISTS selected_listing_seller_account_id text NULL,
  ADD COLUMN IF NOT EXISTS selected_listing_seller_display_name text NULL,
  ADD COLUMN IF NOT EXISTS selected_listing_seller_slug text NULL,
  ADD COLUMN IF NOT EXISTS selected_listing_price_amount numeric(12, 2) NULL,
  ADD COLUMN IF NOT EXISTS selected_listing_snapshot_source text NULL,
  ADD COLUMN IF NOT EXISTS selected_listing_snapshot_captured_at timestamptz NULL;

CREATE INDEX IF NOT EXISTS checkout_cart_line_pages_buyer_idx
  ON checkout_cart_line_pages (buyer_account_id, updated_at DESC, line_id ASC);

CREATE INDEX IF NOT EXISTS checkout_cart_line_pages_catalog_version_idx
  ON checkout_cart_line_pages (product_id);
`;

const claimAccount = "acc_claimer";
const otherAccount = "acc_rival";
const claimedSourceA = "anon_cart_a";
const claimedSourceB = "anon_cart_b";
const presentedSource = "anon_presented";
const claimedStreamA = `checkout.cart-${claimedSourceA}`;

function createCartRuntime(targetPool: PgTransactionalPool) {
  const eventStore = createPostgresEventStore({ pool: targetPool });
  return {
    eventStore,
    runtime: createCheckoutCartRuntime({ eventStore, checkpointStore: {} as never, db: targetPool }),
  };
}

function createClaimAggregate(targetPool: PgTransactionalPool) {
  return createAggregateCommandHandler({
    eventStore: createPostgresEventStore({ pool: targetPool }),
    codec: createPassthroughDomainEventCodec<CheckoutCartEvent>(),
    initialState: () => initialCheckoutCartState,
    evolve: evolveCheckoutCart,
    decide: decideCheckoutCart,
  });
}

async function readClaims(db: PgQueryable = pool) {
  const result = await db.query<{ source_owner_key: string; account_id: string }>(
    "SELECT source_owner_key, account_id FROM checkout_cart_claims ORDER BY source_owner_key",
  );
  return result.rows;
}

async function readStreamEventTypes(streamId: string) {
  const result = await pool.query<{ event_type: string }>(
    "SELECT event_type FROM event_store_events WHERE stream_id = $1 ORDER BY stream_version",
    [streamId],
  );
  return result.rows.map((row) => row.event_type);
}

async function readAllStoredEvents() {
  const result = await pool.query<{ stream_id: string; event_type: string; payload: unknown }>(
    "SELECT stream_id, event_type, payload FROM event_store_events ORDER BY global_position",
  );
  return result.rows;
}

async function readClaimsTableFacts() {
  const columns = await pool.query<{ column_name: string; is_nullable: string; data_type: string }>(
    `SELECT column_name, is_nullable, data_type
     FROM information_schema.columns
     WHERE table_name = 'checkout_cart_claims'
     ORDER BY ordinal_position`,
  );
  const indexes = await pool.query<{ indexname: string; indexdef: string }>(
    "SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'checkout_cart_claims' ORDER BY indexname",
  );
  const constraints = await pool.query<{ conname: string; definition: string }>(
    `SELECT conname, pg_get_constraintdef(oid) AS definition
     FROM pg_constraint
     WHERE conrelid = 'checkout_cart_claims'::regclass AND contype = 'c'
     ORDER BY conname`,
  );
  const persistence = await pool.query<{ relpersistence: string }>(
    "SELECT relpersistence FROM pg_class WHERE relname = 'checkout_cart_claims'",
  );
  const ledger = await pool.query<{ migration_id: string }>(
    "SELECT migration_id FROM bounded_context_schema_migrations WHERE migration_id = $1",
    ["20260903_checkout_cart_claims"],
  );

  return {
    columns: columns.rows,
    indexNames: indexes.rows.map((row) => row.indexname),
    accountIndexDefinition: indexes.rows.find((row) => row.indexname === "checkout_cart_claims_account_idx")?.indexdef,
    constraintNames: constraints.rows.map((row) => row.conname),
    persistence: persistence.rows[0]?.relpersistence,
    ledgerRows: ledger.rows.length,
  };
}

async function tableExists(tableName: string) {
  const result = await pool.query<{ exists: boolean }>("SELECT to_regclass($1) IS NOT NULL AS exists", [tableName]);
  return result.rows[0]?.exists === true;
}

function claimedLine(overrides: Partial<SeededCartLine> = {}): SeededCartLine {
  return seededLine({ buyer_account_id: claimedSourceA, line_id: "cli_source", ...overrides });
}

describeDb("cart claim against the checkout read model", () => {
  beforeAll(async () => {
    const databaseUrls = createMultiContextTestDatabaseUrls(requireDatabaseBaseUrl(), contextNames, "cart_claim");
    await ensureMultiContextTestDatabases(requireDatabaseBaseUrl(), databaseUrls);
    pools = createMultiContextTestPools(databaseUrls);
    pool = pools.checkout;
    checkoutDatabaseUrl = databaseUrls.checkout;
  });

  beforeEach(async () => {
    await resetMultiContextTestSchemas({ checkout: pool });
    // Composes event-core schema, the Checkout boot SQL and every registered
    // migration -- including the Cart Claim ledger entry -- exactly as boot does.
    await bootstrapContextDatabase(checkoutModule, pool);
  });

  afterAll(async () => {
    if (pools) {
      await closeMultiContextTestPools(pools);
    }
    pools = undefined;
  });

  it("claims a source stream with one event, zero copied lines, and read-your-claim through production SQL", async () => {
    await seedReadModel(
      [
        seededLine({ buyer_account_id: claimAccount, line_id: "cli_own", updated_at: "2026-06-16T00:00:00.000Z" }),
        claimedLine({ updated_at: "2026-06-18T00:00:00.000Z" }),
      ],
      [seededOption({ listing_id: "lst_cheap", price_amount: "24.00" }), seededOption()],
    );
    const { runtime } = createCartRuntime(pool);

    const before = await listCartLines(pool, claimAccount);
    const result = await runtime.claimCart(
      { sourceOwnerKey: claimedSourceA, accountId: claimAccount as never },
      context,
    );
    const after = await listCartLines(pool, claimAccount);

    expect(before.map((line) => line.line_id)).toEqual(["cli_own"]);
    expect(result).toEqual({ version: 1 });
    expect(await readStreamEventTypes(claimedStreamA)).toEqual(["checkout.cart.claimed-by-account"]);
    expect(await readStreamEventTypes(`checkout.cart-${claimAccount}`)).toEqual([]);
    // No line was copied: the two seeded rows are still the only two rows.
    expect(
      (await pool.query<{ count: string }>("SELECT count(*)::text AS count FROM checkout_cart_line_pages")).rows[0],
    ).toEqual({ count: "2" });
    expect(after.map((line) => line.line_id)).toEqual(["cli_source", "cli_own"]);
    expect(after.map((line) => line.buyer_account_id)).toEqual([claimedSourceA, claimAccount]);
    // The claimed row keeps the full seller-option enrichment.
    expect(after[0]?.seller_options.map((option) => option.listing_id)).toEqual(["lst_cheap", "lst_dear"]);
    expect(await readClaims()).toEqual([{ source_owner_key: claimedSourceA, account_id: claimAccount }]);
  });

  it("claims a valid empty source and a cleared source without inventing lines", async () => {
    const { runtime } = createCartRuntime(pool);

    await runtime.claimCart({ sourceOwnerKey: claimedSourceA, accountId: claimAccount as never }, context);
    expect(await listCartLines(pool, claimAccount)).toEqual([]);

    await seedReadModel([claimedLine({ buyer_account_id: claimedSourceB, line_id: "cli_b" })], [seededOption()]);
    await runtime.claimCart({ sourceOwnerKey: claimedSourceB, accountId: claimAccount as never }, context);
    await pool.query("DELETE FROM checkout_cart_line_pages WHERE buyer_account_id = $1", [claimedSourceB]);

    // A cleared claimed cart resolves to no lines and stays claimed.
    expect(await listCartLines(pool, claimAccount)).toEqual([]);
    expect(await readClaims()).toEqual([
      { source_owner_key: claimedSourceA, account_id: claimAccount },
      { source_owner_key: claimedSourceB, account_id: claimAccount },
    ]);
  });

  it("repairs a committed claim whose alias is missing, without appending a second event", async () => {
    const { runtime } = createCartRuntime(pool);

    const first = await runtime.claimCart(
      { sourceOwnerKey: claimedSourceA, accountId: claimAccount as never },
      context,
    );
    await pool.query("DELETE FROM checkout_cart_claims WHERE source_owner_key = $1", [claimedSourceA]);
    expect(await readClaims()).toEqual([]);

    const retry = await runtime.claimCart(
      { sourceOwnerKey: claimedSourceA, accountId: claimAccount as never },
      context,
    );
    const steady = await runtime.claimCart(
      { sourceOwnerKey: claimedSourceA, accountId: claimAccount as never },
      context,
    );

    expect(retry.version).toBe(first.version);
    expect(steady.version).toBe(first.version);
    expect(await readStreamEventTypes(claimedStreamA)).toEqual(["checkout.cart.claimed-by-account"]);
    expect(await readClaims()).toEqual([{ source_owner_key: claimedSourceA, account_id: claimAccount }]);
  });

  it("serializes two Accounts on the source stream's loaded version, not on alias uniqueness", async () => {
    const contenderPool = createPgPool(checkoutDatabaseUrl);

    try {
      const incumbent = createClaimAggregate(pool);
      const rival = createClaimAggregate(contenderPool);

      // Both contenders load the SAME source stream at the same version, on two
      // separate connections, before either decides.
      const loadedByIncumbent = await incumbent.repository.load(claimedStreamA);
      const loadedByRival = await rival.repository.load(claimedStreamA);
      expect(loadedByIncumbent.version).toBe(0);
      expect(loadedByRival.version).toBe(loadedByIncumbent.version);
      expect(loadedByIncumbent.state.claimedByAccountId).toBeNull();
      expect(loadedByRival.state.claimedByAccountId).toBeNull();

      const incumbentEvents = decideCheckoutCart(loadedByIncumbent.state, {
        type: "ClaimCart",
        sourceOwnerKey: claimedSourceA,
        accountId: claimAccount as never,
      });
      const rivalEvents = decideCheckoutCart(loadedByRival.state, {
        type: "ClaimCart",
        sourceOwnerKey: claimedSourceA,
        accountId: otherAccount as never,
      });
      expect(incumbentEvents).toHaveLength(1);
      expect(rivalEvents).toHaveLength(1);

      const stored = await incumbent.repository.append({
        streamId: claimedStreamA,
        expectedVersion: loadedByIncumbent.version,
        context,
        events: incumbentEvents,
      });
      expect(stored.map((event) => event.streamVersion)).toEqual([1]);

      // The loser appends at its own stale loaded version and is rejected by the
      // event store, not by the alias table.
      await expect(
        rival.repository.append({
          streamId: claimedStreamA,
          expectedVersion: loadedByRival.version,
          context,
          events: rivalEvents,
        }),
      ).rejects.toThrow();

      const { runtime: winnerRuntime } = createCartRuntime(pool);
      const { runtime: loserRuntime } = createCartRuntime(contenderPool);
      await winnerRuntime.claimCart({ sourceOwnerKey: claimedSourceA, accountId: claimAccount as never }, context);

      // Retrying the loser reloads and observes the winning claimant.
      await expect(
        loserRuntime.claimCart({ sourceOwnerKey: claimedSourceA, accountId: otherAccount as never }, context),
      ).rejects.toThrow("Cart is already claimed by a different account.");

      expect(await readStreamEventTypes(claimedStreamA)).toEqual(["checkout.cart.claimed-by-account"]);
      expect(await readClaims()).toEqual([{ source_owner_key: claimedSourceA, account_id: claimAccount }]);
    } finally {
      await (contenderPool as unknown as { end: () => Promise<void> }).end();
    }
  });

  it("never accepts a contradictory alias as a successful claim", async () => {
    await pool.query("INSERT INTO checkout_cart_claims (source_owner_key, account_id) VALUES ($1, $2)", [
      claimedSourceA,
      otherAccount,
    ]);
    const { runtime } = createCartRuntime(pool);

    await expect(
      runtime.claimCart({ sourceOwnerKey: claimedSourceA, accountId: claimAccount as never }, context),
    ).rejects.toThrow("Cart claim alias is held by a different account.");
    expect(await readClaims()).toEqual([{ source_owner_key: claimedSourceA, account_id: otherAccount }]);
  });

  it("excludes invalid alias rows at the table, independently of the command", async () => {
    const invalidRows: Array<readonly [string, string]> = [
      ["acc_buyer", claimAccount],
      ["anon_", claimAccount],
      [" anon_cart_a", claimAccount],
      ["anon_cart_a ", claimAccount],
      ["anon_cart a", claimAccount],
      ["", claimAccount],
      [claimedSourceA, "anon_cart_b"],
      [claimedSourceA, "acc_"],
      [claimedSourceA, " acc_buyer"],
      [claimedSourceA, ""],
    ];

    for (const [sourceOwnerKey, accountId] of invalidRows) {
      await expect(
        pool.query("INSERT INTO checkout_cart_claims (source_owner_key, account_id) VALUES ($1, $2)", [
          sourceOwnerKey,
          accountId,
        ]),
      ).rejects.toMatchObject({ code: "23514" });
      expect(await readClaims()).toEqual([]);
    }

    expect(await readClaims()).toEqual([]);
  });

  it.each(["fresh boot", "standalone populated-parent migration"] as const)(
    "matches the command's complete whitespace rule on %s",
    async (schemaPath) => {
      await resetMultiContextTestSchemas({ checkout: pool });
      if (schemaPath === "fresh boot") {
        await pool.query(checkoutCartSchemaSql);
      } else {
        await pool.query(parentCartSchemaSql);
        expect(await tableExists("checkout_cart_claims")).toBe(false);
        await pool.query(
          `INSERT INTO checkout_cart_line_pages
             (buyer_account_id, line_id, catalog_catalog_item_id, product_id, item_title, quantity)
           VALUES ('acc_synthetic_parent', 'cli_synthetic_parent', 'cat_synthetic', 'prd_synthetic', 'Parent row', 3)`,
        );
        const before = await pool.query("SELECT * FROM checkout_cart_line_pages");
        const migration = checkoutCartSchemaMigrations.find(
          (candidate) => candidate.migrationId === "20260903_checkout_cart_claims",
        );
        if (!migration) throw new Error("Cart Claim migration is missing.");
        for (let application = 0; application < 2; application += 1) {
          for (const statement of migration.statements) await pool.query(statement);
          expect((await pool.query("SELECT * FROM checkout_cart_line_pages")).rows).toEqual(before.rows);
        }
      }

      // ECMAScript WhiteSpace + LineTerminator, including all Unicode Zs code points.
      const whitespace = [
        0x0009, 0x000a, 0x000b, 0x000c, 0x000d, 0x0020, 0x00a0, 0x1680, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005,
        0x2006, 0x2007, 0x2008, 0x2009, 0x200a, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff,
      ];
      for (const field of ["sourceOwnerKey", "accountId"] as const) {
        for (const codePoint of whitespace) {
          const pair = {
            sourceOwnerKey: `anon_synthetic_${field}_${codePoint}`,
            accountId: `acc_synthetic_${field}_${codePoint}`,
          };
          const character = String.fromCodePoint(codePoint);
          // The embedded values retain the independently observed SQL regressions.
          for (const value of [character + pair[field], pair[field] + "x" + character + "x", pair[field] + character]) {
            const invalid = { ...pair, [field]: value };
            expect(() => requireCheckoutCartClaimIdentity(invalid)).toThrow(/Cart claim (source|account) must be/);
            await expect(
              pool.query("INSERT INTO checkout_cart_claims (source_owner_key, account_id) VALUES ($1, $2)", [
                invalid.sourceOwnerKey,
                invalid.accountId,
              ]),
            ).rejects.toMatchObject({
              code: "23514",
              constraint:
                field === "sourceOwnerKey"
                  ? "checkout_cart_claims_source_owner_key_check"
                  : "checkout_cart_claims_account_id_check",
            });
            expect(await readClaims()).toEqual([]);
          }
        }
      }

      const validPairs = [
        { sourceOwnerKey: "anon_cart_a", accountId: "acc_buyer" },
        { sourceOwnerKey: createId("anon"), accountId: createId("acc") },
        // These are not ECMAScript whitespace; do not silently impose a stricter rule.
        ...[0x0085, 0x180e, 0x200b, 0x2060].map((codePoint) => ({
          sourceOwnerKey: `anon_x${String.fromCodePoint(codePoint)}x`,
          accountId: `acc_x${String.fromCodePoint(codePoint)}x`,
        })),
      ];
      for (const pair of validPairs) {
        expect(requireCheckoutCartClaimIdentity(pair)).toEqual(pair);
        await pool.query("INSERT INTO checkout_cart_claims (source_owner_key, account_id) VALUES ($1, $2)", [
          pair.sourceOwnerKey,
          pair.accountId,
        ]);
        expect(
          (await pool.query("SELECT * FROM checkout_cart_claims WHERE source_owner_key = $1", [pair.sourceOwnerKey]))
            .rows,
        ).toEqual([{ source_owner_key: pair.sourceOwnerKey, account_id: pair.accountId }]);
      }
    },
  );

  it("refuses malformed identities before writing any event or alias", async () => {
    const { runtime } = createCartRuntime(pool);

    for (const candidate of [
      { sourceOwnerKey: "acc_buyer", accountId: claimAccount },
      { sourceOwnerKey: "anon_", accountId: claimAccount },
      { sourceOwnerKey: " anon_cart_a", accountId: claimAccount },
      { sourceOwnerKey: claimedSourceA, accountId: "anon_cart_b" },
      { sourceOwnerKey: claimedSourceA, accountId: "acc_ " },
    ]) {
      await expect(
        runtime.claimCart(
          { sourceOwnerKey: candidate.sourceOwnerKey, accountId: candidate.accountId as never },
          context,
        ),
      ).rejects.toThrow(/Cart claim (source|account) must be an exact/);
    }

    expect(await readAllStoredEvents()).toEqual([]);
    expect(await readClaims()).toEqual([]);
  });

  it("selects deterministic whole-row winners across own, claimed and presented owners", async () => {
    await seedReadModel(
      [
        // Account/claim duplicate: the Account's own row must win despite being older.
        seededLine({
          buyer_account_id: claimAccount,
          line_id: "cli_shared",
          locked_listing_id: "lst_dear",
          seller_preference_id: "lst_dear",
          updated_at: "2026-06-01T00:00:00.000Z",
        }),
        seededLine({
          buyer_account_id: claimedSourceA,
          line_id: "cli_shared",
          locked_listing_id: "lst_cheap",
          seller_preference_id: "lst_cheap",
          updated_at: "2026-06-25T00:00:00.000Z",
        }),
        // Divergent claimed duplicate: the newest claimed row wins.
        seededLine({
          buyer_account_id: claimedSourceA,
          line_id: "cli_divergent",
          quantity: 1,
          updated_at: "2026-06-10T00:00:00.000Z",
        }),
        seededLine({
          buyer_account_id: claimedSourceB,
          line_id: "cli_divergent",
          quantity: 7,
          updated_at: "2026-06-20T00:00:00.000Z",
        }),
        // Timestamp tie: the byte-smallest source owner wins.
        seededLine({
          buyer_account_id: claimedSourceB,
          line_id: "cli_tied",
          quantity: 2,
          updated_at: "2026-06-15T00:00:00.000Z",
        }),
        seededLine({
          buyer_account_id: claimedSourceA,
          line_id: "cli_tied",
          quantity: 3,
          updated_at: "2026-06-15T00:00:00.000Z",
        }),
        // Presented-only source, plus a duplicate the Account union already owns.
        seededLine({
          buyer_account_id: presentedSource,
          line_id: "cli_presented",
          updated_at: "2026-06-30T00:00:00.000Z",
        }),
        seededLine({
          buyer_account_id: presentedSource,
          line_id: "cli_shared",
          locked_listing_id: "lst_cheap",
          updated_at: "2026-06-29T00:00:00.000Z",
        }),
        // A cart belonging to nobody in this read.
        seededLine({ buyer_account_id: "anon_unrelated", line_id: "cli_unrelated" }),
      ],
      [seededOption({ listing_id: "lst_cheap", price_amount: "24.00" }), seededOption()],
    );
    const { runtime } = createCartRuntime(pool);
    await runtime.claimCart({ sourceOwnerKey: claimedSourceA, accountId: claimAccount as never }, context);
    await runtime.claimCart({ sourceOwnerKey: claimedSourceB, accountId: claimAccount as never }, context);

    const rows = await listCartLines(pool, claimAccount, presentedSource);
    const byLineId = new Map(rows.map((row) => [row.line_id, row]));

    // Account union first, then presented-only, each updated_at DESC / line_id ASC.
    expect(rows.map((row) => row.line_id)).toEqual(["cli_divergent", "cli_tied", "cli_shared", "cli_presented"]);
    expect(byLineId.get("cli_shared")).toMatchObject({
      buyer_account_id: claimAccount,
      locked_listing_id: "lst_dear",
      seller_preference_id: "lst_dear",
    });
    expect(byLineId.get("cli_divergent")).toMatchObject({ buyer_account_id: claimedSourceB, quantity: 7 });
    expect(byLineId.get("cli_tied")).toMatchObject({ buyer_account_id: claimedSourceA, quantity: 3 });
    expect(byLineId.get("cli_presented")).toMatchObject({ buyer_account_id: presentedSource });
    expect(rows.filter((row) => row.line_id === "cli_shared")).toHaveLength(1);
    // Seller-option enrichment is unchanged for every winning row.
    for (const row of rows) {
      expect(row.seller_options.map((option) => option.listing_id)).toEqual(["lst_cheap", "lst_dear"]);
      expect(row.seller_options[0]).toMatchObject({ price_amount: "24.00", available_quantity: 3 });
    }
    // An unrelated Account sees nothing from these claims.
    expect(await listCartLines(pool, "acc_unrelated")).toEqual([]);
  });

  it("counts a claimed key that is also presented exactly once, inside the Account union", async () => {
    await seedReadModel(
      [
        seededLine({ buyer_account_id: claimAccount, line_id: "cli_own", updated_at: "2026-06-05T00:00:00.000Z" }),
        claimedLine({ line_id: "cli_overlap", updated_at: "2026-06-06T00:00:00.000Z" }),
      ],
      [seededOption()],
    );
    const { runtime } = createCartRuntime(pool);
    await runtime.claimCart({ sourceOwnerKey: claimedSourceA, accountId: claimAccount as never }, context);

    const rows = await listCartLines(pool, claimAccount, claimedSourceA);

    expect(rows.map((row) => row.line_id)).toEqual(["cli_overlap", "cli_own"]);
    expect(rows).toHaveLength(2);
  });

  it("keeps zero-claim Account, Account-plus-presented and anonymous reads exactly as shipped", async () => {
    await seedReadModel(
      [
        seededLine({
          buyer_account_id: claimAccount,
          line_id: "cli_shared",
          locked_listing_id: "lst_dear",
          updated_at: "2026-06-10T00:00:00.000Z",
        }),
        seededLine({
          buyer_account_id: presentedSource,
          line_id: "cli_shared",
          locked_listing_id: "lst_cheap",
          updated_at: "2026-06-20T00:00:00.000Z",
        }),
        seededLine({ buyer_account_id: claimAccount, line_id: "cli_account", updated_at: "2026-06-11T00:00:00.000Z" }),
        seededLine({
          buyer_account_id: presentedSource,
          line_id: "cli_anonymous",
          updated_at: "2026-06-30T00:00:00.000Z",
        }),
        // Claimed by a DIFFERENT account: it must not leak into this read.
        seededLine({ buyer_account_id: claimedSourceA, line_id: "cli_rival", updated_at: "2026-07-01T00:00:00.000Z" }),
      ],
      [seededOption()],
    );
    await pool.query("INSERT INTO checkout_cart_claims (source_owner_key, account_id) VALUES ($1, $2)", [
      claimedSourceA,
      otherAccount,
    ]);

    expect((await listCartLines(pool, claimAccount, presentedSource)).map((row) => row.line_id)).toEqual([
      "cli_account",
      "cli_shared",
      "cli_anonymous",
    ]);
    expect((await listCartLines(pool, claimAccount)).map((row) => row.line_id)).toEqual(["cli_account", "cli_shared"]);
    // An anonymous primary owner reads only its own key, and never expands aliases.
    expect((await listCartLines(pool, presentedSource)).map((row) => row.line_id)).toEqual([
      "cli_anonymous",
      "cli_shared",
    ]);
    expect((await listCartLines(pool, claimedSourceA)).map((row) => row.line_id)).toEqual(["cli_rival"]);
  });

  it("resolves only own-key lines for the addLine probe while the union sees the claimed stream", async () => {
    await seedReadModel(
      [seededLine({ buyer_account_id: claimAccount, line_id: "cli_own" }), claimedLine({ line_id: "cli_claimed" })],
      [seededOption()],
    );
    const { runtime } = createCartRuntime(pool);
    await runtime.claimCart({ sourceOwnerKey: claimedSourceA, accountId: claimAccount as never }, context);

    expect((await listOwnCartLines(pool, claimAccount)).map((row) => row.line_id)).toEqual(["cli_own"]);
    expect((await listCartLines(pool, claimAccount)).map((row) => row.line_id).sort()).toEqual([
      "cli_claimed",
      "cli_own",
    ]);
    expect((await listOwnCartLines(pool, claimedSourceA)).map((row) => row.line_id)).toEqual(["cli_claimed"]);
  });

  it("creates the logged claims table, index and constraints on a fresh boot", async () => {
    const facts = await readClaimsTableFacts();

    expect(facts.columns).toEqual([
      expect.objectContaining({ column_name: "source_owner_key", is_nullable: "NO" }),
      expect.objectContaining({ column_name: "account_id", is_nullable: "NO" }),
    ]);
    expect(facts.indexNames).toEqual(["checkout_cart_claims_account_idx", "checkout_cart_claims_pkey"]);
    expect(facts.accountIndexDefinition).toContain("(account_id, source_owner_key)");
    expect(facts.constraintNames).toEqual([
      "checkout_cart_claims_account_id_check",
      "checkout_cart_claims_source_owner_key_check",
    ]);
    // 'p' is permanent (logged); the replayable line pages are 'u' (unlogged).
    expect(facts.persistence).toBe("p");
    expect(facts.ledgerRows).toBe(1);
  });

  it("converges a populated database created before Cart Claim and tolerates repeated migration", async () => {
    await resetMultiContextTestSchemas({ checkout: pool });
    // The exact shipped boot SQL minus every claims statement: the shape a
    // long-lived database created before this change actually has.
    const preClaimSchemaSql = checkoutModule.schemaSql
      .split(";")
      .filter((statement) => !statement.includes("checkout_cart_claims"))
      .join(";");
    await pool.query(preClaimSchemaSql);
    expect(await tableExists("checkout_cart_claims")).toBe(false);

    await seedReadModel([seededLine({ buyer_account_id: claimAccount, line_id: "cli_existing" })], [seededOption()]);

    await bootstrapContextDatabase(checkoutModule, pool);
    const afterFirst = await readClaimsTableFacts();
    await bootstrapContextDatabase(checkoutModule, pool);
    const afterSecond = await readClaimsTableFacts();

    expect(afterFirst.indexNames).toEqual(["checkout_cart_claims_account_idx", "checkout_cart_claims_pkey"]);
    expect(afterFirst.constraintNames).toEqual([
      "checkout_cart_claims_account_id_check",
      "checkout_cart_claims_source_owner_key_check",
    ]);
    expect(afterFirst.persistence).toBe("p");
    expect(afterFirst.ledgerRows).toBe(1);
    expect(afterSecond).toEqual(afterFirst);
    // Existing line pages survived both applications.
    expect((await listCartLines(pool, claimAccount)).map((row) => row.line_id)).toEqual(["cli_existing"]);
  });

  it("does not commit the claim alias when its outer projection transaction fails", async () => {
    const handlers = buildCheckoutCartProjectionHandlers(pool);
    const claimTransportEvent = buildTransportEvent(
      "checkout.cart.claimed-by-account",
      { sourceOwnerKey: claimedSourceA, accountId: claimAccount },
      {
        id: "evt_claim",
        streamId: claimedStreamA,
        tenantId: "tnt_test" as never,
        audit: { performedByUserId: "usr_buyer" as never, forAccountId: claimAccount as never },
        timing: { occurredAt: "2026-09-03T00:00:00.000Z", recordedAt: "2026-09-03T00:00:00.000Z" },
      },
    );

    await expect(
      withPgTransaction(pool, async (client) => {
        await handlers["checkout.cart.claimed-by-account"]!(claimTransportEvent, { db: client });
        // The alias is visible inside the supplied transaction ...
        expect(await readClaims(client)).toEqual([{ source_owner_key: claimedSourceA, account_id: claimAccount }]);
        throw new Error("outer projection transaction failed");
      }),
    ).rejects.toThrow("outer projection transaction failed");

    // ... and is gone once that transaction rolls back: the helper committed nothing of its own.
    expect(await readClaims()).toEqual([]);
  });

  it("rebuilds the same Account union after a registered reset and ordered replay", async () => {
    await seedReadModel(
      [
        seededLine({ buyer_account_id: claimAccount, line_id: "cli_own", updated_at: "2026-06-16T00:00:00.000Z" }),
        claimedLine({ updated_at: "2026-06-18T00:00:00.000Z" }),
      ],
      [seededOption()],
    );
    const { runtime } = createCartRuntime(pool);
    await runtime.claimCart({ sourceOwnerKey: claimedSourceA, accountId: claimAccount as never }, context);
    const before = await listCartLines(pool, claimAccount);
    const recordedEvents = await readAllStoredEvents();

    // The registered reset strategy truncates the projector's owned tables.
    const ownedTables = checkoutModule.projectionGroups?.find(
      (group) => group.projectionName === "checkout.cart-projection",
    )?.ownedTables;
    expect(ownedTables).toEqual(["checkout_cart_line_pages", "checkout_cart_claims"]);
    await pool.query(`TRUNCATE ${ownedTables!.join(", ")}`);
    expect(await readClaims()).toEqual([]);

    // Ordered replay of the recorded history through the real handlers, inside
    // one supplied projection transaction.
    const handlers = buildCheckoutCartProjectionHandlers(pool);
    await withPgTransaction(pool, async (client) => {
      for (const stored of recordedEvents) {
        const handler = handlers[stored.event_type];
        if (!handler) {
          continue;
        }
        await handler(
          buildTransportEvent(stored.event_type, stored.payload as Record<string, unknown>, {
            id: "evt_replay",
            streamId: stored.stream_id,
            tenantId: "tnt_test" as never,
            audit: { performedByUserId: "usr_buyer" as never, forAccountId: claimAccount as never },
            timing: { occurredAt: "2026-09-03T00:00:00.000Z", recordedAt: "2026-09-03T00:00:00.000Z" },
          }),
          { db: client },
        );
      }
    });

    expect(await readClaims()).toEqual([{ source_owner_key: claimedSourceA, account_id: claimAccount }]);
    // Replay is idempotent: running it a second time changes nothing.
    await withPgTransaction(pool, async (client) => {
      await handlers["checkout.cart.claimed-by-account"]!(
        buildTransportEvent(
          "checkout.cart.claimed-by-account",
          { sourceOwnerKey: claimedSourceA, accountId: claimAccount },
          {
            id: "evt_replay_2",
            streamId: claimedStreamA,
            tenantId: "tnt_test" as never,
            audit: { performedByUserId: "usr_buyer" as never, forAccountId: claimAccount as never },
            timing: { occurredAt: "2026-09-03T00:00:00.000Z", recordedAt: "2026-09-03T00:00:00.000Z" },
          },
        ),
        { db: client },
      );
    });
    expect(await readClaims()).toEqual([{ source_owner_key: claimedSourceA, account_id: claimAccount }]);

    // Re-seed the line pages the truncate removed and prove the same union.
    await seedReadModel(
      [
        seededLine({ buyer_account_id: claimAccount, line_id: "cli_own", updated_at: "2026-06-16T00:00:00.000Z" }),
        claimedLine({ updated_at: "2026-06-18T00:00:00.000Z" }),
      ],
      [],
    );
    expect((await listCartLines(pool, claimAccount)).map((row) => row.line_id)).toEqual(
      before.map((row) => row.line_id),
    );
  });
});

/**
 * Claimed-stream mutations against real PostgreSQL: the union resolver picks the
 * source stream, the event store enforces per-stream optimistic concurrency, and
 * a second pool supplies a genuinely separate connection.
 */
describeDb("claimed cart mutations against real PostgreSQL", () => {
  beforeAll(async () => {
    const databaseUrls = createMultiContextTestDatabaseUrls(requireDatabaseBaseUrl(), contextNames, "claimed_mutation");
    await ensureMultiContextTestDatabases(requireDatabaseBaseUrl(), databaseUrls);
    pools = createMultiContextTestPools(databaseUrls);
    pool = pools.checkout;
    checkoutDatabaseUrl = databaseUrls.checkout;
  });

  beforeEach(async () => {
    await resetMultiContextTestSchemas({ checkout: pool });
    await bootstrapContextDatabase(checkoutModule, pool);
  });

  afterAll(async () => {
    if (pools) {
      await closeMultiContextTestPools(pools);
    }
    pools = undefined;
  });

  async function addAggregateLine(
    handler: ReturnType<typeof createCartRuntime>["runtime"]["commandHandler"],
    ownerKey: string,
    lineId: string,
  ) {
    await handler({
      streamId: `checkout.cart-${ownerKey}`,
      command: {
        type: "AddCartLine",
        buyerAccountId: ownerKey as never,
        lineId: lineId as never,
        catalogItemId: "cat_charizard",
        productId: "cat_charizard::form:raw",
        itemTitle: "Charizard",
        itemSubtitle: null,
        itemImageUrl: null,
        selectedOptions: [{ dimensionId: "form", optionId: "raw" }],
        productSummary: null,
        quantity: 1,
      },
      context,
    });
  }

  async function readLinePages(ownerKey: string) {
    const result = await pool.query<Record<string, unknown>>(
      "SELECT * FROM checkout_cart_line_pages WHERE buyer_account_id = $1 ORDER BY line_id",
      [ownerKey],
    );
    return result.rows;
  }

  it("routes quantity and fulfillment to the claimed source stream and keeps the seller-options join", async () => {
    await seedReadModel([claimedLine({ line_id: "cli_claimed" })], [seededOption()]);
    const { runtime } = createCartRuntime(pool);
    await addAggregateLine(runtime.commandHandler, claimedSourceA, "cli_claimed");
    await runtime.claimCart({ sourceOwnerKey: claimedSourceA, accountId: claimAccount as never }, context);
    const before = await listCartLines(pool, claimAccount);

    await runtime.setLineQuantity(
      { accountId: claimAccount as never, lineId: "cli_claimed" as never, quantity: 4 },
      context,
    );
    await runtime.setLineFulfillment(
      {
        accountId: claimAccount as never,
        lineId: "cli_claimed" as never,
        fulfillmentMode: "locked-listing",
        lockedListingId: "lst_dear",
        selectedListingSnapshot: { listingId: "lst_dear", sellerAccountId: otherAccount, source: "cart-fulfillment" },
      },
      context,
    );

    expect(await readStreamEventTypes(claimedStreamA)).toEqual([
      "checkout.cart.line-added",
      "checkout.cart.claimed-by-account",
      "checkout.cart.line-quantity-set",
      "checkout.cart.line-fulfillment-set",
    ]);
    // Nothing reached the Account stream.
    expect(await readStreamEventTypes(`checkout.cart-${claimAccount}`)).toEqual([]);
    const after = await listCartLines(pool, claimAccount);
    expect(after.map((row) => row.buyer_account_id)).toEqual([claimedSourceA]);
    expect(after[0]?.seller_options).toEqual(before[0]?.seller_options);
  });

  it("refuses the claimant's own listing on a claimed stream and appends nothing", async () => {
    await seedReadModel([claimedLine({ line_id: "cli_claimed" })], [seededOption()]);
    const { runtime } = createCartRuntime(pool);
    await addAggregateLine(runtime.commandHandler, claimedSourceA, "cli_claimed");
    await runtime.claimCart({ sourceOwnerKey: claimedSourceA, accountId: claimAccount as never }, context);
    const before = await readStreamEventTypes(claimedStreamA);

    // The retained anonymous key is not the buyer; the claiming Account is.
    await expect(
      runtime.setLineFulfillment(
        {
          accountId: claimAccount as never,
          lineId: "cli_claimed" as never,
          fulfillmentMode: "locked-listing",
          lockedListingId: "lst_dear",
          selectedListingSnapshot: { listingId: "lst_dear", sellerAccountId: claimAccount, source: "cart-fulfillment" },
        },
        context,
      ),
    ).rejects.toThrow("Accounts cannot add their own listings to cart.");

    expect(await readStreamEventTypes(claimedStreamA)).toEqual(before);
  });

  it("mutates only the account-first winner and leaves the hidden duplicate row and stream identical", async () => {
    await seedReadModel(
      [
        seededLine({ buyer_account_id: claimAccount, line_id: "cli_dup", updated_at: "2026-06-16T00:00:00.000Z" }),
        claimedLine({ line_id: "cli_dup", updated_at: "2026-06-18T00:00:00.000Z" }),
      ],
      [seededOption()],
    );
    const { runtime } = createCartRuntime(pool);
    await addAggregateLine(runtime.commandHandler, claimedSourceA, "cli_dup");
    await runtime.claimCart({ sourceOwnerKey: claimedSourceA, accountId: claimAccount as never }, context);
    await addAggregateLine(runtime.commandHandler, claimAccount, "cli_dup");
    const claimedRowsBefore = await readLinePages(claimedSourceA);
    const claimedStreamBefore = await readStreamEventTypes(claimedStreamA);

    await runtime.setLineQuantity(
      { accountId: claimAccount as never, lineId: "cli_dup" as never, quantity: 9 },
      context,
    );

    expect(await readStreamEventTypes(`checkout.cart-${claimAccount}`)).toEqual([
      "checkout.cart.line-added",
      "checkout.cart.line-quantity-set",
    ]);
    expect(await readStreamEventTypes(claimedStreamA)).toEqual(claimedStreamBefore);
    expect(await readLinePages(claimedSourceA)).toEqual(claimedRowsBefore);
    // The duplicate stays hidden behind the Account's own winning row.
    const resolved = await listCartLines(pool, claimAccount);
    expect(resolved.map((row) => [row.line_id, row.buyer_account_id])).toEqual([["cli_dup", claimAccount]]);
  });

  it("clears an explicitly removed line id from the Account and every claimed key", async () => {
    await seedReadModel(
      [
        seededLine({ buyer_account_id: claimAccount, line_id: "cli_dup" }),
        claimedLine({ line_id: "cli_dup" }),
        claimedLine({ buyer_account_id: claimedSourceB, line_id: "cli_dup" }),
        claimedLine({ buyer_account_id: claimedSourceB, line_id: "cli_keep" }),
      ],
      [seededOption()],
    );
    const { runtime } = createCartRuntime(pool);
    for (const [owner, lineId] of [
      [claimedSourceA, "cli_dup"],
      [claimedSourceB, "cli_dup"],
      [claimedSourceB, "cli_keep"],
      [claimAccount, "cli_dup"],
    ] as const) {
      await addAggregateLine(runtime.commandHandler, owner, lineId);
    }
    for (const source of [claimedSourceA, claimedSourceB]) {
      await runtime.claimCart({ sourceOwnerKey: source, accountId: claimAccount as never }, context);
    }

    await runtime.removeLine({ accountId: claimAccount as never, lineId: "cli_dup" as never }, context);

    for (const owner of [claimAccount, claimedSourceA, claimedSourceB]) {
      expect(
        (await readStreamEventTypes(`checkout.cart-${owner}`)).filter((type) => type === "checkout.cart.line-removed"),
      ).toHaveLength(1);
    }
    // The line the sweep never planned survives on its claimed key.
    await pool.query("DELETE FROM checkout_cart_line_pages WHERE line_id = $1", ["cli_dup"]);
    expect((await listCartLines(pool, claimAccount)).map((row) => row.line_id)).toEqual(["cli_keep"]);

    // A second identical call appends nothing anywhere.
    const streamsBefore = await Promise.all(
      [claimAccount, claimedSourceA, claimedSourceB].map((owner) => readStreamEventTypes(`checkout.cart-${owner}`)),
    );
    expect(await runtime.removeLine({ accountId: claimAccount as never, lineId: "cli_dup" as never }, context)).toEqual(
      {
        lineId: "cli_dup",
        version: 0,
      },
    );
    expect(
      await Promise.all(
        [claimAccount, claimedSourceA, claimedSourceB].map((owner) => readStreamEventTypes(`checkout.cart-${owner}`)),
      ),
    ).toEqual(streamsBefore);
  });

  it("serializes two connections on one claimed stream with a real loser, and refuses the retained key", async () => {
    await seedReadModel(
      [claimedLine({ line_id: "cli_race_a" }), claimedLine({ line_id: "cli_race_b" })],
      [seededOption()],
    );
    const { runtime } = createCartRuntime(pool);
    await addAggregateLine(runtime.commandHandler, claimedSourceA, "cli_race_a");
    await addAggregateLine(runtime.commandHandler, claimedSourceA, "cli_race_b");
    await runtime.claimCart({ sourceOwnerKey: claimedSourceA, accountId: claimAccount as never }, context);
    const contenderPool = createPgPool(checkoutDatabaseUrl);

    try {
      const rival = createClaimAggregate(contenderPool);
      const rivalRuntime = createCartRuntime(contenderPool).runtime;

      // Both connections load the same claimed stream at the same version,
      // before either decides. They target different lines of that one stream.
      const loadedByRival = await rival.repository.load(claimedStreamA);
      const rivalEvents = decideCheckoutCart(loadedByRival.state, {
        type: "SetCartLineQuantity",
        actingOwnerKey: claimAccount,
        lineId: "cli_race_b" as never,
        quantity: 7,
      });
      const winner = await runtime.setLineQuantity(
        { accountId: claimAccount as never, lineId: "cli_race_a" as never, quantity: 4 },
        context,
      );

      const loser = await rival.repository
        .append({
          streamId: claimedStreamA,
          expectedVersion: loadedByRival.version,
          context,
          events: rivalEvents,
        })
        .then(
          () => null,
          (error: unknown) => error,
        );

      expect(winner.version).toBe(loadedByRival.version + 1);
      // A real rejection from PostgreSQL, recorded rather than swallowed.
      expect(loser).toMatchObject({
        code: "concurrency_conflict",
        message: "Expected stream version does not match current version.",
      });

      // One retry reloads and converges; both lines end up set.
      const retried = await rivalRuntime.setLineQuantity(
        { accountId: claimAccount as never, lineId: "cli_race_b" as never, quantity: 7 },
        context,
      );
      expect(retried.version).toBe(loadedByRival.version + 2);
      expect(await readStreamEventTypes(claimedStreamA)).toEqual([
        "checkout.cart.line-added",
        "checkout.cart.line-added",
        "checkout.cart.claimed-by-account",
        "checkout.cart.line-quantity-set",
        "checkout.cart.line-quantity-set",
      ]);

      // The retained anonymous key is refused on the same stream, before append.
      const settled = await readStreamEventTypes(claimedStreamA);
      await expect(
        rivalRuntime.setLineQuantity(
          { accountId: claimedSourceA as never, lineId: "cli_race_a" as never, quantity: 99 },
          context,
        ),
      ).rejects.toThrow("Cart is owned by a different account.");
      expect(await readStreamEventTypes(claimedStreamA)).toEqual(settled);
    } finally {
      await (contenderPool as unknown as { end: () => Promise<void> }).end();
    }
  });
});

describeDb("post-claim read authority against the claim alias in Postgres", () => {
  beforeAll(async () => {
    const databaseUrls = createMultiContextTestDatabaseUrls(
      requireDatabaseBaseUrl(),
      contextNames,
      "cart_read_authority",
    );
    await ensureMultiContextTestDatabases(requireDatabaseBaseUrl(), databaseUrls);
    pools = createMultiContextTestPools(databaseUrls);
    pool = pools.checkout;
    checkoutDatabaseUrl = databaseUrls.checkout;
  });

  beforeEach(async () => {
    await resetMultiContextTestSchemas({ checkout: pool });
    await bootstrapContextDatabase(checkoutModule, pool);
  });

  afterAll(async () => {
    if (pools) {
      await closeMultiContextTestPools(pools);
    }
    pools = undefined;
  });

  const authorityFor = async (runtime: ReturnType<typeof createCartRuntime>["runtime"], actingOwnerKey: string) =>
    runtime.resolveCartSourceAuthority({ actingOwnerKey, presentedAnonymousCartId: claimedSourceA });

  it("admits the claimant and refuses a stranger while the claim alias is absent", async () => {
    await seedReadModel([claimedLine()], [seededOption()]);
    const { runtime } = createCartRuntime(pool);
    await runtime.claimCart({ sourceOwnerKey: claimedSourceA, accountId: claimAccount as never }, context);

    // The event-first, alias-second window #5731 leaves open: the claim event is
    // durable and the routing row is gone.
    await pool.query("DELETE FROM checkout_cart_claims WHERE source_owner_key = $1", [claimedSourceA]);
    expect(await readClaims()).toEqual([]);

    await expect(authorityFor(runtime, claimAccount)).resolves.toEqual({
      status: "accepted",
      acceptedVia: "account",
    });
    await expect(authorityFor(runtime, otherAccount)).resolves.toEqual({
      status: "refused",
      clearRetainedAnonymousCartCookie: true,
    });
    await expect(authorityFor(runtime, claimedSourceA)).resolves.toEqual({
      status: "refused",
      clearRetainedAnonymousCartCookie: true,
    });
    // The authorized read agrees: with no alias row, the claimant still sees the
    // claimed line and the retained key sees nothing.
    expect(
      (
        await runtime.listAuthorizedCartLines({ accountId: claimAccount, presentedAnonymousCartId: claimedSourceA })
      ).map((line) => line.line_id),
    ).toEqual(["cli_source"]);
    expect(await runtime.listAuthorizedCartLines({ accountId: claimedSourceA })).toEqual([]);
  });

  it("ignores a stale alias row that names a different Account", async () => {
    await seedReadModel([claimedLine()], [seededOption()]);
    const { runtime } = createCartRuntime(pool);
    await runtime.claimCart({ sourceOwnerKey: claimedSourceA, accountId: claimAccount as never }, context);

    // A stale routing row that contradicts the events outright.
    await pool.query("UPDATE checkout_cart_claims SET account_id = $2 WHERE source_owner_key = $1", [
      claimedSourceA,
      otherAccount,
    ]);
    expect(await readClaims()).toEqual([{ source_owner_key: claimedSourceA, account_id: otherAccount }]);

    // The alias cannot hand authority to the Account it names, and cannot take
    // it away from the Account the events name.
    await expect(authorityFor(runtime, otherAccount)).resolves.toEqual({
      status: "refused",
      clearRetainedAnonymousCartCookie: true,
    });
    await expect(authorityFor(runtime, claimAccount)).resolves.toEqual({
      status: "accepted",
      acceptedVia: "account",
    });
  });

  it("cannot invent authority from a partial alias row on an unclaimed source", async () => {
    await seedReadModel([claimedLine()], [seededOption()]);
    const { runtime } = createCartRuntime(pool);

    // No claim event was ever appended; only a routing row exists.
    await pool.query("INSERT INTO checkout_cart_claims (source_owner_key, account_id) VALUES ($1, $2)", [
      claimedSourceA,
      claimAccount,
    ]);

    expect(await readStreamEventTypes(claimedStreamA)).toEqual([]);
    // Presence of a row is not claim completeness: the source is still
    // unclaimed, so possession still authorizes it and no Account is elevated.
    await expect(authorityFor(runtime, claimedSourceA)).resolves.toEqual({
      status: "accepted",
      acceptedVia: "possession",
    });
    await expect(authorityFor(runtime, otherAccount)).resolves.toEqual({
      status: "accepted",
      acceptedVia: "possession",
    });
    await expect(authorityFor(runtime, claimAccount)).resolves.toEqual({
      status: "accepted",
      acceptedVia: "possession",
    });
  });

  it("decides identically after a runtime restart rebuilds state from the durable stream", async () => {
    await seedReadModel([claimedLine()], [seededOption()]);
    const first = createCartRuntime(pool);
    await first.runtime.claimCart({ sourceOwnerKey: claimedSourceA, accountId: claimAccount as never }, context);
    await pool.query("DELETE FROM checkout_cart_claims");

    // A brand new runtime and event store instance: nothing in memory carries
    // over, so this answer comes from replaying the durable stream.
    const restarted = createCartRuntime(pool);

    await expect(authorityFor(restarted.runtime, claimAccount)).resolves.toEqual({
      status: "accepted",
      acceptedVia: "account",
    });
    await expect(authorityFor(restarted.runtime, otherAccount)).resolves.toEqual({
      status: "refused",
      clearRetainedAnonymousCartCookie: true,
    });
    expect(await readClaims()).toEqual([]);
  });

  it("keeps the alias out of the authority read entirely", async () => {
    await seedReadModel([claimedLine()], [seededOption()]);
    const { runtime } = createCartRuntime(pool);
    await runtime.claimCart({ sourceOwnerKey: claimedSourceA, accountId: claimAccount as never }, context);

    // Dropping the routing table outright would break any read that consulted
    // it. Authority is unaffected, which is the strongest available proof that
    // the alias is not in this decision path.
    await pool.query("DROP TABLE checkout_cart_claims");

    await expect(authorityFor(runtime, claimAccount)).resolves.toEqual({
      status: "accepted",
      acceptedVia: "account",
    });
    await expect(authorityFor(runtime, otherAccount)).resolves.toEqual({
      status: "refused",
      clearRetainedAnonymousCartCookie: true,
    });
  });

  it("refuses the retained key through the real readiness path while the claimant still reads the source", async () => {
    await seedReadModel(
      [seededLine({ buyer_account_id: claimAccount, line_id: "cli_own" }), claimedLine()],
      [seededOption()],
    );
    const { runtime } = createCartRuntime(pool);
    await runtime.claimCart({ sourceOwnerKey: claimedSourceA, accountId: claimAccount as never }, context);

    const retained = await runtime.createReadinessSnapshot({ accountId: claimedSourceA });
    const absent = await runtime.createReadinessSnapshot({ accountId: "anon_cart_never_seeded" });
    const claimant = await runtime.createReadinessSnapshot({
      accountId: claimAccount,
      presentedAnonymousCartId: claimedSourceA,
    });

    // Non-enumerating: the refused key produces exactly the snapshot an
    // unclaimed empty key produces.
    expect(retained).toEqual(absent);
    expect(retained.status).toBe("blocked");
    // And the claimant still reads both its own and the claimed source's lines.
    expect(claimant.lineOutcomes.map((outcome) => outcome.lineId).sort()).toEqual(["cli_own", "cli_source"]);
  });
});
