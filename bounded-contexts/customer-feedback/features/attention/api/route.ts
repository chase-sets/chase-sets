import type { AuthenticatedApiEnv } from "@chase-sets/auth-context";
import { parseTypedIdBoundary, TypedIdBoundaryDomainError } from "@chase-sets/http/typed-id";
import { t } from "@chase-sets/localization";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { Hono } from "hono";
import type { createFeedbackCaseRuntime } from "../../cases/api/runtime";
import { FeedbackCaseDecisionError } from "../../cases/domain";
import { canAccessFeedbackAttention } from "./access";
import { listFeedbackAttention } from "../read-model/queries";

export type CustomerFeedbackApiEnv = AuthenticatedApiEnv;

type FeedbackAttentionApiServices = Readonly<{
  db: PgQueryable;
  cases: Pick<ReturnType<typeof createFeedbackCaseRuntime>, "executeByCaseId">;
}>;

export function buildCustomerFeedbackAttentionApi(services: FeedbackAttentionApiServices) {
  const db = services.db;
  const app = new Hono<CustomerFeedbackApiEnv>();
  app.get("/attention", async (c) => {
    const actor = c.get("actor");
    if (!canAccessFeedbackAttention(actor, "view")) return accessResponse(c, actor ? 403 : 401);
    const url = new URL(c.req.url);
    const items = await listFeedbackAttention(db, {
      limit: Number(url.searchParams.get("limit") ?? 100),
      ownerId: url.searchParams.get("ownerId") ?? undefined,
      overdueOnly: url.searchParams.get("overdueOnly") === "true",
    });
    return c.json({ items, metrics: await readMetrics(db) });
  });

  app.get("/attention/export", async (c) => {
    const actor = c.get("actor");
    if (!canAccessFeedbackAttention(actor, "export")) return accessResponse(c, actor ? 403 : 401);
    const items = await listFeedbackAttention(db, { limit: 500 });
    return c.json({ items }, 200, { "Content-Disposition": "attachment; filename=customer-feedback-attention.json" });
  });
  app.post("/cases/:caseId/follow-up", async (c) => {
    const actor = c.get("actor");
    const context = c.get("context");
    if (!actor || !context) return accessResponse(c, 401);
    if (!canAccessFeedbackAttention(actor, "notify")) return accessResponse(c, 403);
    const body = await c.req.json<{
      consentVersion?: string;
      channel?: "web" | "email" | "sms" | "rcs";
      templateVersion?: number;
    }>();
    try {
      const feedbackCase = await services.cases.executeByCaseId(
        parseTypedIdBoundary(c.req.param("caseId"), "fbcase", "caseId"),
        {
          type: "RequestFeedbackCaseFollowUp",
          consentVersion: body.consentVersion ?? "",
          channel: body.channel ?? "web",
          templateVersion: body.templateVersion ?? 1,
          actor: {
            actorId: actor.userId,
            authority: actor.permissions.includes("support.manage") ? "manage-feedback-cases" : "notify-feedback-cases",
          },
          actedAt: new Date().toISOString(),
        },
        context,
      );
      return c.json(caseCommandSnapshot(feedbackCase), 200);
    } catch (error) {
      return caseCommandError(c, error);
    }
  });
  app.post("/cases/:caseId/reopen", async (c) => {
    const actor = c.get("actor");
    const context = c.get("context");
    if (!actor || !context) return accessResponse(c, 401);
    if (!canAccessFeedbackAttention(actor, "manage")) return accessResponse(c, 403);
    try {
      const feedbackCase = await services.cases.executeByCaseId(
        parseTypedIdBoundary(c.req.param("caseId"), "fbcase", "caseId"),
        {
          type: "ReopenFeedbackCase",
          actor: { actorId: actor.userId, authority: "manage-feedback-cases" },
          actedAt: new Date().toISOString(),
        },
        context,
      );
      return c.json(caseCommandSnapshot(feedbackCase), 200);
    } catch (error) {
      return caseCommandError(c, error);
    }
  });
  return app;
}

function caseCommandSnapshot(
  feedbackCase: Awaited<ReturnType<FeedbackAttentionApiServices["cases"]["executeByCaseId"]>>,
) {
  return {
    caseId: feedbackCase.caseId,
    status: feedbackCase.status,
    priority: feedbackCase.priority,
    ownerId: feedbackCase.ownerId,
    dueAt: feedbackCase.dueAt,
    followUpStatus: feedbackCase.followUpStatus,
    followUpDeliveryStatus: feedbackCase.followUpDeliveryStatus,
  };
}

function caseCommandError(
  c: { json: (body: unknown, status: 400 | 403 | 404 | 409 | 422) => Response },
  error: unknown,
) {
  if (error instanceof TypedIdBoundaryDomainError) return c.json(error.body, error.status);
  if (!(error instanceof FeedbackCaseDecisionError)) throw error;
  const status =
    error.code === "forbidden"
      ? 403
      : error.code === "case-not-found"
        ? 404
        : error.code === "invalid-field"
          ? 422
          : 409;
  return c.json({ error: { code: error.code, message: error.message } }, status);
}

async function readMetrics(db: PgQueryable) {
  const result = await db.query<
    Readonly<{
      active_count: string;
      overdue_count: string;
      median_triage_ms: number | null;
      median_close_ms: number | null;
      oldest_overdue_ms: number | null;
      delivery_successes: string;
      delivery_failures: string;
      digest_pending: string;
      digest_failures: string;
      latest_digest_at: string | null;
    }>
  >(
    `WITH attention_metrics AS (
       SELECT COUNT(*) FILTER (WHERE state = 'active')::text AS active_count,
              COUNT(*) FILTER (WHERE state = 'active' AND (due_at < now() OR (triaged_at IS NULL AND triage_due_at < now())))::text AS overdue_count,
              MAX(EXTRACT(EPOCH FROM (now() - CASE
                WHEN due_at < now() THEN due_at
                WHEN triaged_at IS NULL AND triage_due_at < now() THEN triage_due_at
              END)) * 1000)
                FILTER (WHERE state = 'active' AND (due_at < now() OR (triaged_at IS NULL AND triage_due_at < now()))) AS oldest_overdue_ms,
              COUNT(*) FILTER (WHERE delivery_status = 'sent')::text AS attention_delivery_successes,
              COUNT(*) FILTER (WHERE delivery_status IN ('failed', 'suppressed', 'retry-exhausted', 'no-recipient'))::text AS attention_delivery_failures
       FROM customer_feedback_case_attention
     ), case_metrics AS (
       SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (triaged_at - opened_at)) * 1000)
                FILTER (WHERE triaged_at IS NOT NULL) AS median_triage_ms,
              percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (closed_at - opened_at)) * 1000)
                FILTER (WHERE closed_at IS NOT NULL) AS median_close_ms,
              COUNT(*) FILTER (WHERE follow_up_delivery_status = 'sent')::text AS follow_up_delivery_successes,
              COUNT(*) FILTER (WHERE follow_up_delivery_status IN ('failed', 'suppressed', 'retry-exhausted', 'no-recipient'))::text AS follow_up_delivery_failures
       FROM customer_feedback_feedback_cases
     ), digest_metrics AS (
       SELECT COUNT(*) FILTER (WHERE status = 'pending')::text AS digest_pending,
              COUNT(*) FILTER (WHERE status IN ('failed', 'suppressed', 'retry-exhausted', 'no-recipient'))::text AS digest_failures,
              MAX(window_end)::text AS latest_digest_at
       FROM customer_feedback_attention_digest_runs
     )
     SELECT attention_metrics.active_count, attention_metrics.overdue_count,
            attention_metrics.oldest_overdue_ms, case_metrics.median_triage_ms, case_metrics.median_close_ms,
            (attention_metrics.attention_delivery_successes::bigint + case_metrics.follow_up_delivery_successes::bigint)::text AS delivery_successes,
            (attention_metrics.attention_delivery_failures::bigint + case_metrics.follow_up_delivery_failures::bigint)::text AS delivery_failures,
            digest_metrics.digest_pending, digest_metrics.digest_failures, digest_metrics.latest_digest_at
     FROM attention_metrics CROSS JOIN case_metrics CROSS JOIN digest_metrics`,
  );
  const row = result.rows[0];
  return {
    activeCount: Number(row?.active_count ?? 0),
    overdueCount: Number(row?.overdue_count ?? 0),
    medianTimeToTriageMs: row?.median_triage_ms ?? null,
    medianTimeToCloseMs: row?.median_close_ms ?? null,
    oldestOverdueMs: row?.oldest_overdue_ms ?? null,
    deliverySuccesses: Number(row?.delivery_successes ?? 0),
    deliveryFailures: Number(row?.delivery_failures ?? 0),
    digestPending: Number(row?.digest_pending ?? 0),
    digestFailures: Number(row?.digest_failures ?? 0),
    latestDigestAt: row?.latest_digest_at ?? null,
  };
}

function accessResponse(c: { json: (body: unknown, status: 401 | 403) => Response }, status: 401 | 403) {
  return c.json(
    {
      error: {
        code: status === 401 ? "authentication_required" : "authorization_forbidden",
        message:
          status === 401 ? t("customer-feedback.api.authentication.required") : t("customer-feedback.api.forbidden"),
      },
    },
    status,
  );
}
