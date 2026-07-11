import { t } from "@chase-sets/localization";
import { Hono } from "hono";
import type { DiscoveryBrowseServices } from "./runtime";

export function discoveryBrowseRoutes(services: DiscoveryBrowseServices) {
  const app = new Hono();

  app.get("/:slug", async (c) => {
    const setPage = await services.getSetBySlug(c.req.param("slug"));

    if (!setPage) {
      return c.json(
        { error: { code: "not_found", message: t("discovery.features.browse.api.route.set.not.found") } },
        404,
      );
    }

    return c.json(setPage);
  });

  return app;
}
