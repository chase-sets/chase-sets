import { describe, expect, it } from "vitest";
import routeConfig from "./routes";
import { resolveMarketplaceRouteConfigRecords } from "./host";

type RouteEntry = Readonly<{
  file?: string;
  path?: string;
  children?: readonly RouteEntry[];
}>;

function flattenRouteConfig(entries: readonly RouteEntry[]): RouteEntry[] {
  return entries.flatMap((entry) => [entry, ...flattenRouteConfig(entry.children ?? [])]);
}

describe("marketplace route composition", () => {
  it("mounts every registry-driven route contribution in the thin deployable root", () => {
    const flattenedRoutes = flattenRouteConfig(routeConfig as readonly RouteEntry[]);
    const configuredFiles = new Set(
      flattenedRoutes
        .map((entry) => entry.file)
        .filter((file): file is string => typeof file === "string"),
    );
    const configuredPaths = new Set(
      flattenedRoutes
        .map((entry) => entry.path)
        .filter((routePath): routePath is string => typeof routePath === "string"),
    );

    for (const routeRecord of resolveMarketplaceRouteConfigRecords()) {
      expect(configuredFiles).toContain(routeRecord.file);

      if (routeRecord.routeType !== "index") {
        expect(configuredPaths).toContain(routeRecord.routePath);
      }
    }
  });
});
