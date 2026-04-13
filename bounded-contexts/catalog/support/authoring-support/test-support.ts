import { Hono } from "hono";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import { buildCatalogAuthoringApi, type CatalogAuthoringEnv } from "./api";
import type { CatalogServices } from "./services";

export function buildCatalogAuthoringTestApp(
  services: CatalogServices,
  context: EventStoreContext,
): Hono<CatalogAuthoringEnv> {
  const app = new Hono<CatalogAuthoringEnv>();

  app.use("/api/catalog/*", async (c, next) => {
    c.set("context", context);
    await next();
  });
  app.route("/api/catalog", buildCatalogAuthoringApi(services));

  return app;
}

