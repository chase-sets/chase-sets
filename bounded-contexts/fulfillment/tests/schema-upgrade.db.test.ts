import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
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

function documentedSqlAfter(runbook: string, marker: string): string {
  const markerOffset = runbook.indexOf(marker);
  const fenceStart = runbook.indexOf("```sql", markerOffset);
  const sqlStart = runbook.indexOf("\n", fenceStart) + 1;
  const fenceEnd = runbook.indexOf("```", sqlStart);
  if (markerOffset < 0 || fenceStart < 0 || sqlStart === 0 || fenceEnd < 0) {
    throw new Error(`Could not find documented SQL after ${marker}.`);
  }
  return runbook.slice(sqlStart, fenceEnd).trim();
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

  it("executes the bounded Shipment operation and provider-event queries documented for operators", async () => {
    const pool = pools.fulfillment;
    await bootstrapContextDatabase(fulfillmentModule, pool);
    await pool.query(
      `INSERT INTO fulfillment_postage_label_operations (
         operation_key, operation_id, operation_kind, subject_kind, subject_id,
         provider_name, provider_mode, idempotency_key, request_json, status, created_at, updated_at
       ) VALUES
         ('runbook-shipment', 'pop_runbook_shipment', 'purchase-usps-label', 'shipment', 'shp_runbook',
          'synthetic-postage', 'test', 'runbook-shipment', '{"serviceLevel":"USPS_GROUND_ADVANTAGE"}',
          'effect-applied', '2026-09-10T01:00:00.000Z', '2026-09-10T01:00:00.000Z'),
         ('runbook-record-decoy', 'pop_runbook_record', 'purchase-usps-label', 'channel-fulfillment-record', 'shp_runbook',
          'synthetic-postage', 'test', 'runbook-record', '{"serviceLevel":"USPS_GROUND_ADVANTAGE"}',
          'effect-applied', '2026-09-10T02:00:00.000Z', '2026-09-10T02:00:00.000Z')`,
    );
    await pool.query(
      `INSERT INTO fulfillment_postage_provider_events (
         provider_event_id, provider_name, provider_mode, event_kind, provider_object_reference,
         subject_kind, subject_id, tracking_identifier, status, occurred_at, received_at, processing_result
       ) VALUES
         ('pev_runbook_shipment', 'synthetic-postage', 'test', 'refund-status', 'refund_runbook',
          'shipment', 'shp_runbook', 'trk_runbook', 'refunded',
          '2026-09-10T03:00:00.000Z', '2026-09-10T03:00:00.000Z', 'recorded'),
         ('pev_runbook_record_decoy', 'synthetic-postage', 'test', 'refund-status', 'refund_decoy',
          'channel-fulfillment-record', 'shp_runbook', 'trk_runbook', 'refunded',
          '2026-09-10T04:00:00.000Z', '2026-09-10T04:00:00.000Z', 'recorded')`,
    );

    const runbook = readFileSync(new URL("../../../docs/runbooks/postage-operations.md", import.meta.url), "utf8");
    const operationSql = documentedSqlAfter(runbook, "Use this query shape for support diagnostics").replaceAll(
      "<shipmentId>",
      "shp_runbook",
    );
    const providerEventSql = documentedSqlAfter(runbook, "Confirm Fulfillment recorded the provider lifecycle fact")
      .replaceAll("<controlledParcelShipmentId>", "shp_runbook")
      .replaceAll("<trackingIdentifier>", "trk_runbook")
      .replaceAll("<refundOrProviderObjectReference>", "refund_runbook");

    expect(operationSql).toContain("subject_kind = 'shipment'");
    expect(operationSql).toContain("ORDER BY created_at DESC\nLIMIT 25");
    expect(operationSql).not.toMatch(/SELECT[\s\S]*request_json\s*(?:,|FROM)/);
    expect((await pool.query(operationSql)).rows).toEqual([
      expect.objectContaining({ operation_kind: "purchase-usps-label", provider_name: "synthetic-postage" }),
    ]);
    expect(providerEventSql).toContain("subject_kind = 'shipment'");
    expect(providerEventSql).toContain("subject_id = 'shp_runbook'");
    expect(providerEventSql).toContain("OR tracking_identifier = 'trk_runbook'");
    expect(providerEventSql).toContain("OR provider_object_reference = 'refund_runbook'");
    expect(providerEventSql).toContain("ORDER BY received_at DESC\nLIMIT 25");
    expect(providerEventSql).not.toContain("payload_json");
    expect((await pool.query(providerEventSql)).rows).toEqual([
      expect.objectContaining({
        provider_event_id: "pev_runbook_shipment",
        subject_kind: "shipment",
        subject_id: "shp_runbook",
      }),
    ]);
  });

  it("upgrades the exact 3e89401b retained postage schema with only the two subject migrations absent", async () => {
    const pool = pools.fulfillment;
    await bootstrapContextDatabase(fulfillmentModule, pool);
    const freshFence = await pool.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes
       WHERE schemaname = current_schema()
         AND indexname = 'fulfillment_postage_label_operations_active_target_v2_idx'`,
    );
    expect(freshFence.rows).toHaveLength(1);

    await pool.query(`DROP TABLE fulfillment_postage_label_operations CASCADE`);
    await pool.query(`DROP TABLE fulfillment_shipment_tenant_resolutions CASCADE`);
    await pool.query(`DROP TABLE fulfillment_channel_fulfillment_record_tenant_resolutions CASCADE`);
    await pool.query(`DROP TABLE fulfillment_postage_provider_events CASCADE`);

    // These definitions are copied from schema blob 5774c44c0527c39fe8a7841816475a9a1732af29 at exact base
    // 3e89401b9f978bd48ac9ae23bd51ceff3297e4eb, after its recorded 20260823 migration.
    await pool.query(`CREATE TABLE fulfillment_postage_label_operations (
      operation_key text PRIMARY KEY,
      operation_id text NOT NULL UNIQUE,
      operation_kind text NOT NULL CHECK (operation_kind IN ('purchase-usps-label', 'void-label', 'orphan-label-void')),
      shipment_id text NOT NULL,
      tenant_id text NULL,
      seller_account_id text NULL,
      key_digest text NULL,
      request_hash text NULL,
      target_key text NULL,
      provider_name text NOT NULL,
      provider_mode text NOT NULL,
      idempotency_key text NOT NULL,
      provider_idempotency_key text NULL,
      provider_result_json jsonb NULL,
      request_json jsonb NOT NULL DEFAULT '{}'::jsonb,
      status text NOT NULL CHECK (status IN ('reserved', 'invoking', 'ambiguous', 'provider-succeeded', 'effect-applied', 'failed-safe')),
      lifecycle_generation integer NOT NULL DEFAULT 0,
      claim_token text NULL,
      claim_expires_at timestamptz NULL,
      closed_reason text NULL,
      provider_invoked boolean NOT NULL DEFAULT false,
      provider_shipment_id text NULL,
      provider_label_id text NULL,
      tracking_identifier text NULL,
      error_message text NULL,
      created_at timestamptz NOT NULL,
      updated_at timestamptz NOT NULL,
      completed_at timestamptz NULL,
      CONSTRAINT fulfillment_postage_label_operations_lifecycle_present
        CHECK (lifecycle_generation IS NOT NULL AND provider_invoked IS NOT NULL),
      CONSTRAINT fulfillment_postage_label_operations_operation_id_present
        CHECK (operation_id IS NOT NULL)
    )`);
    await pool.query(`CREATE INDEX fulfillment_postage_label_operations_status_idx
      ON fulfillment_postage_label_operations (status, updated_at)`);
    await pool.query(`CREATE UNIQUE INDEX fulfillment_postage_label_operations_operation_id_idx
      ON fulfillment_postage_label_operations (operation_id)`);
    await pool.query(`CREATE UNIQUE INDEX fulfillment_postage_label_operations_receipt_idx
      ON fulfillment_postage_label_operations (tenant_id, seller_account_id, key_digest)
      WHERE tenant_id IS NOT NULL AND seller_account_id IS NOT NULL AND key_digest IS NOT NULL`);
    await pool.query(`CREATE UNIQUE INDEX fulfillment_postage_label_operations_active_target_v1_idx
      ON fulfillment_postage_label_operations (
        tenant_id, seller_account_id, shipment_id, operation_kind, target_key
      )
      WHERE status IN ('reserved', 'invoking', 'ambiguous', 'provider-succeeded', 'effect-applied')`);
    await pool.query(`CREATE TABLE fulfillment_shipment_tenant_resolutions (
      shipment_id text PRIMARY KEY,
      tenant_id text NULL,
      seller_account_id text NULL,
      status text NOT NULL CHECK (status IN ('resolved', 'quarantined')),
      reason_code text NOT NULL,
      resolved_at timestamptz NOT NULL
    )`);
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
      payload_json jsonb NOT NULL DEFAULT '{}'::jsonb,
      payload_hash text NULL,
      handoff_state text NOT NULL DEFAULT 'completed',
      receipt_version integer NOT NULL DEFAULT 1,
      claim_token text NULL,
      claim_generation integer NOT NULL DEFAULT 0,
      claim_expires_at timestamptz NULL,
      CONSTRAINT fulfillment_postage_provider_events_handoff_present
        CHECK (handoff_state IS NOT NULL AND receipt_version IS NOT NULL AND claim_generation IS NOT NULL)
    )`);
    await pool.query(`CREATE INDEX fulfillment_postage_provider_events_shipment_idx
      ON fulfillment_postage_provider_events (shipment_id, occurred_at DESC)
      WHERE shipment_id IS NOT NULL`);
    await pool.query(`CREATE INDEX fulfillment_postage_provider_events_received_idx
      ON fulfillment_postage_provider_events (received_at DESC)`);

    await pool.query(
      `INSERT INTO fulfillment_shipment_tenant_resolutions (
         shipment_id, tenant_id, seller_account_id, status, reason_code, resolved_at
       ) VALUES
         ('shp_base_resolved', 'tnt_base', 'acc_base', 'resolved', 'authoritative-history', '2026-09-09T00:00:00.000Z'),
         ('shp_base_quarantined', NULL, NULL, 'quarantined', 'shipment-history-mixed-tenant', '2026-09-09T00:00:00.000Z')`,
    );
    const retainedStatuses = [
      "reserved",
      "invoking",
      "ambiguous",
      "provider-succeeded",
      "effect-applied",
      "failed-safe",
    ] as const;
    for (const [index, status] of retainedStatuses.entries()) {
      await pool.query(
        `INSERT INTO fulfillment_postage_label_operations (
           operation_key, operation_id, operation_kind, shipment_id,
           tenant_id, seller_account_id, key_digest, request_hash, target_key,
           provider_name, provider_mode, idempotency_key, provider_idempotency_key,
           request_json, status, provider_invoked, created_at, updated_at
         ) VALUES ($1, $2, 'purchase-usps-label', 'shp_base_resolved',
                   'tnt_base', 'acc_base', $3, $4, $5,
                   'synthetic-postage', 'test', $6, $7,
                   '{}', $8, $9, '2026-09-09T00:00:00.000Z', '2026-09-09T00:00:00.000Z')`,
        [
          `base-${status}`,
          `pop_base_${index}`,
          `digest-base-${status}`,
          `hash-base-${status}`,
          `target-base-${status}`,
          `idempotency-base-${status}`,
          `provider-idempotency-base-${status}`,
          status,
          ["invoking", "ambiguous", "provider-succeeded", "effect-applied"].includes(status),
        ],
      );
    }
    await pool.query(
      `INSERT INTO fulfillment_postage_provider_events (
         provider_event_id, provider_name, provider_mode, event_kind, provider_object_reference,
         shipment_id, tracking_identifier, occurred_at, received_at, processing_result
       ) VALUES
         ('base-matched-event', 'synthetic-postage', 'test', 'tracking-status', 'base-matched',
          'shp_base_resolved', 'trk_base', '2026-09-09T01:00:00.000Z', '2026-09-09T01:00:00.000Z', 'recorded'),
         ('base-unmatched-event', 'synthetic-postage', 'test', 'provider-event', 'base-unmatched',
          NULL, NULL, '2026-09-09T02:00:00.000Z', '2026-09-09T02:00:00.000Z', 'unmatched')`,
    );
    await pool.query(
      `DELETE FROM bounded_context_schema_migrations
       WHERE migration_id IN (
         '20260910_fulfillment_postage_operation_subject_v1',
         '20260910_fulfillment_postage_operation_subject_indexes_v1'
       )`,
    );

    const baseColumns = await pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = current_schema()
         AND table_name = 'fulfillment_postage_label_operations'
         AND column_name IN ('shipment_id', 'subject_kind', 'subject_id')
       ORDER BY column_name`,
    );
    expect(baseColumns.rows).toEqual([{ column_name: "shipment_id" }]);
    const baseIndexes = await pool.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes
       WHERE schemaname = current_schema()
         AND indexname IN (
           'fulfillment_postage_label_operations_active_kind_idx',
           'fulfillment_postage_label_operations_active_target_v1_idx',
           'fulfillment_postage_label_operations_active_target_v2_idx',
           'fulfillment_postage_provider_events_shipment_idx'
         ) ORDER BY indexname`,
    );
    expect(baseIndexes.rows).toEqual([
      { indexname: "fulfillment_postage_label_operations_active_target_v1_idx" },
      { indexname: "fulfillment_postage_provider_events_shipment_idx" },
    ]);
    const baseLedger = await pool.query<{ migration_id: string; applied_at: string }>(
      `SELECT migration_id, applied_at::text FROM bounded_context_schema_migrations
       WHERE migration_id IN (
         '20260823_fulfillment_shipment_mutation_authority_v1',
         '20260910_fulfillment_postage_operation_subject_v1',
         '20260910_fulfillment_postage_operation_subject_indexes_v1'
       ) ORDER BY migration_id`,
    );
    expect(baseLedger.rows).toEqual([
      expect.objectContaining({ migration_id: "20260823_fulfillment_shipment_mutation_authority_v1" }),
    ]);
    const baseAuthorityConstraints = await pool.query<{
      conname: string;
      convalidated: boolean;
      definition: string;
    }>(
      `SELECT conname, convalidated, pg_get_constraintdef(oid) AS definition
       FROM pg_constraint
       WHERE conrelid IN (
         'fulfillment_postage_label_operations'::regclass,
         'fulfillment_postage_provider_events'::regclass
       )
         AND conname IN (
           'fulfillment_postage_label_operations_lifecycle_present',
           'fulfillment_postage_label_operations_operation_id_present',
           'fulfillment_postage_provider_events_handoff_present'
         )
       ORDER BY conname`,
    );
    expect(baseAuthorityConstraints.rows.map(({ conname, convalidated }) => ({ conname, convalidated }))).toEqual([
      { conname: "fulfillment_postage_label_operations_lifecycle_present", convalidated: true },
      { conname: "fulfillment_postage_label_operations_operation_id_present", convalidated: true },
      { conname: "fulfillment_postage_provider_events_handoff_present", convalidated: true },
    ]);

    await bootstrapContextDatabase(fulfillmentModule, pool);

    const upgradedOperations = await pool.query<{
      operation_key: string;
      status: string;
      subject_kind: string;
      subject_id: string;
    }>(
      `SELECT operation_key, status, subject_kind, subject_id
       FROM fulfillment_postage_label_operations
       WHERE operation_key LIKE 'base-%'
       ORDER BY status`,
    );
    expect(upgradedOperations.rows).toHaveLength(retainedStatuses.length);
    expect(new Set(upgradedOperations.rows.map((row) => row.status))).toEqual(new Set(retainedStatuses));
    expect(upgradedOperations.rows.every((row) => row.subject_kind === "shipment")).toBe(true);
    expect(upgradedOperations.rows.every((row) => row.subject_id === "shp_base_resolved")).toBe(true);
    const authorities = await pool.query(
      `SELECT shipment_id, tenant_id, seller_account_id, status, reason_code
       FROM fulfillment_shipment_tenant_resolutions
       WHERE shipment_id LIKE 'shp_base_%'
       ORDER BY shipment_id`,
    );
    expect(authorities.rows).toEqual([
      {
        shipment_id: "shp_base_quarantined",
        tenant_id: null,
        seller_account_id: null,
        status: "quarantined",
        reason_code: "shipment-history-mixed-tenant",
      },
      {
        shipment_id: "shp_base_resolved",
        tenant_id: "tnt_base",
        seller_account_id: "acc_base",
        status: "resolved",
        reason_code: "authoritative-history",
      },
    ]);
    const providerEvents = await pool.query(
      `SELECT provider_event_id, subject_kind, subject_id, processing_result
       FROM fulfillment_postage_provider_events
       WHERE provider_event_id LIKE 'base-%'
       ORDER BY provider_event_id`,
    );
    expect(providerEvents.rows).toEqual([
      {
        provider_event_id: "base-matched-event",
        subject_kind: "shipment",
        subject_id: "shp_base_resolved",
        processing_result: "recorded",
      },
      {
        provider_event_id: "base-unmatched-event",
        subject_kind: "shipment",
        subject_id: null,
        processing_result: "unmatched",
      },
    ]);
    const upgradedIndexes = await pool.query<{ indexname: string; indexdef: string }>(
      `SELECT indexname, indexdef FROM pg_indexes
       WHERE schemaname = current_schema()
         AND indexname IN (
           'fulfillment_postage_label_operations_active_kind_idx',
           'fulfillment_postage_label_operations_active_target_v1_idx',
           'fulfillment_postage_label_operations_active_target_v2_idx',
           'fulfillment_postage_provider_events_shipment_idx'
         ) ORDER BY indexname`,
    );
    expect(upgradedIndexes.rows).toEqual([
      expect.objectContaining({
        indexname: "fulfillment_postage_label_operations_active_target_v2_idx",
        indexdef: freshFence.rows[0]?.indexdef,
      }),
    ]);
    const nullability = await pool.query(
      `SELECT table_name, column_name, is_nullable
       FROM information_schema.columns
       WHERE table_schema = current_schema()
         AND table_name IN ('fulfillment_postage_label_operations', 'fulfillment_postage_provider_events')
         AND column_name IN ('subject_kind', 'subject_id')
       ORDER BY table_name, column_name`,
    );
    expect(nullability.rows).toEqual([
      { table_name: "fulfillment_postage_label_operations", column_name: "subject_id", is_nullable: "NO" },
      { table_name: "fulfillment_postage_label_operations", column_name: "subject_kind", is_nullable: "NO" },
      { table_name: "fulfillment_postage_provider_events", column_name: "subject_id", is_nullable: "YES" },
      { table_name: "fulfillment_postage_provider_events", column_name: "subject_kind", is_nullable: "YES" },
    ]);
    const upgradedLedger = await pool.query<{ migration_id: string; applied_at: string }>(
      `SELECT migration_id, applied_at::text FROM bounded_context_schema_migrations
       WHERE migration_id IN (
         '20260823_fulfillment_shipment_mutation_authority_v1',
         '20260910_fulfillment_postage_operation_subject_v1',
         '20260910_fulfillment_postage_operation_subject_indexes_v1'
       ) ORDER BY migration_id`,
    );
    expect(upgradedLedger.rows.map(({ migration_id }) => ({ migration_id }))).toEqual([
      { migration_id: "20260823_fulfillment_shipment_mutation_authority_v1" },
      { migration_id: "20260910_fulfillment_postage_operation_subject_indexes_v1" },
      { migration_id: "20260910_fulfillment_postage_operation_subject_v1" },
    ]);
    expect(upgradedLedger.rows[0]?.applied_at).toBe(baseLedger.rows[0]?.applied_at);
    const upgradedAuthorityConstraints = await pool.query<{
      conname: string;
      convalidated: boolean;
      definition: string;
    }>(
      `SELECT conname, convalidated, pg_get_constraintdef(oid) AS definition
       FROM pg_constraint
       WHERE conrelid IN (
         'fulfillment_postage_label_operations'::regclass,
         'fulfillment_postage_provider_events'::regclass
       )
         AND conname IN (
           'fulfillment_postage_label_operations_lifecycle_present',
           'fulfillment_postage_label_operations_operation_id_present',
           'fulfillment_postage_provider_events_handoff_present'
         )
       ORDER BY conname`,
    );
    expect(upgradedAuthorityConstraints.rows).toEqual(baseAuthorityConstraints.rows);
  });

  it("keeps pre-7171 compatibility coverage for every legacy postage status", async () => {
    const pool = pools.fulfillment;
    await bootstrapContextDatabase(fulfillmentModule, pool);
    const freshFence = await pool.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes
       WHERE schemaname = current_schema()
         AND indexname = 'fulfillment_postage_label_operations_active_target_v2_idx'`,
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
      `INSERT INTO fulfillment_postage_provider_events (
         provider_event_id, provider_name, provider_mode, event_kind, provider_object_reference,
         shipment_id, tracking_identifier, occurred_at, received_at, processing_result
       ) VALUES
         ('legacy-matched-event', 'fake', 'test', 'tracking-status', 'legacy-matched', 'shp_history', 'trk_history', now(), now(), 'recorded'),
         ('legacy-unresolved-event', 'fake', 'test', 'provider-event', 'legacy-unresolved', NULL, NULL, now(), now(), 'unmatched')`,
    );

    await pool.query(
      `DELETE FROM bounded_context_schema_migrations
       WHERE migration_id IN (
         '20260823_fulfillment_shipment_mutation_authority_v1',
         '20260910_fulfillment_postage_operation_subject_v1',
         '20260910_fulfillment_postage_operation_subject_indexes_v1'
       )`,
    );
    await bootstrapContextDatabase(fulfillmentModule, pool);

    const retained = await pool.query<{
      operation_key: string;
      status: string;
      subject_kind: string;
      subject_id: string;
      target_key: string;
    }>(
      `SELECT operation_key, status, subject_kind, subject_id, target_key
       FROM fulfillment_postage_label_operations ORDER BY operation_key`,
    );
    expect(retained.rows).toEqual([
      expect.objectContaining({ operation_key: "legacy-failed", status: "ambiguous", subject_kind: "shipment" }),
      expect.objectContaining({ operation_key: "legacy-pending", status: "reserved", subject_kind: "shipment" }),
      expect.objectContaining({
        operation_key: "legacy-provider-succeeded",
        status: "provider-succeeded",
        subject_kind: "shipment",
      }),
      expect.objectContaining({
        operation_key: "legacy-succeeded",
        status: "effect-applied",
        subject_kind: "shipment",
      }),
    ]);
    expect(new Set(retained.rows.map((row) => row.target_key)).size).toBe(retained.rows.length);
    const indexes = await pool.query<{ indexname: string; indexdef: string }>(
      `SELECT indexname, indexdef FROM pg_indexes
       WHERE schemaname = current_schema()
         AND indexname IN (
           'fulfillment_postage_label_operations_active_kind_idx',
           'fulfillment_postage_label_operations_active_target_v1_idx',
           'fulfillment_postage_label_operations_active_target_v2_idx'
         ) ORDER BY indexname`,
    );
    expect(indexes.rows).toEqual([
      expect.objectContaining({
        indexname: "fulfillment_postage_label_operations_active_target_v2_idx",
        indexdef: expect.stringContaining(
          "tenant_id, seller_account_id, subject_kind, subject_id, operation_kind, target_key",
        ),
      }),
    ]);
    expect(indexes.rows[0]?.indexdef).toBe(freshFence.rows[0]?.indexdef);
    const retainedStatusConstraint = await pool.query<{ definition: string }>(
      `SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint
       WHERE conrelid = 'fulfillment_postage_label_operations'::regclass
         AND conname = 'fulfillment_postage_label_operations_status_check'`,
    );
    expect(retainedStatusConstraint.rows).toEqual(freshStatusConstraint.rows);
    const providerEvents = await pool.query<{
      provider_event_id: string;
      subject_kind: string;
      subject_id: string | null;
    }>(
      `SELECT provider_event_id, subject_kind, subject_id
       FROM fulfillment_postage_provider_events
       WHERE provider_event_id LIKE 'legacy-%'
       ORDER BY provider_event_id`,
    );
    expect(providerEvents.rows).toEqual([
      { provider_event_id: "legacy-matched-event", subject_kind: "shipment", subject_id: "shp_history" },
      { provider_event_id: "legacy-unresolved-event", subject_kind: "shipment", subject_id: null },
    ]);
    const subjectNullability = await pool.query<{
      table_name: string;
      column_name: string;
      is_nullable: "YES" | "NO";
    }>(
      `SELECT table_name, column_name, is_nullable
       FROM information_schema.columns
       WHERE table_schema = current_schema()
         AND table_name IN ('fulfillment_postage_label_operations', 'fulfillment_postage_provider_events')
         AND column_name IN ('subject_kind', 'subject_id')
       ORDER BY table_name, column_name`,
    );
    expect(subjectNullability.rows).toEqual([
      { table_name: "fulfillment_postage_label_operations", column_name: "subject_id", is_nullable: "NO" },
      { table_name: "fulfillment_postage_label_operations", column_name: "subject_kind", is_nullable: "NO" },
      { table_name: "fulfillment_postage_provider_events", column_name: "subject_id", is_nullable: "YES" },
      { table_name: "fulfillment_postage_provider_events", column_name: "subject_kind", is_nullable: "YES" },
    ]);
    const emptyTenant = await pool.query<{ status: string; reason_code: string; tenant_id: string | null }>(
      `SELECT status, reason_code, tenant_id FROM fulfillment_shipment_tenant_resolutions
       WHERE shipment_id = 'shp_empty_tenant'`,
    );
    expect(emptyTenant.rows).toEqual([
      { status: "quarantined", reason_code: "shipment-history-empty-tenant", tenant_id: null },
    ]);
    const ledger = await pool.query<{ migration_id: string }>(
      `SELECT migration_id FROM bounded_context_schema_migrations
       WHERE migration_id IN (
         '20260823_fulfillment_shipment_mutation_authority_v1',
         '20260910_fulfillment_postage_operation_subject_v1',
         '20260910_fulfillment_postage_operation_subject_indexes_v1'
       )
       ORDER BY migration_id`,
    );
    expect(ledger.rows).toEqual([
      { migration_id: "20260823_fulfillment_shipment_mutation_authority_v1" },
      { migration_id: "20260910_fulfillment_postage_operation_subject_indexes_v1" },
      { migration_id: "20260910_fulfillment_postage_operation_subject_v1" },
    ]);
  });
});
