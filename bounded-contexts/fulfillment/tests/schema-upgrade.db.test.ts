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
import { createPostgresEventStore } from "@chase-sets/event-core-postgres";
import { module as fulfillmentModule } from "../index";

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

describeDb("fulfillment schema upgrades", () => {
  let pools: Readonly<Record<"fulfillment", PgTransactionalPool>>;

  beforeAll(async () => {
    const urls = createMultiContextTestDatabaseUrls(adminDatabaseUrl!, ["fulfillment"], "fulfillment_schema_upgrade");
    await ensureMultiContextTestDatabases(adminDatabaseUrl!, urls);
    pools = createMultiContextTestPools(urls);
  });

  beforeEach(async () => resetMultiContextTestSchemas(pools));
  afterAll(async () => closeMultiContextTestPools(pools));

  it("converges deployed return-shipment pages to the complete fresh schema", async () => {
    const pool = pools.fulfillment;
    await bootstrapContextDatabase(fulfillmentModule, pool);
    const freshCustomerColumns = await readColumnNames(pool, "fulfillment_return_shipment_customer_pages");
    const freshOperatorColumns = await readColumnNames(pool, "fulfillment_return_shipment_operator_pages");

    await pool.query(`ALTER TABLE fulfillment_return_shipment_customer_pages
      DROP COLUMN label_status,
      DROP COLUMN label_document_url,
      DROP COLUMN label_failure_reason`);
    await pool.query(`ALTER TABLE fulfillment_return_shipment_operator_pages
      DROP COLUMN label_document_url,
      DROP COLUMN postage_provider_name,
      DROP COLUMN postage_provider_mode,
      DROP COLUMN postage_provider_shipment_id,
      DROP COLUMN postage_provider_label_id,
      DROP COLUMN postage_amount_cents,
      DROP COLUMN estimated_postage_amount_cents,
      DROP COLUMN postage_currency,
      DROP COLUMN label_failure_reason,
      DROP COLUMN label_failure_detail,
      DROP COLUMN label_refund_status,
      DROP COLUMN label_refund_reference,
      DROP COLUMN label_failed_at,
      DROP COLUMN label_voided_at`);
    await pool.query(
      "DELETE FROM bounded_context_schema_migrations WHERE migration_id = '20260718_fulfillment_return_shipment_label_columns'",
    );
    await bootstrapContextDatabase(fulfillmentModule, pool);

    expect(await readColumnNames(pool, "fulfillment_return_shipment_customer_pages")).toEqual(freshCustomerColumns);
    expect(await readColumnNames(pool, "fulfillment_return_shipment_operator_pages")).toEqual(freshOperatorColumns);
    const migration = await pool.query<{ migration_id: string }>(
      "SELECT migration_id FROM bounded_context_schema_migrations WHERE migration_id = '20260718_fulfillment_return_shipment_label_columns'",
    );
    expect(migration.rows).toEqual([{ migration_id: "20260718_fulfillment_return_shipment_label_columns" }]);
  });

  it("issue-7171-history-tenant-migration-bounds upgrades the retained base schema and every legacy postage status", async () => {
    const pool = pools.fulfillment;
    await bootstrapContextDatabase(fulfillmentModule, pool);
    const freshFence = await pool.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes
       WHERE schemaname = current_schema()
         AND indexname = 'fulfillment_postage_label_operations_active_target_v1_idx'`,
    );
    const freshStatusConstraint = await pool.query<{ definition: string }>(
      `SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint
       WHERE conrelid = 'fulfillment_postage_label_operations'::regclass
         AND conname = 'fulfillment_postage_label_operations_status_check'`,
    );
    const eventStore = createPostgresEventStore({ pool });
    const context = {
      tenantId: "tnt_retained",
      audit: { performedByUserId: "usr_retained", forAccountId: "acc_seller" },
    } as const;
    const shipmentIds = ["shp_history", "shp_pending", "shp_provider", "shp_empty_tenant"];
    for (const shipmentId of shipmentIds) {
      await eventStore.appendToStream({
        streamId: `fulfillment.shipment-${shipmentId}`,
        expectedVersion: "no_stream",
        context,
        events: [
          {
            eventType: "fulfillment.shipment.created",
            payload: { shipmentId, sellerAccountId: "acc_seller" },
          },
        ],
      });
    }
    await eventStore.appendToStream({
      streamId: "fulfillment.shipment-shp_empty_tenant",
      expectedVersion: 1,
      context,
      events: [{ eventType: "fulfillment.shipment.packing-started", payload: { shipmentId: "shp_empty_tenant" } }],
    });
    await pool.query(
      `UPDATE event_store_events SET tenant_id = ''
       WHERE stream_id = 'fulfillment.shipment-shp_empty_tenant' AND stream_version = 2`,
    );

    await pool.query(`DROP TABLE fulfillment_postage_label_operations CASCADE`);
    await pool.query(`DROP TABLE fulfillment_shipment_tenant_resolutions CASCADE`);
    await pool.query(`DROP TABLE fulfillment_shipment_pages CASCADE`);
    await pool.query(`DROP TABLE fulfillment_postage_provider_events CASCADE`);
    // Retained definitions from base 42a6ad560 before #7171's authority migration.
    await pool.query(`CREATE TABLE fulfillment_shipment_pages (
      shipment_id text PRIMARY KEY,
      order_id text NOT NULL,
      buyer_account_id text NOT NULL,
      seller_account_id text NOT NULL,
      shipping_option text NOT NULL,
      shipping_destination_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
      shipping_origin_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
      shipping_plan_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
      shipping_method text NULL,
      carrier_name text NULL,
      display_reference text NOT NULL DEFAULT '',
      label_reference text NULL,
      label_document_url text NULL,
      tracking_identifier text NULL,
      postage_provider_name text NULL,
      postage_provider_mode text NULL,
      postage_provider_shipment_id text NULL,
      postage_provider_label_id text NULL,
      postage_rate_id text NULL,
      postage_service_level text NULL,
      postage_amount_cents integer NULL,
      postage_currency text NULL,
      label_status text NOT NULL DEFAULT 'not-purchased',
      label_error_code text NULL,
      label_error_message text NULL,
      label_refund_status text NULL,
      label_refund_reference text NULL,
      status text NOT NULL,
      package_status text NOT NULL,
      package_count integer NULL,
      current_exception_type text NULL,
      current_exception_notes text NULL,
      created_at timestamptz NOT NULL,
      updated_at timestamptz NOT NULL,
      packing_started_at timestamptz NULL,
      package_prepared_at timestamptz NULL,
      label_attached_at timestamptz NULL,
      label_voided_at timestamptz NULL,
      cancelled_at timestamptz NULL,
      dispatched_at timestamptz NULL,
      delivered_at timestamptz NULL,
      returned_at timestamptz NULL,
      exception_raised_at timestamptz NULL
    )`);
    await pool.query(`CREATE TABLE fulfillment_postage_label_operations (
      operation_key text PRIMARY KEY,
      operation_kind text NOT NULL CHECK (operation_kind IN ('purchase-usps-label', 'void-label')),
      shipment_id text NOT NULL,
      provider_name text NOT NULL,
      provider_mode text NOT NULL,
      idempotency_key text NOT NULL,
      request_json jsonb NOT NULL DEFAULT '{}'::jsonb,
      status text NOT NULL CHECK (status IN ('pending', 'provider-succeeded', 'succeeded', 'failed')),
      provider_shipment_id text NULL,
      provider_label_id text NULL,
      tracking_identifier text NULL,
      error_message text NULL,
      created_at timestamptz NOT NULL,
      updated_at timestamptz NOT NULL,
      completed_at timestamptz NULL
    )`);
    await pool.query(`CREATE UNIQUE INDEX fulfillment_postage_label_operations_active_kind_idx
      ON fulfillment_postage_label_operations (shipment_id, operation_kind)
      WHERE status IN ('pending', 'provider-succeeded')`);
    await pool.query(`CREATE TABLE fulfillment_postage_provider_events (
      provider_event_id text PRIMARY KEY,
      provider_name text NOT NULL,
      provider_mode text NOT NULL,
      event_kind text NOT NULL,
      provider_object_reference text NOT NULL,
      shipment_id text NULL,
      tracking_identifier text NULL,
      status text NULL,
      status_detail text NULL,
      occurred_at timestamptz NOT NULL,
      received_at timestamptz NOT NULL,
      processing_result text NOT NULL,
      payload_json jsonb NOT NULL DEFAULT '{}'::jsonb
    )`);
    await pool.query(
      `INSERT INTO fulfillment_shipment_pages (
         shipment_id, order_id, buyer_account_id, seller_account_id, shipping_option,
         status, package_status, created_at, updated_at
       )
       SELECT shipment_id, 'ord_' || shipment_id, 'acc_buyer', 'acc_seller', 'standard',
              'awaiting-label', 'packed', now(), now()
       FROM unnest($1::text[]) AS shipment_id`,
      [shipmentIds],
    );
    await pool.query(
      `INSERT INTO fulfillment_postage_label_operations (
         operation_key, operation_kind, shipment_id, provider_name, provider_mode, idempotency_key,
         request_json, status, created_at, updated_at, completed_at
       ) VALUES
         ('legacy-failed', 'purchase-usps-label', 'shp_history', 'fake', 'test', 'legacy-failed', '{}', 'failed', now(), now(), now()),
         ('legacy-succeeded', 'purchase-usps-label', 'shp_history', 'fake', 'test', 'legacy-succeeded', '{}', 'succeeded', now(), now(), now()),
         ('legacy-pending', 'purchase-usps-label', 'shp_pending', 'fake', 'test', 'legacy-pending', '{}', 'pending', now(), now(), NULL),
         ('legacy-provider-succeeded', 'purchase-usps-label', 'shp_provider', 'fake', 'test', 'legacy-provider', '{}', 'provider-succeeded', now(), now(), NULL)`,
    );

    await pool.query(
      `DELETE FROM bounded_context_schema_migrations
       WHERE migration_id = '20260823_fulfillment_shipment_mutation_authority_v1'`,
    );
    await bootstrapContextDatabase(fulfillmentModule, pool);

    const retained = await pool.query<{ operation_key: string; status: string; target_key: string }>(
      `SELECT operation_key, status, target_key
       FROM fulfillment_postage_label_operations ORDER BY operation_key`,
    );
    expect(retained.rows).toEqual([
      expect.objectContaining({ operation_key: "legacy-failed", status: "ambiguous" }),
      expect.objectContaining({ operation_key: "legacy-pending", status: "reserved" }),
      expect.objectContaining({ operation_key: "legacy-provider-succeeded", status: "provider-succeeded" }),
      expect.objectContaining({ operation_key: "legacy-succeeded", status: "effect-applied" }),
    ]);
    expect(new Set(retained.rows.map((row) => row.target_key)).size).toBe(retained.rows.length);
    const indexes = await pool.query<{ indexname: string; indexdef: string }>(
      `SELECT indexname, indexdef FROM pg_indexes
       WHERE schemaname = current_schema()
         AND indexname IN (
           'fulfillment_postage_label_operations_active_kind_idx',
           'fulfillment_postage_label_operations_active_target_v1_idx'
         ) ORDER BY indexname`,
    );
    expect(indexes.rows).toEqual([
      expect.objectContaining({
        indexname: "fulfillment_postage_label_operations_active_target_v1_idx",
        indexdef: expect.stringContaining("tenant_id, seller_account_id, shipment_id, operation_kind, target_key"),
      }),
    ]);
    expect(indexes.rows[0]?.indexdef).toBe(freshFence.rows[0]?.indexdef);
    const retainedStatusConstraint = await pool.query<{ definition: string }>(
      `SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint
       WHERE conrelid = 'fulfillment_postage_label_operations'::regclass
         AND conname = 'fulfillment_postage_label_operations_status_check'`,
    );
    expect(retainedStatusConstraint.rows).toEqual(freshStatusConstraint.rows);
    const emptyTenant = await pool.query<{ status: string; reason_code: string; tenant_id: string | null }>(
      `SELECT status, reason_code, tenant_id FROM fulfillment_shipment_tenant_resolutions
       WHERE shipment_id = 'shp_empty_tenant'`,
    );
    expect(emptyTenant.rows).toEqual([
      { status: "quarantined", reason_code: "shipment-history-empty-tenant", tenant_id: null },
    ]);
    const ledger = await pool.query<{ migration_id: string }>(
      `SELECT migration_id FROM bounded_context_schema_migrations
       WHERE migration_id = '20260823_fulfillment_shipment_mutation_authority_v1'`,
    );
    expect(ledger.rows).toEqual([{ migration_id: "20260823_fulfillment_shipment_mutation_authority_v1" }]);
  });
});
