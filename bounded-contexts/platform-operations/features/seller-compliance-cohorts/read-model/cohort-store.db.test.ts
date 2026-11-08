import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PgPoolClient, PgTransactionalPool } from "@chase-sets/event-core-postgres";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import { parseIsoUtcTimestamp as iso } from "@chase-sets/primitives/iso-utc-timestamp";
import { module as platformOperationsModule } from "../../../index";
import { evaluateSellerComplianceCohort, type CohortEvaluationInput } from "../domain/cohort-window";
import {
  SELLER_COMPLIANCE_COHORT_POLICY_DEFAULT_VALUE,
  type SellerComplianceCohortPolicyValue,
} from "../domain/seller-compliance-cohort-policy";
import { sellerComplianceCohortSchemaMigrations } from "./cohort-schema";
import {
  readSellerComplianceCohort,
  readSellerComplianceCohortLedgerHead,
  writeSellerComplianceCohort,
  type CohortWrite,
} from "./cohort-store";

const databaseBaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseBaseUrl && process.env.CI)
  throw new Error("TEST_DATABASE_URL is required for database-backed tests in CI.");
const describeDb = databaseBaseUrl ? describe : describe.skip;
const contextNames = ["platform-operations"] as const;
const seller = "synthetic-cohort-seller";
const entryAt = iso("2025-05-10T00:00:00.000Z");
const bandAt = iso("2025-05-12T00:00:00.000Z");
const observedAt = iso("2025-05-13T00:00:00.000Z");
const policy: SellerComplianceCohortPolicyValue = {
  ...SELLER_COMPLIANCE_COHORT_POLICY_DEFAULT_VALUE,
  activated: true,
  currencyCode: "USD",
  qualifyingTransactionCount: 1,
  qualifyingGrossCents: "500000",
  disclosureGrossCents: "2000000",
  windowMonths: 1,
  lookbackMonths: 1,
  comparisonIsInclusive: true,
  saleUnit: "captured-order",
  qualifyingGrossBasis: "item-gross",
  refundTreatment: "exclude-refunded",
  postCaptureCancellationTreatment: "exclude-cancelled",
  mixedLineTreatment: "exclude-mixed",
  unclassifiableTreatment: "exclude-unclassifiable",
  classificationRules: [{ source: "productId", value: "synthetic-card" }],
};
const identity = {
  policyKey: "platform-operations.seller-compliance-cohort",
  documentId: "synthetic-policy",
  eventId: "synthetic-policy-revision",
  streamVersion: 1,
};
function sale(id: string, occurredAt: string, gross: string): CohortEvaluationInput["sales"][number] {
  return {
    paymentId: `synthetic-payment-${id}`,
    orderId: `synthetic-order-${id}`,
    sellerAccountId: seller,
    saleState: "captured",
    occurredAt,
    currencyCode: "USD",
    itemGrossCents: gross,
    shippingChargeCents: "0",
    salesTaxCents: "0",
    authenticityFeeCents: "0",
    protectionCents: "0",
    orderTotalCents: gross,
    marketplaceSalesFeeCents: "0",
    sellerItemNetCents: gross,
    sellerPayoutCents: gross,
    refundedOrderTotalCents: null,
    orderRefundCapCents: null,
    cancelledAt: null,
    captureAnomalies: [],
    refundAnomalies: [],
    reconciliationMismatches: [],
    classificationInputs: [{ productId: "synthetic-card" }],
    classificationInputsVersion: 1,
    changeSequence: "1",
    revision: "1",
  };
}
const sales = [sale("entry", entryAt, "500000"), sale("band", bandAt, "1500000")];
function verdict(overrides: Partial<CohortEvaluationInput> = {}) {
  return evaluateSellerComplianceCohort({
    sales,
    policy,
    evaluationAt: observedAt,
    observedAt,
    policyIdentity: identity,
    ...overrides,
  });
}
function write(overrides: Partial<CohortWrite> = {}): CohortWrite {
  return {
    sellerAccountId: seller,
    expectedVersion: "0",
    evaluation: verdict(),
    policy: { status: "active", value: policy },
    ...overrides,
  };
}

describeDb("seller compliance cohort Postgres store", () => {
  let pools: Record<(typeof contextNames)[number], PgTransactionalPool>;
  let pool: PgTransactionalPool;
  beforeAll(async () => {
    const urls = createMultiContextTestDatabaseUrls(
      databaseBaseUrl!,
      contextNames,
      "platform_operations_seller_compliance_cohorts",
    );
    await ensureMultiContextTestDatabases(databaseBaseUrl!, urls);
    pools = createMultiContextTestPools(urls);
    pool = pools["platform-operations"];
  });
  beforeEach(async () => {
    await resetMultiContextTestSchemas(pools);
    await pool.query(platformOperationsModule.schemaSql);
  });
  afterAll(async () => {
    await closeMultiContextTestPools(pools);
  });

  async function ledger() {
    return (
      await pool.query(
        `SELECT * FROM platform_operations_seller_compliance_cohort_transitions ORDER BY transition_version`,
      )
    ).rows;
  }

  it("pair: persists the exact causal entry/disclosure pair and pg-Date-normalized cohort across connections", async () => {
    await writeSellerComplianceCohort(pool, write());
    const rows = await ledger();
    expect(
      rows.map((row) => [row.transition_id, row.effective_at, row.observed_at, row.target_state, row.target_band]),
    ).toEqual([
      [`${seller}:1:entered`, new Date(entryAt), new Date(observedAt), "member", "none"],
      [`${seller}:2:disclosure-band-changed`, new Date(bandAt), new Date(observedAt), "member", "disclosure"],
    ]);
    const client = await pool.connect();
    try {
      expect(await readSellerComplianceCohort(client, seller)).toMatchObject({
        version: "2",
        state: "member",
        band: "disclosure",
        entryEffectiveAt: entryAt,
        updatedAt: observedAt,
      });
      expect(await readSellerComplianceCohortLedgerHead(client, seller)).toMatchObject({
        version: "2",
        effectiveAt: bandAt,
        observedAt,
        entryEffectiveAt: entryAt,
      });
    } finally {
      client.release();
    }
  });

  it("guard: stale writes, retries and inactive/no-coverage inputs preserve every stored byte", async () => {
    await writeSellerComplianceCohort(pool, write());
    const before = await readSellerComplianceCohort(pool, seller);
    const transitions = await ledger();
    const changed = { ...verdict(), qualifyingCount: 99 };
    for (const candidate of [
      write({ evaluation: changed }),
      write({ expectedVersion: "2" }),
      write({ expectedVersion: "2", policy: null, evaluation: changed }),
      write({ expectedVersion: "2", policy: { status: "inactive", value: policy }, evaluation: changed }),
      write({
        expectedVersion: "2",
        policy: { status: "active", value: SELLER_COMPLIANCE_COHORT_POLICY_DEFAULT_VALUE },
        evaluation: changed,
      }),
    ])
      await writeSellerComplianceCohort(pool, candidate);
    expect(await readSellerComplianceCohort(pool, seller)).toEqual(before);
    expect(await ledger()).toEqual(transitions);
  });

  it("guard: interleaved first writers and existing-row writers commit one transition set", async () => {
    await Promise.all([writeSellerComplianceCohort(pool, write()), writeSellerComplianceCohort(pool, write())]);
    expect(await ledger()).toHaveLength(2);
    const exitAt = iso("2025-07-13T00:00:00.001Z");
    const exit = verdict({
      sales: [],
      evaluationAt: exitAt,
      observedAt: exitAt,
      previous: { state: "member", band: "disclosure", entryEffectiveAt: entryAt, transitionEffectiveAt: bandAt },
    });
    await Promise.all([
      writeSellerComplianceCohort(pool, write({ expectedVersion: "2", evaluation: exit })),
      writeSellerComplianceCohort(pool, write({ expectedVersion: "2", evaluation: exit })),
    ]);
    expect((await ledger()).map((row) => [row.kind, row.target_state, row.target_band])).toEqual([
      ["entered", "member", "none"],
      ["disclosure-band-changed", "member", "disclosure"],
      ["exited", "outside", "none"],
    ]);
  });

  it("guard: the SQL read-version predicate defeats a key-only-write bypass", async () => {
    await writeSellerComplianceCohort(pool, write());
    const guardedPool: PgTransactionalPool = {
      query: pool.query.bind(pool),
      connect: async () => {
        const client = await pool.connect();
        const query: PgPoolClient["query"] = async <Row = Record<string, unknown>>(
          sql: string,
          values?: readonly unknown[],
        ) => {
          if (sql.startsWith("UPDATE platform_operations_seller_compliance_cohorts SET")) {
            await client.query(
              `UPDATE platform_operations_seller_compliance_cohorts SET version=3 WHERE seller_account_id=$1 AND version=2`,
              [seller],
            );
          }
          return client.query<Row>(sql, values);
        };
        return { query, release: client.release.bind(client) };
      },
    };
    await writeSellerComplianceCohort(
      guardedPool,
      write({ expectedVersion: "2", evaluation: { ...verdict(), qualifyingCount: 99 } }),
    );
    expect(await readSellerComplianceCohort(pool, seller)).toMatchObject({ version: "3", qualifyingCount: 2 });
    expect(await ledger()).toHaveLength(2);
  });

  it("seam: exposes exact columns, starts unpublished and never restamps a published retry", async () => {
    await writeSellerComplianceCohort(pool, write());
    const columns = await pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='platform_operations_seller_compliance_cohort_transitions' ORDER BY ordinal_position`,
    );
    expect(columns.rows.map((row) => row.column_name)).toEqual([
      "transition_id",
      "seller_account_id",
      "transition_version",
      "kind",
      "effective_at",
      "observed_at",
      "policy_version",
      "target_state",
      "target_band",
      "recorded_at",
      "published_at",
    ]);
    expect((await ledger()).map((row) => row.published_at)).toEqual([null, null]);
    // Synthetic downstream publisher control, not a publisher implementation.
    await pool.query(
      `UPDATE platform_operations_seller_compliance_cohort_transitions SET published_at=$2 WHERE transition_id=$1 AND published_at IS NULL`,
      [`${seller}:1:entered`, "2025-05-14T00:00:00.000Z"],
    );
    const before = await ledger();
    const secondPublication = await pool.query(
      `UPDATE platform_operations_seller_compliance_cohort_transitions SET published_at=$2 WHERE transition_id=$1 AND published_at IS NULL`,
      [`${seller}:1:entered`, "2025-05-15T00:00:00.000Z"],
    );
    expect(secondPublication.rowCount).toBe(0);
    await writeSellerComplianceCohort(pool, write({ expectedVersion: "2" }));
    expect(await ledger()).toEqual(before);
  });

  it("lifecycle: inactive snapshots freeze and reactivation reconciles the first new transition at the revision", async () => {
    const first = verdict();
    await writeSellerComplianceCohort(pool, write({ evaluation: first }));
    const previous = {
      state: first.state,
      band: first.band,
      entryEffectiveAt: first.entryEffectiveAt,
      transitionEffectiveAt: first.bandEffectiveAt,
    };
    const inactive = { ...policy, activated: false };
    const inactiveAt = iso("2025-05-14T00:00:00.000Z");
    const frozen = await readSellerComplianceCohort(pool, seller);
    await writeSellerComplianceCohort(
      pool,
      write({
        expectedVersion: "2",
        policy: { status: "active", value: inactive },
        evaluation: verdict({
          policy: inactive,
          previous,
          revisionEffectiveAt: inactiveAt,
          priorPolicies: [{ effectiveFrom: "2025-05-01T00:00:00.000Z", policy }],
          evaluationAt: "2025-05-15T00:00:00.000Z",
          observedAt: "2025-05-15T00:00:00.000Z",
        }),
      }),
    );
    expect(await readSellerComplianceCohort(pool, seller)).toEqual(frozen);
    const reactivatedAt = iso("2025-05-16T00:00:00.000Z");
    const reactivated = verdict({
      policy: { ...policy, qualifyingGrossCents: "3000000", disclosureGrossCents: "4000000" },
      previous,
      revisionEffectiveAt: reactivatedAt,
      priorPolicies: [{ effectiveFrom: "2025-05-01T00:00:00.000Z", policy }],
      evaluationAt: "2025-05-17T00:00:00.000Z",
      observedAt: "2025-05-17T00:00:00.000Z",
      policyIdentity: { ...identity, eventId: "synthetic-reactivation", streamVersion: 3 },
    });
    await writeSellerComplianceCohort(pool, write({ expectedVersion: "2", evaluation: reactivated }));
    expect((await ledger()).at(-1)).toMatchObject({
      kind: "exited",
      effective_at: new Date(reactivatedAt),
      target_state: "outside",
      target_band: "none",
    });
  });

  it("seam: a transition insertion failure rolls back the cohort and entire pair", async () => {
    const failingPool: PgTransactionalPool = {
      query: pool.query.bind(pool),
      connect: async () => {
        const client = await pool.connect();
        const query: PgPoolClient["query"] = async <Row = Record<string, unknown>>(
          sql: string,
          values?: readonly unknown[],
        ) => {
          if (
            sql.startsWith("INSERT INTO platform_operations_seller_compliance_cohort_transitions") &&
            values?.[3] === "disclosure-band-changed"
          ) {
            return client.query<Row>(sql, [...values.slice(0, 8), "invalid-band"]);
          }
          return client.query<Row>(sql, values);
        };
        return { query, release: client.release.bind(client) };
      },
    };
    await expect(writeSellerComplianceCohort(failingPool, write())).rejects.toThrow();
    expect(await readSellerComplianceCohort(pool, seller)).toBeNull();
    expect(await ledger()).toEqual([]);
  });

  it("seam: cohort-only restore retains the ledger and allocates numeric versions beyond nine", async () => {
    await pool.query(
      `INSERT INTO platform_operations_seller_compliance_cohort_transitions (transition_id,seller_account_id,transition_version,kind,effective_at,observed_at,policy_version,target_state,target_band) VALUES ($1,$2,9,'exited',$3,$3,$4,'outside','none')`,
      [`${seller}:9:exited`, seller, "2025-05-01T00:00:00.000Z", JSON.stringify(identity)],
    );
    await writeSellerComplianceCohort(pool, write({ expectedVersion: "9" }));
    expect((await ledger()).map((row) => row.transition_id)).toEqual([
      `${seller}:9:exited`,
      `${seller}:10:entered`,
      `${seller}:11:disclosure-band-changed`,
    ]);
    expect(await readSellerComplianceCohortLedgerHead(pool, seller)).toMatchObject({
      version: "11",
      band: "disclosure",
    });
  });

  it("migration: registered DDL creates the seam from an empty schema and is idempotent", async () => {
    await resetMultiContextTestSchemas(pools);
    for (let pass = 0; pass < 2; pass++) {
      for (const migration of sellerComplianceCohortSchemaMigrations) {
        expect(platformOperationsModule.schemaMigrations).toContainEqual(migration);
        for (const statement of migration.statements) await pool.query(statement);
      }
    }
    await writeSellerComplianceCohort(pool, write());
    expect(await ledger()).toHaveLength(2);
    const indexes = await pool.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes WHERE schemaname='public' AND tablename IN ('platform_operations_seller_compliance_cohorts','platform_operations_seller_compliance_cohort_transitions')`,
    );
    expect(indexes.rows.map((row) => row.indexname)).toEqual(
      expect.arrayContaining([
        "platform_operations_seller_compliance_cohorts_due_idx",
        "platform_operations_cohort_transitions_unpublished_idx",
        "platform_operations_seller_compliance_transitions_seller_idx",
      ]),
    );
  });
});
