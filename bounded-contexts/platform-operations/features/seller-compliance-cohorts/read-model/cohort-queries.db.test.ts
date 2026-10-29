import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import { module as platformOperationsModule } from "../../../index";
import { writeSellerComplianceCohort } from "./cohort-store";
import { createSellerComplianceCohortRuntime } from "../api/cohort-evaluation-runtime";
import {
  SELLER_COMPLIANCE_COHORT_POLICY_DEFAULT_VALUE,
  SellerComplianceCohortPolicyDomainError,
} from "../domain/seller-compliance-cohort-policy";

const databaseBaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseBaseUrl && process.env.CI)
  throw new Error("TEST_DATABASE_URL is required for database-backed tests in CI.");
const describeDatabase = databaseBaseUrl ? describe : describe.skip;

describeDatabase("seller compliance cohort persistence", () => {
  let pools: Readonly<Record<"platform-operations", PgTransactionalPool>>;
  let pool: PgTransactionalPool;
  const evaluation = (state: "outside" | "member", band: "none" | "disclosure" = "none") => ({
    state,
    band,
    entryEffectiveAt: state === "member" ? "2025-01-01T00:00:00.000Z" : null,
    bandEffectiveAt: band === "disclosure" ? "2025-01-01T00:00:00.000Z" : null,
    exitEffectiveAt: state === "outside" ? "2025-02-01T00:00:00.000Z" : null,
    windowStart: state === "member" ? "2025-01-01T00:00:00.000Z" : null,
    windowEnd: state === "member" ? "2025-02-01T00:00:00.000Z" : null,
    nextReevaluationAt: state === "member" ? "2025-02-01T00:00:00.000Z" : null,
    unclassifiableCount: 0,
    qualifyingCount: state === "member" ? 2 : 0,
    qualifyingGrossCents: state === "member" ? "500000" : "0",
  });
  beforeAll(async () => {
    const urls = createMultiContextTestDatabaseUrls(
      databaseBaseUrl!,
      ["platform-operations"],
      "seller_compliance_cohort",
    );
    await ensureMultiContextTestDatabases(databaseBaseUrl!, urls);
    pools = createMultiContextTestPools(urls) as typeof pools;
    pool = pools["platform-operations"];
  });
  beforeEach(async () => {
    await resetMultiContextTestSchemas(pools);
    await pool.query(platformOperationsModule.schemaSql);
  });
  afterAll(async () => {
    await closeMultiContextTestPools(pools);
  });

  it("converges under repeated ticks and leaves an unchanged seller byte-identical", async () => {
    const input = {
      sellerAccountId: "seller-1",
      policyVersion: "policy@1",
      observedAt: "2025-01-03T00:00:00.000Z",
      evaluation: evaluation("member"),
    };
    await writeSellerComplianceCohort(pool, input);
    const first = await pool.query(`SELECT * FROM platform_operations_seller_compliance_cohorts`);
    const transitions = await pool.query(`SELECT * FROM platform_operations_seller_compliance_cohort_transitions`);
    await writeSellerComplianceCohort(pool, { ...input, observedAt: "2025-01-04T00:00:00.000Z" });
    const second = await pool.query(`SELECT * FROM platform_operations_seller_compliance_cohorts`);
    const transitionsAgain = await pool.query(`SELECT * FROM platform_operations_seller_compliance_cohort_transitions`);
    expect(second.rows).toEqual(first.rows);
    expect(transitionsAgain.rows).toEqual(transitions.rows);

    await pool.query(
      "TRUNCATE platform_operations_seller_compliance_cohorts, platform_operations_seller_compliance_cohort_transitions",
    );
    await writeSellerComplianceCohort(pool, input);
    const beforeEmptyReplay = await pool.query(
      `SELECT seller_account_id,state,disclosure_band,entry_effective_at,exit_effective_at,window_start,window_end,qualifying_count,qualifying_gross_cents,unclassifiable_count,policy_version,version,next_reevaluation_at,updated_at FROM platform_operations_seller_compliance_cohorts ORDER BY seller_account_id`,
    );
    await pool.query(
      "TRUNCATE platform_operations_seller_compliance_cohorts, platform_operations_seller_compliance_cohort_transitions",
    );
    await writeSellerComplianceCohort(pool, input);
    const afterEmptyReplay = await pool.query(
      `SELECT seller_account_id,state,disclosure_band,entry_effective_at,exit_effective_at,window_start,window_end,qualifying_count,qualifying_gross_cents,unclassifiable_count,policy_version,version,next_reevaluation_at,updated_at FROM platform_operations_seller_compliance_cohorts ORDER BY seller_account_id`,
    );
    expect(afterEmptyReplay.rows).toEqual(beforeEmptyReplay.rows);
  });

  it("stays unconfigured on the compiled default and records a durable failure on a malformed value", async () => {
    const defaultRuntime = createSellerComplianceCohortRuntime({
      db: pool,
      pool,
      policies: { resolvePolicy: async () => ({ value: SELLER_COMPLIANCE_COHORT_POLICY_DEFAULT_VALUE }) } as never,
    });
    expect(await defaultRuntime.sweep({ now: "2025-01-03T00:00:00.000Z", limit: 10 })).toBe(0);
    expect(
      (await pool.query("SELECT count(*)::int AS count FROM platform_operations_seller_compliance_cohorts")).rows[0]
        .count,
    ).toBe(0);
    await writeSellerComplianceCohort(pool, {
      sellerAccountId: "seller-1",
      policyVersion: "policy@1",
      observedAt: "2025-01-03T00:00:00.000Z",
      evaluation: evaluation("member"),
    });
    const malformedRuntime = createSellerComplianceCohortRuntime({
      db: pool,
      pool,
      policies: {
        resolvePolicy: async () => {
          throw new SellerComplianceCohortPolicyDomainError("malformed stored revision");
        },
      } as never,
    });
    expect(await malformedRuntime.sweep({ now: "2025-01-03T00:00:00.000Z", limit: 10 })).toBe(1);
    const result = await pool.query(
      `SELECT failure_kind, policy_version FROM platform_operations_seller_compliance_evaluation_failures`,
    );
    expect(result.rows).toEqual([{ failure_kind: "policy-decode", policy_version: null }]);
  });

  it("appends one immutable transition per state change with an injective identity", async () => {
    await writeSellerComplianceCohort(pool, {
      sellerAccountId: "seller-1",
      policyVersion: "policy@1",
      observedAt: "2025-01-03T00:00:00.000Z",
      evaluation: evaluation("member", "disclosure"),
    });
    const rows = await pool.query(
      `SELECT transition_id,transition_version,kind,effective_at,observed_at,target_band FROM platform_operations_seller_compliance_cohort_transitions ORDER BY transition_version`,
    );
    expect(rows.rows.map((row) => row.transition_id)).toEqual([
      "seller-1:1:entered",
      "seller-1:2:disclosure-band-changed",
    ]);
    expect(rows.rows[0].effective_at).toEqual(rows.rows[1].effective_at);
    expect(rows.rows[1].target_band).toBe("disclosure");
  });

  it("appends entered and disclosure transitions when a re-entry already carries disclosure", async () => {
    await writeSellerComplianceCohort(pool, {
      sellerAccountId: "seller-reentry",
      policyVersion: "policy@1",
      observedAt: "2025-01-01T00:00:00.000Z",
      evaluation: evaluation("outside"),
    });
    await writeSellerComplianceCohort(pool, {
      sellerAccountId: "seller-reentry",
      policyVersion: "policy@1",
      observedAt: "2025-01-01T12:00:00.000Z",
      evaluation: evaluation("member"),
    });
    await writeSellerComplianceCohort(pool, {
      sellerAccountId: "seller-reentry",
      policyVersion: "policy@1",
      observedAt: "2025-01-02T00:00:00.000Z",
      evaluation: evaluation("outside"),
    });
    await writeSellerComplianceCohort(pool, {
      sellerAccountId: "seller-reentry",
      policyVersion: "policy@1",
      observedAt: "2025-01-02T00:00:00.000Z",
      evaluation: evaluation("member", "disclosure"),
    });
    const rows = await pool.query(
      `SELECT transition_id,kind,transition_version FROM platform_operations_seller_compliance_cohort_transitions WHERE seller_account_id = $1 ORDER BY transition_version`,
      ["seller-reentry"],
    );
    expect(rows.rows.map((row) => row.kind)).toEqual(["entered", "exited", "entered", "disclosure-band-changed"]);
  });

  it("processes candidates in bounded resumable pages", async () => {
    await pool.query(
      `INSERT INTO platform_operations_seller_compliance_sweep_checkpoints (trigger_name,snapshot_change_sequence,after_seller_account_id,policy_version) VALUES ($1,$2,$3,$4)`,
      ["t1-changed", "10", "seller-10", "policy@1"],
    );
    const row = await pool.query(
      `SELECT after_seller_account_id FROM platform_operations_seller_compliance_sweep_checkpoints WHERE trigger_name = $1`,
      ["t1-changed"],
    );
    expect(row.rows[0].after_seller_account_id).toBe("seller-10");
  });

  const sweepPolicy = {
    ...SELLER_COMPLIANCE_COHORT_POLICY_DEFAULT_VALUE,
    activated: true,
    currencyCode: "USD",
    qualifyingTransactionCount: 1,
    qualifyingGrossCents: "1",
    disclosureGrossCents: "1000000",
    windowMonths: 1,
    lookbackMonths: 2,
    comparisonIsInclusive: true,
    saleUnit: "captured-order" as const,
    qualifyingGrossBasis: "item-gross" as const,
    refundTreatment: "exclude-refunded" as const,
    postCaptureCancellationTreatment: "exclude-cancelled" as const,
    mixedLineTreatment: "exclude-mixed" as const,
    unclassifiableTreatment: "exclude-unclassifiable" as const,
    classificationRules: [{ source: "productId" as const, value: "card" }],
  };
  const sweepRuntime = (documentId: string) =>
    createSellerComplianceCohortRuntime({
      db: pool,
      pool,
      policies: {
        resolvePolicy: async () => ({ value: sweepPolicy, documentId, effectiveFrom: "2025-01-01T00:00:00.000Z" }),
      } as never,
    });
  /** Records one qualifying sale at `at` and returns the resulting snapshot change sequence. */
  async function recordSale(sellerAccountId: string, at: string): Promise<string> {
    await pool.query(
      `INSERT INTO platform_operations_seller_compliance_sales
       (payment_id,order_id,seller_account_id,sale_state,occurred_at,currency_code,item_gross_cents,order_total_cents,
        marketplace_sales_fee_cents,seller_item_net_cents,seller_payout_cents,classification_inputs,revision,
        change_sequence,recorded_at,changed_at)
       VALUES ($1,$2,$3,'captured',$4,'USD',1,1,0,1,1,'[{"productId":"card"}]'::jsonb,1,
               nextval('platform_operations_seller_compliance_sales_change_seq'),$4,$4)`,
      [`${sellerAccountId}-payment`, `${sellerAccountId}-order`, sellerAccountId, at],
    );
    const result = await pool.query<{ snapshot: string }>(
      `SELECT MAX(change_sequence)::text AS snapshot FROM platform_operations_seller_compliance_sales`,
    );
    return result.rows[0]!.snapshot;
  }
  const iso = (column: string) => `to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS ${column}`;
  /** The complete ordered cohort-slice state: rows, ledger, sweep checkpoints and failures. */
  async function sweepState() {
    const [cohorts, transitions, checkpoints, failures] = await Promise.all([
      pool.query(
        `SELECT seller_account_id,state,disclosure_band,${iso("entry_effective_at")},${iso("exit_effective_at")},
                ${iso("window_start")},${iso("window_end")},qualifying_count,qualifying_gross_cents::text,
                unclassifiable_count,policy_version,version::text,${iso("next_reevaluation_at")},${iso("updated_at")}
         FROM platform_operations_seller_compliance_cohorts ORDER BY seller_account_id`,
      ),
      pool.query(
        `SELECT transition_id,seller_account_id,transition_version::text,kind,${iso("effective_at")},
                ${iso("observed_at")},policy_version,target_state,target_band,${iso("published_at")}
         FROM platform_operations_seller_compliance_cohort_transitions ORDER BY seller_account_id,transition_version`,
      ),
      pool.query(
        `SELECT trigger_name,snapshot_change_sequence::text,after_seller_account_id,policy_version,
                ${iso("pass_started_at")},${iso("updated_at")}
         FROM platform_operations_seller_compliance_sweep_checkpoints ORDER BY trigger_name`,
      ),
      pool.query(
        `SELECT seller_account_id,failure_kind,detail
         FROM platform_operations_seller_compliance_evaluation_failures ORDER BY seller_account_id,failure_kind`,
      ),
    ]);
    return {
      cohorts: cohorts.rows,
      transitions: transitions.rows,
      checkpoints: checkpoints.rows,
      failures: failures.rows,
    };
  }
  const emptyState = { cohorts: [], transitions: [], checkpoints: [], failures: [] };
  const memberRow = (sellerAccountId: string, policyVersion: string, entry: string, windowEnd: string) => ({
    seller_account_id: sellerAccountId,
    state: "member",
    disclosure_band: "none",
    entry_effective_at: entry,
    exit_effective_at: null,
    window_start: entry,
    window_end: windowEnd,
    qualifying_count: 1,
    qualifying_gross_cents: "1",
    unclassifiable_count: 0,
    policy_version: policyVersion,
    version: "1",
  });
  const transitionRow = (
    sellerAccountId: string,
    policyVersion: string,
    version: number,
    kind: "entered" | "exited",
    effectiveAt: string,
    observedAt: string,
  ) => ({
    transition_id: `${sellerAccountId}:${version}:${kind}`,
    seller_account_id: sellerAccountId,
    transition_version: String(version),
    kind,
    effective_at: effectiveAt,
    observed_at: observedAt,
    policy_version: policyVersion,
    target_state: kind === "entered" ? "member" : "outside",
    target_band: "none",
    published_at: null,
  });

  it("AC6 runs repeated production sweeps, exits without a new sale, and converges after an emptied-table replay", async () => {
    const snapshot = await recordSale("ac6-seller", "2025-01-01T00:00:00.000Z");
    const runtime = sweepRuntime("ac6");
    const version = "ac6@2025-01-01T00:00:00.000Z";
    const [tickA, tickB, tickC] = ["2025-01-15T00:00:00.000Z", "2025-02-02T00:00:00.000Z", "2025-03-02T00:00:00.000Z"];
    const completedMarkers = (updatedAt: string) =>
      ["t3-occurrence", "t3-revision"].map((trigger_name) => ({
        trigger_name,
        snapshot_change_sequence: snapshot,
        after_seller_account_id: null,
        policy_version: version,
        pass_started_at: tickA,
        updated_at: updatedAt,
      }));
    const member = (nextReevaluationAt: string, updatedAt: string) => ({
      ...memberRow("ac6-seller", version, "2025-01-01T00:00:00.000Z", "2025-02-01T00:00:00.000Z"),
      next_reevaluation_at: nextReevaluationAt,
      updated_at: updatedAt,
    });
    const entered = transitionRow("ac6-seller", version, 1, "entered", "2025-01-01T00:00:00.000Z", tickA);
    expect(await sweepState()).toEqual(emptyState);

    // The occurrence pass admits the seller with no cohort row; a repeated tick changes nothing.
    expect(await runtime.sweep({ now: tickA, limit: 10 })).toBe(1);
    const afterEntry = {
      ...emptyState,
      cohorts: [member("2025-02-01T00:00:00.000Z", tickA)],
      transitions: [entered],
      checkpoints: completedMarkers(tickA),
    };
    expect(await sweepState()).toEqual(afterEntry);
    expect(await runtime.sweep({ now: tickA, limit: 10 })).toBe(0);
    expect(await sweepState()).toEqual(afterEntry);

    // The due seller is processed on the next advancing tick; an unchanged verdict moves only its next instant.
    expect(await runtime.sweep({ now: tickB, limit: 10 })).toBe(1);
    expect(await sweepState()).toEqual({
      ...emptyState,
      cohorts: [member("2025-03-01T00:00:00.001Z", tickB)],
      transitions: [entered],
      checkpoints: completedMarkers(tickB),
    });

    // With no new sale the window rolls out of the lookback; the exit is dated by that roll-off, not by the tick.
    expect(await runtime.sweep({ now: tickC, limit: 10 })).toBe(1);
    const afterExit = {
      ...emptyState,
      cohorts: [
        {
          seller_account_id: "ac6-seller",
          state: "outside",
          disclosure_band: "none",
          entry_effective_at: null,
          exit_effective_at: "2025-03-01T00:00:00.001Z",
          window_start: null,
          window_end: null,
          qualifying_count: 0,
          qualifying_gross_cents: "0",
          unclassifiable_count: 0,
          policy_version: version,
          version: "2",
          next_reevaluation_at: null,
          updated_at: tickC,
        },
      ],
      transitions: [entered, transitionRow("ac6-seller", version, 2, "exited", "2025-03-01T00:00:00.001Z", tickC)],
      checkpoints: completedMarkers(tickC),
    };
    expect(await sweepState()).toEqual(afterExit);
    expect(await runtime.sweep({ now: tickC, limit: 10 })).toBe(0);
    expect(await sweepState()).toEqual(afterExit);

    // Emptying the cohort slice's state and replaying the same ticks converges to the identical row set.
    await pool.query(
      `TRUNCATE platform_operations_seller_compliance_cohorts,
                platform_operations_seller_compliance_cohort_transitions,
                platform_operations_seller_compliance_sweep_checkpoints`,
    );
    expect(await sweepState()).toEqual(emptyState);
    for (const tick of [tickA, tickB, tickC]) expect(await runtime.sweep({ now: tick, limit: 10 })).toBe(1);
    expect(await sweepState()).toEqual(afterExit);
  });

  it("AC11 and AC12 resume ordered pages and admit a sale on the next production tick", async () => {
    await recordSale("ac11-a", "2025-01-01T00:00:00.000Z");
    const firstSnapshot = await recordSale("ac11-b", "2025-01-01T00:00:00.000Z");
    const runtime = sweepRuntime("ac11");
    const version = "ac11@2025-01-01T00:00:00.000Z";
    const [tick1, tick2, tick3, tick4] = [
      "2025-01-01T12:00:00.000Z",
      "2025-01-02T06:00:00.000Z",
      "2025-01-02T08:00:00.000Z",
      "2025-01-02T09:00:00.000Z",
    ];
    const admitted = (sellerAccountId: string, entry: string, windowEnd: string, observedAt: string) => ({
      row: {
        ...memberRow(sellerAccountId, version, entry, windowEnd),
        next_reevaluation_at: windowEnd,
        updated_at: observedAt,
      },
      entered: transitionRow(sellerAccountId, version, 1, "entered", entry, observedAt),
    });
    const resumedT1 = (afterSellerAccountId: string, updatedAt: string) => ({
      trigger_name: "t1-changed",
      snapshot_change_sequence: firstSnapshot,
      after_seller_account_id: afterSellerAccountId,
      policy_version: version,
      pass_started_at: tick1,
      updated_at: updatedAt,
    });
    const a = admitted("ac11-a", "2025-01-01T00:00:00.000Z", "2025-02-01T00:00:00.000Z", tick1);
    const b = admitted("ac11-b", "2025-01-01T00:00:00.000Z", "2025-02-01T00:00:00.000Z", tick2);
    const c = admitted("ac11-c", "2025-01-02T07:00:00.000Z", "2025-02-02T07:00:00.000Z", tick3);

    // One tick processes at most `limit` sellers and records where the T1 pass stopped.
    expect(await runtime.sweep({ now: tick1, limit: 1 })).toBe(1);
    expect(await sweepState()).toEqual({
      ...emptyState,
      cohorts: [a.row],
      transitions: [a.entered],
      checkpoints: [resumedT1("ac11-a", tick1)],
    });

    // Both changes are 30 hours old, outside a window recomputed from this tick; the pass still resumes after ac11-a.
    expect(await runtime.sweep({ now: tick2, limit: 1 })).toBe(1);
    expect(await sweepState()).toEqual({
      ...emptyState,
      cohorts: [a.row, b.row],
      transitions: [a.entered, b.entered],
      checkpoints: [resumedT1("ac11-b", tick2)],
    });

    // A sale recorded between ticks is admitted on the next tick.
    const secondSnapshot = await recordSale("ac11-c", "2025-01-02T07:00:00.000Z");
    expect(await runtime.sweep({ now: tick3, limit: 1 })).toBe(1);
    expect(await sweepState()).toEqual({
      ...emptyState,
      cohorts: [a.row, b.row, c.row],
      transitions: [a.entered, b.entered, c.entered],
      checkpoints: [resumedT1("ac11-c", tick3)],
    });

    // The T1 pass completes without processing anyone twice; the occurrence pass pages from its raw first seller.
    expect(await runtime.sweep({ now: tick4, limit: 1 })).toBe(0);
    expect(await sweepState()).toEqual({
      ...emptyState,
      cohorts: [a.row, b.row, c.row],
      transitions: [a.entered, b.entered, c.entered],
      checkpoints: [
        {
          trigger_name: "t3-occurrence",
          snapshot_change_sequence: secondSnapshot,
          after_seller_account_id: "ac11-a",
          policy_version: version,
          pass_started_at: tick4,
          updated_at: tick4,
        },
        {
          trigger_name: "t3-revision",
          snapshot_change_sequence: secondSnapshot,
          after_seller_account_id: null,
          policy_version: version,
          pass_started_at: tick4,
          updated_at: tick4,
        },
      ],
    });
  });
});
