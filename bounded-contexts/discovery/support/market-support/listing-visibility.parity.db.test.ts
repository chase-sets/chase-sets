import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import { bootstrapContextDatabase } from "@chase-sets/bounded-context-runtime";
import { buildTransportEvent } from "@chase-sets/event-core/test-support";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { realtimeOutboxSchemaSql } from "@chase-sets/platform-runtime/realtime";
import { module as discoveryModule } from "../../index";
import { buildDiscoveryMarketProjectionHandlers } from "./projection";
import { getDiscoveryPublicListingBySlug } from "./queries";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl && process.env.CI)
  throw new Error("TEST_DATABASE_URL is required for Discovery parity DB tests in CI.");
const describeDb = databaseUrl ? describe : describe.skip;

describeDb("Discovery Listing and Offer visibility parity on Postgres", () => {
  let pool: PgTransactionalPool;
  beforeAll(async () => {
    const urls = createMultiContextTestDatabaseUrls(databaseUrl!, ["discovery"], "listing_visibility_parity");
    await ensureMultiContextTestDatabases(databaseUrl!, urls);
    pool = createMultiContextTestPools(urls).discovery;
  });
  beforeEach(async () => {
    await resetMultiContextTestSchemas({ discovery: pool });
    await pool.query(realtimeOutboxSchemaSql);
    await bootstrapContextDatabase(discoveryModule, pool);
    await pool.query(`
      INSERT INTO discovery_market_accounts (account_id, seller_slug, seller_display_name, status)
      VALUES ('acc_active', 'active', 'Active', 'active'), ('acc_suspended', 'suspended', 'Suspended', 'suspended'), ('acc_closed', 'closed', 'Closed', 'closed');
      INSERT INTO discovery_item_detail_pages (catalog_item_id, slug, title, status, product_schema)
      VALUES ('cat_one', 'item-one', 'Item', 'published', '{}'::jsonb);
      INSERT INTO discovery_market_listings
        (listing_id, listing_slug, product_slug, account_id, inventory_item_id, catalog_catalog_item_id, product_id,
         item_title, price_amount, price_currency_code, listing_stream_version, quantity_cap, supply_total_quantity,
         active_held_quantity, product_measure_snapshot, status)
      VALUES ('lst_active', 'active', 'item-one', 'acc_active', 'inv_active', 'cat_one', 'cat_one::', 'Item', '10.00', 'USD', 2, 1, 1, 0, '{}'::jsonb, 'active'),
             ('lst_suspended', 'suspended', 'item-one', 'acc_suspended', 'inv_suspended', 'cat_one', 'cat_one::', 'Item', '10.00', 'USD', 2, 1, 1, 0, '{}'::jsonb, 'active'),
             ('lst_closed', 'closed', 'item-one', 'acc_closed', 'inv_closed', 'cat_one', 'cat_one::', 'Item', '10.00', 'USD', 2, 1, 1, 0, '{}'::jsonb, 'active');
    `);
  });
  afterAll(async () => {
    if (pool) await closeMultiContextTestPools({ discovery: pool });
  });

  it.each([
    ["active", true],
    ["suspended", false],
    ["closed", false],
    ["missing", false],
  ] as const)("runs the item-detail/direct URL Offer counterpart for %s mirrors", async (slug, visible) => {
    expect(Boolean(await getDiscoveryPublicListingBySlug(pool, slug))).toBe(visible);
    const handlers = buildDiscoveryMarketProjectionHandlers(pool);
    if (slug === "active") {
      await handlers["identity.account.suspended"]!(
        buildTransportEvent(
          "identity.account.suspended",
          {},
          {
            id: "evt_suspend",
            streamId: "identity.account-acc_active",
            streamVersion: 2,
            globalPosition: "2",
            timing: { occurredAt: "2026-10-17T00:00:02.000Z", recordedAt: "2026-10-17T00:00:02.000Z" },
          },
        ),
      );
      expect(await getDiscoveryPublicListingBySlug(pool, "active")).toBeNull();
    }
  });
});
