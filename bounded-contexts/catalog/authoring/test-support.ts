import pg from "pg";
import { Hono } from "hono";
import type { EventStoreContext } from "../../../contracts/event-core/storage";
import type { PgTransactionalPool } from "../../../contracts/event-core/postgres/types";
import { buildCatalogAuthoringApi, type CatalogAuthoringEnv } from "./api";
import type { CatalogServices } from "./services";

export function createCatalogAuthoringTestPool(connectionString: string): PgTransactionalPool {
  return new pg.Pool({ connectionString }) as unknown as PgTransactionalPool;
}

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
