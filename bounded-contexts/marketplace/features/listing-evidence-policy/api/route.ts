import { t } from "@chase-sets/localization";
import { Hono } from "hono";
import type { MarketplaceApiEnv } from "../../../api";
import type { ListingEvidenceEvaluationFacts, ListingEvidencePolicyValue } from "../domain/policy";
import type { ListingEvidencePolicyRuntime } from "./runtime";

type Permission =
  | "listing-evidence-policy.view"
  | "listing-evidence-policy.draft"
  | "listing-evidence-policy.validate"
  | "listing-evidence-policy.activate";

function requireAccess(c: { get(key: "actor"): MarketplaceApiEnv["Variables"]["actor"] }, permission: Permission) {
  const actor = c.get("actor");
  if (!actor) {
    return {
      actor: null,
      response: new Response(
        JSON.stringify({
          error: {
            code: "authentication_required",
            message: t("marketplace.features.listingEvidencePolicy.api.authentication.required"),
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
            message: t("marketplace.features.listingEvidencePolicy.api.forbidden"),
          },
        }),
        { status: 403, headers: { "Content-Type": "application/json" } },
      ),
    };
  }
  return { actor, response: null };
}

function commandContext(c: { get(key: "context"): MarketplaceApiEnv["Variables"]["context"] }) {
  const context = c.get("context");
  if (!context) throw new Error("Authentication context is required.");
  return context;
}

function message(error: unknown) {
  return error instanceof Error ? error.message : t("marketplace.features.listingEvidencePolicy.api.request.failed");
}

export function createListingEvidencePolicyRoutes(runtime: ListingEvidencePolicyRuntime) {
  const app = new Hono<MarketplaceApiEnv>();

  app.get("/", async (c) => {
    const access = requireAccess(c, "listing-evidence-policy.view");
    if (access.response) return access.response;
    return c.json(await runtime.getOverview());
  });

  app.get("/selectors", async (c) => {
    const access = requireAccess(c, "listing-evidence-policy.view");
    if (access.response) return access.response;
    return c.json(await runtime.loadSelectorCatalog());
  });

  app.post("/drafts", async (c) => {
    const access = requireAccess(c, "listing-evidence-policy.draft");
    if (access.response) return access.response;
    try {
      const body = await c.req.json<Record<string, unknown>>();
      const result = await runtime.createDraft(
        {
          policyName: String(body.policyName ?? ""),
          rules: (body.rules ?? []) as ListingEvidencePolicyValue["rules"],
          actorUserId: access.actor.userId,
        },
        commandContext(c),
      );
      return c.json({ policyId: result.documentId, version: result.version, lifecycle: "draft" }, 201);
    } catch (error) {
      return c.json({ error: { code: "validation_failed", message: message(error) } }, 400);
    }
  });

  app.post("/drafts/:id/validate", async (c) => {
    const access = requireAccess(c, "listing-evidence-policy.validate");
    if (access.response) return access.response;
    try {
      const result = await runtime.validateDraft(c.req.param("id"), access.actor.userId, commandContext(c));
      return c.json(result, result.valid ? 200 : 422);
    } catch (error) {
      return c.json({ error: { code: "validation_failed", message: message(error) } }, 400);
    }
  });

  app.post("/drafts/:id/reject", async (c) => {
    const access = requireAccess(c, "listing-evidence-policy.draft");
    if (access.response) return access.response;
    try {
      return c.json(await runtime.rejectDraft(c.req.param("id"), access.actor.userId, commandContext(c)));
    } catch (error) {
      return c.json({ error: { code: "validation_failed", message: message(error) } }, 400);
    }
  });

  app.post("/drafts/:id/activate", async (c) => {
    const access = requireAccess(c, "listing-evidence-policy.activate");
    if (access.response) return access.response;
    try {
      const body = await c.req.json<Record<string, unknown>>();
      const result = await runtime.activateDraft(
        c.req.param("id"),
        {
          effectiveFrom: typeof body.effectiveFrom === "string" ? body.effectiveFrom : "",
          effectiveUntil:
            typeof body.effectiveUntil === "string" && body.effectiveUntil.trim() ? body.effectiveUntil : null,
          impactAcknowledgmentHash: String(body.impactAcknowledgmentHash ?? ""),
          actorUserId: access.actor.userId,
        },
        commandContext(c),
      );
      return c.json(result, 201);
    } catch (error) {
      return c.json({ error: { code: "activation_rejected", message: message(error) } }, 400);
    }
  });

  app.post("/documents/:id/rollback-draft", async (c) => {
    const access = requireAccess(c, "listing-evidence-policy.draft");
    if (access.response) return access.response;
    try {
      const result = await runtime.createRollbackDraft(c.req.param("id"), access.actor.userId, commandContext(c));
      return c.json({ policyId: result.documentId, version: result.version, lifecycle: "draft" }, 201);
    } catch (error) {
      return c.json({ error: { code: "validation_failed", message: message(error) } }, 400);
    }
  });

  app.post("/evaluation", async (c) => {
    const access = requireAccess(c, "listing-evidence-policy.view");
    if (access.response) return access.response;
    try {
      const body = await c.req.json<Record<string, unknown>>();
      return c.json(
        await runtime.evaluate(
          body.facts as ListingEvidenceEvaluationFacts,
          typeof body.at === "string" ? body.at : undefined,
        ),
      );
    } catch (error) {
      return c.json({ error: { code: "evaluation_failed", message: message(error) } }, 400);
    }
  });

  return app;
}
