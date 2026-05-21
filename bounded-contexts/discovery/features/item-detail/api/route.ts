import { t } from "@chase-sets/localization";
import { Hono } from "hono";
import type { DiscoveryItemDetailServices } from "./runtime";

export function discoveryItemDetailRoutes(services: DiscoveryItemDetailServices) {
  const app = new Hono();

  app.get("/:id", async (c) => {
    const item = await services.getItemDetail(c.req.param("id"));

    if (!item) {
      return c.json(
        { error: { code: "not_found", message: t("discovery.features.itemDetail.api.route.item.not.found") } },
        404,
      );
    }

    return c.json(item);
  });

  return app;
}
