import { Hono } from "hono";
import type { SettlementApiEnv } from "../../../api";
import type { SettlementServices } from "../../../support/runtime-support/services";

export function createPayoutReviewHoldRoutes(services: SettlementServices["payoutReviewHold"]) {
  const app = new Hono<SettlementApiEnv>();
  app.get("/accounts/:accountId/payout-review-hold", async (c) => {
    const actor = c.get("actor");
    if (!actor) return c.json({ error: { code: "authentication_required" } }, 401);
    // Operator grants only: seller payouts.view is self-scoped and must not read another account's hold.
    if (
      !actor.permissions.includes("payout-review-holds.manage") &&
      !actor.permissions.includes("payouts.platform.view")
    ) {
      return c.json({ error: { code: "authorization_forbidden" } }, 403);
    }
    return c.json(await services.get(c.req.param("accountId") as never));
  });
  app.post("/accounts/:accountId/payout-review-hold", async (c) => {
    const actor = c.get("actor");
    if (!actor) return c.json({ error: { code: "authentication_required" } }, 401);
    if (!actor.permissions.includes("payout-review-holds.manage"))
      return c.json({ error: { code: "authorization_forbidden" } }, 403);
    const body = await c.req.json().catch(() => ({}));
    const context = c.get("context");
    if (!context) return c.json({ error: { code: "authentication_required" } }, 401);
    try {
      const result = await services.place(
        {
          accountId: c.req.param("accountId") as never,
          reason: body.reason,
          source: "operator",
          sourceReference: body.sourceReference ?? null,
        },
        context,
      );
      return c.json(result, result.outcome === "placed" ? 201 : 200);
    } catch (error) {
      return c.json(
        { error: { code: "validation_failed", message: error instanceof Error ? error.message : String(error) } },
        400,
      );
    }
  });
  app.delete("/accounts/:accountId/payout-review-hold", async (c) => {
    const actor = c.get("actor");
    if (!actor) return c.json({ error: { code: "authentication_required" } }, 401);
    if (!actor.permissions.includes("payout-review-holds.manage"))
      return c.json({ error: { code: "authorization_forbidden" } }, 403);
    const body = await c.req.json().catch(() => ({}));
    const context = c.get("context");
    if (!context) return c.json({ error: { code: "authentication_required" } }, 401);
    try {
      const result = await services.release(
        {
          accountId: c.req.param("accountId") as never,
          reason: body.reason,
          source: "operator",
          sourceReference: body.sourceReference ?? null,
        },
        context,
      );
      return c.json(result);
    } catch (error) {
      return c.json(
        { error: { code: "validation_failed", message: error instanceof Error ? error.message : String(error) } },
        400,
      );
    }
  });
  return app;
}
