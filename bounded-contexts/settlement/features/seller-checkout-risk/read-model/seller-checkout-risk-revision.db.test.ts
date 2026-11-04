import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PgQueryable, PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { bootstrapContextDatabase } from "@chase-sets/bounded-context-runtime";
import { buildTransportEvent } from "@chase-sets/event-core/test-support";
import type { TransportEvent } from "@chase-sets/event-core/transport";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import { module as settlementModule } from "../../../index";
import {
  buildSettlementIdentityAccountRiskSourceProjectionHandlers,
  buildSettlementPaymentsAccountRiskSourceProjectionHandlers,
  buildSettlementReputationAccountRiskSourceProjectionHandlers,
} from "../../wallets/integrations/account-risk-source/account-risk-source-projection";
import { buildSettlementPaymentInputProjectionHandlers } from "../../wallets/integrations/payment-source/payment-source-projection";
import matrix from "../../wallets/integrations/account-risk-source/authority-matrix.fixture.json" with { type: "json" };
import acceptance from "./authority-matrix.fixture.json" with { type: "json" };
import { createSellerCheckoutRiskReader } from "./queries";

const databaseBaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseBaseUrl && process.env.CI)
  throw new Error("TEST_DATABASE_URL is required for database-backed tests in CI.");
const describeDb = databaseBaseUrl ? describe : describe.skip;
const contextNames = ["settlement"] as const;
const accountId = "acc_revision";
const timestamp = "2026-11-04T00:00:00.000Z";
const later = "2026-11-04T00:00:01.000Z";

function event(type: string, data: Record<string, unknown>, at = timestamp, streamVersion = 1): TransportEvent {
  return buildTransportEvent(type, data, {
    id: `evt_synthetic_${type.replace(/[^a-z0-9]+/gi, "_")}_${streamVersion}`,
    streamId: `identity.account-${accountId}`,
    streamVersion,
    tenantId: "tnt_test",
    audit: { performedByUserId: "usr_test", forAccountId: accountId },
    timing: { occurredAt: at, recordedAt: at },
  });
}

function writerCases(db: PgQueryable) {
  const identity = buildSettlementIdentityAccountRiskSourceProjectionHandlers(db);
  const payments = buildSettlementPaymentsAccountRiskSourceProjectionHandlers(db);
  const reputation = buildSettlementReputationAccountRiskSourceProjectionHandlers(db);
  const paymentInput = buildSettlementPaymentInputProjectionHandlers(db);
  const invoke = (handlers: typeof identity, type: string, data: Record<string, unknown>, version = 1) =>
    handlers[type]!(event(type, data, timestamp, version));
  return [
    {
      name: "account creation",
      column: "account_created_at",
      value: new Date(timestamp),
      run: () => invoke(identity, "identity.account.created", { accountId, createdAt: timestamp }),
    },
    {
      name: "badge assignment",
      column: "manual_payout_review",
      value: true,
      run: () => invoke(identity, "identity.account.badge-assigned", { badgeKey: "manual-payout-review" }),
    },
    {
      name: "address linkage",
      column: "shared_address_cluster_count",
      value: 0,
      run: () =>
        invoke(identity, "identity.shipping-address.added", {
          accountId,
          shippingAddressId: "adr_synthetic",
          addedAt: timestamp,
          address: { line1: "synthetic", line2: null, city: "test", state: "IL", postalCode: "00000", country: "US" },
        }),
    },
    {
      name: "instrument linkage",
      column: "shared_instrument_cluster_count",
      value: 0,
      run: () =>
        invoke(payments, "payments.checkout-affordances-published", {
          accountId,
          publishedAt: timestamp,
          savedCheckoutInstruments: [
            {
              instrumentId: "ins_synthetic",
              instrumentRiskClusterKey: "synthetic-private-cluster",
              readiness: "ready",
            },
          ],
        }),
    },
    {
      name: "velocity aggregation",
      column: "listing_24h_count",
      value: 1,
      run: () =>
        invoke(reputation, "marketplace.listing.created", {
          listingId: "lst_synthetic",
          accountId,
          priceAmount: "12.34",
          priceCurrencyCode: "USD",
        }),
    },
    {
      name: "reputation aggregation",
      column: "review_count",
      value: 0,
      run: () =>
        invoke(reputation, "marketplace.review.submitted", {
          reviewId: "rev_synthetic",
          orderId: "ord_synthetic",
          subjectAccountId: accountId,
          authorAccountId: "acc_reviewer",
          authorRole: "buyer",
          rating: 4,
          submittedAt: timestamp,
        }),
    },
    {
      name: "fraud warning",
      column: "stripe_fraud_signal_count",
      value: 2,
      run: () =>
        invoke(payments, "payments.payment-fraud-warning-received", {
          buyerAccountId: accountId,
          receivedAt: timestamp,
        }),
    },
    {
      name: "fraud review open",
      column: "stripe_review_open_count",
      value: 2,
      run: () =>
        invoke(payments, "payments.payment-fraud-review-opened", { buyerAccountId: accountId, openedAt: timestamp }),
    },
    {
      name: "fraud review close",
      column: "stripe_review_open_count",
      value: 0,
      run: () =>
        invoke(payments, "payments.payment-fraud-review-closed", {
          buyerAccountId: accountId,
          outcome: "approved",
          closedAt: timestamp,
        }),
    },
    {
      name: "payment trust aggregation",
      column: "review_count",
      value: 0,
      run: () =>
        invoke(
          paymentInput,
          "payments.payment-created",
          {
            paymentId: "pay_synthetic",
            buyerAccountId: "acc_buyer",
            orderIds: ["ord_synthetic"],
            sellerPayouts: [
              {
                orderId: "ord_synthetic",
                sellerAccountId: accountId,
                sellerItemNetAmount: "12.34",
                sellerPayoutAmount: "12.34",
              },
            ],
            amount: "12.34",
            currencyCode: "usd",
            processorName: "synthetic",
            processorPaymentReference: "synthetic_payment",
            processorStatus: "requires_capture",
            createdAt: timestamp,
          },
          1,
        ),
    },
  ];
}

describeDb("seller checkout risk source revision persistence", () => {
  let pool: PgTransactionalPool;
  let pools: Readonly<Record<"settlement", PgTransactionalPool>> | undefined;
  beforeAll(async () => {
    const urls = createMultiContextTestDatabaseUrls(databaseBaseUrl!, contextNames, "seller_checkout_risk_revision");
    await ensureMultiContextTestDatabases(databaseBaseUrl!, urls);
    pools = createMultiContextTestPools(urls);
    pool = pools.settlement;
  });
  beforeEach(async () => resetMultiContextTestSchemas({ settlement: pool }));
  afterAll(async () => {
    if (pools) await closeMultiContextTestPools(pools);
  });

  async function row() {
    return (await pool.query("SELECT * FROM settlement_account_risk_sources WHERE account_id = $1", [accountId]))
      .rows[0];
  }
  async function column() {
    return (
      await pool.query(`SELECT data_type, is_nullable, column_default FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = 'settlement_account_risk_sources' AND column_name = 'revision'`)
    ).rows;
  }
  const oldModule = {
    ...settlementModule,
    schemaSql: settlementModule.schemaSql.replace("  revision bigint NOT NULL DEFAULT 0,", ""),
    schemaMigrations: settlementModule.schemaMigrations!.filter(
      (migration) => migration.migrationId !== matrix.revisionMigration,
    ),
  };

  it("upgrades the real old-schema ledger, preserves old facts at zero and boots twice without resets with fresh parity", async () => {
    await bootstrapContextDatabase(oldModule, pool);
    expect(await column()).toEqual([]);
    await pool.query(
      `INSERT INTO settlement_account_risk_sources (account_id, account_created_at, trusted_seller, manual_payout_review, stripe_fraud_signal_count, updated_at)
      VALUES ($1, $2, true, true, 9, $2)`,
      [accountId, timestamp],
    );
    const before = await row();
    await bootstrapContextDatabase(settlementModule, pool);
    expect(await row()).toEqual({ ...before, revision: "0" });
    const upgradedColumn = await column();
    await bootstrapContextDatabase(settlementModule, pool);
    expect(await row()).toEqual({ ...before, revision: "0" });
    expect(
      (
        await pool.query(
          "SELECT count(*)::integer AS count FROM bounded_context_schema_migrations WHERE migration_id = $1",
          [matrix.revisionMigration],
        )
      ).rows,
    ).toEqual([{ count: 1 }]);
    await resetMultiContextTestSchemas({ settlement: pool });
    await bootstrapContextDatabase(settlementModule, pool);
    expect(await column()).toEqual(upgradedColumn);
    expect(upgradedColumn).toEqual([{ data_type: "bigint", is_nullable: "NO", column_default: "0" }]);
    await writerCases(pool)[0]!.run();
    expect((await row())?.revision).toBe("1");
    const fresh = await row();
    await bootstrapContextDatabase(settlementModule, pool);
    await bootstrapContextDatabase(settlementModule, pool);
    expect(await row()).toEqual(fresh);
  });

  it("executes all immutable legacy backfills before the revision column exists, then ledger-skips them on a second boot", async () => {
    const legacyIds = matrix.legacyNormalization.map((entry) => entry.migrationId);
    await bootstrapContextDatabase(
      {
        ...oldModule,
        schemaMigrations: oldModule.schemaMigrations.filter((migration) => !legacyIds.includes(migration.migrationId)),
      },
      pool,
    );
    const columns = matrix.legacyNormalization.flatMap((entry) => entry.columns);
    for (const name of columns)
      await pool.query(`ALTER TABLE settlement_account_risk_sources ALTER COLUMN ${name} DROP NOT NULL`);
    await pool.query(
      `INSERT INTO settlement_account_risk_sources (account_id, updated_at, ${columns.join(", ")}) VALUES ($1, $2, ${columns.map(() => "NULL").join(", ")})`,
      [accountId, timestamp],
    );
    const observed: { sql: string; revisionPresent: boolean }[] = [];
    const legacyStatements = matrix.legacyNormalization.flatMap((entry) => entry.statements);
    const traced: PgTransactionalPool = {
      query: pool.query.bind(pool),
      connect: async () => {
        const client = await pool.connect();
        return {
          release: client.release.bind(client),
          query: async <Row = Record<string, unknown>>(sql: string, values?: readonly unknown[]) => {
            if (legacyStatements.includes(sql)) {
              const result = await client.query(
                `SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'settlement_account_risk_sources' AND column_name = 'revision'`,
              );
              observed.push({ sql, revisionPresent: result.rows.length > 0 });
            }
            return client.query<Row>(sql, values);
          },
        };
      },
    };
    await bootstrapContextDatabase(settlementModule, traced);
    expect(observed).toEqual(legacyStatements.map((sql) => ({ sql, revisionPresent: false })));
    const normalized = await row();
    expect(normalized?.revision).toBe("0");
    expect(normalized?.updated_at).toEqual(new Date(timestamp));
    for (const name of columns)
      expect(normalized?.[name], name).toEqual(
        name === "velocity_alert_flags" ? [] : name === "stripe_fraud_flag" ? false : name.endsWith("_cents") ? "0" : 0,
      );
    await bootstrapContextDatabase(settlementModule, traced);
    expect(observed).toHaveLength(legacyStatements.length);
    expect(await row()).toEqual(normalized);
    await writerCases(pool)[0]!.run();
    expect((await row())?.revision).toBe("1");
  });

  for (const [index, name] of acceptance.dbWriterCases.entries()) {
    it(`publishes insert one and an atomic increment for every ${name} write/conflict`, async () => {
      await bootstrapContextDatabase(settlementModule, pool);
      let writes = 0;
      const traced: PgQueryable = {
        query: async <Row = Record<string, unknown>>(sql: string, values?: readonly unknown[]) => {
          if (!/^INSERT INTO settlement_account_risk_sources\b/.test(sql.trim())) return pool.query<Row>(sql, values);
          const before = await row();
          const result = await pool.query<Row>(sql, values);
          const after = await row();
          expect(after?.revision).toBe(String(Number(before?.revision ?? 0) + 1));
          expect(after?.updated_at).toEqual(new Date(timestamp));
          writes++;
          return result;
        },
      };
      const writer = writerCases(traced)[index]!;
      expect(writer.name).toBe(name);
      await writer.run();
      expect(writes).toBeGreaterThan(0);
      await writer.run();
      expect((await row())?.[writer.column]).toEqual(writer.value);
      expect(Number((await row())?.revision)).toBe(writes);
      expect((await pool.query("SELECT count(*)::integer AS count FROM settlement_ledger_entry_pages")).rows).toEqual([
        { count: 0 },
      ]);
    });
  }

  it("serializes overlapping conflicting writers in PostgreSQL without a lost revision or fraud count", async () => {
    await bootstrapContextDatabase(settlementModule, pool);
    const warning = (db: PgQueryable, at: string) =>
      buildSettlementPaymentsAccountRiskSourceProjectionHandlers(db)["payments.payment-fraud-warning-received"]!(
        event("payments.payment-fraud-warning-received", { buyerAccountId: accountId, receivedAt: at }, at),
      );
    await warning(pool, timestamp);
    const first = await pool.connect();
    const second = await pool.connect();
    try {
      await first.query("BEGIN");
      await warning(first, timestamp);
      const firstPid = (await first.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!.pid;
      const secondPid = (await second.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!.pid;
      const pending = warning(second, later).then(
        () => null,
        (error: unknown) => error,
      );
      try {
        let blockers: number[] = [];
        for (let attempt = 0; attempt < 100 && !blockers.includes(firstPid); attempt++) {
          blockers = (await pool.query<{ blockers: number[] }>("SELECT pg_blocking_pids($1) AS blockers", [secondPid]))
            .rows[0]!.blockers;
        }
        expect(blockers).toContain(firstPid);
      } finally {
        await first.query("COMMIT");
        expect(await pending).toBeNull();
      }
      expect(await row()).toMatchObject({ revision: "3", stripe_fraud_signal_count: 3, updated_at: new Date(later) });
    } finally {
      await first.query("ROLLBACK");
      first.release();
      second.release();
    }
  });

  it("observes absence after UNLOGGED projection loss and reconstructs source facts/stamps through ordered replay", async () => {
    await bootstrapContextDatabase(settlementModule, pool);
    const replay = async () => {
      const cases = writerCases(pool);
      for (const writer of cases) await writer.run();
      const identity = buildSettlementIdentityAccountRiskSourceProjectionHandlers(pool);
      await identity["identity.account.badge-assigned"]!(
        event("identity.account.badge-assigned", { badgeKey: "trusted-seller" }, later),
      );
      await identity["identity.account.badge-removed"]!(
        event("identity.account.badge-removed", { badgeKey: "trusted-seller" }, later, 2),
      );
    };
    await replay();
    const before = await row();
    const reader = createSellerCheckoutRiskReader(pool);
    const owner = { kind: "account", accountId } as const;
    const observed = await reader(owner);
    expect(observed).toMatchObject({
      rowState: "present",
      sourceTimestamp: later,
      sourceRevision: Number(before?.revision),
      status: "clear",
      reasonCode: null,
    });
    expect(
      (await pool.query("SELECT relpersistence FROM pg_class WHERE oid = 'settlement_account_risk_sources'::regclass"))
        .rows,
    ).toEqual([{ relpersistence: "u" }]);
    await pool.query(`TRUNCATE settlement_account_risk_sources, settlement_account_review_sources, settlement_account_address_risk_sources,
      settlement_account_instrument_risk_sources, settlement_account_velocity_sources, settlement_order_trust_signal_sources, settlement_payment_sources`);
    expect(await reader(owner)).toEqual({
      schemaVersion: "settlement.seller-checkout-risk.v1",
      policyRevision: "seller-checkout-risk-v1",
      status: "clear",
      reasonCode: null,
      sourceRevision: 0,
      sourceTimestamp: null,
      rowState: "absent",
    });
    await writerCases(pool)[0]!.run();
    expect((await row())?.revision).toBe("1");
    expect(Number(before?.revision)).toBeGreaterThan(1);
    await pool.query("TRUNCATE settlement_account_risk_sources");
    await replay();
    expect(await row()).toEqual(before);
    expect(await reader(owner)).toEqual(observed);
    expect((await pool.query("SELECT count(*)::integer AS count FROM settlement_ledger_entry_pages")).rows).toEqual([
      { count: 0 },
    ]);
  });
});
