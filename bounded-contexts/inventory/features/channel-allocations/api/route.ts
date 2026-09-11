import { Hono } from "hono";
import type { InventoryApiEnv } from "../../../api";
import type { InventoryChannelStockAllocationServices } from "./runtime";

export function inventoryChannelStockAllocationRoutes(services: InventoryChannelStockAllocationServices) {
  const app = new Hono<InventoryApiEnv>();

  app.get("/:itemId/channel-stock-allocation", async (c) => {
    const actor = c.get("actor");
    const allocation = await services.read({
      accountId: actor.accountId,
      inventoryItemId: c.req.param("itemId"),
    });
    return c.json({ allocation });
  });

  app.put("/:itemId/channel-stock-allocation", async (c) => {
    const actor = c.get("actor");
    const raw = await c.req.json();
    const body = typeof raw === "object" && raw !== null && !Array.isArray(raw) ? raw : { value: raw };
    const result = await services.set(
      {
        ...(body as Record<string, unknown>),
        accountId: actor.accountId,
        inventoryItemId: c.req.param("itemId"),
      } as never,
      c.get("context"),
    );
    if (result.kind === "refused") {
      return c.json({ error: result }, 409);
    }
    return c.json({ allocation: result.allocation });
  });

  return app;
}
