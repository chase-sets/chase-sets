import { Hono, type Handler } from "hono";
import type { PricingApiEnv } from "../../../api";
import { PolicyControlValidationError, type RepricingPolicyServices } from "./runtime";
import { DryRunRequiredError, type RepricingPolicyActivationServices } from "./activation";
import type { RepricingPolicyCommand, ReviseRepricingPolicyCommand } from "../domain/domain";
import type { RepricingScopePreviewInput } from "../read-model/controls";

export function createRepricingPolicyRoutes(services: RepricingPolicyServices & RepricingPolicyActivationServices) {
  const app = new Hono<PricingApiEnv>();
  app.onError((error, c) => {
    if (error instanceof SyntaxError || error instanceof PolicyControlValidationError)
      return c.json({ error: { code: "validation_failed" } }, 400);
    throw error;
  });
  app.use("*", async (c, next) => {
    const actor = c.get("actor");
    if (!actor) return c.json({ error: { code: "authentication_required" } }, 401);
    const permission = c.req.method === "POST" ? "pricing.manage" : "pricing.view";
    if (!actor.permissions.includes(permission)) return c.json({ error: { code: "authorization_forbidden" } }, 403);
    return next();
  });
  app.get("/", async (c) => {
    const accountId = c.get("actor")!.accountId;
    const policies = await services.listAccountRepricingPolicies({ accountId });
    const budget = await services.getBudget(accountId, new Date().toISOString().slice(0, 10));
    const loaded = await Promise.all(policies.map(({ policyId }) => services.loadOwnedRepricingPolicy(policyId, accountId)));
    return c.json(loaded.flatMap((policy) => policy ? [{ ...policy.state, changesUsedToday: budget.changesUsed }] : []));
  });
  app.get("/halt", async (c) => c.json(await services.getHalt(c.get("actor")!.accountId)));
  app.post("/halt", async (c) => {
    const context = c.get("context");
    if (!context) return c.json({ error: { code: "authentication_required" } }, 401);
    const body = await c.req.json<{ engaged: boolean }>();
    if (typeof body?.engaged !== "boolean") return c.json({ error: { code: "validation_failed" } }, 400);
    return c.json(await services.setHalt(c.get("actor")!.accountId, body.engaged, context));
  });
  app.get("/budget", async (c) => {
    const day = c.req.query("day") ?? new Date().toISOString().slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !Number.isFinite(Date.parse(day)) || new Date(day).toISOString().slice(0, 10) !== day)
      return c.json({ error: { code: "validation_failed" } }, 400);
    return c.json(await services.getBudget(c.get("actor")!.accountId, day));
  });
  app.get("/categories", async (c) => c.json(await services.listCategories(c.get("actor")!.accountId)));
  app.post("/scope-preview", async (c) => {
    const accountId = c.get("actor")!.accountId;
    const body = await c.req.json<Omit<RepricingScopePreviewInput, "accountId">>();
    if (!body || (body.replacingPolicyId !== undefined && typeof body.replacingPolicyId !== "string"))
      return c.json({ error: { code: "validation_failed" } }, 400);
    if (body.replacingPolicyId !== undefined && !(await services.loadOwnedRepricingPolicy(body.replacingPolicyId, accountId)))
      return c.json({ error: { code: "not_found" } }, 404);
    if (!validScope(body.scope) || (body.excludedListingIds !== undefined && !idList(body.excludedListingIds)))
      return c.json({ error: { code: "validation_failed" } }, 400);
    return c.json(await services.previewScope({ ...body, accountId }));
  });
  app.post("/", async (c) => {
    const context = c.get("context");
    if (!context) return c.json({ error: { code: "authentication_required" } }, 401);
    const body = await c.req.json<{ dryRunId?: string; name: string }>();
    if (typeof body?.dryRunId !== "string" || !body.dryRunId)
      return c.json({ error: { code: "dry_run_required" } }, 409);
    if (typeof body.name !== "string" || !body.name.trim()) return c.json({ error: { code: "validation_failed" } }, 400);
    try {
      const state = await services.activateRepricingPolicy({ accountId: c.get("actor")!.accountId, dryRunId: body.dryRunId, name: body.name }, context);
      return state ? c.json(state, 201) : c.json({ error: { code: "not_found" } }, 404);
    } catch (error) {
      if (error instanceof DryRunRequiredError) return c.json({ error: { code: "dry_run_required" } }, 409);
      throw error;
    }
  });
  app.get("/:policyId", async (c) => {
    const accountId = c.get("actor")!.accountId;
    const policyId = c.req.param("policyId");
    if (!(await services.getAccountRepricingPolicy({ accountId, policyId }))) return c.json({ error: { code: "not_found" } }, 404);
    const loaded = await services.loadOwnedRepricingPolicy(policyId, accountId);
    return loaded ? c.json(loaded.state) : c.json({ error: { code: "not_found" } }, 404);
  });
  app.post("/:policyId/revise", async (c) => {
    const context = c.get("context");
    if (!context) return c.json({ error: { code: "authentication_required" } }, 401);
    const policyId = c.req.param("policyId");
    const accountId = c.get("actor")!.accountId;
    if (!(await services.loadOwnedRepricingPolicy(policyId, accountId))) return c.json({ error: { code: "not_found" } }, 404);
    const body = await c.req.json<Omit<ReviseRepricingPolicyCommand, "type" | "revisedAt">>();
    const state = await services.executeOwnedRepricingPolicy({ policyId, accountId, context,
      command: { ...body, type: "ReviseRepricingPolicy", revisedAt: new Date().toISOString() } });
    return state ? c.json(state) : c.json({ error: { code: "not_found" } }, 404);
  });
  const lifecycle = (action: "pause" | "resume" | "delete"): Handler<PricingApiEnv> => async (c) => {
      const context = c.get("context");
      if (!context) return c.json({ error: { code: "authentication_required" } }, 401);
      const now = new Date().toISOString();
      const command: Exclude<RepricingPolicyCommand, { type: "CreateRepricingPolicy" }> = action === "pause"
        ? { type: "PauseRepricingPolicy", pausedAt: now }
        : action === "resume" ? { type: "ResumeRepricingPolicy", resumedAt: now } : { type: "DeleteRepricingPolicy", deletedAt: now };
      const state = await services.executeOwnedRepricingPolicy({ policyId: c.req.param("policyId"), accountId: c.get("actor")!.accountId, context, command });
      return state ? c.json(state) : c.json({ error: { code: "not_found" } }, 404);
  };
  app.post("/:policyId/pause", lifecycle("pause"));
  app.post("/:policyId/resume", lifecycle("resume"));
  app.post("/:policyId/delete", lifecycle("delete"));
  return app;
}

function idList(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((id) => typeof id === "string" && id.trim().length > 0);
}
function validScope(scope: RepricingScopePreviewInput["scope"]): boolean {
  return scope?.kind === "all-listings" ||
    (scope?.kind === "catalog-filter" && idList(scope.categoryIds) && scope.categoryIds.length > 0) ||
    (scope?.kind === "listing-set" && idList(scope.listingIds) && scope.listingIds.length > 0);
}
