import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { assertApiRouteTableHasNoCollisions, type ResolvedApiMount } from "@chase-sets/bounded-context-runtime";
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

type AssemblyRuntime = Readonly<{
  mountedContexts: readonly Readonly<{
    contextName: string;
    services: unknown;
    module: Readonly<{ apiMounts: readonly Readonly<{ mountPath: string }>[]; buildApis: unknown }>;
  }>[];
}>;

function observeApiAssembly(runtime: AssemblyRuntime) {
  const entries = runtime.mountedContexts.flatMap(({ contextName, module, services }) => {
    if (typeof module.buildApis !== "function") {
      throw new Error(`${contextName} must publish buildApis.`);
    }
    const rawEntries = Reflect.apply(module.buildApis, module, [services]) as readonly Readonly<{
      mountPath: string;
      contextMountOrdinal: number;
      router: Hono;
    }>[];
    for (const entry of rawEntries) {
      expect(Reflect.ownKeys(entry)).toEqual(["mountPath", "contextMountOrdinal", "router"]);
    }
    expect(rawEntries.map(({ mountPath, contextMountOrdinal }) => ({ mountPath, contextMountOrdinal }))).toEqual(
      module.apiMounts.map(({ mountPath }, index) => ({ mountPath, contextMountOrdinal: index + 1 })),
    );
    return rawEntries.map((entry) => ({ ...entry, contextName }));
  });
  const assembly = new Hono();
  for (const entry of entries) {
    assembly.route(entry.mountPath, entry.router);
  }
  return { entries, mountedRoutes: assembly.routes.map(({ method, path }) => ({ method, path })) };
}

function verifyCompleteRouteCensus(
  mounts: readonly ResolvedApiMount[],
  observed: ReturnType<typeof observeApiAssembly>,
) {
  const identity = ({
    contextName,
    mountPath,
    contextMountOrdinal,
  }: Pick<ResolvedApiMount, "contextName" | "mountPath" | "contextMountOrdinal">) => ({
    contextName,
    mountPath,
    contextMountOrdinal,
  });
  expect(mounts.map(identity), "complete declared mount coverage").toEqual(observed.entries.map(identity));
  const report = assertApiRouteTableHasNoCollisions(mounts);
  expect(report, "complete scan coverage against independently mounted module entries").toEqual({
    scanned: observed.entries.length,
    total: observed.entries.length,
    routeCount: observed.mountedRoutes.length,
    duplicateGroups: [],
  });
  return report;
}

function createCensusRuntime(additionalEntry = false) {
  const runtime = createRouteInventoryRuntime();
  if (!additionalEntry) {
    return runtime;
  }
  const auth = runtime.mountedContexts.find((entry) => entry.contextName === "auth");
  if (!auth) {
    throw new Error("The discovery control requires the registered Auth context.");
  }
  const mountPath = "/api/census-control";
  const module = {
    ...auth.module,
    apiMounts: [...auth.module.apiMounts, { mountPath, kind: "additional" as const, requiresAuth: false }],
    buildApis: (services: unknown) => {
      const entries = Reflect.apply(auth.module.buildApis, auth.module, [services]);
      return [
        ...entries,
        { mountPath, contextMountOrdinal: entries.length + 1, router: new Hono().get("/unique", (c) => c.text("ok")) },
      ];
    },
  };
  const mountedContexts = runtime.mountedContexts.map((entry) => (entry === auth ? { ...entry, module } : entry));
  return {
    ...runtime,
    mountedContexts,
    mountedModules: mountedContexts.map(({ module, services }) => ({ module, services })),
  };
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
  it.each([false, true])(
    "boots all discovered API entries with closed keyed shape and complete coverage (additional entry: %s)",
    (additionalEntry) => {
      const runtime = createCensusRuntime(additionalEntry);
      const observed = observeApiAssembly(runtime);
      const mounts = Reflect.apply(resolveApiHostMounts, undefined, [runtime]);
      const report = verifyCompleteRouteCensus(mounts, observed);
      console.info(
        `route-collision-census candidate entryShape=keyed rows=${observed.entries.length} scanned=${report.scanned}/${report.total} routes=${report.routeCount} groups=${report.duplicateGroups.length}`,
      );

      const app = Reflect.apply(buildPlatformApiApp, undefined, [runtime]);
      expect(app.routes.length).toBeGreaterThan(report.routeCount);
      verifyMountedTail(app.routes, observed.mountedRoutes);
      if (additionalEntry) {
        expect(observed.mountedRoutes).toContainEqual({ method: "GET", path: "/api/census-control/unique" });
        expect(app.routes).toEqual(
          expect.arrayContaining([expect.objectContaining({ method: "GET", path: "/api/census-control/unique" })]),
        );
      }
      expect(app.routes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ method: "GET", path: "/api/catalog/operator-session" }),
          expect.objectContaining({ method: "POST", path: "/api/catalog/operator-session/grant" }),
          expect.objectContaining({ method: "DELETE", path: "/api/catalog/operator-session" }),
          expect.objectContaining({ method: "PUT", path: "/api/public/catalog/operator-session/tcgplayer" }),
          expect.objectContaining({ method: "DELETE", path: "/api/public/catalog/operator-session/grant" }),
          expect.objectContaining({ method: "GET", path: "/api/marketplace/account/offer-policies" }),
          expect.objectContaining({ method: "GET", path: "/api/marketplace/account/offer-policies/:id" }),
          expect.objectContaining({ method: "POST", path: "/api/marketplace/account/offer-policies/:id/commands" }),
          expect.objectContaining({ method: "GET", path: "/api/channels/connections/:connectionId/attention" }),
          expect.objectContaining({ method: "GET", path: "/api/channels/connections/:connectionId/drift" }),
          expect.objectContaining({
            method: "POST",
            path: "/api/channels/connections/:connectionId/drift/:channelListingId/accept",
          }),
          expect.objectContaining({
            method: "POST",
            path: "/api/channels/connections/:connectionId/drift/:channelListingId/repush",
          }),
          expect.objectContaining({
            method: "POST",
            path: "/api/channels/connections/:connectionId/attention/resolve",
          }),
        ]),
      );
    },
  );

  it("rejects a duplicate method/path in the real assembled mounts", () => {
    const runtime = createCensusRuntime();
    const mounts = Reflect.apply(resolveApiHostMounts, undefined, [runtime]) as readonly ResolvedApiMount[];
    expect(() => assertApiRouteTableHasNoCollisions([...mounts, mounts[0]])).toThrow("E_ROUTE_COLLISION");
  });

  it("rejects an omitted discovered mount against the independent assembly", () => {
    const runtime = createCensusRuntime();
    const observed = observeApiAssembly(runtime);
    const mounts = Reflect.apply(resolveApiHostMounts, undefined, [runtime]) as readonly ResolvedApiMount[];
    expect(() => verifyCompleteRouteCensus(mounts.slice(1), observed)).toThrow("complete declared mount coverage");
  });

  it("rejects an omitted route scan against the independent assembly", () => {
    const runtime = createCensusRuntime();
    const observed = observeApiAssembly(runtime);
    const mounts = Reflect.apply(resolveApiHostMounts, undefined, [runtime]) as readonly ResolvedApiMount[];
    const firstRouter = mounts[0].router as Hono;
    const omittedRoute = mounts.map((mount, index) =>
      index === 0 ? { ...mount, router: { routes: firstRouter.routes.slice(1) } } : mount,
    );
    expect(() => verifyCompleteRouteCensus(omittedRoute, observed)).toThrow("complete scan coverage");
  });

  it("refuses an unreadable route table rather than reporting an incomplete scan as success", () => {
    const runtime = createCensusRuntime();
    const mounts = Reflect.apply(resolveApiHostMounts, undefined, [runtime]) as readonly ResolvedApiMount[];
    const unreadable = mounts.map((mount, index) => (index === 0 ? { ...mount, router: {} } : mount));
    expect(() => assertApiRouteTableHasNoCollisions(unreadable)).toThrow("E_ROUTE_SHAPE");
  });

  it("rejects an omitted mounted route against the independent assembly", () => {
    const runtime = createCensusRuntime();
    const observed = observeApiAssembly(runtime);
    const app = Reflect.apply(buildPlatformApiApp, undefined, [runtime]);
    expect(() => verifyMountedTail(app.routes.slice(0, -1), observed.mountedRoutes)).toThrow(
      "Mounted route block is not the complete contiguous tail",
    );
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
