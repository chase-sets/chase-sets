import { beforeAll, beforeEach, afterAll, describe, expect, it } from "vitest";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { bootstrapContextDatabase } from "@chase-sets/bounded-context-runtime";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import { module as collectionsModule } from "../../index";
import { activateAnonymousOwnerCutover } from "./anonymous-owner-activation";

const baseUrl = process.env.TEST_DATABASE_URL;
if (!baseUrl && process.env.CI)
  throw new Error("TEST_DATABASE_URL is required for anonymous-owner activation DB proof.");
const describeDb = baseUrl ? describe : describe.skip;
let pool: PgTransactionalPool;

describeDb("anonymous owner activation", () => {
  beforeAll(async () => {
    const urls = createMultiContextTestDatabaseUrls(baseUrl!, ["collections"], "anonymous_owner_activation");
    await ensureMultiContextTestDatabases(baseUrl!, urls);
    pool = createMultiContextTestPools(urls).collections;
  });
  beforeEach(async () => {
    await resetMultiContextTestSchemas({ collections: pool });
    await bootstrapContextDatabase(collectionsModule, pool);
  });
  afterAll(async () => {
    if (pool) await closeMultiContextTestPools({ collections: pool });
  });

  it("anonymous-owner-activation-schema-parity", async () => {
    const column = await pool.query<{ is_nullable: string }>(
      `SELECT is_nullable FROM information_schema.columns
       WHERE table_name = 'collections_anonymous_saved_list_intents' AND column_name = 'anonymous_owner_id'`,
    );
    const activation = await pool.query<{ activated_at: string | null }>(
      "SELECT activated_at FROM collections_anonymous_owner_activation WHERE singleton = true",
    );
    const trigger = await pool.query("SELECT 1 FROM pg_trigger WHERE tgname = 'collections_anonymous_owner_raw_fence'");
    expect(column.rows).toEqual([{ is_nullable: "YES" }]);
    expect(activation.rows).toEqual([{ activated_at: null }]);
    expect(trigger.rows).toHaveLength(1);
  });

  it("anonymous-owner-activation-one-way", async () => {
    const first = await activateAnonymousOwnerCutover(pool, {
      gatePacketSha256: "a".repeat(64),
      floorCommit: "54c9898f45e14e616230e584d5a4ec078ceb1a03",
    });
    const second = await activateAnonymousOwnerCutover(pool, {
      gatePacketSha256: "b".repeat(64),
      floorCommit: "different",
    });
    await bootstrapContextDatabase(collectionsModule, pool);
    expect(first.activated_at).toBeTruthy();
    expect(second).toEqual(first);
    expect(
      (
        await pool.query(
          "SELECT activated_at::text AS activated_at, gate_packet_sha256, floor_commit FROM collections_anonymous_owner_activation",
        )
      ).rows,
    ).toEqual([
      {
        activated_at: first.activated_at,
        gate_packet_sha256: "a".repeat(64),
        floor_commit: "54c9898f45e14e616230e584d5a4ec078ceb1a03",
      },
    ]);
  });

  it("anonymous-owner-fence-rejects-raw-writes", async () => {
    const insert = `INSERT INTO collections_anonymous_saved_list_intents
      (intent_id, anonymous_owner_id, source_path, source_surface, catalog_catalog_item_id, product_id,
       selected_options, add_command_id, line_id, expires_at)
      VALUES ($1, $2, '/search', 'search', 'cat_fence', 'cat_fence::condition:near-mint', '[]'::jsonb,
       'slc_fence', 'sll_fence', now() + interval '30 days')`;
    await pool.query(insert, ["sli_fence_inactive", "anon_fence"]);
    await activateAnonymousOwnerCutover(pool, { gatePacketSha256: "c".repeat(64), floorCommit: "floor" });
    await expect(pool.query(insert, ["sli_fence_insert", "anon_fence"])).rejects.toThrow("anonymous-owner-fence");
    await pool.query(
      "UPDATE collections_anonymous_saved_list_intents SET source_path = '/item' WHERE intent_id = 'sli_fence_inactive'",
    );
    await expect(
      pool.query(
        "UPDATE collections_anonymous_saved_list_intents SET anonymous_owner_id = 'anon_other' WHERE intent_id = 'sli_fence_inactive'",
      ),
    ).rejects.toThrow("anonymous-owner-fence");
    await pool.query(
      "UPDATE collections_anonymous_saved_list_intents SET anonymous_owner_id = NULL WHERE intent_id = 'sli_fence_inactive'",
    );
  });
});
