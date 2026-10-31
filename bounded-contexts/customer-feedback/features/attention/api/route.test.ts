import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { feedbackOverdueSql } from "../read-model/queries";
import type { CustomerFeedbackApiEnv } from "./route";
import { buildCustomerFeedbackAttentionApi } from "./route";

const context = {
  tenantId: "tnt_test" as never,
  audit: { performedByUserId: "usr_operator" as never, forAccountId: "acc_platform" as never },
};

function buildApp(permissions: readonly string[] | null) {
  const executeByCaseId = vi.fn(async (_caseId, command: { type: string }) => ({
    caseId: "fbcase_01",
    status: command.type === "ReopenFeedbackCase" ? "triaged" : "actioned",
    priority: "high",
    ownerId: "usr_operator",
    dueAt: null,
    followUpStatus: command.type === "RequestFeedbackCaseFollowUp" ? "requested" : "not-requested",
    followUpDeliveryStatus: command.type === "RequestFeedbackCaseFollowUp" ? "pending" : "not-requested",
  }));
  const app = new Hono<CustomerFeedbackApiEnv>();
  app.use("*", async (c, next) => {
    c.set(
      "actor",
      permissions
        ? {
            sessionId: "ses_1",
            tenantId: "tnt_test",
            userId: "usr_operator",
            accountId: "acc_platform",
            membershipId: "mem_1",
            roleKey: "support",
            permissions,
          }
        : null,
    );
    c.set("context", permissions ? context : null);
    await next();
  });
  app.route("/", buildCustomerFeedbackAttentionApi({ db: { query: vi.fn() }, cases: { executeByCaseId } } as never));
  return { app, executeByCaseId };
}

describe("Customer Feedback attention API authorization", () => {
  it("rejects unauthenticated attention deep links before querying the read model", async () => {
    const { app } = buildApp(null);
    const response = await app.request("/attention");
    expect(response.status).toBe(401);
  });

  it("allows notify-only operators to request follow-up but not reopen cases", async () => {
    const { app, executeByCaseId } = buildApp(["support.notify"]);
    const followUp = await app.request("/cases/fbcase_01/follow-up", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ consentVersion: "feedback-follow-up-v1", channel: "web", templateVersion: 2 }),
    });
    expect(followUp.status).toBe(200);
    expect(executeByCaseId).toHaveBeenCalledWith(
      "fbcase_01",
      expect.objectContaining({
        type: "RequestFeedbackCaseFollowUp",
        actor: { actorId: "usr_operator", authority: "notify-feedback-cases" },
      }),
      context,
    );
    expect((await app.request("/cases/fbcase_01/reopen", { method: "POST" })).status).toBe(403);
  });

  it("allows managers to reopen and returns the committed snapshot", async () => {
    const { app } = buildApp(["support.manage"]);
    const response = await app.request("/cases/fbcase_01/reopen", { method: "POST" });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ caseId: "fbcase_01", status: "triaged" });
  });
});

const readNow = "2026-07-14T12:00:00.250Z";

function attentionRow(attentionId: string, fields: Readonly<Record<string, unknown>>) {
  return {
    attentionId,
    caseId: `fbcase_${attentionId}`,
    state: "active",
    reason: "low-score",
    ruleVersion: "low-score-v1",
    rating: 1,
    priority: "urgent",
    ownerId: null,
    triagedAt: null,
    dueAt: null,
    closedAt: null,
    deliveryStatus: "pending",
    deliveryReference: null,
    deliveryReportedAt: null,
    followUpDeliveryStatus: "not-requested",
    followUpChannel: null,
    ...fields,
  };
}

// node-postgres returns timestamptz columns as Date objects; every fixture timestamp keeps non-zero milliseconds.
const at = (iso: string) => new Date(iso);

const lifecycleRows = [
  attentionRow("untriaged-past-triage", {
    openedAt: at("2026-07-14T10:00:00.250Z"),
    triageDueAt: at("2026-07-14T11:00:00.250Z"),
  }),
  attentionRow("triaged-past-due", {
    priority: "normal",
    openedAt: at("2026-07-14T08:00:00.250Z"),
    triagedAt: at("2026-07-14T08:30:00.250Z"),
    dueAt: at("2026-07-14T11:00:00.250Z"),
    triageDueAt: at("2026-07-15T08:00:00.250Z"),
  }),
  attentionRow("closed", {
    openedAt: at("2026-07-14T10:00:00.250Z"),
    triageDueAt: at("2026-07-14T11:00:00.250Z"),
    closedAt: at("2026-07-14T11:30:00.250Z"),
  }),
  attentionRow("within-both-deadlines", {
    priority: "high",
    openedAt: at("2026-07-14T11:00:00.250Z"),
    dueAt: at("2026-07-15T12:00:00.250Z"),
    triageDueAt: at("2026-07-14T15:00:00.250Z"),
  }),
  attentionRow("fallback-untriaged", {
    priority: "low",
    openedAt: at("2026-07-14T11:00:00.250Z"),
    triageDueAt: at("2026-07-16T11:00:00.250Z"),
  }),
  attentionRow("fallback-triaged", {
    priority: "normal",
    openedAt: at("2026-07-14T11:00:00.250Z"),
    triagedAt: at("2026-07-14T11:10:00.250Z"),
    triageDueAt: at("2026-07-15T11:00:00.250Z"),
  }),
  attentionRow("triage-boundary-exact", {
    openedAt: at("2026-07-14T11:00:00.250Z"),
    triageDueAt: at("2026-07-14T12:00:00.250Z"),
  }),
  attentionRow("triage-boundary-plus-1ms", {
    openedAt: at("2026-07-14T11:00:00.249Z"),
    triageDueAt: at("2026-07-14T12:00:00.249Z"),
  }),
  attentionRow("due-boundary-exact", {
    openedAt: at("2026-07-14T09:00:00.250Z"),
    triagedAt: at("2026-07-14T09:05:00.250Z"),
    dueAt: at("2026-07-14T12:00:00.250Z"),
    triageDueAt: at("2026-07-14T10:00:00.250Z"),
  }),
  attentionRow("due-boundary-plus-1ms", {
    openedAt: at("2026-07-14T09:00:00.250Z"),
    triagedAt: at("2026-07-14T09:05:00.250Z"),
    dueAt: at("2026-07-14T12:00:00.249Z"),
    triageDueAt: at("2026-07-14T10:00:00.250Z"),
  }),
  // Raised from low to urgent after the attention row was stored: the stored deadline still reflects low.
  attentionRow("reprioritized", {
    openedAt: at("2026-07-14T09:00:00.250Z"),
    triageDueAt: at("2026-07-16T09:00:00.250Z"),
  }),
];

const expectedSla = {
  "untriaged-past-triage": {
    triageDueAt: "2026-07-14T11:00:00.250Z",
    effectiveDueAt: "2026-07-14T11:00:00.250Z",
    timeToTriageMs: null,
    breach: "triage",
    overdue: true,
  },
  "triaged-past-due": {
    triageDueAt: "2026-07-15T08:00:00.250Z",
    effectiveDueAt: "2026-07-14T11:00:00.250Z",
    timeToTriageMs: 1_800_000,
    breach: "due",
    overdue: true,
  },
  closed: {
    triageDueAt: "2026-07-14T11:00:00.250Z",
    effectiveDueAt: "2026-07-14T11:00:00.250Z",
    timeToTriageMs: null,
    breach: null,
    overdue: false,
  },
  "within-both-deadlines": {
    triageDueAt: "2026-07-14T15:00:00.250Z",
    effectiveDueAt: "2026-07-15T12:00:00.250Z",
    timeToTriageMs: null,
    breach: null,
    overdue: false,
  },
  "fallback-untriaged": {
    triageDueAt: "2026-07-16T11:00:00.250Z",
    effectiveDueAt: "2026-07-16T11:00:00.250Z",
    timeToTriageMs: null,
    breach: null,
    overdue: false,
  },
  "fallback-triaged": {
    triageDueAt: "2026-07-15T11:00:00.250Z",
    effectiveDueAt: null,
    timeToTriageMs: 600_000,
    breach: null,
    overdue: false,
  },
  "triage-boundary-exact": {
    triageDueAt: "2026-07-14T12:00:00.250Z",
    effectiveDueAt: "2026-07-14T12:00:00.250Z",
    timeToTriageMs: null,
    breach: null,
    overdue: false,
  },
  "triage-boundary-plus-1ms": {
    triageDueAt: "2026-07-14T12:00:00.249Z",
    effectiveDueAt: "2026-07-14T12:00:00.249Z",
    timeToTriageMs: null,
    breach: "triage",
    overdue: true,
  },
  "due-boundary-exact": {
    triageDueAt: "2026-07-14T10:00:00.250Z",
    effectiveDueAt: "2026-07-14T12:00:00.250Z",
    timeToTriageMs: 300_000,
    breach: null,
    overdue: false,
  },
  "due-boundary-plus-1ms": {
    triageDueAt: "2026-07-14T10:00:00.250Z",
    effectiveDueAt: "2026-07-14T12:00:00.249Z",
    timeToTriageMs: 300_000,
    breach: "due",
    overdue: true,
  },
  reprioritized: {
    triageDueAt: "2026-07-14T10:00:00.250Z",
    effectiveDueAt: "2026-07-14T10:00:00.250Z",
    timeToTriageMs: null,
    breach: "triage",
    overdue: true,
  },
};

const metricsRow = {
  active_count: "11",
  overdue_count: "5",
  median_triage_ms: null,
  median_close_ms: null,
  oldest_overdue_ms: 7_200_000,
  delivery_successes: "0",
  delivery_failures: "0",
  digest_pending: "0",
  digest_failures: "0",
  latest_digest_at: null,
};

async function readAttention(path: string, rows: readonly unknown[]) {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(readNow));
  // The clock moves on during the item read, so any second clock read for metrics would differ from readNow.
  const query = vi
    .fn()
    .mockImplementationOnce(async () => {
      vi.setSystemTime(Date.now() + 1);
      return { rows };
    })
    .mockResolvedValueOnce({ rows: [metricsRow] });
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
  app.route("/", buildCustomerFeedbackAttentionApi({ db: { query }, cases: {}, invitations: {} } as never));
  const response = await app.request(path);
  expect(response.status).toBe(200);
  const body = (await response.json()) as {
    items: { attentionId: string; triageDueAt: string; sla: unknown }[];
    metrics: Record<string, unknown>;
  };
  return { body, query };
}

describe("Customer Feedback attention API read", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("maps every attention row through the SLA helper at the one read instant bound into the item and metrics SQL", async () => {
    const { body, query } = await readAttention("/attention?overdueOnly=true&limit=50", [
      lifecycleRows[7],
      lifecycleRows[1],
    ]);

    expect(body.items).toEqual([
      expect.objectContaining({
        attentionId: "triage-boundary-plus-1ms",
        openedAt: "2026-07-14T11:00:00.249Z",
        triageDueAt: "2026-07-14T12:00:00.249Z",
        sla: expectedSla["triage-boundary-plus-1ms"],
      }),
      expect.objectContaining({ attentionId: "triaged-past-due", sla: expectedSla["triaged-past-due"] }),
    ]);
    expect(body.metrics).toMatchObject({ overdueCount: 5, oldestOverdueMs: 7_200_000 });

    expect(query).toHaveBeenCalledTimes(2);
    const [[itemsSql, itemsValues], [metricsSql, metricsValues]] = query.mock.calls as [string, unknown[]][];
    expect(itemsValues).toEqual([readNow, 50]);
    expect(metricsValues).toEqual([readNow]);
    expect(itemsSql).not.toMatch(/now\(\)/i);
    expect(metricsSql).not.toMatch(/now\(\)/i);
    const queueOverdue = feedbackOverdueSql(
      {
        openedAt: 'attention_queue."openedAt"',
        priority: "attention_queue.priority",
        triagedAt: 'attention_queue."triagedAt"',
        dueAt: 'attention_queue."dueAt"',
      },
      "$1::timestamptz",
    );
    const storedOverdue = feedbackOverdueSql(
      { openedAt: "opened_at", priority: "priority", triagedAt: "triaged_at", dueAt: "due_at" },
      "$1::timestamptz",
    );
    expect(itemsSql).toContain(`AND ${queueOverdue}`);
    expect(metricsSql).toContain(
      `COUNT(*) FILTER (WHERE state = 'active' AND ${storedOverdue})::text AS overdue_count`,
    );
    expect(metricsSql).toContain(`FILTER (WHERE state = 'active' AND ${storedOverdue}) AS oldest_overdue_ms`);
  });

  it("returns API-owned SLA state for the attention lifecycle and deadline boundaries", async () => {
    const { body } = await readAttention("/attention", lifecycleRows);

    expect(Object.fromEntries(body.items.map((item) => [item.attentionId, item.sla]))).toEqual(expectedSla);
    const reprioritized = body.items.find((item) => item.attentionId === "reprioritized");
    expect(reprioritized?.triageDueAt).toBe("2026-07-16T09:00:00.250Z");
  });
});
