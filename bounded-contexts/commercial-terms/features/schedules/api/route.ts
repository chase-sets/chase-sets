import { t } from "@chase-sets/localization";
import { Hono } from "hono";
import type { CommercialTermsApiEnv } from "../../../api";
import {
  DEFAULT_SHIPPING_ALLOWANCE_PERCENTAGE_BPS,
  normalizeCommercialAccountType,
  normalizeCommercialTermsStatus,
} from "../../../support/runtime-support/common";
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
      response: new Response(
        JSON.stringify({
          error: {
            code: "authentication_required",
            message: t("commercialTerms.features.schedules.api.route.authentication.required"),
          },
        }),
        {
          status: 401,
          headers: { "Content-Type": "application/json" },
        },
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
            message: t("commercialTerms.features.schedules.api.route.forbidden"),
          },
        }),
        {
          status: 403,
          headers: { "Content-Type": "application/json" },
        },
      ),
    };
  }

  return { actor, response: null };
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : t("commercialTerms.features.schedules.api.route.request.failed");
}

function scheduleCommandBody(body: Record<string, unknown>) {
  return {
    label: String(body.label ?? ""),
    marketplaceSalesFeePercentageBps: Number(body.marketplaceSalesFeePercentageBps ?? 0),
    marketplaceSalesFeeFixedAmount: String(body.marketplaceSalesFeeFixedAmount ?? ""),
    shippingAllowancePercentageBps: Number(
      body.shippingAllowancePercentageBps ?? DEFAULT_SHIPPING_ALLOWANCE_PERCENTAGE_BPS,
    ),
    status: normalizeCommercialTermsStatus(String(body.status ?? "active")),
    effectiveFrom: typeof body.effectiveFrom === "string" ? body.effectiveFrom : new Date().toISOString(),
    effectiveUntil:
      typeof body.effectiveUntil === "string" && body.effectiveUntil.trim().length > 0 ? body.effectiveUntil : null,
  };
}

export function createScheduleRoutes(services: ScheduleServices, resolutions: ResolutionServices) {
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
      return c.json(
        { error: { code: "not_found", message: t("commercialTerms.features.schedules.api.route.schedule.not.found") } },
        404,
      );
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
      return c.json(
        {
          error: {
            code: "authentication_required",
            message: t("commercialTerms.features.schedules.api.route.authentication.context.missing"),
          },
        },
        401,
      );
    }

    const body = await c.req.json();

    try {
      const result = await services.createSchedule(
        {
          ...scheduleCommandBody(body),
          accountType: normalizeCommercialAccountType(String(body.accountType ?? "")),
          createdByUserId: access.actor.userId,
        },
        context,
      );

      const preview =
        typeof body.previewAmount === "string" && body.previewAmount.trim().length > 0
          ? await resolutions
              .previewListingTerms({
                accountId: access.actor.accountId,
                amount: body.previewAmount,
                effectiveAt: new Date().toISOString(),
              })
              .catch(() => null)
          : null;

      return c.json({ id: result.scheduleId, version: result.version, preview }, 201);
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
            message: t("commercialTerms.features.schedules.api.route.authentication.context.missing"),
          },
        },
        401,
      );
    }

    const body = await c.req.json();

    try {
      const result = await services.reviseSchedule(
        c.req.param("id"),
        {
          ...scheduleCommandBody(body),
          revisedByUserId: access.actor.userId,
        },
        context,
      );
      return c.json({ id: result.scheduleId, version: result.version });
    } catch (error) {
      return c.json({ error: { code: "validation_failed", message: errorMessage(error) } }, 400);
    }
  });

  return app;
}
