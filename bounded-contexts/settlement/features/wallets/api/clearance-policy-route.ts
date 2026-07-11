import { t } from "@chase-sets/localization";
import { Hono } from "hono";
import type { PolicyRuntime } from "@chase-sets/platform-policy/runtime";
import type { SettlementApiEnv } from "../../../api";
import { settlementClearancePolicy, type SettlementClearancePolicyValue } from "../domain/clearance-policy";

/**
 * Admin-managed create/revise/history routes for the settlement clearance
 * policy, mounted on the shared platform-policy machinery (see
 * `../../../support/runtime-support/services.ts`). Mirrors the
 * checkout-processing-fee route shape from Commercial Terms -- settlement
 * both owns this policy's schema and is its only consumer, so no
 * cross-context host port is needed.
 */

function requireAccess(
  c: { get(key: "actor"): SettlementApiEnv["Variables"]["actor"] },
  permission: "payouts.view" | "payouts.manage",
) {
  const actor = c.get("actor");
  if (!actor) {
    return {
      actor: null,
      response: new Response(
        JSON.stringify({
          error: {
            code: "authentication_required",
            message: t("settlement.features.wallets.api.clearancePolicyRoute.authentication.required"),
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
            message: t("settlement.features.wallets.api.clearancePolicyRoute.forbidden"),
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
    : t("settlement.features.wallets.api.clearancePolicyRoute.request.failed");
}

function policyValueFromBody(body: Record<string, unknown>): SettlementClearancePolicyValue {
  return {
    baseClearanceDays: Number(body.baseClearanceDays ?? 0),
    extendedClearanceDays: Number(body.extendedClearanceDays ?? 0),
    highValueThresholdAmount: String(body.highValueThresholdAmount ?? "0.00"),
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

export function createClearancePolicyRoutes(policies: PolicyRuntime) {
  const app = new Hono<SettlementApiEnv>();

  app.get("/", async (c) => {
    const access = requireAccess(c, "payouts.view");
    if (access.response) {
      return access.response;
    }

    const resolved = await policies.resolvePolicy(settlementClearancePolicy);
    const document = resolved.documentId ? await policies.getPolicyDocument(resolved.documentId) : null;

    return c.json({
      policy_key: settlementClearancePolicy.policyKey,
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
    const access = requireAccess(c, "payouts.view");
    if (access.response) {
      return access.response;
    }

    const document = await policies.getPolicyDocument(c.req.param("id"));
    if (!document || document.policy_key !== settlementClearancePolicy.policyKey) {
      return c.json(
        {
          error: {
            code: "not_found",
            message: t("settlement.features.wallets.api.clearancePolicyRoute.document.not.found"),
          },
        },
        404,
      );
    }

    return c.json(document);
  });

  app.post("/", async (c) => {
    const access = requireAccess(c, "payouts.manage");
    if (access.response) {
      return access.response;
    }
    const context = c.get("context");
    if (!context) {
      return c.json(
        {
          error: {
            code: "authentication_required",
            message: t("settlement.features.wallets.api.clearancePolicyRoute.authentication.context.missing"),
          },
        },
        401,
      );
    }

    const body = await c.req.json();

    try {
      const result = await policies.createPolicyDocument(
        settlementClearancePolicy,
        { ...documentCommandBody(body), actorUserId: access.actor.userId },
        context,
      );
      return c.json({ id: result.documentId, version: result.version }, 201);
    } catch (error) {
      return c.json({ error: { code: "validation_failed", message: errorMessage(error) } }, 400);
    }
  });

  app.put("/:id", async (c) => {
    const access = requireAccess(c, "payouts.manage");
    if (access.response) {
      return access.response;
    }
    const context = c.get("context");
    if (!context) {
      return c.json(
        {
          error: {
            code: "authentication_required",
            message: t("settlement.features.wallets.api.clearancePolicyRoute.authentication.context.missing.2"),
          },
        },
        401,
      );
    }

    const body = await c.req.json();

    try {
      const result = await policies.revisePolicyDocument(
        settlementClearancePolicy,
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
