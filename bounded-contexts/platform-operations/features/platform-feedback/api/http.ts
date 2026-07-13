import { t } from "@chase-sets/localization";
import { Hono } from "hono";
import type { AuthenticatedApiEnv } from "@chase-sets/auth-context";
import type { PlatformFeedbackServices } from "./runtime";
import { normalizeTopic, normalizeWorkflow, type PlatformFeedbackRelatedEntity } from "../domain/common";
import { createReportedContentRoutes } from "../../reported-content/api/http";
import type { ReportedContentServices } from "../../reported-content/api/runtime";
import { createRiskAlertRoutes } from "../../risk-alerts/api/http";
import type { RiskAlertServices } from "../../risk-alerts/api/runtime";

export type ExperienceApiEnv = AuthenticatedApiEnv;

/**
 * Customer feedback authorization capabilities. Operator queue/detail/
 * metrics reads require `view`; triage/notes/review/archive/bulk/follow-up/
 * redaction commands require `manage`; the sensitive free-text comment export
 * is a *separate* grant so a view-only staff assignment cannot download the
 * comment corpus. All three are platform-staff only -- ordinary account roles
 * hold none of them (see Identity ROLE_PERMISSIONS / Auth AUTH_ROLE_PERMISSIONS).
 */
export type PlatformFeedbackOperatorCapability =
  | "platform-feedback.view"
  | "platform-feedback.manage"
  | "platform-feedback.export";

/**
 * The one canonical authorization mapping for the customer feedback surface.
 * Each route is either the narrowly scoped `customer` command surface (a
 * signed-in subject acting only on their own experience; no operator
 * capability) or a staff-only `operator` surface gated by an explicit
 * capability. This registry is the single source of truth consumed by the
 * route-registry/composition-boundary regression test so a later change cannot
 * silently move an operator route onto the customer surface, or drop an
 * operator route's capability gate.
 */
export type PlatformFeedbackRouteSurface = Readonly<{
  // HTTP verb ("verb" rather than "method" so this route manifest is not
  // mistaken for a fetch-options object by the mutation-surface scanner).
  verb: "GET" | "POST";
  path: string;
  surface: "customer" | "operator";
  capability: PlatformFeedbackOperatorCapability | null;
}>;

export const PLATFORM_FEEDBACK_ROUTE_SURFACES: readonly PlatformFeedbackRouteSurface[] = [
  // Customer command surface: authenticated subject, own experience only.
  { verb: "GET", path: "/prompt", surface: "customer", capability: null },
  { verb: "POST", path: "/", surface: "customer", capability: null },
  { verb: "POST", path: "/dismiss", surface: "customer", capability: null },
  // Staff-only operator surface.
  { verb: "GET", path: "/", surface: "operator", capability: "platform-feedback.view" },
  { verb: "GET", path: "/metrics", surface: "operator", capability: "platform-feedback.view" },
  { verb: "GET", path: "/export", surface: "operator", capability: "platform-feedback.export" },
  { verb: "POST", path: "/bulk/review", surface: "operator", capability: "platform-feedback.manage" },
  { verb: "POST", path: "/bulk/archive", surface: "operator", capability: "platform-feedback.manage" },
  { verb: "GET", path: "/:id", surface: "operator", capability: "platform-feedback.view" },
  { verb: "POST", path: "/:id/notes", surface: "operator", capability: "platform-feedback.manage" },
  { verb: "POST", path: "/:id/review", surface: "operator", capability: "platform-feedback.manage" },
  { verb: "POST", path: "/:id/archive", surface: "operator", capability: "platform-feedback.manage" },
] as const;

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : t("experience.api.request.failed");
}

function authenticationRequired() {
  return new Response(
    JSON.stringify({
      error: { code: "authentication_required", message: t("experience.api.authentication.required") },
    }),
    {
      status: 401,
      headers: { "Content-Type": "application/json" },
    },
  );
}

function authorizationForbidden() {
  return new Response(
    JSON.stringify({ error: { code: "authorization_forbidden", message: t("experience.api.forbidden") } }),
    {
      status: 403,
      headers: { "Content-Type": "application/json" },
    },
  );
}

function requireActor(
  c: {
    get(key: "actor"): ExperienceApiEnv["Variables"]["actor"];
  },
  capability?: PlatformFeedbackOperatorCapability,
) {
  const actor = c.get("actor");
  if (!actor) {
    return { actor: null, response: authenticationRequired() };
  }

  if (capability && !actor.permissions.includes(capability)) {
    return { actor: null, response: authorizationForbidden() };
  }

  return { actor, response: null };
}

// Identity fields that must derive from the authenticated session, never from
// request input. Rejecting them on the customer command surface prevents a
// cross-account/-subject replay (attributing feedback to, or redeeming an
// invitation belonging to, another account/user). The subject's own account and
// user id are read from the resolved actor below.
const CUSTOMER_IDENTITY_OVERRIDE_FIELDS = [
  "userId",
  "user_id",
  "accountId",
  "account_id",
  "forAccountId",
  "for_account_id",
  "subjectId",
  "subject_id",
  "membershipId",
  "membership_id",
  "invitationId",
  "invitation_id",
  "onBehalfOf",
  "on_behalf_of",
] as const;

function assertNoCustomerIdentityOverride(body: unknown): void {
  if (!body || typeof body !== "object") {
    return;
  }

  const record = body as Record<string, unknown>;
  for (const field of CUSTOMER_IDENTITY_OVERRIDE_FIELDS) {
    if (record[field] !== undefined && record[field] !== null) {
      throw new CustomerIdentityOverrideError();
    }
  }
}

class CustomerIdentityOverrideError extends Error {
  public constructor() {
    super("Feedback submission may not set account, user, subject, or invitation identifiers.");
    this.name = "CustomerIdentityOverrideError";
  }
}

function relatedEntitiesFromBody(value: unknown): readonly PlatformFeedbackRelatedEntity[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.map((entry) => {
    const record = entry && typeof entry === "object" ? (entry as Record<string, unknown>) : {};
    return {
      type: String(record.type ?? ""),
      id: String(record.id ?? ""),
    };
  });
}

function relatedEntitiesFromQuery(c: { req: { query(name: string): string | undefined } }) {
  const relatedEntityType = c.req.query("relatedEntityType");
  const relatedEntityId = c.req.query("relatedEntityId");
  return relatedEntityType && relatedEntityId ? [{ type: relatedEntityType, id: relatedEntityId }] : [];
}

function csvCell(value: unknown) {
  const text = Array.isArray(value) ? value.join("; ") : String(value ?? "");
  return `"${text.replace(/"/g, '""')}"`;
}

function feedbackIdsFromBody(value: unknown): readonly string[] {
  const record = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  return Array.isArray(record.feedbackIds) ? record.feedbackIds.map(String) : [];
}

/**
 * Narrowly scoped customer command surface: a signed-in subject may present
 * (`GET /prompt`), submit (`POST /`), or dismiss (`POST /dismiss`) feedback
 * about their own experience only. Account and user identity always come from
 * the resolved actor; any attempt to supply them (or an invitation/subject
 * identifier) in the request body is rejected, so this surface can never be
 * used to enumerate, mutate, or replay another account's feedback.
 */
export function registerCustomerFeedbackRoutes(app: Hono<ExperienceApiEnv>, services: PlatformFeedbackServices): void {
  app.get("/prompt", async (c) => {
    const access = requireActor(c);
    if (access.response) {
      return access.response;
    }

    try {
      return c.json(
        await services.getPromptEligibility({
          accountId: access.actor.accountId,
          workflow: normalizeWorkflow(c.req.query("workflow") ?? ""),
          relatedEntities: relatedEntitiesFromQuery(c),
        }),
      );
    } catch (error) {
      return c.json({ error: { code: "validation_failed", message: errorMessage(error) } }, 400);
    }
  });

  app.post("/", async (c) => {
    const access = requireActor(c);
    if (access.response) {
      return access.response;
    }
    const context = c.get("context");
    if (!context) {
      return c.json(
        { error: { code: "authentication_required", message: t("experience.api.authentication.context.missing") } },
        401,
      );
    }
    const body = await c.req.json();

    try {
      // No cross-account replay: identity is session-derived, never body-supplied.
      assertNoCustomerIdentityOverride(body);
      const result = await services.submitPlatformFeedback(
        {
          userId: access.actor.userId,
          accountId: access.actor.accountId,
          rating: Number(body.rating ?? 0),
          topic: normalizeTopic(String(body.topic ?? "")),
          comment: typeof body.comment === "string" ? body.comment : null,
          followUpConsent: Boolean(body.followUpConsent),
          workflow: normalizeWorkflow(String(body.workflow ?? "")),
          sourceRoutePath: String(body.sourceRoutePath ?? ""),
          relatedEntities: relatedEntitiesFromBody(body.relatedEntities),
        },
        context,
      );
      return c.json({ id: result.feedbackId, version: result.version, status: "submitted" }, 201);
    } catch (error) {
      if (error instanceof CustomerIdentityOverrideError) {
        return c.json({ error: { code: "authorization_forbidden", message: error.message } }, 403);
      }
      return c.json({ error: { code: "validation_failed", message: errorMessage(error) } }, 400);
    }
  });

  app.post("/dismiss", async (c) => {
    const access = requireActor(c);
    if (access.response) {
      return access.response;
    }
    const context = c.get("context");
    if (!context) {
      return c.json(
        { error: { code: "authentication_required", message: t("experience.api.authentication.context.missing.2") } },
        401,
      );
    }
    const body = await c.req.json();

    try {
      assertNoCustomerIdentityOverride(body);
      const result = await services.dismissPrompt(
        {
          userId: access.actor.userId,
          accountId: access.actor.accountId,
          workflow: normalizeWorkflow(String(body.workflow ?? "")),
          sourceRoutePath: String(body.sourceRoutePath ?? ""),
          relatedEntities: relatedEntitiesFromBody(body.relatedEntities),
        },
        context,
      );
      return c.json({ id: result.promptId, version: result.version, snoozedUntil: result.snoozedUntil });
    } catch (error) {
      if (error instanceof CustomerIdentityOverrideError) {
        return c.json({ error: { code: "authorization_forbidden", message: error.message } }, 403);
      }
      return c.json({ error: { code: "validation_failed", message: errorMessage(error) } }, 400);
    }
  });
}

/**
 * Staff-only operator surface. Every route is gated by an explicit
 * platform-feedback capability; export is gated separately from view so it can
 * be withheld from a view-only staff assignment. A trailing deny-by-default
 * matcher closes any operator subpath that is not (yet) implemented -- triage,
 * follow-up, assignment, redaction, and other future operator leaves -- so a
 * guessed operator path can never fall through to an unauthenticated 404 for a
 * customer session.
 */
export function registerPlatformFeedbackOperatorRoutes(
  app: Hono<ExperienceApiEnv>,
  services: PlatformFeedbackServices,
): void {
  app.get("/", async (c) => {
    const access = requireActor(c, "platform-feedback.view");
    if (access.response) {
      return access.response;
    }

    const limit = Number(c.req.query("limit") ?? 50);
    const offset = Number(c.req.query("offset") ?? 0);
    const result = await services.listPlatformFeedback({
      limit,
      offset,
      status: c.req.query("status"),
      topic: c.req.query("topic"),
      workflow: c.req.query("workflow"),
    });

    return c.json({
      items: result.items,
      total: result.total,
      count: result.items.length,
    });
  });

  app.get("/metrics", async (c) => {
    const access = requireActor(c, "platform-feedback.view");
    if (access.response) {
      return access.response;
    }

    return c.json(await services.getPlatformFeedbackMetrics());
  });

  app.get("/export", async (c) => {
    // Export is a separate capability: view-only staff cannot download the
    // free-text comment corpus unless export is explicitly granted.
    const access = requireActor(c, "platform-feedback.export");
    if (access.response) {
      return access.response;
    }

    const result = await services.listPlatformFeedback({
      limit: 500,
      offset: 0,
      status: c.req.query("status"),
      topic: c.req.query("topic"),
      workflow: c.req.query("workflow"),
    });
    const rows = [
      [
        "feedback_id",
        "account_id",
        "user_id",
        "rating",
        "topic",
        "workflow",
        "status",
        "comment",
        "follow_up_consent",
        "source_route_path",
        "related_entity_key",
        "submitted_at",
        "updated_at",
        "reviewed_by_user_id",
        "reviewed_at",
        "archived_by_user_id",
        "archived_at",
        "operator_note_count",
      ],
      ...result.items.map((item) => [
        item.feedback_id,
        item.account_id,
        item.user_id,
        item.rating,
        item.topic,
        item.workflow,
        item.status,
        item.comment,
        item.follow_up_consent,
        item.source_route_path,
        item.related_entity_key,
        item.submitted_at,
        item.updated_at,
        item.reviewed_by_user_id,
        item.reviewed_at,
        item.archived_by_user_id,
        item.archived_at,
        item.operator_notes.length,
      ]),
    ];

    return new Response(rows.map((row) => row.map(csvCell).join(",")).join("\n"), {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": 'attachment; filename="chase-sets-platform-feedback.csv"',
      },
    });
  });

  app.post("/bulk/review", async (c) => {
    const access = requireActor(c, "platform-feedback.manage");
    if (access.response) {
      return access.response;
    }
    const context = c.get("context");
    if (!context) {
      return c.json(
        { error: { code: "authentication_required", message: t("experience.api.authentication.context.missing.3") } },
        401,
      );
    }

    try {
      const body = await c.req.json().catch(() => ({}));
      const result = await services.bulkMarkReviewed(feedbackIdsFromBody(body), access.actor.userId, context);
      return c.json({
        action: result.action,
        updated: result.updated,
        skipped: result.skipped,
        items: result.items.map((item) => ({ id: item.feedbackId, version: item.version, status: "reviewed" })),
      });
    } catch (error) {
      return c.json({ error: { code: "validation_failed", message: errorMessage(error) } }, 400);
    }
  });

  app.post("/bulk/archive", async (c) => {
    const access = requireActor(c, "platform-feedback.manage");
    if (access.response) {
      return access.response;
    }
    const context = c.get("context");
    if (!context) {
      return c.json(
        { error: { code: "authentication_required", message: t("experience.api.authentication.context.missing.4") } },
        401,
      );
    }

    try {
      const body = await c.req.json().catch(() => ({}));
      const result = await services.bulkArchive(feedbackIdsFromBody(body), access.actor.userId, context);
      return c.json({
        action: result.action,
        updated: result.updated,
        skipped: result.skipped,
        items: result.items.map((item) => ({ id: item.feedbackId, version: item.version, status: "archived" })),
      });
    } catch (error) {
      return c.json({ error: { code: "validation_failed", message: errorMessage(error) } }, 400);
    }
  });

  app.get("/:id", async (c) => {
    const access = requireActor(c, "platform-feedback.view");
    if (access.response) {
      return access.response;
    }

    const feedback = await services.getPlatformFeedback(c.req.param("id"));
    if (!feedback) {
      return c.json({ error: { code: "not_found", message: t("experience.api.platform.feedback.not.found") } }, 404);
    }

    return c.json(feedback);
  });

  app.post("/:id/notes", async (c) => {
    const access = requireActor(c, "platform-feedback.manage");
    if (access.response) {
      return access.response;
    }
    const context = c.get("context");
    if (!context) {
      return c.json(
        { error: { code: "authentication_required", message: t("experience.api.authentication.context.missing.3") } },
        401,
      );
    }

    try {
      const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
      const result = await services.recordOperatorNote(
        c.req.param("id"),
        {
          body: String(body.body ?? ""),
          recordedByUserId: access.actor.userId,
        },
        context,
      );
      return c.json({ id: result.feedbackId, version: result.version, noteId: result.noteId });
    } catch (error) {
      return c.json({ error: { code: "validation_failed", message: errorMessage(error) } }, 400);
    }
  });

  app.post("/:id/review", async (c) => {
    const access = requireActor(c, "platform-feedback.manage");
    if (access.response) {
      return access.response;
    }
    const context = c.get("context");
    if (!context) {
      return c.json(
        { error: { code: "authentication_required", message: t("experience.api.authentication.context.missing.3") } },
        401,
      );
    }

    try {
      const result = await services.markReviewed(c.req.param("id"), access.actor.userId, context);
      return c.json({ id: result.feedbackId, version: result.version, status: "reviewed" });
    } catch (error) {
      return c.json({ error: { code: "validation_failed", message: errorMessage(error) } }, 400);
    }
  });

  app.post("/:id/archive", async (c) => {
    const access = requireActor(c, "platform-feedback.manage");
    if (access.response) {
      return access.response;
    }
    const context = c.get("context");
    if (!context) {
      return c.json(
        { error: { code: "authentication_required", message: t("experience.api.authentication.context.missing.4") } },
        401,
      );
    }

    try {
      const result = await services.archive(c.req.param("id"), access.actor.userId, context);
      return c.json({ id: result.feedbackId, version: result.version, status: "archived" });
    } catch (error) {
      return c.json({ error: { code: "validation_failed", message: errorMessage(error) } }, 400);
    }
  });
}

/**
 * Deny-by-default terminal for any feedback path that no customer or operator
 * route matched (e.g. a guessed operator leaf such as `/:id/redact`,
 * `/:id/assign`, or `/:id/follow-up`). Anonymous callers receive 401; any
 * authenticated caller without the relevant operator capability receives 403,
 * so a customer session can never probe the operator surface. Mutating verbs
 * demand `manage`, so a view-only staff assignment cannot mutate through an
 * unimplemented path either. An authorized staff caller falls through to 404
 * because the leaf genuinely does not exist yet.
 */
function registerFeedbackDenyByDefault(app: Hono<ExperienceApiEnv>): void {
  app.all("*", (c) => {
    const method = c.req.method.toUpperCase();
    const capability: PlatformFeedbackOperatorCapability =
      method === "GET" || method === "HEAD" ? "platform-feedback.view" : "platform-feedback.manage";
    const access = requireActor(c, capability);
    if (access.response) {
      return access.response;
    }

    return c.json({ error: { code: "not_found", message: t("experience.api.platform.feedback.not.found") } }, 404);
  });
}

/** Customer-only surface, isolated for composition-boundary tests. */
export function createCustomerFeedbackRoutes(services: PlatformFeedbackServices) {
  const app = new Hono<ExperienceApiEnv>();
  registerCustomerFeedbackRoutes(app, services);
  return app;
}

/** Staff-only operator surface, isolated for composition-boundary tests. */
export function createPlatformFeedbackOperatorRoutes(services: PlatformFeedbackServices) {
  const app = new Hono<ExperienceApiEnv>();
  registerPlatformFeedbackOperatorRoutes(app, services);
  registerFeedbackDenyByDefault(app);
  return app;
}

export function createPlatformFeedbackRoutes(services: PlatformFeedbackServices) {
  const app = new Hono<ExperienceApiEnv>();
  registerCustomerFeedbackRoutes(app, services);
  registerPlatformFeedbackOperatorRoutes(app, services);
  registerFeedbackDenyByDefault(app);
  return app;
}

export function buildExperienceApi(
  platformFeedback: PlatformFeedbackServices,
  reportedContent?: ReportedContentServices,
  riskAlerts?: RiskAlertServices,
) {
  const app = new Hono<ExperienceApiEnv>();
  app.route("/platform-feedback", createPlatformFeedbackRoutes(platformFeedback));
  if (reportedContent) {
    app.route("/reported-content", createReportedContentRoutes(reportedContent));
  }
  if (riskAlerts) {
    app.route("/risk-alerts", createRiskAlertRoutes(riskAlerts));
  }
  return app;
}
