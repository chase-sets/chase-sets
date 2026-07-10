import { index, layout, route, type RouteConfig } from "@react-router/dev/routes";
import { toRouteConfigEntry } from "@chase-sets/platform-runtime/web-route-config";
import { resolveMarketplaceRouteConfigRecords } from "./host";

const contextRoutes = resolveMarketplaceRouteConfigRecords();
const rootContextRoutes = contextRoutes
  .filter((routeRecord) => (routeRecord.placement ?? "layout") === "root")
  .map((routeRecord) =>
    toRouteConfigEntry(routeRecord, {
      index,
      route,
    }),
  );
const layoutContextRoutes = contextRoutes
  .filter((routeRecord) => (routeRecord.placement ?? "layout") === "layout")
  .map((routeRecord) =>
    toRouteConfigEntry(routeRecord, {
      index,
      route,
    }),
  );

export default [
  ...rootContextRoutes,
  route("manifest.webmanifest", "routes/manifest.ts"),
  route("service-worker.js", "routes/service-worker.ts"),
  route("favicon.svg", "routes/favicon-svg.ts"),
  route("favicon.ico", "routes/favicon.ts"),
  route(".well-known/appspecific/com.chrome.devtools.json", "routes/chrome-devtools.ts"),
  route("robots.txt", "routes/robots.ts"),
  route("sitemap.xml", "routes/sitemap.ts"),
  route("health/ready", "routes/health-ready.ts"),
  route("health/live", "routes/health-live.ts"),
  route("analytics/item-detail-rail", "routes/item-detail-rail-analytics.ts"),
  route("offline", "routes/offline.tsx"),
  layout("routes/layout.tsx", [index("routes/index.tsx"), ...layoutContextRoutes, route("*", "routes/not-found.tsx")]),
] satisfies RouteConfig;
