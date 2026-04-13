import { Hono } from "hono";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { CatalogServices } from "./services";
import { blueprintRoutes } from "../../features/blueprints/api/route";
import { catalogItemRoutes } from "../../features/catalog-items/api/route";
import { categoryRoutes } from "../../features/categories/api/route";
import { componentRoutes } from "../../features/components/api/route";
import { dimensionRoutes } from "../../features/dimensions/api/route";
import { fieldRoutes } from "../../features/fields/api/route";

export type CatalogAuthoringEnv = {
  Variables: {
    context: EventStoreContext;
  };
};

export function buildCatalogAuthoringApi(services: CatalogServices) {
  const app = new Hono<CatalogAuthoringEnv>();

  app.route("/dimensions", dimensionRoutes(services.dimensions));
  app.route("/fields", fieldRoutes(services.fields));
  app.route("/components", componentRoutes(services.components));
  app.route("/blueprints", blueprintRoutes(services.blueprints));
  app.route("/categories", categoryRoutes(services.categories));
  app.route("/items", catalogItemRoutes(services.items));

  return app;
}
