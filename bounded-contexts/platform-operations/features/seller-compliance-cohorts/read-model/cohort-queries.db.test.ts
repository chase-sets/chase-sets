import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { module as platformOperationsModule } from "../../../index";
import { listCohortChangedSellers } from "./cohort-queries";
import { readSellerComplianceSnapshotChangeSequence } from "../../seller-compliance-sales/read-model/queries";

const url = process.env.TEST_DATABASE_URL;
if (!url && process.env.CI) throw new Error("TEST_DATABASE_URL is required for cohort range query tests.");
const describeDb = url ? describe : describe.skip;
describeDb("cohort-owned seller change range", () => {
  let pools: Record<"platform-operations", PgTransactionalPool>;
  let pool: PgTransactionalPool;
  const tick = "2025-05-20T00:00:00.000Z";
  beforeAll(async () => {
    const urls = createMultiContextTestDatabaseUrls(url!, ["platform-operations"], "synthetic_cohort_range");
    await ensureMultiContextTestDatabases(url!, urls);
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
  async function seed(seller: string, sequence: number, suffix = "") {
    await pool.query(
      `INSERT INTO platform_operations_seller_compliance_sales
      (payment_id,order_id,seller_account_id,sale_state,occurred_at,change_sequence,recorded_at,changed_at)
      VALUES ($1,$1,$2,'captured','2025-01-01',$3,'2025-01-01','2025-01-01')`,
      [`synthetic-${seller}-${suffix}`, seller, sequence],
    );
  }
  it("resume cursor retains the raw-page suffix across a greater-than-24-hour gap and defers behind-cursor changes", async () => {
    for (let i = 0; i < 102; i++) await seed(`synthetic-${String(i).padStart(3, "0")}`, i + 1);
    await seed("synthetic-050", 103, "duplicate-seller");
    const snapshot = await readSellerComplianceSnapshotChangeSequence(pool);
    const input = {
      lastCompletedSnapshot: "0",
      currentSnapshot: snapshot,
      afterSellerAccountId: null,
      evaluationAt: tick,
      policyChanged: false,
      limit: 100,
    };
    const first = await listCohortChangedSellers(pool, input);
    expect(first).toHaveLength(100);
    await seed("synthetic-000", 104, "behind-cursor");
    const suffix = await listCohortChangedSellers(pool, {
      ...input,
      afterSellerAccountId: first.at(-1)!,
      evaluationAt: "2025-05-23T00:00:00.000Z",
    });
    expect(suffix).toEqual(["synthetic-100", "synthetic-101"]);
    expect(new Set([...first, ...suffix]).size).toBe(102);
    const next = await listCohortChangedSellers(pool, {
      ...input,
      lastCompletedSnapshot: snapshot,
      currentSnapshot: await readSellerComplianceSnapshotChangeSequence(pool),
    });
    expect(next).toEqual(["synthetic-000"]);
  });
  it("includes due and revision sellers once, independent of sale changed_at", async () => {
    await seed("synthetic-sale", 5);
    await pool.query(`INSERT INTO platform_operations_seller_compliance_cohorts
      (seller_account_id,state,disclosure_band,policy_version,next_reevaluation_at,updated_at)
      VALUES ('synthetic-due','outside','none','synthetic-version','2025-05-19','2025-01-01'),
      ('synthetic-future','outside','none','synthetic-version','2025-05-21','2025-01-01')`);
    const input = {
      lastCompletedSnapshot: "0",
      currentSnapshot: "5",
      afterSellerAccountId: null,
      evaluationAt: tick,
      policyChanged: false,
      limit: 100,
    };
    expect(await listCohortChangedSellers(pool, input)).toEqual(["synthetic-due", "synthetic-sale"]);
    expect(await listCohortChangedSellers(pool, { ...input, policyChanged: true })).toEqual([
      "synthetic-due",
      "synthetic-future",
      "synthetic-sale",
    ]);
    await expect(listCohortChangedSellers(pool, { ...input, limit: 101 })).rejects.toThrow();
  });
});
