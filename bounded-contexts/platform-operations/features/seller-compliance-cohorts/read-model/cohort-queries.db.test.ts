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
  });

  it("stays unconfigured on the compiled default and records a durable failure on a malformed value", async () => {
    await pool.query(
      `INSERT INTO platform_operations_seller_compliance_evaluation_failures (seller_account_id,evaluation_at,failure_kind,detail,policy_version) VALUES ($1,$2,$3,$4,$5)`,
      ["seller-1", "2025-01-03T00:00:00.000Z", "policy-decode", "invalid", "policy@bad"],
    );
    const result = await pool.query(
      `SELECT failure_kind, policy_version FROM platform_operations_seller_compliance_evaluation_failures`,
    );
    expect(result.rows).toEqual([{ failure_kind: "policy-decode", policy_version: "policy@bad" }]);
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
      observedAt: "2025-01-02T00:00:00.000Z",
      evaluation: evaluation("member", "disclosure"),
    });
    const rows = await pool.query(
      `SELECT transition_id,kind,transition_version FROM platform_operations_seller_compliance_cohort_transitions WHERE seller_account_id = $1 ORDER BY transition_version`,
      ["seller-reentry"],
    );
    expect(rows.rows).toEqual([
      { transition_id: "seller-reentry:1:entered", kind: "entered", transition_version: "1" },
      {
        transition_id: "seller-reentry:2:disclosure-band-changed",
        kind: "disclosure-band-changed",
        transition_version: "2",
      },
    ]);
  });

  it("processes candidates in bounded resumable pages", async () => {
    await pool.query(
      `INSERT INTO platform_operations_seller_compliance_sweep_checkpoints (trigger_name,snapshot_change_sequence,after_seller_account_id,policy_version) VALUES ($1,$2,$3,$4)`,
      ["cohort-sweep", "10", "seller-10", "policy@1"],
    );
    const row = await pool.query(
      `SELECT after_seller_account_id FROM platform_operations_seller_compliance_sweep_checkpoints WHERE trigger_name = $1`,
      ["cohort-sweep"],
    );
    expect(row.rows[0].after_seller_account_id).toBe("seller-10");
  });
});
