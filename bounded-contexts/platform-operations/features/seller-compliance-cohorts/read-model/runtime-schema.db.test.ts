import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { bootstrapContextDatabase } from "@chase-sets/bounded-context-runtime";
import { closeMultiContextTestPools, createMultiContextTestDatabaseUrls, createMultiContextTestPools, ensureMultiContextTestDatabases, resetMultiContextTestSchemas } from "@chase-sets/bounded-context-runtime/test-support";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { module as platformOperationsModule } from "../../../index";
import { readCohortSweepCheckpoint, recordCohortEvaluationFailure, writeCohortSweepCheckpoint } from "./cohort-queries";

const url = process.env.TEST_DATABASE_URL;
if (!url && process.env.CI) throw new Error("TEST_DATABASE_URL is required for cohort runtime schema tests.");
const describeDb = url ? describe : describe.skip;
describeDb("seller compliance runtime schema", () => {
  let pools: Record<"platform-operations", PgTransactionalPool>;
  let pool: PgTransactionalPool;
  beforeAll(async () => {
    const urls = createMultiContextTestDatabaseUrls(url!, ["platform-operations"], "synthetic_cohort_runtime_schema");
    await ensureMultiContextTestDatabases(url!, urls);
    pools = createMultiContextTestPools(urls);
    pool = pools["platform-operations"];
  });
  beforeEach(async () => { await resetMultiContextTestSchemas(pools); await bootstrapContextDatabase(platformOperationsModule, pool); });
  afterAll(async () => { await closeMultiContextTestPools(pools); });

  it("durably deduplicates the exact failure key with nullable and store-encoded policy identity", async () => {
    const failure = { sellerAccountId: "synthetic-seller", evaluationAt: "2025-05-13T00:00:00.000Z", failureKind: "policy-decode", policyVersion: null, detail: "before selection" };
    await recordCohortEvaluationFailure(pool, failure);
    await recordCohortEvaluationFailure(pool, { ...failure, detail: "retry must not restamp" });
    const policyVersion = JSON.stringify({ policyKey: "platform-operations.seller-compliance-cohort", documentId: "synthetic-document", eventId: "synthetic-event", streamVersion: 2 });
    await recordCohortEvaluationFailure(pool, { ...failure, failureKind: "missing-prior-policy", policyVersion });
    const read = async () => (await pool.query("SELECT seller_account_id,evaluation_at,failure_kind,policy_version,detail FROM platform_operations_seller_compliance_evaluation_failures ORDER BY failure_kind")).rows;
    const before = await read();
    expect(before).toHaveLength(2);
    expect(before[0]).toMatchObject({ failure_kind: "missing-prior-policy", policy_version: policyVersion });
    expect(before[1]).toMatchObject({ failure_kind: "policy-decode", policy_version: null, detail: "before selection" });
    await bootstrapContextDatabase(platformOperationsModule, pool);
    expect(await read()).toEqual(before);
  });

  it("retains the completion checkpoint and rejects a stale read-version writer", async () => {
    const old = await readCohortSweepCheckpoint(pool);
    const first = await writeCohortSweepCheckpoint(pool, old, { ...old, currentSnapshot: "12", currentPolicyHorizon: "99", evaluationAt: "2025-05-13T00:00:00.000Z", rawPageCursor: "synthetic-z", sellerCursor: "synthetic-b" });
    await expect(writeCohortSweepCheckpoint(pool, old, { ...old, sellerCursor: "synthetic-stale" })).rejects.toThrow("lost its read version");
    const complete = await writeCohortSweepCheckpoint(pool, first, { ...first, lastCompletedSnapshot: "12", currentSnapshot: null, policyHorizon: "99", currentPolicyHorizon: null, lastEvaluationAt: first.evaluationAt, evaluationAt: null });
    expect(await readCohortSweepCheckpoint(pool)).toEqual(complete);
    expect(complete).toMatchObject({ lastCompletedSnapshot: "12", rawPageCursor: "synthetic-z", sellerCursor: "synthetic-b" });
  });
});
