import { t } from "@chase-sets/localization";
import { Hono } from "hono";
import type { InventoryApiEnv } from "../../../api";
import type { RestockDecisionServices } from "./runtime";

export function inventoryRestockDecisionRoutes(restockDecisions: RestockDecisionServices) {
  const app = new Hono<InventoryApiEnv>();

  app.get("/", async (c) => {
    const actor = c.get("actor");
    const limit = Number(c.req.query("limit") ?? 50);
    const offset = Number(c.req.query("offset") ?? 0);
    const result = await restockDecisions.listPending({
      accountId: actor.accountId,
      limit,
      offset,
    });

    return c.json({
      items: result.items,
      total: result.total,
      count: result.items.length,
    });
  });

  app.post("/:id/decision", async (c) => {
    const actor = c.get("actor");
    const body = await c.req.json();
    const outcome = String(body.outcome ?? "");
    if (outcome !== "restocked" && outcome !== "written-off") {
      return c.json(
        {
          error: {
            code: "validation_failed",
            message: t("inventory.features.restockDecisions.api.route.unsupported.outcome"),
          },
        },
        400,
      );
    }

    const result = await restockDecisions.recordDecision(
      {
        accountId: actor.accountId,
        decisionId: c.req.param("id"),
        outcome,
        damageNote: typeof body.damageNote === "string" ? body.damageNote : null,
      },
      c.get("context"),
    );

    return c.json({ id: result.decisionId, version: result.version, status: "recorded" });
  });

  return app;
}
