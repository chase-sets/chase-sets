import { Hono } from "hono";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
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
import { buildCustomerFeedbackAttentionApi, type CustomerFeedbackApiEnv } from "../api/route";
import { listFeedbackAttention, type FeedbackAttentionQueueItem } from "./queries";

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
  afterEach(() => {
    vi.useRealTimers();
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

  it("returns API-owned SLA state for the attention lifecycle and deadline boundaries", async () => {
    for (const fixture of lifecycleFixtures) {
      await insertCase(
        pool,
        `case_${fixture.attentionId}`,
        fixture.priority,
        fixture.openedAt,
        fixture.closedAt ? "closed" : "new",
      );
      await insertLifecycleAttention(pool, fixture);
    }
    await insertCase(pool, "case_derived", "urgent", "2026-07-14T10:30:00.250Z");
    const { app, calls } = recordingAttentionApp(pool);

    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(readNow));
    const all = await readAttention(app, "/attention");
    const overdueOnly = await readAttention(app, "/attention?overdueOnly=true");
    vi.useRealTimers();

    const slaById = Object.fromEntries(all.items.map((item) => [item.attentionId, item.sla]));
    expect(Object.fromEntries(all.items.map((item) => [item.attentionId, item.sla.breach]))).toEqual({
      "untriaged-past-triage": "triage",
      "triaged-past-due": "due",
      "within-both-deadlines": null,
      "fallback-untriaged": null,
      "fallback-triaged": null,
      "triage-boundary-exact": null,
      "triage-boundary-plus-1ms": "triage",
      "due-boundary-exact": null,
      "due-boundary-plus-1ms": "due",
      reprioritized: "triage",
      "sla:case_derived": "triage",
    });
    expect(slaById["triage-boundary-exact"]).toMatchObject({ triageDueAt: "2026-07-14T12:00:00.250Z", overdue: false });
    expect(slaById["triage-boundary-plus-1ms"]).toMatchObject({
      triageDueAt: "2026-07-14T12:00:00.249Z",
      overdue: true,
    });
    expect(slaById["due-boundary-plus-1ms"]).toMatchObject({
      effectiveDueAt: "2026-07-14T12:00:00.249Z",
      overdue: true,
    });
    expect(slaById["fallback-triaged"]).toEqual({
      triageDueAt: "2026-07-15T11:00:00.250Z",
      effectiveDueAt: null,
      timeToTriageMs: 600_000,
      breach: null,
      overdue: false,
    });
    const reprioritized = all.items.find((item) => item.attentionId === "reprioritized");
    expect(reprioritized?.triageDueAt).toBe("2026-07-16T09:00:00.250Z");
    expect(reprioritized?.sla).toMatchObject({ triageDueAt: "2026-07-14T10:00:00.250Z", overdue: true });

    const overdueIds = all.items.filter((item) => item.sla.overdue).map((item) => item.attentionId);
    expect(overdueOnly.items.map((item) => item.attentionId).sort()).toEqual([...overdueIds].sort());
    // Metrics count the stored attention rows, as before; derived "sla:" rows are queue-only.
    const storedOverdue = all.items.filter((item) => item.sla.overdue && !item.attentionId.startsWith("sla:"));
    expect(all.metrics.overdueCount).toBe(storedOverdue.length);
    expect(all.metrics.overdueCount).toBe(5);
    expect(Number(all.metrics.oldestOverdueMs)).toBe(Math.max(...storedOverdue.map(overdueAgeMs)));
    expect(Number(all.metrics.oldestOverdueMs)).toBe(7_200_000);
    expect(overdueOnly.metrics).toEqual(all.metrics);

    expect(calls).toHaveLength(4);
    for (const call of calls) {
      expect(call.text).not.toMatch(/now\(\)/i);
      expect(call.values?.[0]).toBe(readNow);
    }
    expect([calls[1]?.values, calls[3]?.values]).toEqual([[readNow], [readNow]]);
  });
});

const readNow = "2026-07-14T12:00:00.250Z";

type LifecycleFixture = Readonly<{
  attentionId: string;
  priority: string;
  openedAt: string;
  triagedAt?: string;
  dueAt?: string;
  triageDueAt: string;
  closedAt?: string;
}>;

const lifecycleFixtures: readonly LifecycleFixture[] = [
  {
    attentionId: "untriaged-past-triage",
    priority: "urgent",
    openedAt: "2026-07-14T10:00:00.250Z",
    triageDueAt: "2026-07-14T11:00:00.250Z",
  },
  {
    attentionId: "triaged-past-due",
    priority: "normal",
    openedAt: "2026-07-14T08:00:00.250Z",
    triagedAt: "2026-07-14T08:30:00.250Z",
    dueAt: "2026-07-14T11:00:00.250Z",
    triageDueAt: "2026-07-15T08:00:00.250Z",
  },
  {
    attentionId: "closed",
    priority: "urgent",
    openedAt: "2026-07-14T10:00:00.250Z",
    triageDueAt: "2026-07-14T11:00:00.250Z",
    closedAt: "2026-07-14T11:30:00.250Z",
  },
  {
    attentionId: "within-both-deadlines",
    priority: "high",
    openedAt: "2026-07-14T11:00:00.250Z",
    dueAt: "2026-07-15T12:00:00.250Z",
    triageDueAt: "2026-07-14T15:00:00.250Z",
  },
  {
    attentionId: "fallback-untriaged",
    priority: "low",
    openedAt: "2026-07-14T11:00:00.250Z",
    triageDueAt: "2026-07-16T11:00:00.250Z",
  },
  {
    attentionId: "fallback-triaged",
    priority: "normal",
    openedAt: "2026-07-14T11:00:00.250Z",
    triagedAt: "2026-07-14T11:10:00.250Z",
    triageDueAt: "2026-07-15T11:00:00.250Z",
  },
  {
    attentionId: "triage-boundary-exact",
    priority: "urgent",
    openedAt: "2026-07-14T11:00:00.250Z",
    triageDueAt: "2026-07-14T12:00:00.250Z",
  },
  {
    attentionId: "triage-boundary-plus-1ms",
    priority: "urgent",
    openedAt: "2026-07-14T11:00:00.249Z",
    triageDueAt: "2026-07-14T12:00:00.249Z",
  },
  {
    attentionId: "due-boundary-exact",
    priority: "urgent",
    openedAt: "2026-07-14T09:00:00.250Z",
    triagedAt: "2026-07-14T09:05:00.250Z",
    dueAt: "2026-07-14T12:00:00.250Z",
    triageDueAt: "2026-07-14T10:00:00.250Z",
  },
  {
    attentionId: "due-boundary-plus-1ms",
    priority: "urgent",
    openedAt: "2026-07-14T09:00:00.250Z",
    triagedAt: "2026-07-14T09:05:00.250Z",
    dueAt: "2026-07-14T12:00:00.249Z",
    triageDueAt: "2026-07-14T10:00:00.250Z",
  },
  // Raised from low to urgent after the attention row was stored: the stored deadline still reflects low.
  {
    attentionId: "reprioritized",
    priority: "urgent",
    openedAt: "2026-07-14T09:00:00.250Z",
    triageDueAt: "2026-07-16T09:00:00.250Z",
  },
];

type AttentionResponse = Readonly<{
  items: readonly FeedbackAttentionQueueItem[];
  metrics: Readonly<{ overdueCount: number; oldestOverdueMs: number | string | null }>;
}>;

function recordingAttentionApp(pool: PgTransactionalPool) {
  const calls: { text: string; values: readonly unknown[] | undefined }[] = [];
  const db = {
    query: (text: string, values?: readonly unknown[]) => {
      calls.push({ text, values });
      return pool.query(text, values);
    },
  };
  const app = new Hono<CustomerFeedbackApiEnv>();
  app.use("*", async (c, next) => {
    c.set("actor", {
      sessionId: "ses_1",
      tenantId: "tnt_test",
      userId: "usr_operator",
      accountId: "acc_platform",
      membershipId: "mem_1",
      roleKey: "support",
      permissions: ["support.view"],
    } as never);
    await next();
  });
  app.route("/", buildCustomerFeedbackAttentionApi({ db, cases: {}, invitations: {} } as never));
  return { app, calls };
}

async function readAttention(app: Hono<CustomerFeedbackApiEnv>, path: string): Promise<AttentionResponse> {
  const response = await app.request(path);
  expect(response.status).toBe(200);
  return (await response.json()) as AttentionResponse;
}

function overdueAgeMs(item: FeedbackAttentionQueueItem): number {
  const deadline =
    item.dueAt !== null && Date.parse(item.dueAt) < Date.parse(readNow) ? item.dueAt : item.sla.triageDueAt;
  return Date.parse(readNow) - Date.parse(deadline);
}

async function insertCase(
  pool: PgTransactionalPool,
  caseId: string,
  priority: string,
  openedAt: string,
  status: "new" | "closed" = "new",
) {
  await pool.query(
    `INSERT INTO customer_feedback_feedback_cases (
       case_id, stream_id, invitation_id, survey_kind, survey_version, question_version, rating,
       submission_idempotency_key, submitted_at, open_reason, status, priority, consent_status,
       consent_version, follow_up_status, opened_at
     ) VALUES ($1, $2, $3, 'transactional-csat', 'v1', 'v1', 1, $4, $5, 'low-score', $7, $6,
       'not-granted', 'v1', 'not-requested', $5)`,
    [caseId, `stream_${caseId}`, `invitation_${caseId}`, `submission_${caseId}`, openedAt, priority, status],
  );
}

async function insertLifecycleAttention(pool: PgTransactionalPool, fixture: LifecycleFixture) {
  await pool.query(
    `INSERT INTO customer_feedback_case_attention (
       attention_id, case_id, state, reason, rule_version, rating, priority, opened_at, triaged_at, due_at,
       triage_due_at, closed_at
     ) VALUES ($1, $2, $3, 'low-score', 'low-score-v1', 1, $4, $5, $6, $7, $8, $9)`,
    [
      fixture.attentionId,
      `case_${fixture.attentionId}`,
      fixture.closedAt ? "resolved" : "active",
      fixture.priority,
      fixture.openedAt,
      fixture.triagedAt ?? null,
      fixture.dueAt ?? null,
      fixture.triageDueAt,
      fixture.closedAt ?? null,
    ],
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
