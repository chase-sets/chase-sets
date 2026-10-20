import { Hono } from "hono";
import type { PricingApiEnv } from "../../../api";
import type { PricingHealthServices } from "./services";

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
      Object.keys(query).some((key) => key !== "policyId") ||
      (query.policyId !== undefined && (!query.policyId || query.policyId.length > 256))
    )
      return c.json({ error: { code: "validation_failed" } }, 400);
    const data = await services.getHealth(c.get("actor")!.accountId, query.policyId, new Date().toISOString());
    return data
      ? c.json({ ...data, canCompute: c.get("actor")!.permissions.includes("pricing.manage") })
      : c.json({ error: { code: "not_found" } }, 404);
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
    const runs = services.compare
      ? await services.compare(c.get("actor")!.accountId, c.req.param("policyId"), context)
      : null;
    return runs ? c.json({ runs }, 202) : c.json({ error: { code: "not_found" } }, 404);
  });
  return app;
}
