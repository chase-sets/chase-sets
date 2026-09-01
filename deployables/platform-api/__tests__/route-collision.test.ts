import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { assertApiRouteTableHasNoCollisions } from "@chase-sets/bounded-context-runtime";
import { resolveApiHostMounts } from "@chase-sets/platform-runtime/api";
import { module as platformOperationsModule } from "@chase-sets/platform-operations";
import { buildPlatformApiApp } from "../src/app";
import { createRouteInventoryRuntime, createServiceProxy } from "./route-inventory-test-support";

type PublicRoute = Readonly<{ method: string; path: string }>;

function verifyMountedTail(routes: readonly PublicRoute[], expected: readonly PublicRoute[]): void {
  const actual = routes.slice(-expected.length).map(({ method, path }) => ({ method, path }));
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`Mounted route block is not the complete contiguous tail: ${JSON.stringify(actual)}.`);
  }
}

function createPlatformOperationsServiceProxy(includeRiskAlerts: boolean) {
  const proxy = new Proxy(() => proxy, {
    get(_target, property) {
      if (property === "then") {
        return undefined;
      }
      if (property === "riskAlerts") {
        return includeRiskAlerts ? createServiceProxy() : undefined;
      }
      return createServiceProxy();
    },
  });
  return proxy;
}

describe("platform API route collision assembly", () => {
  it("boots all contexts with all 30 API entries using the exact closed keyed shape", () => {
    const runtime = createRouteInventoryRuntime();
    const rawEntries = runtime.mountedContexts.flatMap((entry) =>
      Reflect.apply(entry.module.buildApis, entry.module, [entry.services]),
    );

    expect(rawEntries).toHaveLength(30);
    for (const apiEntry of rawEntries) {
      expect(Reflect.ownKeys(apiEntry)).toEqual(["mountPath", "contextMountOrdinal", "router"]);
    }

    const mounts = Reflect.apply(resolveApiHostMounts, undefined, [runtime]);
    const report = assertApiRouteTableHasNoCollisions(mounts);
    expect(report).toEqual({ scanned: 30, total: 30, routeCount: 767, duplicateGroups: [] });
    console.info(
      `route-collision-census candidate entryShape=keyed rows=${rawEntries.length}/30 scanned=${report.scanned}/${report.total} routes=${report.routeCount} groups=${report.duplicateGroups.length}`,
    );

    const app = Reflect.apply(buildPlatformApiApp, undefined, [runtime]);
    expect(app.routes.length).toBeGreaterThan(report.routeCount);
  });

  it("keeps observability and mount middleware ahead of the complete mounted-router tail", () => {
    const authRouter = new Hono().get("/session", (context) => context.json({ ok: true }));
    const catalogRouter = new Hono().get("/items", (context) => context.json({ items: [] }));
    const authModule = {
      contextName: "auth",
      apiMounts: [{ mountPath: "/api/auth", kind: "primary", requiresAuth: false }],
      buildApis: () => [{ mountPath: "/api/auth", contextMountOrdinal: 1, router: authRouter }],
      projectionHandlerSets: () => [],
    };
    const catalogModule = {
      contextName: "catalog",
      apiMounts: [{ mountPath: "/api/catalog", kind: "primary", requiresAuth: true }],
      buildApis: () => [{ mountPath: "/api/catalog", contextMountOrdinal: 1, router: catalogRouter }],
      projectionHandlerSets: () => [],
    };
    const mountedContexts = [
      {
        contextName: "auth",
        mountRole: "active",
        module: authModule,
        services: createServiceProxy(),
        pool: createServiceProxy(),
        projectionHandlerSets: [],
      },
      {
        contextName: "catalog",
        mountRole: "active",
        module: catalogModule,
        services: createServiceProxy(),
        pool: createServiceProxy(),
        projectionHandlerSets: [],
      },
    ];
    const runtime = {
      mountedContexts,
      mountedModules: mountedContexts.map(({ module, services }) => ({ module, services })),
      services: { auth: createServiceProxy(), catalog: createServiceProxy(), identity: createServiceProxy() },
      projectionGroups: [],
      subscriptionRunners: [],
    };
    const app = Reflect.apply(buildPlatformApiApp, undefined, [runtime, { runtimeProfile: "landing" }]);
    const expectedMountedTail = [
      { method: "GET", path: "/api/auth/session" },
      { method: "GET", path: "/api/catalog/items" },
    ];

    verifyMountedTail(app.routes, expectedMountedTail);
    const mountMiddlewareSequence = app.routes
      .slice(0, -expectedMountedTail.length)
      .filter(
        (route: PublicRoute) =>
          route.method === "ALL" && (route.path === "/api/auth/*" || route.path === "/api/catalog/*"),
      )
      .map((route: PublicRoute) => route.path);
    expect(mountMiddlewareSequence).toEqual([
      "/api/auth/*",
      "/api/catalog/*",
      "/api/catalog/*",
      "/api/auth/*",
      "/api/catalog/*",
      "/api/auth/*",
      "/api/catalog/*",
    ]);
    expect(app.routes[0]).toMatchObject({ method: "ALL", path: "/*" });
  });

  it("rejects the assembly mutant that mounts a router before read-consistency middleware", () => {
    const mutant = new Hono();
    mutant.get("/api/example/mounted", (context) => context.text("mounted"));
    mutant.use("/api/example/*", async (_context, next) => next());

    expect(() => verifyMountedTail(mutant.routes, [{ method: "GET", path: "/api/example/mounted" }])).toThrow(
      "Mounted route block is not the complete contiguous tail",
    );
  });

  it("preserves the platform-operations optional risk-alert route surface", () => {
    const withoutRiskAlerts = Reflect.apply(platformOperationsModule.buildApis, platformOperationsModule, [
      createPlatformOperationsServiceProxy(false),
    ]);
    const withRiskAlerts = Reflect.apply(platformOperationsModule.buildApis, platformOperationsModule, [
      createPlatformOperationsServiceProxy(true),
    ]);
    const experiencePaths = (entries: typeof withRiskAlerts) =>
      entries[1].router.routes.map((route: PublicRoute) => route.path);

    expect(experiencePaths(withoutRiskAlerts).some((path: string) => path.startsWith("/risk-alerts"))).toBe(false);
    expect(experiencePaths(withRiskAlerts).some((path: string) => path.startsWith("/risk-alerts"))).toBe(true);
  });
});
