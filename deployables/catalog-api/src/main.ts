import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { loadConfig } from "./config";
import { createPool } from "./infrastructure/postgres";
import { createCatalogServices } from "./infrastructure/wiring";
import { tenantContextMiddleware, type TenantContextEnv } from "./middleware/tenant-context";
import { errorHandler } from "./middleware/error-handler";
import { healthRoutes } from "./routes/health";
import { dimensionRoutes } from "./routes/dimensions";
import { fieldRoutes } from "./routes/fields";
import { componentRoutes } from "./routes/components";
import { blueprintRoutes } from "./routes/blueprints";
import { categoryRoutes } from "./routes/categories";
import { catalogItemRoutes } from "./routes/catalog-items";

const config = loadConfig();
const pool = createPool(config.databaseUrl);
const services = createCatalogServices(pool);

const app = new Hono<TenantContextEnv>();

app.onError(errorHandler);

app.route("/health", healthRoutes());

app.use("/api/*", tenantContextMiddleware);
app.route("/api/dimensions", dimensionRoutes(services));
app.route("/api/fields", fieldRoutes(services));
app.route("/api/components", componentRoutes(services));
app.route("/api/blueprints", blueprintRoutes(services));
app.route("/api/categories", categoryRoutes(services));
app.route("/api/catalog-items", catalogItemRoutes(services));

const PROJECTION_INTERVAL_MS = 1_000;

setInterval(async () => {
  for (const projector of services.projectors) {
    try {
      await projector.runOnce();
    } catch (error) {
      console.error("Projection error:", error);
    }
  }
}, PROJECTION_INTERVAL_MS);

serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`Catalog API listening on port ${info.port}`);
});
