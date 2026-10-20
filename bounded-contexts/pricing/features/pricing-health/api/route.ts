import { Hono } from "hono";
import type { PricingApiEnv } from "../../../api";
import { PricingHealthCandidateRefusedError, type PricingHealthServices } from "./services";
import { GoalComparisonValidationError, type GoalParameterRequest } from "./goal-comparison";

export function createPricingHealthRoutes(services: PricingHealthServices) {
  const app = new Hono<PricingApiEnv>();
  app.use("*", async (c, next) => {
    const actor = c.get("actor");
    if (!actor) return c.json({ error: { code: "authentication_required" } }, 401);
    if (!actor.permissions.includes(c.req.method === "POST" ? "pricing.manage" : "pricing.view"))
      return c.json({ error: { code: "authorization_forbidden" } }, 403);
    return next();
  });
  app.get("/", async (c) => {
    const query = c.req.query();
    if (
      Object.keys(query).some((key) => !["policyId", "goals"].includes(key)) ||
      (query.policyId !== undefined && (!query.policyId || query.policyId.length > 256))
    )
      return c.json({ error: { code: "validation_failed" } }, 400);
    let requests: readonly GoalParameterRequest[] | undefined;
    if (query.goals !== undefined) {
      try {
        const parsed: unknown = JSON.parse(query.goals);
        if (!Array.isArray(parsed)) throw new Error("not an array");
        requests = parsed as GoalParameterRequest[];
      } catch {
        return c.json({ error: { code: "validation_failed" } }, 400);
      }
    }
    try {
      const data = requests
        ? await services.getHealth(c.get("actor")!.accountId, query.policyId, new Date().toISOString(), requests)
        : await services.getHealth(c.get("actor")!.accountId, query.policyId, new Date().toISOString());
      return data
        ? c.json({ ...data, canCompute: c.get("actor")!.permissions.includes("pricing.manage") })
        : c.json({ error: { code: "not_found" } }, 404);
    } catch (error) {
      if (error instanceof GoalComparisonValidationError)
        return c.json(
          { error: { code: "validation_failed", details: error.details.map((message) => ({ message })) } },
          400,
        );
      throw error;
    }
  });
  app.post("/:policyId/compute", async (c) => {
    const context = c.get("context");
    if (!context) return c.json({ error: { code: "authentication_required" } }, 401);
    const run = await services.compute(c.get("actor")!.accountId, c.req.param("policyId"), context);
    return run ? c.json(run, 202) : c.json({ error: { code: "not_found" } }, 404);
  });
  app.post("/:policyId/compare", async (c) => {
    const context = c.get("context");
    if (!context) return c.json({ error: { code: "authentication_required" } }, 401);
    try {
      let requests: readonly GoalParameterRequest[] | undefined;
      const contentType = c.req.header("content-type") ?? "";
      if (contentType.includes("application/json")) {
        const body: unknown = await c.req.json().catch(() => undefined);
        if (body === undefined || body === null || typeof body !== "object" || Array.isArray(body))
          throw new GoalComparisonValidationError(["compare body must be an object with a goals array"]);
        const candidate = body as { goals?: unknown };
        const keys = Object.keys(body);
        if (keys.length !== 1 || !keys.includes("goals") || !Array.isArray(candidate.goals))
          throw new GoalComparisonValidationError(["compare body must contain only a goals array"]);
        requests = candidate.goals as GoalParameterRequest[];
      }
      const runs = await services.compare(c.get("actor")!.accountId, c.req.param("policyId"), context, requests);
      return runs ? c.json({ runs }, 202) : c.json({ error: { code: "not_found" } }, 404);
    } catch (error) {
      if (error instanceof GoalComparisonValidationError)
        return c.json(
          { error: { code: "validation_failed", details: error.details.map((message) => ({ message })) } },
          400,
        );
      if (error instanceof PricingHealthCandidateRefusedError)
        return c.json({ error: { code: "candidate_enqueue_refused" } }, 409);
      throw error;
    }
  });
  return app;
}
