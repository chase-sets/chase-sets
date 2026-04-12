import {
  index,
  layout,
  route,
  type RouteConfig,
} from "@react-router/dev/routes";
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
  route("favicon.ico", "routes/favicon.ts"),
  route(
    ".well-known/appspecific/com.chrome.devtools.json",
    "routes/chrome-devtools.ts",
  ),
  route("robots.txt", "routes/robots.ts"),
  route("sitemap.xml", "routes/sitemap.ts"),
  layout("routes/layout.tsx", [
    index("routes/index.tsx"),
    ...layoutContextRoutes,
  ]),
] satisfies RouteConfig;
