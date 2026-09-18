import { Hono, type Handler } from "hono";
import type { PolicyRuntime } from "@chase-sets/platform-policy/runtime";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type { PricingApiEnv } from "../../../api";
import { getAccountRepricingPolicy } from "../../repricing-policies/read-model/queries";
import { repricingManagementPolicy } from "../domain/management-policy";
import { getRepricingAttentionSummary, listRepricingActivity, repricingActivityFilters } from "./activity";

export function createRepricingActivityServices({
  db,
  policies,
}: Readonly<{ db: PgQueryable; policies: Pick<PolicyRuntime, "resolvePolicy"> }>) {
  return {
    getAccountRepricingPolicy: (accountId: string, policyId: string) =>
      getAccountRepricingPolicy(db, { accountId, policyId }),
    activity: (input: Parameters<typeof listRepricingActivity>[1]) => listRepricingActivity(db, input),
    attention: async (accountId: string, now: string) =>
      getRepricingAttentionSummary(db, {
        accountId,
        now,
        floorBindingAlertDays: (await policies.resolvePolicy(repricingManagementPolicy)).value.floorBindingAlertDays,
      }),
  };
}

export function createRepricingActivityRoutes(services: ReturnType<typeof createRepricingActivityServices>) {
  const app = new Hono<PricingApiEnv>();
  const requirePricingView: Handler<PricingApiEnv> = async (c, next) => {
    const actor = c.get("actor");
    if (!actor) return c.json({ error: { code: "authentication_required" } }, 401);
    if (!actor.permissions.includes("pricing.view")) return c.json({ error: { code: "authorization_forbidden" } }, 403);
    return next();
  };
  app.use("/attention-summary", requirePricingView);
  app.use("/:policyId/activity", requirePricingView);
  app.get("/attention-summary", async (c) => {
    // This endpoint is account-scoped; it never accepts an unchecked foreign policy selector.
    if (Object.keys(c.req.query()).length) return c.json({ error: { code: "validation_failed" } }, 400);
    return c.json(await services.attention(c.get("actor")!.accountId, new Date().toISOString()));
  });
  app.get("/:policyId/activity", async (c) => {
    const accountId = c.get("actor")!.accountId;
    const policyId = c.req.param("policyId");
    if (!(await services.getAccountRepricingPolicy(accountId, policyId))) {
      return c.json({ error: { code: "not_found" } }, 404);
    }
    const query = c.req.query();
    const filter = repricingActivityFilters.find((value) => value === query.filter);
    const limit = query.limit === undefined ? 25 : Number(query.limit);
    if (
      Object.keys(query).some((key) => !["filter", "after", "limit"].includes(key)) ||
      (query.filter !== undefined && !filter) ||
      (query.limit !== undefined && !/^[1-9]\d*$/.test(query.limit)) ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 50 ||
      (query.after !== undefined && (!query.after || query.after.length > 256))
    ) {
      return c.json({ error: { code: "validation_failed" } }, 400);
    }
    return c.json(
      await services.activity({
        accountId,
        policyId,
        filter,
        limit,
        after: query.after,
        now: new Date().toISOString(),
      }),
    );
  });
  return app;
}
