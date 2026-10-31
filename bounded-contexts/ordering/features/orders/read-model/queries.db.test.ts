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
import { getPurchase, getSale, listPurchases, listSales } from "./queries";

const databaseBaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseBaseUrl && process.env.CI) {
  throw new Error("TEST_DATABASE_URL is required for database-backed tests in CI.");
}
const describeDb = databaseBaseUrl ? describe : describe.skip;
const contextNames = ["ordering"] as const;

async function insertOrderPage(
  db: PgTransactionalPool,
  params: Readonly<{ orderId: string; buyerAccountId: string; sellerAccountId: string }>,
) {
  await db.query(
    `INSERT INTO ordering_order_pages (
       order_id,
       source_type,
       buyer_account_id,
       seller_account_id,
       shipping_option,
       item_subtotal_amount,
       shipping_base_amount,
       shipping_discount_amount,
       shipping_charge_amount,
       total_amount,
       marketplace_sales_fee_amount,
       seller_net_amount,
       seller_payout_amount,
       terms_resolved_at,
       status
     ) VALUES ($1, 'cart-checkout', $2, $3, 'standard', '20.00', '4.99', '0.00', '4.99', '24.99', '2.00', '18.00', '22.99', now(), 'pending-payment')`,
    [params.orderId, params.buyerAccountId, params.sellerAccountId],
  );
}

async function insertOrderLine(
  db: PgTransactionalPool,
  params: Readonly<{ orderId: string; lineId: string; lineIndex: number; itemTitle: string }>,
) {
  await db.query(
    `INSERT INTO ordering_order_line_pages (
       order_id,
       line_id,
       line_index,
       listing_id,
       inventory_item_id,
       catalog_catalog_item_id,
       product_id,
       item_title,
       unit_price_amount,
       quantity,
       line_total_amount,
       marketplace_sales_fee_unit_amount,
       marketplace_sales_fee_total_amount,
       seller_net_unit_amount,
       seller_net_total_amount
     ) VALUES ($1, $2, $3, 'lst_1', 'inv_1', 'cat_1', 'cat_1::', $4, '10.00', 1, '10.00', '1.00', '1.00', '9.00', '9.00')`,
    [params.orderId, params.lineId, params.lineIndex, params.itemTitle],
  );
}

describeDb("ordering order read-model queries against live Postgres", () => {
  let pools: Readonly<Record<(typeof contextNames)[number], PgTransactionalPool>>;

  beforeAll(async () => {
    const databaseUrls = createMultiContextTestDatabaseUrls(databaseBaseUrl!, contextNames, "ordering_order_queries");
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

  it("orders item_titles by line_index for a multi-line purchase", async () => {
    await insertOrderPage(pools.ordering, {
      orderId: "ord_1",
      buyerAccountId: "acc_buyer",
      sellerAccountId: "acc_seller",
    });
    // Insert out of line-index order to prove the aggregate respects line_index, not insertion order.
    await insertOrderLine(pools.ordering, { orderId: "ord_1", lineId: "line_2", lineIndex: 1, itemTitle: "Blastoise" });
    await insertOrderLine(pools.ordering, { orderId: "ord_1", lineId: "line_1", lineIndex: 0, itemTitle: "Charizard" });

    const purchases = await listPurchases(pools.ordering, { buyerAccountId: "acc_buyer" });

    expect(purchases.items).toHaveLength(1);
    expect(purchases.items[0]?.item_titles).toEqual(["Charizard", "Blastoise"]);
    expect(purchases.items[0]?.total_quantity).toBe(2);

    const detail = await getPurchase(pools.ordering, "ord_1", "acc_buyer");
    expect(detail?.item_titles).toEqual(["Charizard", "Blastoise"]);
  });

  it("returns an empty item_titles array for an order with no lines yet", async () => {
    await insertOrderPage(pools.ordering, {
      orderId: "ord_2",
      buyerAccountId: "acc_buyer",
      sellerAccountId: "acc_seller",
    });

    const purchases = await listPurchases(pools.ordering, { buyerAccountId: "acc_buyer" });

    expect(purchases.items[0]?.item_titles).toEqual([]);
  });

  it("withholds self-service cancel while a recorded payment has no terminal failure", async () => {
    for (const orderId of ["ord_unpaid", "ord_paying", "ord_failed"]) {
      await insertOrderPage(pools.ordering, { orderId, buyerAccountId: "acc_buyer", sellerAccountId: "acc_seller" });
    }
    await pools.ordering.query(
      `INSERT INTO ordering_payment_deadline_inputs (
         order_id, payment_id, payment_method_category, payment_deadline_at, payment_deadline_policy,
         terminal_failure_at, failure_code, updated_at
       ) VALUES
         ('ord_paying', 'pay_open', 'card', now() + interval '1 hour', 'card-standard', NULL, NULL, now()),
         ('ord_failed', 'pay_failed', NULL, now() + interval '10 minutes', 'terminal-failure', now(), 'card_declined', now())`,
    );

    const phases = Object.fromEntries(
      await Promise.all(
        ["ord_unpaid", "ord_paying", "ord_failed"].map(async (orderId) => {
          const purchase = await getPurchase(pools.ordering, orderId, "acc_buyer");
          return [
            orderId,
            [purchase?.self_service_cancellation_available, purchase?.cancellation_unavailable_reason],
          ] as const;
        }),
      ),
    );

    expect(phases).toEqual({
      ord_unpaid: [true, null],
      ord_paying: [false, "payment-unresolved"],
      ord_failed: [true, null],
    });
    const listed = await listPurchases(pools.ordering, { buyerAccountId: "acc_buyer" });
    expect(listed.items.find((item) => item.order_id === "ord_paying")?.cancellation_unavailable_reason).toBe(
      "payment-unresolved",
    );
  });

  it("also surfaces item_titles on the seller-facing sale read model", async () => {
    await insertOrderPage(pools.ordering, {
      orderId: "ord_3",
      buyerAccountId: "acc_buyer",
      sellerAccountId: "acc_seller",
    });
    await insertOrderLine(pools.ordering, { orderId: "ord_3", lineId: "line_1", lineIndex: 0, itemTitle: "Charizard" });

    const sales = await listSales(pools.ordering, { sellerAccountId: "acc_seller" });
    expect(sales.items[0]?.item_titles).toEqual(["Charizard"]);

    const detail = await getSale(pools.ordering, "ord_3", "acc_seller");
    expect(detail?.item_titles).toEqual(["Charizard"]);
  });
});
