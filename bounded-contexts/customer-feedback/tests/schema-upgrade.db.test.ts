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
import { module as customerFeedbackModule } from "../index";

const adminDatabaseUrl = process.env.TEST_DATABASE_URL;
if (!adminDatabaseUrl && process.env.CI) {
  throw new Error("TEST_DATABASE_URL is required for database-backed tests in CI.");
}
const describeDb = adminDatabaseUrl ? describe : describe.skip;

describeDb("customer-feedback schema upgrades", () => {
  let pools: Readonly<Record<"customer-feedback", PgTransactionalPool>>;

  beforeAll(async () => {
    const urls = createMultiContextTestDatabaseUrls(
      adminDatabaseUrl!,
      ["customer-feedback"],
      "customer_feedback_schema_upgrade",
    );
    await ensureMultiContextTestDatabases(adminDatabaseUrl!, urls);
    pools = createMultiContextTestPools(urls);
  });

  beforeEach(async () => resetMultiContextTestSchemas(pools));
  afterAll(async () => closeMultiContextTestPools(pools));

  it("widens the deployed CSAT export lifecycle to accept pending rows", async () => {
    const pool = pools["customer-feedback"];
    await pool.query(`CREATE TABLE customer_feedback_csat_export_audits (
      export_id text PRIMARY KEY,
      actor_id text NOT NULL,
      filters jsonb NOT NULL,
      started_at timestamptz NOT NULL,
      completed_at timestamptz NOT NULL,
      row_count integer NOT NULL CHECK (row_count >= 0),
      result text NOT NULL CHECK (result IN ('completed', 'failed'))
    )`);

    await bootstrapContextDatabase(customerFeedbackModule, pool);

    const completedAt = await pool.query<{ is_nullable: string }>(`SELECT is_nullable
      FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND table_name = 'customer_feedback_csat_export_audits'
        AND column_name = 'completed_at'`);
    expect(completedAt.rows).toEqual([{ is_nullable: "YES" }]);

    const resultConstraint = await pool.query<{ definition: string }>(`SELECT pg_get_constraintdef(oid) AS definition
      FROM pg_constraint
      WHERE conrelid = 'customer_feedback_csat_export_audits'::regclass
        AND conname = 'customer_feedback_csat_export_audits_result_check'`);
    expect(resultConstraint.rows[0]?.definition).toContain("'pending'::text");
    expect(resultConstraint.rows[0]?.definition).toContain("'expired'::text");

    await expect(
      pool.query(`INSERT INTO customer_feedback_csat_export_audits
        (export_id, actor_id, filters, started_at, completed_at, artifact_expires_at, row_count, result)
        VALUES ('cse_pending', 'usr_admin', '{}'::jsonb, now(), NULL, now() + interval '1 day', 0, 'pending')`),
    ).resolves.toBeDefined();
  });
});
