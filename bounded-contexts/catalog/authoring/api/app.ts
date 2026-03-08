import { Hono } from "hono";
import type { CatalogAuthoringEnv } from "./types";
import type { CatalogServices } from "./services";
import { dimensionRoutes } from "./routes/dimensions";
import { fieldRoutes } from "./routes/fields";
import { componentRoutes } from "./routes/components";
import { blueprintRoutes } from "./routes/blueprints";
import { categoryRoutes } from "./routes/categories";
import { catalogItemRoutes } from "./routes/catalog-items";

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
