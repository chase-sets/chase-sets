import { Hono } from "hono";
import type { CatalogAuthoringEnv } from "./types";
import type { CatalogServices } from "./services";
import { dimensionRoutes } from "../dimensions/route";
import { fieldRoutes } from "../fields/route";
import { componentRoutes } from "../components/route";
import { blueprintRoutes } from "../blueprints/route";
import { categoryRoutes } from "../categories/route";
import { catalogItemRoutes } from "../catalog-items/route";

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

