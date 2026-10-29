import { Hono } from "hono";
import type { PricingApiEnv } from "../../../api";
import {
  PricingHealthApplyRefusedError,
  PricingHealthCandidateRefusedError,
  type ApplyGoalRequest,
  type PricingHealthServices,
} from "./services";
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
    let parameterRequests: readonly GoalParameterRequest[] | undefined;
    if (query.goals !== undefined) {
      try {
        const parsed: unknown = JSON.parse(query.goals);
        if (!Array.isArray(parsed)) throw new Error("goals must be an array");
        parameterRequests = parsed as GoalParameterRequest[];
      } catch {
        return c.json({ error: { code: "validation_failed" } }, 400);
      }
    }
    try {
      const data =
        parameterRequests === undefined
          ? await services.getHealth(c.get("actor")!.accountId, query.policyId, new Date().toISOString())
          : await services.getHealth(
              c.get("actor")!.accountId,
              query.policyId,
              new Date().toISOString(),
              parameterRequests,
            );
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
      const raw = await c.req.text();
      let parameterRequests: readonly GoalParameterRequest[] | undefined;
      if (raw.trim().length > 0) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw);
        } catch {
          throw new GoalComparisonValidationError(["compare body must be JSON"]);
        }
        if (
          !parsed ||
          typeof parsed !== "object" ||
          Array.isArray(parsed) ||
          Object.keys(parsed).length !== 1 ||
          !("goals" in parsed) ||
          !Array.isArray(parsed.goals)
        )
          throw new GoalComparisonValidationError(["compare body must contain only a goals array"]);
        parameterRequests = parsed.goals as GoalParameterRequest[];
      }
      const runs =
        parameterRequests === undefined
          ? await services.compare(c.get("actor")!.accountId, c.req.param("policyId"), context)
          : await services.compare(c.get("actor")!.accountId, c.req.param("policyId"), context, parameterRequests);
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
  app.post("/:policyId/apply-goal", async (c) => {
    const context = c.get("context");
    if (!context) return c.json({ error: { code: "authentication_required" } }, 401);
    let body: ApplyGoalRequest;
    try {
      body = (await c.req.json()) as ApplyGoalRequest;
    } catch {
      return c.json({ error: { code: "validation_failed" } }, 400);
    }
    if (!validApplyGoalRequest(body)) return c.json({ error: { code: "validation_failed" } }, 400);
    try {
      const result = await services.applyGoal(c.get("actor")!.accountId, c.req.param("policyId"), body, context);
      return result ? c.json(result) : c.json({ error: { code: "not_found" } }, 404);
    } catch (error) {
      if (error instanceof PricingHealthApplyRefusedError)
        return c.json({ error: { code: "goal_apply_refused", reason: error.code } }, 409);
      throw error;
    }
  });
  return app;
}

function validApplyGoalRequest(value: ApplyGoalRequest): value is ApplyGoalRequest {
  return (
    !!value &&
    typeof value === "object" &&
    typeof value.dryRunId === "string" &&
    value.dryRunId.length > 0 &&
    Number.isSafeInteger(value.targetRevision) &&
    value.targetRevision > 0 &&
    typeof value.targetBodyHash === "string" &&
    value.targetBodyHash.length > 0 &&
    typeof value.candidateBodyHash === "string" &&
    value.candidateBodyHash.length > 0 &&
    typeof value.goalId === "string" &&
    value.goalId.length > 0 &&
    Number.isSafeInteger(value.goalVersion) &&
    value.goalVersion > 0 &&
    !!value.parameters &&
    typeof value.parameters === "object" &&
    !Array.isArray(value.parameters) &&
    Object.values(value.parameters).every((parameter) => typeof parameter === "number" && Number.isFinite(parameter))
  );
}
