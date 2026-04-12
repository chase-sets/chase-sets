import type { RouteConfigEntry } from "@react-router/dev/routes";
import {
  resolveWebHostRouteRecords,
  type WebContextRegistry,
  type WebHostName,
  type WebHostRouteRecord,
} from "./web";

export type HostRouteConfigRecord = Readonly<
  WebHostRouteRecord & {
    file: string;
  }
>;

function toRouteSourceFile(contextName: string, fileExport: string) {
  return `../../../bounded-contexts/${contextName}/${fileExport.replace(/^\.\//, "")}.tsx`;
}

export function resolveWebHostRouteConfigRecords(
  registry: WebContextRegistry,
  hostName: WebHostName,
  _options: Readonly<{
    appDirectory?: string;
    deployableRoot?: string;
    repoRoot?: string;
  }> = {},
): readonly HostRouteConfigRecord[] {
  return resolveWebHostRouteRecords(registry, hostName).map((route) => ({
    ...route,
    file: toRouteSourceFile(route.contextName, route.fileExport),
  }));
}

export function toRouteConfigEntry(
  route: HostRouteConfigRecord,
  helpers: Readonly<{
    index: (file: string) => RouteConfigEntry;
    route: (routePath: string, file: string) => RouteConfigEntry;
  }>,
): RouteConfigEntry {
  if (route.routeType === "index") {
    return helpers.index(route.file);
  }

  return helpers.route(route.routePath, route.file);
}
