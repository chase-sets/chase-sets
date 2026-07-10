import { index, layout, route, type RouteConfig } from "@react-router/dev/routes";
import type { WebHostSection } from "@chase-sets/platform-runtime/web";
import { toRouteConfigEntry } from "@chase-sets/platform-runtime/web-route-config";
import { resolveAdminWebRouteConfigRecords } from "./host";

const contextRoutes = resolveAdminWebRouteConfigRecords();

const adminSections = [
  "access",
  "catalog",
  "commerce",
  "growth",
  "support",
  "platform",
] as const satisfies readonly WebHostSection[];

function sectionRoutes(section: WebHostSection, placement: "root" | "layout") {
  return contextRoutes
    .filter((routeRecord) => routeRecord.section === section && (routeRecord.placement ?? "layout") === placement)
    .map((routeRecord) =>
      toRouteConfigEntry(routeRecord, {
        index,
        route,
      }),
    );
}

export default [
  route("manifest.webmanifest", "routes/manifest.ts"),
  route("service-worker.js", "routes/service-worker.ts"),
  route("favicon.svg", "routes/favicon-svg.ts"),
  route("favicon.ico", "routes/favicon.ts"),
  route("health/ready", "routes/health-ready.ts"),
  route("health/live", "routes/health-live.ts"),
  route("offline", "routes/offline.tsx"),
  route("/", "routes/index.tsx"),
  ...adminSections.flatMap((section) => sectionRoutes(section, "root")),
  layout("routes/access-layout.tsx", [route("access", "routes/access-home.tsx"), ...sectionRoutes("access", "layout")]),
  layout("routes/catalog-layout.tsx", [
    route("catalog", "routes/catalog-home.tsx"),
    ...sectionRoutes("catalog", "layout"),
  ]),
  layout("routes/commerce-layout.tsx", [
    route("commerce", "routes/commerce-home.tsx"),
    ...sectionRoutes("commerce", "layout"),
  ]),
  layout("routes/growth-layout.tsx", [route("growth", "routes/growth-home.tsx"), ...sectionRoutes("growth", "layout")]),
  layout("routes/support-layout.tsx", [
    route("support", "routes/support-home.tsx"),
    ...sectionRoutes("support", "layout"),
  ]),
  layout("routes/platform-layout.tsx", [
    route("platform", "routes/platform-home.tsx"),
    ...sectionRoutes("platform", "layout"),
  ]),
] satisfies RouteConfig;
