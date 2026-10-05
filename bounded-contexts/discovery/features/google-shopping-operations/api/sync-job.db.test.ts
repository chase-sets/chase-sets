import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { bootstrapContextDatabase } from "@chase-sets/bounded-context-runtime";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { module as discoveryModule } from "../../../index";
import { createGoogleShoppingSyncRuntime, type GoogleShoppingFeedRowFilter } from "./sync-job";

const now = "2026-06-03T12:00:00.000Z";
let pool: PgTransactionalPool;

describe("Google Shopping feed row list database query", () => {
  beforeAll(async () => {
    const baseUrl = process.env.TEST_DATABASE_URL;
    if (!baseUrl) throw new Error("TEST_DATABASE_URL is required for the Google Shopping feed row DB tests.");
    const urls = createMultiContextTestDatabaseUrls(baseUrl, ["discovery"], "google_shopping_list");
    await ensureMultiContextTestDatabases(baseUrl, urls);
    const pools = createMultiContextTestPools(urls);
    pool = pools.discovery;
    await resetMultiContextTestSchemas(pools);
    await bootstrapContextDatabase(discoveryModule, pool);
  }, 120_000);

  afterAll(async () => {
    if (pool) await closeMultiContextTestPools({ discovery: pool });
  });

  beforeEach(async () => {
    await pool.query("DELETE FROM discovery_google_shopping_feed_rows", []);
    await pool.query("DELETE FROM discovery_market_listings", []);
    await pool.query("DELETE FROM discovery_item_detail_pages", []);
  });

  it("counts triple overlap, eligible failed-only and disapproved-only once each, independently of the page", async () => {
    await seedRow("triple", { eligibility: "excluded", sync: "failed", diagnostics: "disapproved" });
    await seedRow("failed", { sync: "failed" });
    await seedRow("disapproved", { diagnostics: "disapproved" });
    await seedRow("healthy");
    const runtime = createGoogleShoppingSyncRuntime({ db: pool });
    const all = await runtime.listFeedRows({ now });
    expect(all.summary).toMatchObject({
      totalRows: 4,
      eligibleRows: 3,
      excludedRows: 1,
      failedRows: 2,
      disapprovedRows: 2,
      attentionRows: 3,
    });
    expect(all.summary.excludedRows + all.summary.failedRows + all.summary.disapprovedRows).toBe(5);
    const page = await runtime.listFeedRows({ now, filter: "excluded", search: "triple", limit: 1 });
    expect(page.rows.map((row) => row.listingId)).toEqual(["triple"]);
    expect(page.summary).toEqual(all.summary);
  });

  it.each(["eligible", "excluded"] as const)("counts an all-%s feed and the empty feed", async (eligibility) => {
    const runtime = createGoogleShoppingSyncRuntime({ db: pool });
    const empty = await runtime.listFeedRows({ now });
    expect(Object.values(empty.summary)).toEqual(Array(10).fill(0));
    expect(empty.rows).toEqual([]);
    for (const id of ["a", "b", "c"]) await seedRow(id, { eligibility });
    const list = await runtime.listFeedRows({ now });
    expect(list.summary).toMatchObject({
      totalRows: 3,
      eligibleRows: eligibility === "eligible" ? 3 : 0,
      excludedRows: eligibility === "excluded" ? 3 : 0,
      attentionRows: eligibility === "excluded" ? 3 : 0,
    });
  });

  it("gets titles from local projections even when invalid-image rows have no export payload", async () => {
    for (const id of ["catalog", "listing", "neither", "catalog-only", "null-listing"]) {
      await seedRow(id, { eligibility: "excluded" });
    }
    await seedListing("catalog", "Competing listing title");
    await seedListing("listing", "Listing title");
    await seedListing("null-listing", null);
    await seedCatalog("catalog", "Catalog title");
    await seedCatalog("catalog-only", "Catalog without listing projection");
    const list = await createGoogleShoppingSyncRuntime({ db: pool }).listFeedRows({ now });
    expect(list.rows.map((row) => [row.listingId, row.title])).toEqual([
      ["catalog", "Catalog title"],
      ["catalog-only", "Catalog without listing projection"],
      ["listing", "Listing title"],
      ["neither", null],
      ["null-listing", null],
    ]);
    expect(
      list.rows.every((row) => row.payloadHash === null && row.exclusionReasons.includes("invalid-image-url")),
    ).toBe(true);
    expect(list.rows[0]?.canonicalUrl).toBe("https://marketplace.chasesets.test/listings/catalog");
    expect(list.rows[0]?.accountId).toBe("feed-account");
    expect(list.rows[0]?.productId).toBe("feed-product");
    expect(list.rows[0]?.updatedAt).toBe(now);
  });

  it("preserves literal search escaping, filtering, limit and row-id ordering across shared projection columns", async () => {
    for (const id of ["needle_%\\a", "needle_%\\b", "needleXXa", "other"]) {
      await seedRow(id, { eligibility: "excluded" });
      await seedListing(id, `Listing ${id}`);
      await seedCatalog(id, `Catalog ${id}`);
    }
    await seedRow("needle_%\\eligible");
    const runtime = createGoogleShoppingSyncRuntime({ db: pool });
    const input = { now, filter: "excluded" as const, search: "NEEDLE_%\\", limit: 1 };
    const page = await runtime.listFeedRows(input);
    expect(page.rows.map((row) => row.listingId)).toEqual(["needle_%\\a"]);
    const remaining = await runtime.listFeedRows({ ...input, limit: 10 });
    expect(remaining.rows.map((row) => row.listingId)).toEqual(["needle_%\\a", "needle_%\\b"]);
    expect(page.summary).toEqual(remaining.summary);
    expect(page.summary.totalRows).toBe(5);
  });

  it.each([
    ["all", ["a", "b", "c"]],
    ["failed", ["b", "a", "c"]],
    ["disapproved", ["c", "a", "b"]],
    ["pending-delete", ["c", "a", "b"]],
    ["stale", ["c", "a", "b"]],
    ["nearing-refresh", ["c", "a", "b"]],
    ["pending-diagnostics", ["c", "a", "b"]],
  ] satisfies [GoogleShoppingFeedRowFilter, string[]][])(
    "preserves %s ordering after title joins",
    async (filter, expected) => {
      for (const id of ["a", "b", "c"]) {
        await seedRow(id, {
          sync: "failed",
          diagnostics: filter === "pending-diagnostics" ? "pending" : "disapproved",
        });
        await seedListing(id, `Listing ${id}`);
        await seedCatalog(id, `Catalog ${id}`);
        await pool.query(
          `UPDATE discovery_google_shopping_feed_rows SET
        updated_at = $2::timestamptz, last_sync_attempted_at = $3::timestamptz,
        last_diagnostic_at = $4::timestamptz, last_submitted_at = '2026-01-01',
        last_submitted_payload_hash = 'old', payload_hash = 'new', tombstone_status = $5
        WHERE listing_id = $1`,
          [
            id,
            id === "c" ? "2026-06-01" : now,
            id === "b" ? now : null,
            id === "c" ? now : null,
            filter === "pending-delete" ? "deleted" : "live",
          ],
        );
      }
      const list = await createGoogleShoppingSyncRuntime({ db: pool }).listFeedRows({ now, filter, limit: 2 });
      expect(list.rows.map((row) => row.listingId)).toEqual(expected.slice(0, 2));
    },
  );
});

async function seedRow(id: string, options: { eligibility?: string; sync?: string; diagnostics?: string } = {}) {
  await pool.query(
    `INSERT INTO discovery_google_shopping_feed_rows
    (row_id, listing_id, account_id, catalog_catalog_item_id, product_id, merchant_offer_id,
     external_seller_id, canonical_url, target_country, content_language, eligibility_status,
     sync_status, diagnostic_status, exclusion_reasons, image_exclusion_reasons, updated_at)
    VALUES ($1, $1, 'feed-account', $1, 'feed-product', $1, 'seller', $2, 'US', 'en', $3, $4, $5, $6, $6, $7)`,
    [
      id,
      `https://marketplace.chasesets.test/listings/${id}`,
      options.eligibility ?? "eligible",
      options.sync ?? "accepted",
      options.diagnostics ?? "approved",
      JSON.stringify(options.eligibility === "excluded" ? ["invalid-image-url"] : []),
      now,
    ],
  );
}

async function seedListing(id: string, title: string | null) {
  await pool.query(
    `INSERT INTO discovery_market_listings
    (listing_id, account_id, inventory_item_id, catalog_catalog_item_id, product_id, item_title, price_amount, updated_at)
    VALUES ($1, 'listing-account', 'inventory', $1, 'listing-product', $2, '5.00', '2026-01-01')`,
    [id, title],
  );
}

async function seedCatalog(id: string, title: string) {
  await pool.query(
    `INSERT INTO discovery_item_detail_pages (catalog_item_id, title, updated_at)
    VALUES ($1, $2, '2026-01-02')`,
    [id, title],
  );
}
