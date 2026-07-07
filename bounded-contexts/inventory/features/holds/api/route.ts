import { Hono } from "hono";
import type { InventoryApiEnv } from "../../../api";
import type { InventoryHoldServices } from "./runtime";

export function inventoryHoldRoutes(services: InventoryHoldServices) {
  const app = new Hono<InventoryApiEnv>();

  app.post("/:id/release", async (c) => {
    const actor = c.get("actor");
    const result = await services.releaseHold(
      {
        accountId: actor.accountId,
        holdId: c.req.param("id"),
        releaseReason: "manual",
      },
      c.get("context"),
    );

    return c.json({
      id: result.holdId,
      version: result.version,
    });
  });

  return app;
}
