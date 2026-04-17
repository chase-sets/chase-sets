import { Hono } from "hono";
import type { CommercialTermsApiEnv } from "../../../api";
import type { ResolutionServices } from "../../resolutions/api/runtime";
import type { ScheduleServices } from "./runtime";

function requireAccess(
  c: { get(key: "actor"): CommercialTermsApiEnv["Variables"]["actor"] },
  permission: "commercial-terms.view" | "commercial-terms.manage",
) {
  const actor = c.get("actor");
  if (!actor) {
    return {
      actor: null,
      response: new Response(JSON.stringify({ error: "Authentication required." }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      }),
    };
  }

  if (!actor.permissions.includes(permission)) {
    return {
      actor: null,
      response: new Response(JSON.stringify({ error: "Forbidden." }), {
        status: 403,
        headers: { "Content-Type": "application/json" },
      }),
    };
  }

  return { actor, response: null };
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Request failed.";
}

export function createScheduleRoutes(
  services: ScheduleServices,
  resolutions: ResolutionServices,
) {
  const app = new Hono<CommercialTermsApiEnv>();

  app.get("/", async (c) => {
    const access = requireAccess(c, "commercial-terms.view");
    if (access.response) {
      return access.response;
    }

    const limit = Number(c.req.query("limit") ?? 50);
    const offset = Number(c.req.query("offset") ?? 0);
    const result = await services.listSchedules({ limit, offset });

    return c.json({
      items: result.items,
      total: result.total,
      count: result.items.length,
    });
  });

  app.get("/:id", async (c) => {
    const access = requireAccess(c, "commercial-terms.view");
    if (access.response) {
      return access.response;
    }

    const schedule = await services.getSchedule(c.req.param("id"));
    if (!schedule) {
      return c.json({ error: "Schedule not found." }, 404);
    }

    return c.json(schedule);
  });

  app.post("/", async (c) => {
    const access = requireAccess(c, "commercial-terms.manage");
    if (access.response) {
      return access.response;
    }
    const context = c.get("context");
    if (!context) {
      return c.json({ error: "Authentication context missing." }, 401);
    }

    const body = await c.req.json();

    try {
      const result = await services.createSchedule(
        {
          label: String(body.label ?? ""),
          accountType: String(body.accountType ?? "") as never,
          marketplaceFeePercentageBps: Number(body.marketplaceFeePercentageBps ?? 0),
          marketplaceFeeFixedAmount: String(body.marketplaceFeeFixedAmount ?? ""),
          paymentFeePercentageBps: Number(body.paymentFeePercentageBps ?? 0),
          paymentFeeFixedAmount: String(body.paymentFeeFixedAmount ?? ""),
          status: String(body.status ?? "active") as never,
          effectiveFrom:
            typeof body.effectiveFrom === "string"
              ? body.effectiveFrom
              : new Date().toISOString(),
          effectiveUntil:
            typeof body.effectiveUntil === "string" && body.effectiveUntil.trim().length > 0
              ? body.effectiveUntil
              : null,
        },
        context,
      );

      const preview =
        typeof body.previewAmount === "string" && body.previewAmount.trim().length > 0
          ? await resolutions.previewListingTerms({
              sellerAccountId: access.actor.accountId,
              amount: body.previewAmount,
              effectiveAt: new Date().toISOString(),
            }).catch(() => null)
          : null;

      return c.json({ id: result.scheduleId, version: result.version, preview }, 201);
    } catch (error) {
      return c.json({ error: errorMessage(error) }, 400);
    }
  });

  return app;
}
