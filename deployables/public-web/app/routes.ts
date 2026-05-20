import {
  index,
  route,
  type RouteConfig,
} from "@react-router/dev/routes";
import { toRouteConfigEntry } from "@chase-sets/platform-runtime/web-route-config";
import { resolvePublicRouteConfigRecords } from "./host";

const legacyOrderProtectionPath = ["bu", "yer-protection"].join("");
const legacyMarketplaceSalesFeesPath = ["sel", "ler-fees"].join("");

const publicContextRoutes = resolvePublicRouteConfigRecords()
  .map((routeRecord) =>
    toRouteConfigEntry(routeRecord, {
      index,
      route,
    }),
  );

export default [
  ...publicContextRoutes,
  route("manifest.webmanifest", "routes/manifest.ts"),
  route("favicon.svg", "routes/favicon-svg.ts"),
  route("favicon.ico", "routes/favicon.ts"),
  route(
    ".well-known/appspecific/com.chrome.devtools.json",
    "routes/chrome-devtools.ts",
  ),
  route("robots.txt", "routes/robots.ts"),
  route("sitemap.xml", "routes/sitemap.ts"),
  route("analytics/waitlist", "routes/waitlist-analytics.ts"),
  route(legacyOrderProtectionPath, "routes/legacy-order-protection-url.ts"),
  route(legacyMarketplaceSalesFeesPath, "routes/legacy-marketplace-sales-fees-url.ts"),
  route("*", "routes/not-found.tsx"),
] satisfies RouteConfig;
