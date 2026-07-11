import { t } from "@chase-sets/localization";
import { Hono } from "hono";
import type { PolicyRuntime } from "@chase-sets/platform-policy/runtime";
import type { PlatformOperationsApiEnv } from "../../../api";
import { rateLimitPolicy, type RateLimitPolicyValue } from "../domain/rate-limit-policy";

/**
 * Admin-managed create/revise/history routes for the platform-wide
 * rate-limit policy, mounted on the shared platform-policy machinery (see
 * `../../../support/runtime-support/services.ts`). Mirrors the
 * checkout-processing-fee and settlement payout-bounds route shape.
 *
 * Gated by `security.manage` rather than a new permission key: tuning rate
 * limits (especially the incident multiplier) is a security-incident lever,
 * not a routine merchandising setting, so it rides the same elevated
 * permission already granted to platform-admin and owner.
 */

function requireAccess(c: { get(key: "actor"): PlatformOperationsApiEnv["Variables"]["actor"] }) {
  const actor = c.get("actor");
  if (!actor) {
    return {
      actor: null,
      response: new Response(
        JSON.stringify({
          error: {
            code: "authentication_required",
            message: t("platformOperations.features.rateLimitPolicy.api.route.authentication.required"),
          },
        }),
        { status: 401, headers: { "Content-Type": "application/json" } },
      ),
    };
  }

  if (!actor.permissions.includes("security.manage")) {
    return {
      actor: null,
      response: new Response(
        JSON.stringify({
          error: {
            code: "authorization_forbidden",
            message: t("platformOperations.features.rateLimitPolicy.api.route.forbidden"),
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
    : t("platformOperations.features.rateLimitPolicy.api.route.request.failed");
}

function policyValueFromBody(body: Record<string, unknown>): RateLimitPolicyValue {
  const rawSurfaces =
    body.surfaces && typeof body.surfaces === "object" && !Array.isArray(body.surfaces)
      ? (body.surfaces as Record<string, unknown>)
      : {};
  const surfaces: Record<string, Readonly<{ max?: number; windowMs?: number; disabled?: boolean }>> = {};
  for (const [surfaceKey, rawOverride] of Object.entries(rawSurfaces)) {
    const override = (rawOverride ?? {}) as Record<string, unknown>;
    surfaces[surfaceKey] = {
      ...(override.max !== undefined && override.max !== null ? { max: Number(override.max) } : {}),
      ...(override.windowMs !== undefined && override.windowMs !== null ? { windowMs: Number(override.windowMs) } : {}),
      ...(override.disabled !== undefined && override.disabled !== null
        ? { disabled: Boolean(override.disabled) }
        : {}),
    };
  }

  return {
    incidentMultiplier: Number(body.incidentMultiplier ?? 1),
    surfaces,
  };
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

export function createRateLimitPolicyRoutes(policies: PolicyRuntime) {
  const app = new Hono<PlatformOperationsApiEnv>();

  app.get("/", async (c) => {
    const access = requireAccess(c);
    if (access.response) {
      return access.response;
    }

    const resolved = await policies.resolvePolicy(rateLimitPolicy);
    const document = resolved.documentId ? await policies.getPolicyDocument(resolved.documentId) : null;

    return c.json({
      policy_key: rateLimitPolicy.policyKey,
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
    const access = requireAccess(c);
    if (access.response) {
      return access.response;
    }

    const document = await policies.getPolicyDocument(c.req.param("id"));
    if (!document || document.policy_key !== rateLimitPolicy.policyKey) {
      return c.json(
        {
          error: {
            code: "not_found",
            message: t("platformOperations.features.rateLimitPolicy.api.route.document.not.found"),
          },
        },
        404,
      );
    }

    return c.json(document);
  });

  app.post("/", async (c) => {
    const access = requireAccess(c);
    if (access.response) {
      return access.response;
    }
    const context = c.get("context");
    if (!context) {
      return c.json(
        {
          error: {
            code: "authentication_required",
            message: t("platformOperations.features.rateLimitPolicy.api.route.authentication.context.missing"),
          },
        },
        401,
      );
    }

    const body = await c.req.json();

    try {
      const result = await policies.createPolicyDocument(
        rateLimitPolicy,
        { ...documentCommandBody(body), actorUserId: access.actor.userId },
        context,
      );
      return c.json({ id: result.documentId, version: result.version }, 201);
    } catch (error) {
      return c.json({ error: { code: "validation_failed", message: errorMessage(error) } }, 400);
    }
  });

  app.put("/:id", async (c) => {
    const access = requireAccess(c);
    if (access.response) {
      return access.response;
    }
    const context = c.get("context");
    if (!context) {
      return c.json(
        {
          error: {
            code: "authentication_required",
            message: t("platformOperations.features.rateLimitPolicy.api.route.authentication.context.missing.2"),
          },
        },
        401,
      );
    }

    const body = await c.req.json();

    try {
      const result = await policies.revisePolicyDocument(
        rateLimitPolicy,
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
