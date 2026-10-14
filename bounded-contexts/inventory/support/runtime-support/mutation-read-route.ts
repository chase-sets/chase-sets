import { Hono } from "hono";
import type { InventoryApiEnv } from "../../api";
import type { createInventoryMutationRuntime } from "./mutation-attempt";

export function inventoryMutationReadRoutes(
  mutations: Pick<ReturnType<typeof createInventoryMutationRuntime>, "read">,
) {
  const app = new Hono<InventoryApiEnv>();
  app.get("/:id", async (c) => {
    c.header("Cache-Control", "private, no-store");
    const actor = c.get("actor");
    const context = c.get("context");
    if (!actor || !context || context.audit.forAccountId !== actor.accountId || !context.audit.performedByUserId) {
      return c.json(
        { error: { code: "inventory_attempt_unavailable", message: "Inventory result is unavailable." } },
        404,
      );
    }
    try {
      const receipt = await mutations.read(c.req.param("id"), context);
      if (!receipt)
        return c.json(
          { error: { code: "inventory_attempt_unavailable", message: "Inventory result is unavailable." } },
          404,
        );
      return c.json(receipt, 200, { "Cache-Control": "private, no-store" });
    } catch {
      return c.json(
        { error: { code: "inventory_attempt_unavailable", message: "Inventory result is unavailable." } },
        404,
      );
    }
  });
  return app;
}
