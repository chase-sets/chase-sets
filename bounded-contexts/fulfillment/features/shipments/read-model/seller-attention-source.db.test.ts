import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { bootstrapContextDatabase } from "@chase-sets/bounded-context-runtime";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import { aggregateSellerAttentionQueue, isSellerAttentionItem } from "@chase-sets/seller-attention-queue";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { module as fulfillmentModule } from "../../../index";
import { createShipByAttentionSourceFromReadModel } from "./seller-attention-source";

const adminDatabaseUrl = process.env.TEST_DATABASE_URL;
if (!adminDatabaseUrl && process.env.CI) {
  throw new Error("TEST_DATABASE_URL is required for database-backed tests in CI.");
}
const describeDb = adminDatabaseUrl ? describe : describe.skip;

describeDb("Fulfillment's Seller Desk ship-by source against PostgreSQL", () => {
  let pool: PgTransactionalPool;

  beforeAll(async () => {
    const urls = createMultiContextTestDatabaseUrls(adminDatabaseUrl!, ["fulfillment"], "fulfillment_attention_text");
    await ensureMultiContextTestDatabases(adminDatabaseUrl!, urls);
    pool = createMultiContextTestPools(urls).fulfillment;
  });
  beforeEach(async () => {
    await resetMultiContextTestSchemas({ fulfillment: pool });
    await bootstrapContextDatabase(fulfillmentModule, pool);
    await pool.query(
      `INSERT INTO fulfillment_shipment_pages (
         shipment_id, tenant_id, order_id, buyer_account_id, seller_account_id, shipping_option,
         display_reference, status, package_status, created_at, updated_at
       ) VALUES ('shp_attention', 'tnt_1', 'ord_attention', 'acc_buyer', 'acc_seller', 'standard',
                 'SHP-ATTENTION', 'awaiting-package', 'pending',
                 '2026-07-13T00:00:00.123456Z', '2026-07-13T00:05:00.000Z')`,
    );
  });
  afterAll(async () => closeMultiContextTestPools({ fulfillment: pool }));

  it("reads a shipment the driver would hand back as a Date as ISO text, so the Desk keeps it", async () => {
    const plain = await pool.query<{ created_at: unknown }>(
      "SELECT created_at FROM fulfillment_shipment_pages WHERE shipment_id = 'shp_attention'",
    );
    expect(plain.rows[0]?.created_at).toBeInstanceOf(Date);

    const source = createShipByAttentionSourceFromReadModel(pool);
    const context = { accountId: "acc_seller", now: "2026-07-14T12:00:00.000Z" };
    const items = await source.load(context);
    expect(items).toHaveLength(1);
    expect(items[0]?.observedAt).toBe("2026-07-13T00:00:00.123Z");
    expect(isSellerAttentionItem(items[0], "fulfillment-ship-by")).toBe(true);

    const queue = await aggregateSellerAttentionQueue([source], context);
    expect(queue.sources).toEqual([{ id: "fulfillment-ship-by", status: "available", itemCount: 1 }]);
    expect(queue.items.map((item) => item.id)).toEqual(["fulfillment-ship-by:shp_attention"]);
  });
});
