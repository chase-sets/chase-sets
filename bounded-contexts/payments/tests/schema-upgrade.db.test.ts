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
import { buildTransportEvent } from "@chase-sets/event-core/test-support";
import { payoutReviewHoldFactTypes } from "@chase-sets/event-core/payout-review-hold-facts";
import { toTransportEvent } from "@chase-sets/event-core/transport";
import { buildPolicyDocumentProjectionHandlers } from "@chase-sets/platform-policy/projection";
import { createPolicyRuntime } from "@chase-sets/platform-policy/runtime";
import { module as paymentsModule } from "../index";
import { paymentsCardDeclineSchemaMigrations } from "../features/payments/api/card-decline-schema";
import { cardAuthenticationPolicy } from "../features/payments/domain/card-authentication-policy";
import { buildPaymentsSettlementAccountRiskSourceProjectionHandlers } from "../features/payments/integrations/account-risk-source/account-risk-source-projection";
import { getPaymentAccountRiskSource } from "../features/payments/read-model/queries";

const adminDatabaseUrl = process.env.TEST_DATABASE_URL;
if (!adminDatabaseUrl && process.env.CI) {
  throw new Error("TEST_DATABASE_URL is required for database-backed tests in CI.");
}
const describeDb = adminDatabaseUrl ? describe : describe.skip;

type PaymentsTestPools = Readonly<Record<"payments", PgTransactionalPool>>;

async function readColumnNames(pool: PgTransactionalPool, tableName: string): Promise<string[]> {
  const columns = await pool.query<{ column_name: string }>(
    `SELECT column_name
     FROM information_schema.columns
     WHERE table_schema = current_schema()
       AND table_name = $1
     ORDER BY column_name`,
    [tableName],
  );
  return columns.rows.map((row) => row.column_name);
}

describeDb("payments schema upgrades", () => {
  let pools: PaymentsTestPools;

  beforeAll(async () => {
    const databaseUrls = createMultiContextTestDatabaseUrls(adminDatabaseUrl!, ["payments"], "payments_schema_upgrade");
    await ensureMultiContextTestDatabases(adminDatabaseUrl!, databaseUrls);
    pools = createMultiContextTestPools(databaseUrls);
  });

  beforeEach(async () => {
    await resetMultiContextTestSchemas(pools);
  });

  afterAll(async () => {
    await closeMultiContextTestPools(pools);
  });

  it("rebuilds the 3DS hold signal without inheriting a lagged Identity badge removal", async () => {
    const pool = pools.payments;
    const accountId = "acc_synthetic_removed_badge";
    const heldAccountId = "acc_synthetic_active_hold";
    await bootstrapContextDatabase(paymentsModule, pool);
    await pool.query("ALTER TABLE payments_account_risk_sources DROP COLUMN payout_review_hold");
    await pool.query(
      "DELETE FROM bounded_context_schema_migrations WHERE migration_id = '20261120_payments_payout_review_hold_risk_source'",
    );
    // The retired reader applied the assignment, missed the removal, and
    // Settlement emits no hold facts for this now-unbadged account.
    await pool.query(
      `INSERT INTO payments_account_risk_sources
         (account_id, manual_payout_review, stripe_fraud_flag, stripe_fraud_signal_count)
       VALUES ($1, true, true, 2), ($2, true, false, 0)`,
      [accountId, heldAccountId],
    );
    await bootstrapContextDatabase(paymentsModule, pool);
    expect(await getPaymentAccountRiskSource(pool, accountId)).toMatchObject({
      manual_payout_review: false,
      stripe_fraud_flag: true,
      stripe_fraud_signal_count: 2,
    });
    const handlers = buildPaymentsSettlementAccountRiskSourceProjectionHandlers(pool);
    const payload = {
      accountId: heldAccountId,
      factSchemaVersion: 1,
      reason: "Synthetic review",
      source: "operator",
      sourceReference: null,
    };
    await handlers[payoutReviewHoldFactTypes.placed]!(buildTransportEvent(payoutReviewHoldFactTypes.placed, payload));
    await pool.query("UPDATE payments_account_risk_sources SET manual_payout_review = false WHERE account_id = $1", [
      heldAccountId,
    ]);
    expect((await getPaymentAccountRiskSource(pool, heldAccountId))?.manual_payout_review).toBe(true);
    await handlers[payoutReviewHoldFactTypes.released]!(
      buildTransportEvent(payoutReviewHoldFactTypes.released, payload),
    );
    expect((await getPaymentAccountRiskSource(pool, heldAccountId))?.manual_payout_review).toBe(false);
  });

  it("converges fresh and migration-only decline stores and preserves windows on repeated startup", async () => {
    await bootstrapContextDatabase(paymentsModule, pools.payments);
    const tables = ["payments_card_decline_counters", "payments_card_decline_events"];
    const fresh = await Promise.all(tables.map((table) => readColumnNames(pools.payments, table)));
    await pools.payments.query("DROP TABLE payments_card_decline_counters, payments_card_decline_events");
    await pools.payments.query(
      "DELETE FROM bounded_context_schema_migrations WHERE migration_id = '20261004_payments_card_decline_velocity'",
    );
    for (const migration of paymentsCardDeclineSchemaMigrations) {
      for (const statement of migration.statements) await pools.payments.query(statement);
    }
    expect(await Promise.all(tables.map((table) => readColumnNames(pools.payments, table)))).toEqual(fresh);
    await pools.payments.query(
      `INSERT INTO payments_card_decline_counters VALUES ('synthetic_digest', 5, '2026-10-04T01:00:00Z')`,
    );
    await pools.payments.query(
      `INSERT INTO payments_card_decline_events VALUES ('stripe', 'evt_restart', 'synthetic_facts_digest')`,
    );
    await bootstrapContextDatabase(paymentsModule, pools.payments);
    await bootstrapContextDatabase(paymentsModule, pools.payments);
    expect((await pools.payments.query("SELECT decline_count FROM payments_card_decline_counters")).rows).toEqual([
      { decline_count: 5 },
    ]);
    expect((await pools.payments.query("SELECT event_id FROM payments_card_decline_events")).rows).toEqual([
      { event_id: "evt_restart" },
    ]);
    expect(
      (
        await pools.payments.query(
          "SELECT migration_id FROM bounded_context_schema_migrations WHERE migration_id = '20261004_payments_card_decline_velocity'",
        )
      ).rows,
    ).toHaveLength(1);
    expect(
      (await pools.payments.query("SELECT relpersistence FROM pg_class WHERE relname = ANY($1)", [tables])).rows,
    ).toEqual([{ relpersistence: "p" }, { relpersistence: "p" }]);
    expect(
      (
        await pools.payments.query(
          "SELECT indexname FROM pg_indexes WHERE schemaname = current_schema() AND indexname = 'payments_card_decline_counters_expiry_idx'",
        )
      ).rows,
    ).toHaveLength(1);
  });

  it("converges the deployed pre-authenticity order-input table to the complete fresh schema", async () => {
    await bootstrapContextDatabase(paymentsModule, pools.payments);
    const freshColumns = await readColumnNames(pools.payments, "payments_order_inputs");

    await resetMultiContextTestSchemas(pools);
    await pools.payments.query(`CREATE TABLE payments_order_inputs (
  order_id text PRIMARY KEY,
  source_type text NULL,
  source_reference_id text NULL,
  buyer_account_id text NOT NULL,
  buyer_email text NULL,
  seller_account_id text NOT NULL DEFAULT '',
  sales_tax_amount numeric(12, 2) NOT NULL DEFAULT 0,
  total_amount numeric(12, 2) NOT NULL,
  marketplace_sales_fee_amount numeric(12, 2) NOT NULL,
  marketplace_checkout_fee_amount numeric(12, 2) NOT NULL,
  seller_net_amount numeric(12, 2) NOT NULL,
  seller_item_net_amount numeric(12, 2) NOT NULL DEFAULT 0,
  shipping_allowance_amount numeric(12, 2) NOT NULL DEFAULT 0,
  shipping_overage_amount numeric(12, 2) NOT NULL DEFAULT 0,
  seller_shipping_payout_amount numeric(12, 2) NOT NULL DEFAULT 0,
  seller_payout_amount numeric(12, 2) NOT NULL DEFAULT 0,
  shipping_allowance_percentage_bps integer NOT NULL DEFAULT 500,
  terms_schedule_id text NULL,
  terms_agreement_id text NULL,
  terms_resolved_at timestamptz NOT NULL,
  status text NOT NULL,
  pending_payment_at timestamptz NULL,
  payment_deadline_at timestamptz NULL,
  payment_deadline_policy text NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  cancelled_at timestamptz NULL,
  ready_for_fulfillment_at timestamptz NULL
);`);

    await bootstrapContextDatabase(paymentsModule, pools.payments);

    const upgradedColumns = await readColumnNames(pools.payments, "payments_order_inputs");
    expect(upgradedColumns).toEqual(freshColumns);
    expect(upgradedColumns).toContain("authenticity_fee_amount");

    const migration = await pools.payments.query<{ migration_id: string }>(
      `SELECT migration_id
       FROM bounded_context_schema_migrations
       WHERE migration_id = '20260718_payments_order_inputs_authenticity_fee_amount'`,
    );
    expect(migration.rows).toEqual([{ migration_id: "20260718_payments_order_inputs_authenticity_fee_amount" }]);
  });

  it("converges deployed support refund effects on return inputs", async () => {
    await pools.payments.query(`CREATE TABLE payments_support_refund_effects (
  support_request_id text PRIMARY KEY,
  refund_effect_id text NOT NULL,
  order_id text NOT NULL,
  payment_id text NULL,
  refund_id text NULL,
  resolution_type text NOT NULL,
  requested_amount numeric(12, 2) NULL,
  status text NOT NULL,
  failure_message text NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);`);

    await bootstrapContextDatabase(paymentsModule, pools.payments);

    expect(await readColumnNames(pools.payments, "payments_support_refund_effects")).toEqual(
      expect.arrayContaining([
        "attempts",
        "return_delivered_at",
        "refund_release_due_at",
        "return_condition_disputed_at",
        "return_shipping_deduction_amount",
      ]),
    );
  });

  it("bootstraps over the deployed refund table before adding remedy causation", async () => {
    await pools.payments.query(`CREATE TABLE payments_refund_pages (
  refund_id text PRIMARY KEY,
  payment_id text NOT NULL,
  order_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  amount numeric(12, 2) NOT NULL,
  currency_code text NOT NULL,
  reason text NOT NULL,
  processor_name text NOT NULL,
  processor_refund_reference text NULL,
  processor_status text NOT NULL,
  status text NOT NULL,
  failure_code text NULL,
  failure_message text NULL,
  requested_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  issued_at timestamptz NULL,
  failed_at timestamptz NULL,
  last_stream_version bigint NOT NULL DEFAULT 0
);`);

    await bootstrapContextDatabase(paymentsModule, pools.payments);

    expect(await readColumnNames(pools.payments, "payments_refund_pages")).toEqual(
      expect.arrayContaining([
        "remedy_id",
        "coverage_id",
        "liability_funding_kind",
        "seller_funded_amount",
        "platform_funded_amount",
        "refund_trigger",
        "reason_code",
      ]),
    );

    const indexes = await pools.payments.query<{ indexname: string }>(
      `SELECT indexname
       FROM pg_indexes
       WHERE schemaname = current_schema()
         AND tablename = 'payments_refund_pages'`,
    );
    expect(indexes.rows.map((row) => row.indexname)).toContain("payments_refund_pages_remedy_idx");
  });

  it("returns the policy tables to logged storage and gives a kept row the stream version it was projected at", async () => {
    const pool = pools.payments;
    const policyTables = ["platform_policy_documents", "platform_policy_document_history"];
    const migrationIds = [
      "20261123_payments_policy_documents_logged",
      "20261123_platform_policy_document_stream_version",
    ];
    const persistence = async () =>
      Promise.all(
        policyTables.map(async (tableName) => {
          const result = await pool.query<{ relpersistence: string }>(
            "SELECT relpersistence FROM pg_class WHERE oid = to_regclass($1)",
            [tableName],
          );
          return result.rows[0]?.relpersistence;
        }),
      );
    const documentRows = async () => (await pool.query("SELECT * FROM platform_policy_documents")).rows;
    const historyRows = async () =>
      (await pool.query("SELECT * FROM platform_policy_document_history ORDER BY history_id ASC")).rows;
    const ledgerRows = async () =>
      (
        await pool.query(
          `SELECT migration_id, applied_at FROM bounded_context_schema_migrations
           WHERE migration_id = ANY($1::text[]) ORDER BY migration_id ASC`,
          [migrationIds],
        )
      ).rows;

    await bootstrapContextDatabase(paymentsModule, pool);
    const eventStore = createPostgresEventStore({ pool });
    const runtime = createPolicyRuntime({ eventStore, db: pool });
    const handlers = buildPolicyDocumentProjectionHandlers(pool);
    const context = {
      tenantId: "tnt_policy_upgrade" as never,
      audit: { performedByUserId: "usr_policy_upgrade" as never, forAccountId: "acc_policy_upgrade" as never },
    };
    const params = (highPaymentAmount: string) => ({
      value: { highPaymentAmount, highSellerExposureAmount: "250.00" },
      status: "active" as const,
      effectiveFrom: "2026-01-01T00:00:00.000Z",
      effectiveUntil: null,
      actorUserId: "usr_policy_upgrade",
    });
    const { documentId } = await runtime.createPolicyDocument(cardAuthenticationPolicy, params("200.00"), context);
    await runtime.revisePolicyDocument(cardAuthenticationPolicy, documentId, params("100.00"), context);
    const readStream = () => eventStore.readStream({ streamId: `platform-policy.document-${documentId}` });
    const project = async (event: Awaited<ReturnType<typeof readStream>>[number]) => {
      const handler = handlers[event.eventType];
      if (!handler) throw new Error(`No policy projection handler for '${event.eventType}'.`);
      await handler(toTransportEvent(event));
    };
    for (const event of await readStream()) {
      await project(event);
    }
    // A revision the projection has not reached: the row holds version 2 while the stream is at 3.
    await runtime.revisePolicyDocument(cardAuthenticationPolicy, documentId, params("50.00"), context);

    // The shape an earlier build left behind: both tables unlogged, no stream version, neither migration applied.
    await pool.query("ALTER TABLE platform_policy_documents DROP COLUMN stream_version");
    for (const tableName of policyTables) {
      await pool.query(`ALTER TABLE ${tableName} SET UNLOGGED`);
    }
    await pool.query("DELETE FROM bounded_context_schema_migrations WHERE migration_id = ANY($1::text[])", [
      migrationIds,
    ]);
    expect(await persistence()).toEqual(["u", "u"]);
    expect(await readColumnNames(pool, "platform_policy_documents")).not.toContain("stream_version");
    const earlierRows = await documentRows();
    expect(earlierRows).toEqual([expect.objectContaining({ document_id: documentId })]);
    expect(earlierRows[0]).toMatchObject({ value: { highPaymentAmount: "100.00" } });
    const history = await historyRows();
    expect(history).toHaveLength(2);

    await bootstrapContextDatabase(paymentsModule, pool);

    expect(await persistence()).toEqual(["p", "p"]);
    const upgradedRows = await documentRows();
    expect(upgradedRows).toEqual([{ ...earlierRows[0], stream_version: "2" }]);
    expect(await historyRows()).toEqual(history);
    const ledger = await ledgerRows();
    expect(ledger.map((row) => row.migration_id)).toEqual(migrationIds);

    await bootstrapContextDatabase(paymentsModule, pool);

    expect(await persistence()).toEqual(["p", "p"]);
    expect(await documentRows()).toEqual(upgradedRows);
    expect(await historyRows()).toEqual(history);
    expect(await ledgerRows()).toEqual(ledger);

    // The backfilled version holds the row through a replay and still admits the revision it has not seen.
    const stream = await readStream();
    for (const event of stream.slice(0, 2)) {
      await project(event);
      expect(await documentRows()).toEqual(upgradedRows);
    }
    await handlers[stream[2]!.eventType]?.(toTransportEvent(stream[2]!));
    expect(await documentRows()).toEqual([
      expect.objectContaining({ value: expect.objectContaining({ highPaymentAmount: "50.00" }), stream_version: "3" }),
    ]);
  });
});
