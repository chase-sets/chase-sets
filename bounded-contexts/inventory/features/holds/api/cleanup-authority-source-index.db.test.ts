import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import { bootstrapContextDatabase } from "@chase-sets/bounded-context-runtime";
import { module as inventoryModule } from "../../..";
import {
  INVENTORY_HOLD_SOURCE_ORDER_INDEX_NAME,
  INVENTORY_HOLD_SOURCE_LOOKUP_SQL,
  createInventoryHoldCleanupAuthority,
} from "./cleanup-authority";
import { inventoryHoldSourceIndexSchemaMigrations } from "../read-model/schema";

// phantom-SQL rule: exercised against a real Postgres sandbox
// (TEST_DATABASE_URL, see .env.sandbox.local / dev:bootstrap), never mocked.
// The concurrent partial expression index and its query plan cannot be proven
// anywhere but a live server.
const databaseBaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseBaseUrl && process.env.CI) {
  throw new Error("TEST_DATABASE_URL is required for database-backed tests in CI.");
}
const describeDb = databaseBaseUrl ? describe : describe.skip;
const contextNames = ["inventory"] as const;

const MIGRATION_ID = "20260822_inventory_hold_source_order_index";
const TENANT_ID = "tnt_cleanup";
const ORDER_ID = "ord_cleanup_1";

type CountRow = Readonly<{ count: string }>;
type IndexRow = Readonly<{ indexdef: string }>;
type PlanRow = Readonly<{ "QUERY PLAN": string }>;

describeDb("cleanup-authority-source-index-migration", () => {
  let pools: Readonly<Record<(typeof contextNames)[number], PgTransactionalPool>>;

  beforeAll(async () => {
    const databaseUrls = createMultiContextTestDatabaseUrls(
      databaseBaseUrl!,
      contextNames,
      "inventory_hold_source_index",
    );
    await ensureMultiContextTestDatabases(databaseBaseUrl!, databaseUrls);
    pools = createMultiContextTestPools(databaseUrls);
  });

  beforeEach(async () => {
    await resetMultiContextTestSchemas(pools);
  });

  afterAll(async () => {
    await closeMultiContextTestPools(pools);
  });

  async function indexDefinition(pool: PgTransactionalPool): Promise<string | null> {
    const result = await pool.query<IndexRow>(
      `SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND indexname = $1`,
      [INVENTORY_HOLD_SOURCE_ORDER_INDEX_NAME],
    );
    return result.rows[0]?.indexdef ?? null;
  }

  async function ledgerCount(pool: PgTransactionalPool): Promise<number> {
    const result = await pool.query<CountRow>(
      `SELECT count(*)::text AS count FROM bounded_context_schema_migrations WHERE migration_id = $1`,
      [MIGRATION_ID],
    );
    return Number(result.rows[0]?.count ?? "0");
  }

  it("is a newly identified Inventory-owned migration, not an amendment of the shared one", () => {
    expect(inventoryHoldSourceIndexSchemaMigrations).toHaveLength(1);
    expect(inventoryHoldSourceIndexSchemaMigrations[0]!.migrationId).toBe(MIGRATION_ID);
    expect(inventoryModule.schemaMigrations?.map((migration) => migration.migrationId)).toContain(MIGRATION_ID);
    // The already-recorded shared event-core migration is untouched: appending
    // to it would never run on a database that already has its ledger row.
    expect(inventoryModule.schemaMigrations?.map((migration) => migration.migrationId)).not.toContain(
      "20260628_event_store_events_concurrent_indexes",
    );
    const statements = inventoryHoldSourceIndexSchemaMigrations[0]!.statements;
    expect(statements).toHaveLength(1);
    expect(statements[0]).toContain("CREATE INDEX CONCURRENTLY IF NOT EXISTS");
  });

  it("applies once on a fresh database and records exactly one ledger row", async () => {
    const pool = pools.inventory;
    expect(await indexDefinition(pool)).toBeNull();

    await bootstrapContextDatabase(inventoryModule, pool);

    const definition = await indexDefinition(pool);
    expect(definition).not.toBeNull();
    // Leading tenant, then the sourceRef order-id expression, then the
    // ordering columns, partial to the two source-bearing Hold event types.
    expect(definition).toContain("tenant_id");
    expect(definition).toContain("sourceRef");
    expect(definition).toContain("orderId");
    expect(definition).toContain("global_position");
    expect(definition).toContain("stream_id");
    expect(definition).toContain("inventory.hold.placed");
    expect(definition).toContain("inventory.hold.converted");
    expect(await ledgerCount(pool)).toBe(1);
  });

  it("is a no-op on a second boot and stays at one ledger row", async () => {
    const pool = pools.inventory;
    await bootstrapContextDatabase(inventoryModule, pool);
    const firstDefinition = await indexDefinition(pool);

    await bootstrapContextDatabase(inventoryModule, pool);

    expect(await indexDefinition(pool)).toBe(firstDefinition);
    expect(await ledgerCount(pool)).toBe(1);
  });

  it("skips the statement when the ledger is prepopulated but still boots cleanly", async () => {
    const pool = pools.inventory;
    // Prepopulate the ledger the way a database that already ran this
    // migration would look, then prove boot honours the ledger.
    await pool.query(`CREATE TABLE IF NOT EXISTS bounded_context_schema_migrations (
      migration_id text PRIMARY KEY,
      description text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    await pool.query(
      `INSERT INTO bounded_context_schema_migrations (migration_id, description, applied_at)
       VALUES ($1, 'prepopulated', now())`,
      [MIGRATION_ID],
    );

    await bootstrapContextDatabase(inventoryModule, pool);

    expect(await ledgerCount(pool)).toBe(1);
    // The ledger row suppressed the statement, so the index is absent -- the
    // observable proof that the skip is real rather than incidental.
    expect(await indexDefinition(pool)).toBeNull();
  });

  it("serves the reverse Hold lookup from the index and returns the real Hold set", async () => {
    const pool = pools.inventory;
    await bootstrapContextDatabase(inventoryModule, pool);

    await pool.query(
      `INSERT INTO event_store_streams (stream_id, current_version, updated_at)
       VALUES ('inventory.hold-hld_direct', 1, now()),
              ('inventory.hold-hld_converted', 2, now()),
              ('inventory.hold-hld_other_order', 1, now()),
              ('inventory.hold-hld_other_tenant', 1, now())`,
    );
    await pool.query(
      `INSERT INTO event_store_events (
         event_id, stream_id, stream_version, tenant_id, stream_context_name, stream_category,
         event_type, payload, occurred_at, recorded_at, performed_by_user_id, for_account_id
       ) VALUES
         ('evt_1', 'inventory.hold-hld_direct', 1, $1, 'inventory', 'inventory.hold', 'inventory.hold.placed',
          $2::jsonb, now(), now(), 'usr_test', 'acc_seller'),
         ('evt_2', 'inventory.hold-hld_converted', 1, $1, 'inventory', 'inventory.hold', 'inventory.hold.placed',
          $3::jsonb, now(), now(), 'usr_test', 'acc_seller'),
         ('evt_3', 'inventory.hold-hld_converted', 2, $1, 'inventory', 'inventory.hold', 'inventory.hold.converted',
          $4::jsonb, now(), now(), 'usr_test', 'acc_seller'),
         ('evt_4', 'inventory.hold-hld_other_order', 1, $1, 'inventory', 'inventory.hold', 'inventory.hold.placed',
          $5::jsonb, now(), now(), 'usr_test', 'acc_seller'),
         ('evt_5', 'inventory.hold-hld_other_tenant', 1, 'tnt_other', 'inventory', 'inventory.hold',
          'inventory.hold.placed', $2::jsonb, now(), now(), 'usr_test', 'acc_seller')`,
      [
        TENANT_ID,
        JSON.stringify({
          holdId: "hld_direct",
          purpose: "order",
          sourceRef: { orderId: ORDER_ID, reservationRequestId: "rsv_1" },
        }),
        JSON.stringify({
          holdId: "hld_converted",
          purpose: "checkout",
          sourceRef: { checkoutSessionId: "chk_1", lineKey: "line_1" },
        }),
        JSON.stringify({
          holdId: "hld_converted",
          purpose: "order",
          sourceRef: { orderId: ORDER_ID, reservationRequestId: "rsv_2" },
        }),
        JSON.stringify({
          holdId: "hld_other_order",
          purpose: "order",
          sourceRef: { orderId: "ord_other", reservationRequestId: "rsv_9" },
        }),
      ],
    );

    const authority = createInventoryHoldCleanupAuthority({
      eventStore: { readStream: async () => [] },
      db: pool,
    });

    // Direct placement and checkout conversion both appear; the other Order
    // and the other tenant do not.
    expect(await authority.lookupOrderHoldIds({ tenantId: TENANT_ID, orderId: ORDER_ID })).toEqual({
      kind: "lookup",
      holdIds: ["hld_direct", "hld_converted"],
    });

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      // Force the planner off the sequential scan a tiny table would otherwise
      // prefer, so the plan proves the index is usable for this exact query.
      await client.query("SET LOCAL enable_seqscan = off");
      const plan = await client.query<PlanRow>(`EXPLAIN ${INVENTORY_HOLD_SOURCE_LOOKUP_SQL}`, [TENANT_ID, ORDER_ID]);
      const planText = plan.rows.map((row) => row["QUERY PLAN"]).join("\n");
      expect(planText).toContain(INVENTORY_HOLD_SOURCE_ORDER_INDEX_NAME);
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
  });
});
