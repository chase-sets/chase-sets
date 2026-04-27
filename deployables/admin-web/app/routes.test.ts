import { describe, expect, it } from "vitest";
import routeConfig from "./routes";
import { resolveAdminWebRouteConfigRecords } from "./host";
import { loader as faviconLoader } from "./routes/favicon";

type RouteEntry = Readonly<{
  file?: string;
  path?: string;
  children?: readonly RouteEntry[];
}>;

function flattenRouteConfig(entries: readonly RouteEntry[]): RouteEntry[] {
  return entries.flatMap((entry) => [entry, ...flattenRouteConfig(entry.children ?? [])]);
}

describe("admin web route composition", () => {
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

    expect(configuredPaths).toContain("favicon.svg");
    expect(configuredPaths).toContain("favicon.ico");

    for (const routeRecord of resolveAdminWebRouteConfigRecords()) {
      expect(configuredFiles).toContain(routeRecord.file);

      if (routeRecord.routeType !== "index") {
        expect(configuredPaths).toContain(routeRecord.routePath);
      }
    }
  });

  it("serves the shared Chase Sets favicon", async () => {
    const response = faviconLoader({
      request: new Request("https://admin.example/favicon.svg"),
      params: {},
      context: undefined,
    } as never);

    expect(response.headers.get("Content-Type")).toContain("image/svg+xml");
    await expect(response.text()).resolves.toContain("logoGradient");
  });
});
