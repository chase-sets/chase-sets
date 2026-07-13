import { t } from "@chase-sets/localization";
import { Hono } from "hono";
import type { PolicyRuntime } from "@chase-sets/platform-policy/runtime";
import type { MarketplaceApiEnv } from "../../../api";
import {
  marketplaceListingGatePolicy,
  MARKETPLACE_LISTING_GATE_LAUNCH_POLICY_VALUE,
  type MarketplaceListingGatePolicyValue,
} from "../domain/listing-gate-policy";

/**
 * Admin-managed create/revise/history routes for the marketplace
 * listing-gate policy, mounted on the shared platform-policy machinery (see
 * `../../../support/runtime-support/services.ts`). Mirrors the settlement
 * clearance-policy route shape -- marketplace both owns this policy's schema
 * and is its only consumer, so no cross-context host port is needed.
 */

function requireAccess(
  c: { get(key: "actor"): MarketplaceApiEnv["Variables"]["actor"] },
  permission: "listings.view" | "listings.manage",
) {
  const actor = c.get("actor");
  if (!actor) {
    return {
      actor: null,
      response: new Response(
        JSON.stringify({
          error: {
            code: "authentication_required",
            message: t("marketplace.features.listings.api.listingGatePolicyRoute.authentication.required"),
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
            message: t("marketplace.features.listings.api.listingGatePolicyRoute.forbidden"),
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
    : t("marketplace.features.listings.api.listingGatePolicyRoute.request.failed");
}

function policyValueFromBody(body: Record<string, unknown>): MarketplaceListingGatePolicyValue {
  return {
    maxActiveAnonymousListingDrafts: Number(body.maxActiveAnonymousListingDrafts ?? 0),
    anonymousListingDraftTtlDays: Number(body.anonymousListingDraftTtlDays ?? 0),
    maxListingEvidenceUploadBytes: Number(body.maxListingEvidenceUploadBytes ?? 0),
    maxListingEvidenceCount: Number(
      body.maxListingEvidenceCount ?? MARKETPLACE_LISTING_GATE_LAUNCH_POLICY_VALUE.maxListingEvidenceCount,
    ),
    maxListingEvidenceTotalBytes: Number(
      body.maxListingEvidenceTotalBytes ?? MARKETPLACE_LISTING_GATE_LAUNCH_POLICY_VALUE.maxListingEvidenceTotalBytes,
    ),
    evidenceGarbageCollectionSafeDelayHours: Number(
      body.evidenceGarbageCollectionSafeDelayHours ??
        MARKETPLACE_LISTING_GATE_LAUNCH_POLICY_VALUE.evidenceGarbageCollectionSafeDelayHours,
    ),
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

export function createListingGatePolicyRoutes(policies: PolicyRuntime) {
  const app = new Hono<MarketplaceApiEnv>();

  app.get("/", async (c) => {
    const access = requireAccess(c, "listings.view");
    if (access.response) {
      return access.response;
    }

    const resolved = await policies.resolvePolicy(marketplaceListingGatePolicy);
    const document = resolved.documentId ? await policies.getPolicyDocument(resolved.documentId) : null;

    return c.json({
      policy_key: marketplaceListingGatePolicy.policyKey,
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
    const access = requireAccess(c, "listings.view");
    if (access.response) {
      return access.response;
    }

    const document = await policies.getPolicyDocument(c.req.param("id"));
    if (!document || document.policy_key !== marketplaceListingGatePolicy.policyKey) {
      return c.json(
        {
          error: {
            code: "not_found",
            message: t("marketplace.features.listings.api.listingGatePolicyRoute.document.not.found"),
          },
        },
        404,
      );
    }

    return c.json(document);
  });

  app.post("/", async (c) => {
    const access = requireAccess(c, "listings.manage");
    if (access.response) {
      return access.response;
    }
    const context = c.get("context");
    if (!context) {
      return c.json(
        {
          error: {
            code: "authentication_required",
            message: t("marketplace.features.listings.api.listingGatePolicyRoute.authentication.context.missing"),
          },
        },
        401,
      );
    }

    const body = await c.req.json();

    try {
      const result = await policies.createPolicyDocument(
        marketplaceListingGatePolicy,
        { ...documentCommandBody(body), actorUserId: access.actor.userId },
        context,
      );
      return c.json({ id: result.documentId, version: result.version }, 201);
    } catch (error) {
      return c.json({ error: { code: "validation_failed", message: errorMessage(error) } }, 400);
    }
  });

  app.put("/:id", async (c) => {
    const access = requireAccess(c, "listings.manage");
    if (access.response) {
      return access.response;
    }
    const context = c.get("context");
    if (!context) {
      return c.json(
        {
          error: {
            code: "authentication_required",
            message: t("marketplace.features.listings.api.listingGatePolicyRoute.authentication.context.missing.2"),
          },
        },
        401,
      );
    }

    const body = await c.req.json();

    try {
      const result = await policies.revisePolicyDocument(
        marketplaceListingGatePolicy,
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
