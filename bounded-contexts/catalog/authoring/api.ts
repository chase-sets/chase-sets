import { Hono } from "hono";
import type { EventStoreContext } from "../../../contracts/event-core/storage";
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

  app.route("/dimensions", dimensionRoutes(services));
  app.route("/fields", fieldRoutes(services));
  app.route("/components", componentRoutes(services));
  app.route("/blueprints", blueprintRoutes(services));
  app.route("/categories", categoryRoutes(services));
  app.route("/items", catalogItemRoutes(services));

  return app;
}
