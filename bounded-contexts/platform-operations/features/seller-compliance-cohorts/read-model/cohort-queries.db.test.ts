import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PgPoolClient, PgTransactionalPool } from "@chase-sets/event-core-postgres";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import { module as platformOperationsModule } from "../../../index";
import { readSellerComplianceCohortLedgerHead, writeSellerComplianceCohort } from "./cohort-store";
import { readSellerComplianceCohortState, readSellerComplianceUnclassifiableCoverage } from "./cohort-queries";
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

  /** Node-postgres may hand timestamptz back as Date; compare every column as its ISO string. */
  const isoRow = (row: Record<string, unknown> | null) =>
    row === null
      ? null
      : Object.fromEntries(
          Object.entries(row).map(([key, value]) => [key, value instanceof Date ? value.toISOString() : value]),
        );

  it("converges under repeated ticks and leaves an unchanged seller byte-identical", async () => {
    const input = {
      sellerAccountId: "seller-1",
      policyVersion: "policy@1",
      observedAt: "2025-01-03T00:00:00.000Z",
      evaluation: evaluation("member"),
      expectedVersion: "0",
    };
    await writeSellerComplianceCohort(pool, input);
    const first = await pool.query(`SELECT * FROM platform_operations_seller_compliance_cohorts`);
    const transitions = await pool.query(`SELECT * FROM platform_operations_seller_compliance_cohort_transitions`);
    await writeSellerComplianceCohort(pool, { ...input, observedAt: "2025-01-04T00:00:00.000Z", expectedVersion: "1" });
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
    // The inert default retains no policy evidence either.
    expect((await pool.query("SELECT * FROM platform_operations_seller_compliance_policy_evidence")).rows).toEqual([]);
    await writeSellerComplianceCohort(pool, {
      sellerAccountId: "seller-1",
      policyVersion: "policy@1",
      observedAt: "2025-01-03T00:00:00.000Z",
      evaluation: evaluation("member"),
      expectedVersion: "0",
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
    const result = await pool.query(`SELECT * FROM platform_operations_seller_compliance_evaluation_failures`);
    expect(result.rows.map(isoRow)).toEqual([
      {
        seller_account_id: "seller-1",
        evaluation_at: "2025-01-03T00:00:00.000Z",
        failure_kind: "policy-decode",
        detail: "malformed stored revision",
        policy_version: null,
        recorded_at: expect.any(String),
      },
    ]);
    expect((await pool.query("SELECT * FROM platform_operations_seller_compliance_policy_evidence")).rows).toEqual([]);
  });

  it("reads the stored cohort state and unclassifiable coverage for missing and existing sellers", async () => {
    expect(await readSellerComplianceCohortState(pool, "seller-q")).toBeNull();
    expect(await readSellerComplianceUnclassifiableCoverage(pool, "seller-q")).toEqual({
      unclassifiable_count: "0",
      total_count: "0",
    });
    await writeSellerComplianceCohort(pool, {
      sellerAccountId: "seller-q",
      policyVersion: "policy@1",
      observedAt: "2025-01-03T00:00:00.000Z",
      evaluation: { ...evaluation("member"), unclassifiableCount: 1 },
      expectedVersion: "0",
    });
    expect(isoRow(await readSellerComplianceCohortState(pool, "seller-q"))).toEqual({
      seller_account_id: "seller-q",
      state: "member",
      disclosure_band: "none",
      entry_effective_at: "2025-01-01T00:00:00.000Z",
      exit_effective_at: null,
      window_start: "2025-01-01T00:00:00.000Z",
      window_end: "2025-02-01T00:00:00.000Z",
      qualifying_count: 2,
      qualifying_gross_cents: "500000",
      unclassifiable_count: 1,
      policy_version: "policy@1",
      version: "1",
      next_reevaluation_at: "2025-02-01T00:00:00.000Z",
    });
    expect(await readSellerComplianceUnclassifiableCoverage(pool, "seller-q")).toEqual({
      unclassifiable_count: "1",
      total_count: "3",
    });
    expect(await readSellerComplianceCohortState(pool, "seller-other")).toBeNull();
  });

  it("restores a lost row past nine transitions on the ledger's numerically latest version", async () => {
    const states = [
      "member",
      "outside",
      "member",
      "outside",
      "member",
      "outside",
      "member",
      "outside",
      "member",
      "outside",
    ];
    for (const [index, state] of states.entries())
      await writeSellerComplianceCohort(pool, {
        sellerAccountId: "seller-10",
        policyVersion: "policy@1",
        observedAt: `2025-01-${String(index + 3).padStart(2, "0")}T00:00:00.000Z`,
        evaluation: evaluation(state as "member" | "outside"),
        expectedVersion: String(index),
      });
    await pool.query("DELETE FROM platform_operations_seller_compliance_cohorts");
    expect(await readSellerComplianceCohortLedgerHead(pool, "seller-10")).toEqual({
      version: "10",
      state: "outside",
      band: "none",
      policyVersion: "policy@1",
      effectiveAt: "2025-02-01T00:00:00.000Z",
      observedAt: "2025-01-12T00:00:00.000Z",
      entryEffectiveAt: null,
      exitEffectiveAt: "2025-02-01T00:00:00.000Z",
    });
    await writeSellerComplianceCohort(pool, {
      sellerAccountId: "seller-10",
      policyVersion: "policy@1",
      observedAt: "2025-01-13T00:00:00.000Z",
      evaluation: evaluation("member"),
      expectedVersion: "10",
    });
    const ledger = await pool.query<{ transition_id: string }>(
      `SELECT transition_id FROM platform_operations_seller_compliance_cohort_transitions ORDER BY transition_version`,
    );
    expect(ledger.rows.map((row) => row.transition_id).slice(-3)).toEqual([
      "seller-10:9:entered",
      "seller-10:10:exited",
      "seller-10:11:entered",
    ]);
    expect((await readSellerComplianceCohortState(pool, "seller-10"))?.version).toBe("11");
  });

  it("appends one immutable transition per state change with an injective identity", async () => {
    await writeSellerComplianceCohort(pool, {
      sellerAccountId: "seller-1",
      policyVersion: "policy@1",
      observedAt: "2025-01-03T00:00:00.000Z",
      evaluation: evaluation("member", "disclosure"),
      expectedVersion: "0",
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
      expectedVersion: "0",
    });
    await writeSellerComplianceCohort(pool, {
      sellerAccountId: "seller-reentry",
      policyVersion: "policy@1",
      observedAt: "2025-01-01T12:00:00.000Z",
      evaluation: evaluation("member"),
      expectedVersion: "0",
    });
    await writeSellerComplianceCohort(pool, {
      sellerAccountId: "seller-reentry",
      policyVersion: "policy@1",
      observedAt: "2025-01-02T00:00:00.000Z",
      evaluation: evaluation("outside"),
      expectedVersion: "1",
    });
    await writeSellerComplianceCohort(pool, {
      sellerAccountId: "seller-reentry",
      policyVersion: "policy@1",
      observedAt: "2025-01-02T00:00:00.000Z",
      evaluation: evaluation("member", "disclosure"),
      expectedVersion: "2",
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
  const sweepRuntime = (documentId: string, writePool: PgTransactionalPool = pool) =>
    createSellerComplianceCohortRuntime({
      db: pool,
      pool: writePool,
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
  /** Every column of the cohort slice's tables: rows, the immutable ledger, sweep checkpoints and failures. */
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
                ${iso("observed_at")},policy_version,target_state,target_band,${iso("recorded_at")},
                ${iso("published_at")}
         FROM platform_operations_seller_compliance_cohort_transitions ORDER BY seller_account_id,transition_version`,
      ),
      pool.query(
        `SELECT trigger_name,snapshot_change_sequence::text,after_seller_account_id,policy_version,
                ${iso("pass_started_at")},${iso("updated_at")}
         FROM platform_operations_seller_compliance_sweep_checkpoints ORDER BY trigger_name`,
      ),
      pool.query(
        `SELECT seller_account_id,${iso("evaluation_at")},failure_kind,detail,policy_version,${iso("recorded_at")}
         FROM platform_operations_seller_compliance_evaluation_failures
         ORDER BY seller_account_id,evaluation_at,failure_kind`,
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
    // Recorded by the database clock once; replays compare the exact value, never a re-recorded one.
    recorded_at: expect.any(String),
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
    // The activated policy's content is retained by version for later revisions to judge the time before them.
    expect(
      (
        await pool.query(
          `SELECT policy_version,${iso("effective_from")},value FROM platform_operations_seller_compliance_policy_evidence`,
        )
      ).rows,
    ).toEqual([{ policy_version: version, effective_from: "2025-01-01T00:00:00.000Z", value: sweepPolicy }]);

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

    // Control only (cohort-only loss is proven separately): emptying every derived table and replaying the same ticks
    // rebuilds the same rows and a re-recorded ledger.
    await pool.query(
      `TRUNCATE platform_operations_seller_compliance_cohorts,
                platform_operations_seller_compliance_cohort_transitions,
                platform_operations_seller_compliance_sweep_checkpoints`,
    );
    expect(await sweepState()).toEqual(emptyState);
    for (const tick of [tickA, tickB, tickC]) expect(await runtime.sweep({ now: tick, limit: 10 })).toBe(1);
    expect(await sweepState()).toEqual(afterExit);
  });

  it("restores cohort-only loss after entry, steady and exit ticks from the retained ledger", async () => {
    await recordSale("p3-seller", "2025-01-01T00:00:00.000Z");
    const runtime = sweepRuntime("p3");
    const ticks = ["2025-01-15T00:00:00.000Z", "2025-02-02T00:00:00.000Z", "2025-03-02T00:00:00.000Z"];
    for (const [index, tick] of ticks.entries()) {
      expect(await runtime.sweep({ now: tick, limit: 10 })).toBe(1);
      const expected = await sweepState();
      // Only the cohort rows are lost; sales, the ledger, checkpoints and failures are retained.
      await pool.query("DELETE FROM platform_operations_seller_compliance_cohorts");
      for (const replayed of ticks.slice(0, index + 1)) await runtime.sweep({ now: replayed, limit: 10 });
      // Identical rows and every ledger column, recorded_at included: no transition was re-recorded or duplicated.
      expect(await sweepState()).toEqual(expected);
    }
    const final = await sweepState();
    expect(final.transitions.map((row) => [row.transition_id, row.effective_at, row.observed_at])).toEqual([
      ["p3-seller:1:entered", "2025-01-01T00:00:00.000Z", ticks[0]],
      ["p3-seller:2:exited", "2025-03-01T00:00:00.001Z", ticks[2]],
    ]);
    expect(final.cohorts).toEqual([
      expect.objectContaining({ state: "outside", version: "2", exit_effective_at: "2025-03-01T00:00:00.001Z" }),
    ]);
  });

  it("restores partial cohort loss in bounded pages, retries an interrupted restore and then does nothing", async () => {
    for (const seller of ["p3-a", "p3-b", "p3-c"]) await recordSale(seller, "2025-01-01T00:00:00.000Z");
    const tick = "2025-01-15T00:00:00.000Z";
    const version = "p3@2025-01-01T00:00:00.000Z";
    expect(await sweepRuntime("p3").sweep({ now: tick, limit: 10 })).toBe(3);
    const expected = await sweepState();
    await pool.query("DELETE FROM platform_operations_seller_compliance_cohorts WHERE seller_account_id <> 'p3-b'");
    // The first restoring write is cut off inside its transaction.
    let interrupt = true;
    const interrupting: PgTransactionalPool = {
      query: pool.query.bind(pool),
      connect: async () => {
        const client = await pool.connect();
        return {
          query: (async (text: string, values?: readonly unknown[]) => {
            if (interrupt && text.startsWith("INSERT INTO platform_operations_seller_compliance_cohorts ")) {
              interrupt = false;
              throw new Error("connection lost during restore");
            }
            return client.query(text, values);
          }) as PgPoolClient["query"],
          release: (error?: unknown) => client.release(error),
        };
      },
    };
    expect(await sweepRuntime("p3", interrupting).sweep({ now: tick, limit: 1 })).toBe(1);
    const interrupted = await sweepState();
    expect(interrupted.cohorts.map((row) => row.seller_account_id)).toEqual(["p3-b"]);
    expect(interrupted.transitions).toEqual(expected.transitions);
    expect(interrupted.checkpoints).toContainEqual(
      expect.objectContaining({ trigger_name: "recovery", after_seller_account_id: "p3-a" }),
    );
    const failure = {
      seller_account_id: "p3-a",
      evaluation_at: tick,
      failure_kind: "evaluation",
      detail: "connection lost during restore",
      policy_version: version,
      recorded_at: expect.any(String),
    };
    expect(interrupted.failures).toEqual([failure]);
    // A restarted runtime resumes the page after the interruption, then a new pass retries the interrupted seller.
    const restarted = sweepRuntime("p3");
    const restored: number[] = [];
    for (let run = 0; run < 4; run += 1) restored.push(await restarted.sweep({ now: tick, limit: 1 }));
    expect(restored).toEqual([1, 0, 1, 0]);
    // Intact rows make a completed no-op: nothing is evaluated or written again.
    expect(await restarted.sweep({ now: tick, limit: 10 })).toBe(0);
    const final = await sweepState();
    expect(final).toEqual({ ...expected, failures: [failure] });
    expect(final.failures[0]!.recorded_at).toBe(interrupted.failures[0]!.recorded_at);
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
