import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { bootstrapContextDatabase } from "@chase-sets/bounded-context-runtime";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import { createPostgresEventStore, type PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { ZERO_GLOBAL_POSITION, type EventStoreContext } from "@chase-sets/event-core/storage";
import { toTransportEvent } from "@chase-sets/event-core/transport";
import { readCompleteStream } from "@chase-sets/event-core/complete-stream";
import { createListingAuthorityRecoveryCursorStore } from "@chase-sets/platform-runtime/listing-authority-recovery-cursor";
import { createCatalogListingAuthority } from "../features/product-measures/api/listing-authority";
import { module as catalogModule } from "../index";

const adminDatabaseUrl = process.env.TEST_DATABASE_URL;
if (!adminDatabaseUrl && process.env.CI) {
  throw new Error("TEST_DATABASE_URL is required for database-backed tests in CI.");
}
const describeDb = adminDatabaseUrl ? describe : describe.skip;

async function readColumnNames(pool: PgTransactionalPool, tableName: string): Promise<string[]> {
  const result = await pool.query<{ column_name: string }>(
    `SELECT column_name
     FROM information_schema.columns
     WHERE table_schema = current_schema() AND table_name = $1
     ORDER BY column_name`,
    [tableName],
  );
  return result.rows.map((row) => row.column_name);
}

describeDb("catalog schema upgrades", () => {
  let pools: Readonly<Record<"catalog", PgTransactionalPool>>;

  beforeAll(async () => {
    const urls = createMultiContextTestDatabaseUrls(adminDatabaseUrl!, ["catalog"], "catalog_schema_upgrade");
    await ensureMultiContextTestDatabases(adminDatabaseUrl!, urls);
    pools = createMultiContextTestPools(urls);
  });

  beforeEach(async () => resetMultiContextTestSchemas(pools));
  afterAll(async () => closeMultiContextTestPools(pools));

  it("persists independent recovery cursors, rejects stale writers and restarts discovery after cache loss", async () => {
    const pool = pools.catalog;
    await bootstrapContextDatabase(catalogModule, pool);
    const store = createListingAuthorityRecoveryCursorStore(pool, "catalog");
    expect(await store.load()).toEqual({ revision: "0", cursor: { eventAfter: "0", sqlAfter: "" } });
    expect(await store.save("0", { eventAfter: "100", sqlAfter: "synthetic-sql-42" })).toBe(true);
    const restarted = createListingAuthorityRecoveryCursorStore(pool, "catalog");
    expect(await restarted.load()).toEqual({
      revision: "1",
      cursor: { eventAfter: "100", sqlAfter: "synthetic-sql-42" },
    });
    expect(await store.save("0", { eventAfter: "900", sqlAfter: "stale" })).toBe(false);
    expect(await restarted.save("1", { eventAfter: "0", sqlAfter: "synthetic-sql-43" })).toBe(true);
    expect(await store.save("1", { eventAfter: "999", sqlAfter: "stale" })).toBe(false);
    await pool.query("UPDATE listing_authority_recovery_cursors SET event_after='malformed' WHERE owner='catalog'");
    expect(await restarted.load()).toEqual({ revision: "2", cursor: { eventAfter: "0", sqlAfter: "" } });
    await pool.query("DELETE FROM listing_authority_recovery_cursors WHERE owner='catalog'");
    expect(await store.save("2", { eventAfter: "999", sqlAfter: "stale" })).toBe(false);
    expect(await store.load()).toEqual({ revision: "0", cursor: { eventAfter: "0", sqlAfter: "" } });
    expect((await pool.query("SELECT count(*)::int AS events FROM event_store_events")).rows).toEqual([{ events: 0 }]);
  });

  it("upgrades legacy Product Measure Profiles without pretending their SQL rows have source authority", async () => {
    const pool = pools.catalog;
    await bootstrapContextDatabase(catalogModule, pool);
    await pool.query("ALTER TABLE catalog_product_measure_profiles DROP COLUMN source_revision");
    await pool.query(
      "DELETE FROM bounded_context_schema_migrations WHERE migration_id='20260927_catalog_product_measure_profile_source_revision'",
    );
    await pool.query(`INSERT INTO catalog_product_measure_profiles (profile_id,key,name,measure_snapshot)
      VALUES ('profile-synthetic','synthetic','Synthetic','{}'::jsonb)`);
    await bootstrapContextDatabase(catalogModule, pool);
    await bootstrapContextDatabase(catalogModule, pool);
    expect(
      (
        await pool.query(
          "SELECT source_revision::text FROM catalog_product_measure_profiles WHERE profile_id='profile-synthetic'",
        )
      ).rows,
    ).toEqual([{ source_revision: "0" }]);
    expect(
      (
        await pool.query(
          "SELECT migration_id FROM bounded_context_schema_migrations WHERE migration_id='20260927_catalog_product_measure_profile_source_revision'",
        )
      ).rows,
    ).toHaveLength(1);
  });

  it("reconciles SQL profiles in bounded pages of 100 and replays the original canonical revisions", async () => {
    const pool = pools.catalog;
    await bootstrapContextDatabase(catalogModule, pool);
    const measure = {
      unitLengthInches: 3.5,
      unitWidthInches: 2.5,
      unitHeightInches: 0.01,
      unitWeightOunces: 0.1,
      physicalFlags: ["raw-card"],
      stackBehavior: "stackable-thickness",
      confidence: "measured",
    } as const;
    await pool.query(
      `INSERT INTO catalog_product_measure_profiles (profile_id,key,name,measure_snapshot)
      SELECT 'synthetic-profile-' || n, 'synthetic-profile-' || n, 'Synthetic profile ' || n, $1::jsonb
      FROM generate_series(1,101) n`,
      [JSON.stringify(measure)],
    );
    const first = catalogModule.createServices(pool, {});
    expect(await first.productMeasures.reconcileProfileAuthority()).toBe(100);
    expect(
      (
        await pool.query(
          "SELECT count(*)::int AS pending FROM catalog_product_measure_profiles WHERE source_revision=0",
        )
      ).rows,
    ).toEqual([{ pending: 1 }]);
    const restarted = catalogModule.createServices(pool, {});
    expect(await restarted.productMeasures.reconcileProfileAuthority()).toBe(1);
    expect(await restarted.productMeasures.reconcileProfileAuthority()).toBe(0);
    await restarted.productMeasures.upsertProfile(
      {
        ...measure,
        profileId: "synthetic-profile-1",
        key: "synthetic-profile-1",
        name: "Synthetic revised profile",
        unitWeightOunces: 0.2,
      },
      {
        tenantId: "tnt_catalog",
        audit: { performedByUserId: "usr_catalog_system", forAccountId: "acc_catalog_system" },
      },
    );
    const before = (
      await pool.query(
        "SELECT profile_id,source_revision,measure_snapshot FROM catalog_product_measure_profiles ORDER BY profile_id",
      )
    ).rows;
    const store = createPostgresEventStore({ pool });
    const events = await readCompleteStream(store, { streamId: "catalog.product-measure-profiles" });
    expect(events).toHaveLength(102);
    expect(events.every((event) => event.performedByUserId === "usr_catalog_system")).toBe(true);
    await pool.query("TRUNCATE catalog_product_measure_profiles");
    const handler = restarted.productMeasures.projectors[0]!.handlers["catalog.product-measure-profile.recorded"]!;
    for (const event of events) await handler(toTransportEvent(event));
    // A delayed old event must not overwrite a newer source revision.
    for (const event of [...events].reverse()) await handler(toTransportEvent(event));
    expect(
      (
        await pool.query(
          "SELECT profile_id,source_revision,measure_snapshot FROM catalog_product_measure_profiles ORDER BY profile_id",
        )
      ).rows,
    ).toEqual(before);
    expect(await restarted.productMeasures.reconcileProfileAuthority()).toBe(0);
    expect(await readCompleteStream(store, { streamId: "catalog.product-measure-profiles" })).toHaveLength(102);
  });

  it("reads current Product source revisions in SQL and rejects a mutation between resolution and the final read", async () => {
    const pool = pools.catalog;
    await bootstrapContextDatabase(catalogModule, pool);
    const eventStore = createPostgresEventStore({ pool });
    const context: EventStoreContext = {
      tenantId: "tnt_synthetic",
      audit: { forAccountId: "acc_synthetic", performedByUserId: "usr_synthetic" },
    };
    await eventStore.appendToStream({
      streamId: "catalog.blueprint-bp_synthetic",
      expectedVersion: 0,
      context,
      events: [
        {
          eventType: "catalog.blueprint.created",
          payload: {
            blueprintId: "bp_synthetic",
            key: "synthetic",
            name: { en: "Synthetic" },
            description: { en: "" },
          },
        },
        { eventType: "catalog.blueprint.published", payload: {} },
      ],
    });
    await eventStore.appendToStream({
      streamId: "catalog.item-cat_synthetic",
      expectedVersion: 0,
      context,
      events: [
        {
          eventType: "catalog.catalog-item.created",
          payload: {
            itemId: "cat_synthetic",
            languageCode: "en",
            title: { en: "Synthetic" },
            subtitle: null,
            description: { en: "" },
          },
        },
        { eventType: "catalog.catalog-item.blueprint-assigned", payload: { blueprintId: "bp_synthetic" } },
        { eventType: "catalog.catalog-item.published", payload: { blueprintId: "bp_synthetic" } },
      ],
    });
    let invalidate = false;
    const authority = createCatalogListingAuthority(
      {
        eventStore,
        checkpointStore: { loadCheckpoint: async () => ZERO_GLOBAL_POSITION, saveCheckpoint: async () => {} },
        db: {
          query: async <Row>(text: string, values?: readonly unknown[]) => {
            if (invalidate && text.includes("WITH expected AS")) {
              invalidate = false;
              await eventStore.appendToStream({
                streamId: "catalog.item-cat_synthetic",
                expectedVersion: 3,
                context,
                events: [{ eventType: "catalog.catalog-item.archived", payload: {} }],
              });
            }
            return pool.query<Row>(text, values);
          },
        },
      },
      () => {
        throw new Error("Read-only test must not request a consumer reservation.");
      },
    );
    const subjects = [{ catalogItemId: "cat_synthetic", productId: "cat_synthetic::", selectedOptions: [] }];
    const result = await authority.readCurrentProducts(subjects, { maxAgeMs: 60_000 });
    expect(result.value).toEqual([
      expect.objectContaining({ ...subjects[0], blueprintId: "bp_synthetic", productMeasureSnapshot: null }),
    ]);
    invalidate = true;
    await expect(authority.readCurrentProducts(subjects, { maxAgeMs: 60_000 })).rejects.toThrow(
      "stale or unreconciled",
    );
  });

  it("converges a deployed scope-sync table to the complete fresh schema", async () => {
    const pool = pools.catalog;
    await bootstrapContextDatabase(catalogModule, pool);
    const freshColumns = await readColumnNames(pool, "catalog_scope_sync_state");

    await pool.query("ALTER TABLE catalog_scope_sync_state DROP COLUMN scope_record_id");
    await pool.query(
      "DELETE FROM bounded_context_schema_migrations WHERE migration_id = '20260718_catalog_scope_sync_state_scope_record_id'",
    );
    await bootstrapContextDatabase(catalogModule, pool);

    expect(await readColumnNames(pool, "catalog_scope_sync_state")).toEqual(freshColumns);
    const migration = await pool.query<{ migration_id: string }>(
      "SELECT migration_id FROM bounded_context_schema_migrations WHERE migration_id = '20260718_catalog_scope_sync_state_scope_record_id'",
    );
    expect(migration.rows).toEqual([{ migration_id: "20260718_catalog_scope_sync_state_scope_record_id" }]);
  });
});
