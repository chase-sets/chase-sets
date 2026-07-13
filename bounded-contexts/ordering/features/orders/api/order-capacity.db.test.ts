import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { module as orderingModule } from "../../../index";
import {
  backfillSellerOpenOrderClaims,
  claimSellerOrderCapacity,
  loadSellerOrderCapacityCap,
  reconcileSellerOrderCapacity,
  releaseSellerOrderCapacityClaim,
} from "./order-capacity";

const databaseBaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseBaseUrl && process.env.CI) {
  throw new Error("TEST_DATABASE_URL is required for database-backed tests in CI.");
}
const describeDb = databaseBaseUrl ? describe : describe.skip;
const contextNames = ["ordering"] as const;

async function setSellerCap(pool: PgTransactionalPool, sellerAccountId: string, maxOpenOrders: number | null) {
  await pool.query(
    `INSERT INTO ordering_seller_order_capacity_inputs (seller_account_id, max_open_orders, updated_at)
     VALUES ($1, $2, now())
     ON CONFLICT (seller_account_id) DO UPDATE
     SET max_open_orders = EXCLUDED.max_open_orders, updated_at = EXCLUDED.updated_at`,
    [sellerAccountId, maxOpenOrders],
  );
}

async function openClaimCount(pool: PgTransactionalPool, sellerAccountId: string) {
  const result = await pool.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM ordering_seller_open_order_claims WHERE seller_account_id = $1 AND status = 'claimed'`,
    [sellerAccountId],
  );
  return Number(result.rows[0]?.n ?? 0);
}

describeDb("ordering seller order capacity db", () => {
  let pools: Readonly<Record<(typeof contextNames)[number], PgTransactionalPool>>;

  beforeAll(async () => {
    const databaseUrls = createMultiContextTestDatabaseUrls(databaseBaseUrl!, contextNames, "ordering_order_capacity");
    await ensureMultiContextTestDatabases(databaseBaseUrl!, databaseUrls);
    pools = createMultiContextTestPools(databaseUrls);
  });

  beforeEach(async () => {
    await resetMultiContextTestSchemas(pools);
    await pools.ordering.query(orderingModule.schemaSql);
  });

  afterAll(async () => {
    await closeMultiContextTestPools(pools);
  });

  it("takes no lock and claims freely when no cap is set (unlimited)", async () => {
    const db = pools.ordering;

    expect(await loadSellerOrderCapacityCap(db, "acc_seller")).toBeNull();

    const result = await claimSellerOrderCapacity(db, [
      { sellerAccountId: "acc_seller", orderIds: ["ord_1", "ord_2"] },
    ]);

    expect(result.rejectedSellerAccountIds).toEqual([]);
    expect(await openClaimCount(db, "acc_seller")).toBe(2);
    // No capacity row is created just from an unlimited claim -- the fast
    // pre-check short-circuits before the seed-and-lock step.
    const capacityRow = await db.query(
      `SELECT 1 FROM ordering_seller_order_capacity_inputs WHERE seller_account_id = $1`,
      ["acc_seller"],
    );
    expect(capacityRow.rowCount).toBe(0);
  });

  it("claims up to the cap and rejects the group once it would be exceeded", async () => {
    const db = pools.ordering;
    await setSellerCap(db, "acc_seller", 2);

    const first = await claimSellerOrderCapacity(db, [{ sellerAccountId: "acc_seller", orderIds: ["ord_1", "ord_2"] }]);
    expect(first.rejectedSellerAccountIds).toEqual([]);
    expect(await openClaimCount(db, "acc_seller")).toBe(2);

    const second = await claimSellerOrderCapacity(db, [{ sellerAccountId: "acc_seller", orderIds: ["ord_3"] }]);
    expect(second.rejectedSellerAccountIds).toEqual(["acc_seller"]);
    expect(await openClaimCount(db, "acc_seller")).toBe(2);
  });

  it("claims a multi-order seller group atomically -- all or nothing", async () => {
    const db = pools.ordering;
    await setSellerCap(db, "acc_seller", 2);

    const result = await claimSellerOrderCapacity(db, [
      { sellerAccountId: "acc_seller", orderIds: ["ord_1", "ord_2", "ord_3"] },
    ]);

    expect(result.rejectedSellerAccountIds).toEqual(["acc_seller"]);
    expect(await openClaimCount(db, "acc_seller")).toBe(0);
  });

  it("isolates rejection per seller group -- other sellers in the same call still claim", async () => {
    const db = pools.ordering;
    await setSellerCap(db, "acc_seller_full", 1);
    await claimSellerOrderCapacity(db, [{ sellerAccountId: "acc_seller_full", orderIds: ["ord_0"] }]);

    const result = await claimSellerOrderCapacity(db, [
      { sellerAccountId: "acc_seller_full", orderIds: ["ord_1"] },
      { sellerAccountId: "acc_seller_open", orderIds: ["ord_2"] },
    ]);

    expect(result.rejectedSellerAccountIds).toEqual(["acc_seller_full"]);
    expect(await openClaimCount(db, "acc_seller_full")).toBe(1);
    expect(await openClaimCount(db, "acc_seller_open")).toBe(1);
  });

  it("races two concurrent claims for the last capacity slot -- exactly one wins, no deadlock", async () => {
    const db = pools.ordering;
    await setSellerCap(db, "acc_seller", 1);

    const [first, second] = await Promise.all([
      claimSellerOrderCapacity(db, [{ sellerAccountId: "acc_seller", orderIds: ["ord_a"] }]),
      claimSellerOrderCapacity(db, [{ sellerAccountId: "acc_seller", orderIds: ["ord_b"] }]),
    ]);

    const outcomes = [first, second];
    const winners = outcomes.filter((outcome) => outcome.rejectedSellerAccountIds.length === 0);
    const losers = outcomes.filter((outcome) => outcome.rejectedSellerAccountIds.length > 0);

    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    expect(losers[0]?.rejectedSellerAccountIds).toEqual(["acc_seller"]);
    expect(await openClaimCount(db, "acc_seller")).toBe(1);
  });

  it("releases idempotently -- a second release for the same order is a no-op", async () => {
    const db = pools.ordering;
    await setSellerCap(db, "acc_seller", 1);
    await claimSellerOrderCapacity(db, [{ sellerAccountId: "acc_seller", orderIds: ["ord_1"] }]);

    const releasedAt = new Date().toISOString();
    const firstRelease = await releaseSellerOrderCapacityClaim(db, "ord_1", releasedAt);
    const secondRelease = await releaseSellerOrderCapacityClaim(db, "ord_1", releasedAt);

    expect(firstRelease).toBe("acc_seller");
    expect(secondRelease).toBeNull();
    expect(await openClaimCount(db, "acc_seller")).toBe(0);
  });

  it("releasing an order that was never claimed is a no-op", async () => {
    const db = pools.ordering;

    const released = await releaseSellerOrderCapacityClaim(db, "ord_never_claimed", new Date().toISOString());

    expect(released).toBeNull();
  });

  it("frees the slot on release so a subsequent claim can succeed", async () => {
    const db = pools.ordering;
    await setSellerCap(db, "acc_seller", 1);
    await claimSellerOrderCapacity(db, [{ sellerAccountId: "acc_seller", orderIds: ["ord_1"] }]);

    const rejected = await claimSellerOrderCapacity(db, [{ sellerAccountId: "acc_seller", orderIds: ["ord_2"] }]);
    expect(rejected.rejectedSellerAccountIds).toEqual(["acc_seller"]);

    await releaseSellerOrderCapacityClaim(db, "ord_1", new Date().toISOString());

    const accepted = await claimSellerOrderCapacity(db, [{ sellerAccountId: "acc_seller", orderIds: ["ord_2"] }]);
    expect(accepted.rejectedSellerAccountIds).toEqual([]);
    expect(await openClaimCount(db, "acc_seller")).toBe(1);
  });

  it("reconciles at-capacity true once the open count reaches the cap", async () => {
    const db = pools.ordering;
    await setSellerCap(db, "acc_seller", 1);

    expect(await reconcileSellerOrderCapacity(db, "acc_seller")).toEqual({ atCapacity: false });

    await claimSellerOrderCapacity(db, [{ sellerAccountId: "acc_seller", orderIds: ["ord_1"] }]);
    expect(await reconcileSellerOrderCapacity(db, "acc_seller")).toEqual({ atCapacity: true });

    await releaseSellerOrderCapacityClaim(db, "ord_1", new Date().toISOString());
    expect(await reconcileSellerOrderCapacity(db, "acc_seller")).toEqual({ atCapacity: false });
  });

  it("reconciles at-capacity false for an unlimited seller regardless of open count", async () => {
    const db = pools.ordering;

    await claimSellerOrderCapacity(db, [{ sellerAccountId: "acc_seller", orderIds: ["ord_1", "ord_2", "ord_3"] }]);

    expect(await reconcileSellerOrderCapacity(db, "acc_seller")).toEqual({ atCapacity: false });
  });

  it("backfill seeds claims from open orders idempotently, ignoring cancelled and dispatched ones", async () => {
    const db = pools.ordering;
    const now = new Date().toISOString();

    await db.query(
      `INSERT INTO ordering_order_pages (
         order_id, display_reference, source_type, source_reference_id, buyer_account_id, seller_account_id,
         shipping_option, item_subtotal_amount, shipping_base_amount, shipping_discount_amount,
         shipping_charge_amount, total_amount, marketplace_sales_fee_amount, seller_net_amount,
         terms_resolved_at, status, created_at, updated_at
       ) VALUES
         ('ord_open', 'CS-OPEN', 'cart-checkout', 'chk_1', 'acc_buyer', 'acc_seller', 'standard', '10.00', '4.99', '0.00', '4.99', '14.99', '1.00', '9.00', $1, 'pending-payment', $1, $1),
         ('ord_cancelled', 'CS-CANC', 'cart-checkout', 'chk_2', 'acc_buyer', 'acc_seller', 'standard', '10.00', '4.99', '0.00', '4.99', '14.99', '1.00', '9.00', $1, 'cancelled', $1, $1),
         ('ord_dispatched', 'CS-DISP', 'cart-checkout', 'chk_3', 'acc_buyer', 'acc_seller', 'standard', '10.00', '4.99', '0.00', '4.99', '14.99', '1.00', '9.00', $1, 'ready-for-fulfillment', $1, $1)`,
      [now],
    );
    await db.query(
      `INSERT INTO ordering_fulfillment_cancellation_inputs (
         order_id, shipment_id, shipment_status, package_status, created_at, updated_at
       ) VALUES ('ord_dispatched', 'shp_1', 'dispatched', 'packed', $1, $1)`,
      [now],
    );

    const firstRun = await backfillSellerOpenOrderClaims(db);
    expect(firstRun).toEqual(["acc_seller"]);
    expect(await openClaimCount(db, "acc_seller")).toBe(1);

    const claimedOrderId = await db.query<{ order_id: string }>(
      `SELECT order_id FROM ordering_seller_open_order_claims WHERE seller_account_id = $1 AND status = 'claimed'`,
      ["acc_seller"],
    );
    expect(claimedOrderId.rows[0]?.order_id).toBe("ord_open");

    // Idempotent re-run: no duplicate rows, no error.
    const secondRun = await backfillSellerOpenOrderClaims(db);
    expect(secondRun).toEqual([]);
    expect(await openClaimCount(db, "acc_seller")).toBe(1);
  });
});
