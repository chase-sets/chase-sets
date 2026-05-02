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

type RouteConfigIndexOptions = Pick<RouteConfigEntry, "id">;
type RouteConfigRouteOptions = Pick<RouteConfigEntry, "id" | "index" | "caseSensitive">;

type RouteConfigRouteHelper = {
  (routePath: string | null | undefined, file: string, children?: RouteConfigEntry[]): RouteConfigEntry;
  (
    routePath: string | null | undefined,
    file: string,
    options: RouteConfigRouteOptions,
    children?: RouteConfigEntry[],
  ): RouteConfigEntry;
};

function toRouteConfigId(route: WebHostRouteRecord) {
  return [
    route.contextName,
    route.section,
    route.routeId,
  ].filter(Boolean).join("/");
}

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
    index: (file: string, options?: RouteConfigIndexOptions) => RouteConfigEntry;
    route: RouteConfigRouteHelper;
  }>,
): RouteConfigEntry {
  const id = toRouteConfigId(route);

  if (route.routeType === "index") {
    return helpers.index(route.file, { id });
  }

  return helpers.route(route.routePath, route.file, { id });
}
