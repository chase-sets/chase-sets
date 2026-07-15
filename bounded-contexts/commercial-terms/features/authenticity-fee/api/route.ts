import { t } from "@chase-sets/localization";
import { Hono } from "hono";
import type { CommercialTermsPolicyRuntime } from "../../../support/runtime-support/policy-runtime";
import type { CommercialTermsApiEnv } from "../../../api";
import { normalizeCommercialTermsStatus, normalizeEffectiveWindow } from "../../../support/runtime-support/common";
import { authenticityFeePolicy, decodeAuthenticityFeePolicyValue } from "../domain/policy";

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
            message: t("commercialTerms.features.authenticityFee.api.route.authentication.required"),
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
            message: t("commercialTerms.features.authenticityFee.api.route.forbidden"),
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
    : t("commercialTerms.features.authenticityFee.api.route.request.failed");
}

function policyValueFromBody(body: Record<string, unknown>) {
  return decodeAuthenticityFeePolicyValue({
    optInThresholdAmount: String(body.optInThresholdAmount ?? ""),
    bands: Array.isArray(body.bands)
      ? (body.bands as Record<string, unknown>[]).map((band) => ({
          minOrderValueAmount: String(band.minOrderValueAmount ?? ""),
          category: String(band.category ?? ""),
          flatAmount: String(band.flatAmount ?? ""),
          percentageBps: Number(band.percentageBps),
          capAmount: String(band.capAmount ?? ""),
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

export function createAuthenticityFeeRoutes(policies: CommercialTermsPolicyRuntime) {
  const app = new Hono<CommercialTermsApiEnv>();

  app.get("/", async (c) => {
    const access = requireAccess(c, "commercial-terms.view");
    if (access.response) {
      return access.response;
    }

    const resolved = await policies.resolvePolicy(authenticityFeePolicy);
    const document = resolved.documentId ? await policies.getPolicyDocument(resolved.documentId) : null;

    return c.json({
      policy_key: authenticityFeePolicy.policyKey,
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
    if (!document || document.policy_key !== authenticityFeePolicy.policyKey) {
      return c.json(
        {
          error: {
            code: "not_found",
            message: t("commercialTerms.features.authenticityFee.api.route.document.not.found"),
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
            message: t("commercialTerms.features.authenticityFee.api.route.authentication.context.missing"),
          },
        },
        401,
      );
    }

    const body = await c.req.json();

    try {
      const result = await policies.createPolicyDocument(
        authenticityFeePolicy,
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
            message: t("commercialTerms.features.authenticityFee.api.route.authentication.context.missing"),
          },
        },
        401,
      );
    }

    const body = await c.req.json();

    try {
      const result = await policies.revisePolicyDocument(
        authenticityFeePolicy,
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
