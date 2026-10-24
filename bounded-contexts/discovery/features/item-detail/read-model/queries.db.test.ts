import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { bootstrapContextDatabase } from "@chase-sets/bounded-context-runtime";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import type { PgQueryable, PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { module as discoveryModule } from "../../../index";
import { getDiscoveryItemDetail } from "./queries";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl && process.env.CI)
  throw new Error("TEST_DATABASE_URL is required for the Discovery item-detail lookup DB tests in CI.");
const describeDb = databaseUrl ? describe : describe.skip;

// The page lookup accepts a Catalog Item id, a current slug, or a retired slug
// that discovery_slug_redirects maps to the item by id or by target slug.
describeDb("getDiscoveryItemDetail page lookup on Postgres", () => {
  let pool: PgTransactionalPool;

  beforeAll(async () => {
    const urls = createMultiContextTestDatabaseUrls(databaseUrl!, ["discovery"], "item_detail_lookup");
    await ensureMultiContextTestDatabases(databaseUrl!, urls);
    pool = createMultiContextTestPools(urls).discovery;
  }, 120_000);

  beforeEach(async () => {
    await resetMultiContextTestSchemas({ discovery: pool });
    await bootstrapContextDatabase(discoveryModule, pool);
    await pool.query(`
      INSERT INTO discovery_item_detail_pages (catalog_item_id, slug, title, status, product_schema) VALUES
        ('cat_one', 'item-one', 'One', 'published', '{}'::jsonb),
        ('cat_two', 'item-two', 'Two', 'published', '{}'::jsonb),
        ('cat_slug_clash', 'cat_one', 'Slug clash', 'published', '{}'::jsonb),
        ('cat_no_slug', '', 'No slug', 'published', '{}'::jsonb);
      INSERT INTO discovery_slug_redirects (entity_kind, slug, entity_id, target_slug) VALUES
        ('item', 'old-item-one', 'cat_one', 'item-one'),
        ('item', 'old-item-two', 'cat_retired', 'item-two'),
        ('category', 'old-category', 'cat_two', 'item-two');
    `);
  });

  afterAll(async () => {
    if (pool) await closeMultiContextTestPools({ discovery: pool });
  });

  const lookup = async (input: string) => (await getDiscoveryItemDetail(pool, input))?.catalog_item_id ?? null;

  it("resolves an id, a current slug, and retired slugs by entity id or target slug", async () => {
    expect(await lookup("cat_two")).toBe("cat_two");
    expect(await lookup("item-two")).toBe("cat_two");
    expect(await lookup("old-item-one")).toBe("cat_one");
    expect(await lookup("old-item-two")).toBe("cat_two");
  });

  it("prefers a slug match over an id match and ignores other entity kinds, empty slugs, and unknown input", async () => {
    expect(await lookup("cat_one")).toBe("cat_slug_clash");
    expect(await lookup("old-category")).toBeNull();
    expect(await lookup("")).toBeNull();
    expect(await lookup("missing")).toBeNull();
  });

  it("plans the page lookup without a sequential scan of discovery_item_detail_pages", async () => {
    const statements: string[] = [];
    const recording: PgQueryable = {
      query: (text: string, values?: readonly unknown[]) => {
        statements.push(text);
        return pool.query(text, values);
      },
    };
    await getDiscoveryItemDetail(recording, "old-item-two");
    const client = await pool.connect();
    try {
      await client.query("SET enable_seqscan = off");
      const plan = await client.query<{ "QUERY PLAN": string }>(`EXPLAIN ${statements[0]}`, ["old-item-two"]);
      const lines = plan.rows.map((row) => row["QUERY PLAN"]);
      expect(lines.filter((line) => /Seq Scan on discovery_item_detail_pages/.test(line))).toEqual([]);
    } finally {
      await client.query("RESET enable_seqscan");
      client.release();
    }
  });
});
