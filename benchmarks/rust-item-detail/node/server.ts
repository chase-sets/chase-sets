// Node baseline: mounts the production Discovery item-detail and category routes
// (same Hono routes, same query modules, same createPgPool and pool settings as
// platform-api) on @hono/node-server. Nothing here reimplements product logic.
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { createClient } from "redis";
import { createPgPool } from "../../../infrastructure/event-core-postgres/pool";
import { discoveryItemDetailRoutes } from "../../../bounded-contexts/discovery/features/item-detail/api/route";
import { discoveryCategoryRoutes } from "../../../bounded-contexts/discovery/features/categories/api/route";
import {
  getDiscoveryItemDetail,
  getDiscoveryItemDetailSellerOverlay,
} from "../../../bounded-contexts/discovery/features/item-detail/read-model/queries";
import {
  getDiscoveryCategoryBySlug,
  listDiscoveryCategories,
} from "../../../bounded-contexts/discovery/features/categories/read-model/queries";

const db = createPgPool(process.env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:55432/postgres?sslmode=disable", {
  max: Number(process.env.POOL_MAX ?? 10),
  idleTimeoutMillis: 30_000,
  idleInTransactionSessionTimeoutMillis: 15_000,
  connectionTimeoutMillis: 5_000,
});

const app = new Hono();

// Optional Redis cache-aside for public GETs (benchmark variant). Same key, TTL and
// rules as the Rust port: only 200 responses are cached; Redis errors fall through to Postgres.
const redisUrl = process.env.REDIS_URL;
const cacheTtl = Number(process.env.CACHE_TTL_SECONDS ?? 30);
if (redisUrl) {
  const redis = createClient({ url: redisUrl });
  redis.on("error", (error) => console.error("redis error", error));
  await redis.connect();
  app.use("/api/*", async (c, next) => {
    const key = `rb:${c.req.path}${new URL(c.req.url).search}`;
    const hit = await redis.get(key).catch(() => null);
    if (hit !== null) {
      return c.body(hit, 200, { "content-type": "application/json", "x-cache": "hit" });
    }
    await next();
    if (c.res.status === 200) {
      const body = await c.res.clone().text();
      await redis.set(key, body, { EX: cacheTtl }).catch(() => undefined);
      c.header("x-cache", "miss");
    }
  });
}
app.get("/health/live", (c) => c.json({ ok: true }));
app.route(
  "/api/discovery/items",
  discoveryItemDetailRoutes({
    getItemDetail: (id) => getDiscoveryItemDetail(db, id),
    getSellerOverlay: (params) => getDiscoveryItemDetailSellerOverlay(db, params),
    findSimilarItems: async () => null,
    projectors: [],
  }) as unknown as Hono,
);
app.route(
  "/api/discovery/categories",
  discoveryCategoryRoutes({
    listCategories: (params) => listDiscoveryCategories(db, params),
    getCategoryBySlug: (slug) => getDiscoveryCategoryBySlug(db, slug),
    projectors: [],
  }),
);

serve({ fetch: app.fetch, port: Number(process.env.PORT ?? 8080), hostname: "0.0.0.0" }, (info) => {
  console.log(`node item-detail bench listening on ${info.port}`);
});
