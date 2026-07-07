import { Hono } from "hono";
import { t } from "@chase-sets/localization";
import type { InventoryApiEnv } from "../../../api";
import { InventoryDomainError } from "../../../support/runtime-support/common";
import type { InventoryHoldServices } from "./runtime";

export function inventoryHoldRoutes(services: InventoryHoldServices) {
  const app = new Hono<InventoryApiEnv>();

  app.post("/:id/release", async (c) => {
    const actor = c.get("actor");
    let result: Awaited<ReturnType<InventoryHoldServices["releaseHold"]>>;
    try {
      result = await services.releaseHold(
        {
          accountId: actor.accountId,
          holdId: c.req.param("id"),
          releaseReason: "manual",
        },
        c.get("context"),
      );
    } catch (error) {
      if (
        error instanceof InventoryDomainError &&
        error.message === "Only manual inventory holds can be released by sellers."
      ) {
        return c.json(
          {
            error: {
              code: "inventory_hold_not_seller_releasable",
              message: t("inventory.features.holds.api.route.only.manual.holds.can.be.released.by.sellers"),
            },
          },
          400,
        );
      }
      throw error;
    }

    return c.json({
      id: result.holdId,
      version: result.version,
    });
  });

  return app;
}
