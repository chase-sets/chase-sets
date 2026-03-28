import pg from "pg";
import { Hono } from "hono";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { buildIdentityApi, type IdentityApiEnv } from "./api";
import type { IdentityServices } from "./services";

export function createIdentityTestPool(connectionString: string): PgTransactionalPool {
  return new pg.Pool({ connectionString }) as unknown as PgTransactionalPool;
}

export function buildIdentityTestApp(
  services: IdentityServices,
  context: EventStoreContext,
): Hono<IdentityApiEnv> {
  const app = new Hono<IdentityApiEnv>();
  app.use("/api/identity/*", async (c, next) => {
    c.set("context", context);
    c.set("actor", null);
    await next();
  });
  app.route("/api/identity", buildIdentityApi(services));
  return app;
}
