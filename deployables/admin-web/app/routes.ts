import {
  index,
  layout,
  route,
  type RouteConfig,
} from "@react-router/dev/routes";
import { toRouteConfigEntry } from "@chase-sets/platform-runtime/web-route-config";
import { resolveAdminWebRouteConfigRecords } from "./host";

const contextRoutes = resolveAdminWebRouteConfigRecords();
const catalogRootRoutes = contextRoutes
  .filter(
    (routeRecord) =>
      routeRecord.section === "catalog" &&
      (routeRecord.placement ?? "layout") === "root",
  )
  .map((routeRecord) =>
    toRouteConfigEntry(routeRecord, {
      index,
      route,
    }),
  );
const identityRootRoutes = contextRoutes
  .filter(
    (routeRecord) =>
      routeRecord.section === "identity" &&
      (routeRecord.placement ?? "layout") === "root",
  )
  .map((routeRecord) =>
    toRouteConfigEntry(routeRecord, {
      index,
      route,
    }),
  );
const catalogLayoutRoutes = contextRoutes
  .filter(
    (routeRecord) =>
      routeRecord.section === "catalog" &&
      (routeRecord.placement ?? "layout") === "layout",
  )
  .map((routeRecord) =>
    toRouteConfigEntry(routeRecord, {
      index,
      route,
    }),
  );
const identityLayoutRoutes = contextRoutes
  .filter(
    (routeRecord) =>
      routeRecord.section === "identity" &&
      (routeRecord.placement ?? "layout") === "layout",
  )
  .map((routeRecord) =>
    toRouteConfigEntry(routeRecord, {
      index,
      route,
    }),
  );

export default [
  route("/", "routes/index.tsx"),
  ...catalogRootRoutes,
  ...identityRootRoutes,
  layout("routes/catalog-layout.tsx", [
    route("catalog", "routes/catalog-home.tsx"),
    ...catalogLayoutRoutes,
  ]),
  layout("routes/identity-layout.tsx", [
    route("identity", "routes/identity-home.tsx"),
    ...identityLayoutRoutes,
  ]),
] satisfies RouteConfig;
