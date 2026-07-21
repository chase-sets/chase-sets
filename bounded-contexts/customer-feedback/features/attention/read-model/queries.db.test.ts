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
import { module as customerFeedbackModule } from "../../../index";
import { listFeedbackAttention } from "./queries";

const adminDatabaseUrl = process.env.TEST_DATABASE_URL;
if (!adminDatabaseUrl && process.env.CI) {
  throw new Error("TEST_DATABASE_URL is required for database-backed tests in CI.");
}
const describeDb = adminDatabaseUrl ? describe : describe.skip;

describeDb("feedback attention queries", () => {
  let pool: PgTransactionalPool;

  beforeAll(async () => {
    const urls = createMultiContextTestDatabaseUrls(
      adminDatabaseUrl!,
      ["customer-feedback"],
      "customer_feedback_attention_queries",
    );
    await ensureMultiContextTestDatabases(adminDatabaseUrl!, urls);
    pool = createMultiContextTestPools(urls)["customer-feedback"];
  });

  beforeEach(async () => {
    await resetMultiContextTestSchemas({ "customer-feedback": pool });
    await bootstrapContextDatabase(customerFeedbackModule, pool);
  });
  afterAll(async () => closeMultiContextTestPools({ "customer-feedback": pool }));

  it("executes the production query after a joined priority collision and preserves queue ordering", async () => {
    await insertCase(pool, "case_urgent", "normal", "2026-07-14T11:00:00.000Z");
    await insertCase(pool, "case_sla_high", "high", "2026-07-14T07:00:00.000Z");
    await insertCase(pool, "case_normal_a", "urgent", "2026-07-14T11:00:00.000Z");
    await insertCase(pool, "case_normal_b", "low", "2026-07-14T11:00:00.000Z");
    await insertCase(pool, "case_fallback", "urgent", "2026-07-14T11:00:00.000Z");

    await insertAttention(pool, "attention_urgent", "case_urgent", "urgent", "2026-07-14T13:00:00.000Z");
    await insertAttention(pool, "attention_normal_a", "case_normal_a", "normal", "2026-07-14T13:00:00.000Z");
    await insertAttention(pool, "attention_normal_b", "case_normal_b", "normal", "2026-07-14T13:00:00.000Z");
    await insertAttention(pool, "attention_fallback", "case_fallback", "low", null);

    await expect(preFixJoinedOrderBy(pool)).rejects.toMatchObject({ code: "42702" });

    await expect(listFeedbackAttention(pool, { now: "2026-07-14T12:00:00.000Z" })).resolves.toMatchObject([
      { attentionId: "attention_urgent", priority: "urgent" },
      { attentionId: "sla:case_sla_high", priority: "high" },
      { attentionId: "attention_normal_a", priority: "normal" },
      { attentionId: "attention_normal_b", priority: "normal" },
      { attentionId: "attention_fallback", priority: "low" },
    ]);
  });
});

async function insertCase(pool: PgTransactionalPool, caseId: string, priority: string, openedAt: string) {
  await pool.query(
    `INSERT INTO customer_feedback_feedback_cases (
       case_id, stream_id, invitation_id, survey_kind, survey_version, question_version, rating,
       submission_idempotency_key, submitted_at, open_reason, status, priority, consent_status,
       consent_version, follow_up_status, opened_at
     ) VALUES ($1, $2, $3, 'transactional-csat', 'v1', 'v1', 1, $4, $5, 'low-score', 'new', $6,
       'not-granted', 'v1', 'not-requested', $5)`,
    [caseId, `stream_${caseId}`, `invitation_${caseId}`, `submission_${caseId}`, openedAt, priority],
  );
}

async function insertAttention(
  pool: PgTransactionalPool,
  attentionId: string,
  caseId: string,
  priority: string,
  dueAt: string | null,
) {
  await pool.query(
    `INSERT INTO customer_feedback_case_attention (
       attention_id, case_id, state, reason, rule_version, rating, priority, opened_at, due_at, triage_due_at
     ) VALUES ($1, $2, 'active', 'low-score', 'low-score-v1', 1, $3, '2026-07-14T11:00:00.000Z', $4,
       '2026-07-14T12:00:00.000Z')`,
    [attentionId, caseId, priority, dueAt],
  );
}

function preFixJoinedOrderBy(pool: PgTransactionalPool) {
  return pool.query(`WITH attention_queue AS (
    SELECT attention_id AS "attentionId", case_id AS "caseId", priority, due_at AS "dueAt",
           triage_due_at AS "triageDueAt"
    FROM customer_feedback_case_attention
    WHERE state = 'active'
  )
  SELECT attention_queue.*
  FROM attention_queue
  JOIN customer_feedback_feedback_cases AS cases ON cases.case_id = attention_queue."caseId"
  ORDER BY CASE priority WHEN 'urgent' THEN 4 WHEN 'high' THEN 3 WHEN 'normal' THEN 2 ELSE 1 END DESC,
           COALESCE("dueAt", "triageDueAt"), "attentionId"`);
}
