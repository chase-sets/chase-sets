import { describe, expect, it } from "vitest";
import { webContextRegistry } from "../context-registry";

type RouteContribution = Readonly<{
  routeId: string;
  routePath: string;
  fileExport: string;
  sourceContext: string;
}>;

function marketplaceRoutes() {
  return webContextRegistry.flatMap((entry) =>
    (entry.manifest.deployableContributions ?? [])
      .filter((contribution) => contribution.deployable === "marketplace-web")
      .flatMap((contribution) =>
        (contribution.routes ?? []).map((route) => ({
          routeId: route.routeId,
          routePath: route.routePath,
          fileExport: route.fileExport,
          sourceContext: route.sourceContext,
        })),
      ),
  ) as RouteContribution[];
}

describe("marketplace checkout and payment composition", () => {
  it("composes marketplace route contributions from bounded context manifests", () => {
    const routes = marketplaceRoutes();

    expect(routes.length).toBeGreaterThan(0);
    expect([...new Set(routes.map((route) => route.sourceContext))]).toEqual(
      expect.arrayContaining(["auth", "checkout", "payments"]),
    );
    expect(routes.every((route) => route.routeId && route.routePath && route.fileExport && route.sourceContext)).toBe(
      true,
    );
    expect(new Set(routes.map((route) => route.routeId)).size).toBe(routes.length);
  });
});
