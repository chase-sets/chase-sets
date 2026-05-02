import { Hono } from "hono";
import type { InventoryApiEnv } from "../../../api";
import type { InventoryHoldServices } from "../../holds/api/runtime";
import type { InventoryItemServices } from "./runtime";

export function inventoryItemRoutes(
  items: InventoryItemServices,
  holds: InventoryHoldServices,
) {
  const app = new Hono<InventoryApiEnv>();

  app.get("/", async (c) => {
    const actor = c.get("actor");
    const limit = Number(c.req.query("limit") ?? 50);
    const offset = Number(c.req.query("offset") ?? 0);
    const result = await items.listItems({
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

  app.get("/:id", async (c) => {
    const actor = c.get("actor");
    const item = await items.getItem(c.req.param("id"), actor.accountId);

    if (!item) {
      return c.json({ error: { code: "not_found", message: "Inventory item not found." } }, 404);
    }

    return c.json(item);
  });

  app.post("/", async (c) => {
    const actor = c.get("actor");
    const body = await c.req.json();
    const result = await items.createItem(
      {
        accountId: actor.accountId as never,
        catalogItemId: String(body.catalogItemId ?? ""),
        selectedOptions: body.selectedOptions,
        gradedCard:
          typeof body.gradedCard === "object" && body.gradedCard !== null
            ? body.gradedCard
            : null,
        storageLocationId: String(body.storageLocationId ?? ""),
        totalQuantity: Number(body.totalQuantity ?? 0),
        acquisitionCostAmount:
          body.acquisitionCostAmount === null ||
          typeof body.acquisitionCostAmount === "undefined" ||
          String(body.acquisitionCostAmount).trim() === ""
            ? null
            : String(body.acquisitionCostAmount),
      },
      c.get("context"),
    );

      return c.json({ id: result.itemId, version: result.version, status: "created" }, 201);
  });

  app.post("/:id/adjustments", async (c) => {
    const actor = c.get("actor");
    const body = await c.req.json();
    const result = await items.adjustItem(
      {
        accountId: actor.accountId,
        itemId: c.req.param("id"),
        quantityDelta: Number(body.quantityDelta ?? 0),
        reason: String(body.reason ?? ""),
      },
      c.get("context"),
    );

      return c.json({ id: result.itemId, version: result.version, status: "adjusted" });
  });

  app.post("/:id/holds", async (c) => {
    const actor = c.get("actor");
    const body = await c.req.json();
    const result = await holds.createHold(
      {
        accountId: actor.accountId as never,
        itemId: c.req.param("id"),
        quantity: Number(body.quantity ?? 0),
        reason: String(body.reason ?? ""),
        notes: typeof body.notes === "string" ? body.notes : null,
      },
      c.get("context"),
    );

      return c.json({ id: result.holdId, version: result.version, status: "placed" }, 201);
  });

  return app;
}
