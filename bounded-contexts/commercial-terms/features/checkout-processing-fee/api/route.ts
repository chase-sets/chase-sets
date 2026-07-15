import { t } from "@chase-sets/localization";
import { Hono } from "hono";
import type { CommercialTermsPolicyRuntime } from "../../../support/runtime-support/policy-runtime";
import type { CommercialTermsApiEnv } from "../../../api";
import { normalizeCommercialTermsStatus, normalizeEffectiveWindow } from "../../../support/runtime-support/common";
import { checkoutProcessingFeePolicy, decodeCheckoutProcessingFeePolicyValue } from "../domain/policy";

function requireAccess(
  c: { get(key: "actor"): CommercialTermsApiEnv["Variables"]["actor"] },
  permission: "commercial-terms.view" | "commercial-terms.manage",
) {
  const actor = c.get("actor");
  if (!actor) {
    return {
      actor: null,
      response: new Response(
        JSON.stringify({
          error: {
            code: "authentication_required",
            message: t("commercialTerms.features.checkoutProcessingFee.api.route.authentication.required"),
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
            message: t("commercialTerms.features.checkoutProcessingFee.api.route.forbidden"),
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
    : t("commercialTerms.features.checkoutProcessingFee.api.route.request.failed");
}

function policyValueFromBody(body: Record<string, unknown>) {
  const base = body.base as Record<string, unknown> | undefined;
  return decodeCheckoutProcessingFeePolicyValue({
    enabledJurisdictions: Array.isArray(body.enabledJurisdictions) ? body.enabledJurisdictions : null,
    base: {
      percentageBps: Number(base?.percentageBps),
      fixedAmount: String(base?.fixedAmount ?? ""),
    },
    methodAdjustments: Array.isArray(body.methodAdjustments)
      ? (body.methodAdjustments as Record<string, unknown>[]).map((adjustment) => ({
          paymentMethodCategory: String(adjustment.paymentMethodCategory ?? ""),
          percentageBpsDelta: Number(adjustment.percentageBpsDelta),
          fixedAmountDelta: String(adjustment.fixedAmountDelta ?? ""),
        }))
      : null,
  });
}

function documentCommandBody(body: Record<string, unknown>) {
  const effectiveWindow = normalizeEffectiveWindow(
    typeof body.effectiveFrom === "string" ? body.effectiveFrom : "",
    typeof body.effectiveUntil === "string" && body.effectiveUntil.trim().length > 0 ? body.effectiveUntil : null,
    { from: "Effective from", until: "Effective until" },
  );
  return {
    value: policyValueFromBody(body),
    status: normalizeCommercialTermsStatus(String(body.status ?? "")),
    ...effectiveWindow,
  };
}

export function createCheckoutProcessingFeeRoutes(policies: CommercialTermsPolicyRuntime) {
  const app = new Hono<CommercialTermsApiEnv>();

  app.get("/", async (c) => {
    const access = requireAccess(c, "commercial-terms.view");
    if (access.response) {
      return access.response;
    }

    const resolved = await policies.resolvePolicy(checkoutProcessingFeePolicy);
    const document = resolved.documentId ? await policies.getPolicyDocument(resolved.documentId) : null;

    return c.json({
      policy_key: checkoutProcessingFeePolicy.policyKey,
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
    const access = requireAccess(c, "commercial-terms.view");
    if (access.response) {
      return access.response;
    }

    const document = await policies.getPolicyDocument(c.req.param("id"));
    if (!document || document.policy_key !== checkoutProcessingFeePolicy.policyKey) {
      return c.json(
        {
          error: {
            code: "not_found",
            message: t("commercialTerms.features.checkoutProcessingFee.api.route.document.not.found"),
          },
        },
        404,
      );
    }

    return c.json(document);
  });

  app.post("/", async (c) => {
    const access = requireAccess(c, "commercial-terms.manage");
    if (access.response) {
      return access.response;
    }
    const context = c.get("context");
    if (!context) {
      return c.json(
        {
          error: {
            code: "authentication_required",
            message: t("commercialTerms.features.checkoutProcessingFee.api.route.authentication.context.missing"),
          },
        },
        401,
      );
    }

    const body = await c.req.json();

    try {
      const result = await policies.createPolicyDocument(
        checkoutProcessingFeePolicy,
        { ...documentCommandBody(body), actorUserId: access.actor.userId },
        context,
      );
      return c.json({ id: result.documentId, version: result.version }, 201);
    } catch (error) {
      return c.json({ error: { code: "validation_failed", message: errorMessage(error) } }, 400);
    }
  });

  app.put("/:id", async (c) => {
    const access = requireAccess(c, "commercial-terms.manage");
    if (access.response) {
      return access.response;
    }
    const context = c.get("context");
    if (!context) {
      return c.json(
        {
          error: {
            code: "authentication_required",
            message: t("commercialTerms.features.checkoutProcessingFee.api.route.authentication.context.missing"),
          },
        },
        401,
      );
    }

    const body = await c.req.json();

    try {
      const result = await policies.revisePolicyDocument(
        checkoutProcessingFeePolicy,
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
