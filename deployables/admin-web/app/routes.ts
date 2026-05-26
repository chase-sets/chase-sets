import { index, layout, route, type RouteConfig } from "@react-router/dev/routes";
import { toRouteConfigEntry } from "@chase-sets/platform-runtime/web-route-config";
import { resolveAdminWebRouteConfigRecords } from "./host";

const contextRoutes = resolveAdminWebRouteConfigRecords();
const catalogRootRoutes = contextRoutes
  .filter((routeRecord) => routeRecord.section === "catalog" && (routeRecord.placement ?? "layout") === "root")
  .map((routeRecord) =>
    toRouteConfigEntry(routeRecord, {
      index,
      route,
    }),
  );
const identityRootRoutes = contextRoutes
  .filter((routeRecord) => routeRecord.section === "identity" && (routeRecord.placement ?? "layout") === "root")
  .map((routeRecord) =>
    toRouteConfigEntry(routeRecord, {
      index,
      route,
    }),
  );
const experienceRootRoutes = contextRoutes
  .filter((routeRecord) => routeRecord.section === "experience" && (routeRecord.placement ?? "layout") === "root")
  .map((routeRecord) =>
    toRouteConfigEntry(routeRecord, {
      index,
      route,
    }),
  );
const operationsRootRoutes = contextRoutes
  .filter((routeRecord) => routeRecord.section === "operations" && (routeRecord.placement ?? "layout") === "root")
  .map((routeRecord) =>
    toRouteConfigEntry(routeRecord, {
      index,
      route,
    }),
  );
const catalogLayoutRoutes = contextRoutes
  .filter((routeRecord) => routeRecord.section === "catalog" && (routeRecord.placement ?? "layout") === "layout")
  .map((routeRecord) =>
    toRouteConfigEntry(routeRecord, {
      index,
      route,
    }),
  );
const identityLayoutRoutes = contextRoutes
  .filter((routeRecord) => routeRecord.section === "identity" && (routeRecord.placement ?? "layout") === "layout")
  .map((routeRecord) =>
    toRouteConfigEntry(routeRecord, {
      index,
      route,
    }),
  );
const experienceLayoutRoutes = contextRoutes
  .filter((routeRecord) => routeRecord.section === "experience" && (routeRecord.placement ?? "layout") === "layout")
  .map((routeRecord) =>
    toRouteConfigEntry(routeRecord, {
      index,
      route,
    }),
  );

export default [
  route("manifest.webmanifest", "routes/manifest.ts"),
  route("service-worker.js", "routes/service-worker.ts"),
  route("favicon.svg", "routes/favicon-svg.ts"),
  route("favicon.ico", "routes/favicon.ts"),
  route("health/ready", "routes/health-ready.ts"),
  route("offline", "routes/offline.tsx"),
  route("/", "routes/index.tsx"),
  ...catalogRootRoutes,
  ...identityRootRoutes,
  ...experienceRootRoutes,
  layout("routes/operations-layout.tsx", [...operationsRootRoutes]),
  layout("routes/catalog-layout.tsx", [route("catalog", "routes/catalog-home.tsx"), ...catalogLayoutRoutes]),
  layout("routes/identity-layout.tsx", [route("identity", "routes/identity-home.tsx"), ...identityLayoutRoutes]),
  layout("routes/experience-layout.tsx", [
    route("experience", "routes/experience-home.tsx"),
    ...experienceLayoutRoutes,
  ]),
] satisfies RouteConfig;
