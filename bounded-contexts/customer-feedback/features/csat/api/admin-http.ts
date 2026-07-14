import type { AuthenticatedApiEnv } from "@chase-sets/auth-context";
import { t } from "@chase-sets/localization";
import { Hono } from "hono";
import { transactionalCsatV1 } from "../domain/survey";
import type {
  CsatAdminExportAudit,
  CsatAdminQueueFilters,
  CsatAdminQueueQuery,
  CsatAnalyticsQuery,
} from "./analytics-contract";
import type { CsatAdminReadPort } from "./runtime";

type CustomerFeedbackApiEnv = AuthenticatedApiEnv;

function accessFor(c: { get(key: "actor"): CustomerFeedbackApiEnv["Variables"]["actor"] }, permission: string) {
  const actor = c.get("actor");
  if (!actor) return new Response(JSON.stringify({ error: { code: "authentication_required" } }), { status: 401 });
  if (!actor.permissions.includes(permission)) {
    return new Response(
      JSON.stringify({ error: { code: "authorization_forbidden", message: t("experience.api.forbidden") } }),
      {
        status: 403,
        headers: { "Content-Type": "application/json" },
      },
    );
  }
  return actor;
}

function listParam(value: string | undefined): string[] | undefined {
  const values = value
    ?.split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  return values && values.length > 0 ? values : undefined;
}

function filtersFromQuery(c: { req: { query(name: string): string | undefined } }): CsatAdminQueueFilters {
  const surveyVersion = c.req.query("surveyVersion");
  return {
    from: c.req.query("from") || undefined,
    to: c.req.query("to") || undefined,
    ...(surveyVersion
      ? {
          surveyVersion: {
            ...transactionalCsatV1.id,
            surveyVersion,
          },
        }
      : {}),
    outcomeCodes: listParam(c.req.query("outcomeCodes")) as CsatAdminQueueFilters["outcomeCodes"],
    customerRoles: listParam(c.req.query("customerRoles")) as CsatAdminQueueFilters["customerRoles"],
    states: listParam(c.req.query("states")),
    ratings: listParam(c.req.query("ratings"))
      ?.map(Number)
      .filter((value): value is 1 | 2 | 3 | 4 | 5 => value >= 1 && value <= 5),
    followUpConsent: c.req.query("followUpConsent") as CsatAdminQueueFilters["followUpConsent"],
  };
}

function analyticsQuery(
  c: { req: { query(name: string): string | undefined } },
  filters: CsatAdminQueueFilters,
): CsatAnalyticsQuery {
  const asOf = c.req.query("asOf") ?? new Date().toISOString();
  return {
    asOf,
    trendFrom: filters.from,
    trendTo: filters.to,
    surveyVersion: filters.surveyVersion,
    outcomeCodes: filters.outcomeCodes as CsatAnalyticsQuery["outcomeCodes"],
    customerRoles: filters.customerRoles as CsatAnalyticsQuery["customerRoles"],
    trendGranularity: c.req.query("granularity") === "week" ? "week" : "day",
  };
}

function queueQuery(
  c: { req: { query(name: string): string | undefined } },
  filters: CsatAdminQueueFilters,
): CsatAdminQueueQuery {
  return {
    ...filters,
    cursor: c.req.query("cursor") ?? null,
    direction: c.req.query("direction") === "previous" ? "previous" : "next",
    limit: Number(c.req.query("limit") ?? 50),
  };
}

function csvCell(value: unknown): string {
  const text = String(value ?? "");
  const safe = /^[=+\-@]/.test(text) ? `'${text}` : text;
  return `"${safe.replace(/"/g, '""')}"`;
}

export function buildCustomerFeedbackApi(port: CsatAdminReadPort) {
  const app = new Hono<CustomerFeedbackApiEnv>();

  app.get("/", async (c) => {
    const access = accessFor(c, "platform-feedback.view");
    if (access instanceof Response) return access;
    const filters = filtersFromQuery(c);
    const [analytics, queue] = await Promise.all([
      port.readAdminAnalytics(analyticsQuery(c, filters)),
      port.listAdminQueue(queueQuery(c, filters)),
    ]);
    return c.json({ analytics, queue, filters });
  });

  app.get("/export", (c) => {
    const access = accessFor(c, "platform-feedback.export");
    if (access instanceof Response) return access;
    const filters = filtersFromQuery(c);
    const startedAt = new Date().toISOString();
    const query = { ...filters, cursor: null, direction: "next" as const, limit: 100 };
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const encoder = new TextEncoder();
        let cursor: string | null = null;
        let rowCount = 0;
        try {
          controller.enqueue(
            encoder.encode(
              "\uFEFFinvitation_id,state,survey_version,question_version,outcome_code,customer_role,eligible_at,issued_at,presented_at,submitted_at,rating,follow_up_consent\n",
            ),
          );
          do {
            const page = await port.listAdminQueue({ ...query, cursor });
            for (const item of page.items) {
              controller.enqueue(
                encoder.encode(
                  [
                    item.invitationId,
                    item.state,
                    item.surveyVersion.surveyVersion,
                    item.surveyVersion.questionVersion,
                    item.outcomeCode,
                    item.customerRole,
                    item.eligibleAt,
                    item.issuedAt,
                    item.presentedAt,
                    item.submittedAt,
                    item.rating,
                    item.followUpConsent,
                  ]
                    .map(csvCell)
                    .join(",") + "\n",
                ),
              );
              rowCount += 1;
            }
            cursor = page.nextCursor;
          } while (cursor);
          await recordExport(port, access.userId, filters, startedAt, rowCount, "completed");
          controller.close();
        } catch (error) {
          await recordExport(port, access.userId, filters, startedAt, rowCount, "failed");
          controller.error(error);
        }
      },
    });
    return new Response(stream, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": 'attachment; filename="csat-feedback-export.csv"',
        "Cache-Control": "no-store",
      },
    });
  });

  return app;
}

async function recordExport(
  port: CsatAdminReadPort,
  actorId: string,
  filters: CsatAdminQueueFilters,
  startedAt: string,
  rowCount: number,
  result: CsatAdminExportAudit["result"],
) {
  await port.recordAdminExport({
    actorId,
    filters,
    startedAt,
    completedAt: new Date().toISOString(),
    rowCount,
    result,
  });
}
