import { t } from "@chase-sets/localization";
import { Hono } from "hono";
import type { PolicyRuntime } from "@chase-sets/platform-policy/runtime";
import type { SupportApiEnv } from "./http";
import { supportDeadlinePolicy, type SupportDeadlinePolicyValue } from "../domain/support-deadline-policy";

/**
 * Admin-managed create/revise/history routes for the support-flow deadline
 * policy, mounted on the shared platform-policy machinery (see
 * `../../../support/runtime-support/services.ts`). Mirrors the settlement
 * clearance-policy/payout-bounds-policy route shape -- Platform Operations
 * both owns this policy's schema/admin routes and is its only consumer, so
 * no cross-context host port is needed. Gated behind the same
 * `support.view`/`support.manage` permissions the rest of this slice's admin
 * surfaces use.
 */

function requireAccess(
  c: { get(key: "actor"): SupportApiEnv["Variables"]["actor"] },
  permission: "support.view" | "support.manage",
) {
  const actor = c.get("actor");
  if (!actor) {
    return {
      actor: null,
      response: new Response(
        JSON.stringify({
          error: {
            code: "authentication_required",
            message: t("support.features.supportRequests.api.deadlinePolicyRoute.authentication.required"),
          },
        }),
        { status: 401, headers: { "Content-Type": "application/json" } },
      ),
    };
  }

  if (!actor.permissions.includes(permission)) {
    return {
      actor: null,
      response: new Response(
        JSON.stringify({
          error: {
            code: "authorization_forbidden",
            message: t("support.features.supportRequests.api.deadlinePolicyRoute.forbidden"),
          },
        }),
        { status: 403, headers: { "Content-Type": "application/json" } },
      ),
    };
  }

  return { actor, response: null };
}

function errorMessage(error: unknown) {
  return error instanceof Error
    ? error.message
    : t("support.features.supportRequests.api.deadlinePolicyRoute.request.failed");
}

function policyValueFromBody(body: Record<string, unknown>): SupportDeadlinePolicyValue {
  return body.flows as SupportDeadlinePolicyValue;
}

function documentCommandBody(body: Record<string, unknown>) {
  return {
    value: policyValueFromBody(body),
    status: body.status === "inactive" ? ("inactive" as const) : ("active" as const),
    effectiveFrom: typeof body.effectiveFrom === "string" ? body.effectiveFrom : new Date().toISOString(),
    effectiveUntil:
      typeof body.effectiveUntil === "string" && body.effectiveUntil.trim().length > 0 ? body.effectiveUntil : null,
  };
}

export function createSupportDeadlinePolicyRoutes(policies: PolicyRuntime) {
  const app = new Hono<SupportApiEnv>();

  app.get("/", async (c) => {
    const access = requireAccess(c, "support.view");
    if (access.response) {
      return access.response;
    }

    const resolved = await policies.resolvePolicy(supportDeadlinePolicy);
    const document = resolved.documentId ? await policies.getPolicyDocument(resolved.documentId) : null;

    return c.json({
      policy_key: supportDeadlinePolicy.policyKey,
      source: resolved.source,
      document_id: resolved.documentId,
      effective_from: resolved.effectiveFrom,
      effective_until: document?.effective_until ?? null,
      resolved_at: resolved.resolvedAt,
      value: resolved.value,
      history: document?.history ?? [],
    });
  });

  app.get("/:id", async (c) => {
    const access = requireAccess(c, "support.view");
    if (access.response) {
      return access.response;
    }

    const document = await policies.getPolicyDocument(c.req.param("id"));
    if (!document || document.policy_key !== supportDeadlinePolicy.policyKey) {
      return c.json(
        {
          error: {
            code: "not_found",
            message: t("support.features.supportRequests.api.deadlinePolicyRoute.document.not.found"),
          },
        },
        404,
      );
    }

    return c.json(document);
  });

  app.post("/", async (c) => {
    const access = requireAccess(c, "support.manage");
    if (access.response) {
      return access.response;
    }
    const context = c.get("context");
    if (!context) {
      return c.json(
        {
          error: {
            code: "authentication_required",
            message: t("support.features.supportRequests.api.deadlinePolicyRoute.authentication.context.missing"),
          },
        },
        401,
      );
    }

    const body = await c.req.json();

    try {
      const result = await policies.createPolicyDocument(
        supportDeadlinePolicy,
        { ...documentCommandBody(body), actorUserId: access.actor.userId },
        context,
      );
      return c.json({ id: result.documentId, version: result.version }, 201);
    } catch (error) {
      return c.json({ error: { code: "validation_failed", message: errorMessage(error) } }, 400);
    }
  });

  app.put("/:id", async (c) => {
    const access = requireAccess(c, "support.manage");
    if (access.response) {
      return access.response;
    }
    const context = c.get("context");
    if (!context) {
      return c.json(
        {
          error: {
            code: "authentication_required",
            message: t("support.features.supportRequests.api.deadlinePolicyRoute.authentication.context.missing.2"),
          },
        },
        401,
      );
    }

    const body = await c.req.json();

    try {
      const result = await policies.revisePolicyDocument(
        supportDeadlinePolicy,
        c.req.param("id"),
        { ...documentCommandBody(body), actorUserId: access.actor.userId },
        context,
      );
      return c.json({ id: result.documentId, version: result.version });
    } catch (error) {
      return c.json({ error: { code: "validation_failed", message: errorMessage(error) } }, 400);
    }
  });

  return app;
}
