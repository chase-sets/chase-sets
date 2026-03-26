import { Hono } from "hono";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { CatalogServices } from "./services";
import { blueprintRoutes } from "./blueprints/route";
import { catalogItemRoutes } from "./catalog-items/route";
import { categoryRoutes } from "./categories/route";
import { componentRoutes } from "./components/route";
import { dimensionRoutes } from "./dimensions/route";
import { fieldRoutes } from "./fields/route";

export type CatalogAuthoringEnv = {
  Variables: {
    context: EventStoreContext;
  };
};

export function buildCatalogAuthoringApi(services: CatalogServices): Hono<CatalogAuthoringEnv> {
  const app = new Hono<CatalogAuthoringEnv>();

  app.route("/dimensions", dimensionRoutes(services.dimensions));
  app.route("/fields", fieldRoutes(services.fields));
  app.route("/components", componentRoutes(services.components));
  app.route("/blueprints", blueprintRoutes(services.blueprints));
  app.route("/categories", categoryRoutes(services.categories));
  app.route("/items", catalogItemRoutes(services.items));

  return app;
}