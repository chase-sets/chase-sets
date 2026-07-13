import type { AuthenticatedApiEnv } from "@chase-sets/auth-context";
import { t } from "@chase-sets/localization";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { Hono } from "hono";
import { canAccessFeedbackAttention } from "./access";
import { listFeedbackAttention } from "../read-model/queries";

export type CustomerFeedbackApiEnv = AuthenticatedApiEnv;

export function buildCustomerFeedbackAttentionApi(db: PgQueryable) {
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
  return app;
}

async function readMetrics(db: PgQueryable) {
  const result = await db.query<
    Readonly<{
      active_count: string;
      overdue_count: string;
      median_triage_ms: number | null;
      delivery_failures: string;
    }>
  >(
    `SELECT COUNT(*) FILTER (WHERE attention.state = 'active')::text AS active_count,
            COUNT(*) FILTER (WHERE attention.state = 'active' AND (attention.due_at < now() OR attention.triage_due_at < now()))::text AS overdue_count,
            percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (attention.triaged_at - attention.opened_at)) * 1000)
              FILTER (WHERE attention.triaged_at IS NOT NULL) AS median_triage_ms,
            COUNT(*) FILTER (WHERE cases.follow_up_delivery_status IN ('failed', 'suppressed', 'retry-exhausted', 'no-recipient'))::text AS delivery_failures
     FROM customer_feedback_case_attention AS attention
     LEFT JOIN customer_feedback_feedback_cases AS cases ON cases.case_id = attention.case_id`,
  );
  const row = result.rows[0];
  return {
    activeCount: Number(row?.active_count ?? 0),
    overdueCount: Number(row?.overdue_count ?? 0),
    medianTimeToTriageMs: row?.median_triage_ms ?? null,
    deliveryFailures: Number(row?.delivery_failures ?? 0),
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
