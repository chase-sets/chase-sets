import { afterEach, describe, expect, it, vi } from "vitest";
import { createApiHost, getApiHostContextNames, getApiHostSeedOrder, type ApiContextRegistry } from "./api";
import { createWorkerRunnerLoop, type WorkerRunner } from "./worker";
import { getWebHostSections, resolveWebHostNavItems, resolveWebHostRouteRecords, type WebContextRegistry } from "./web";
import { resolveWebHostRouteConfigRecords, toRouteConfigEntry } from "./web-route-config";

function createModule(contextName: string) {
  return {
    contextName,
    routePrefix: `/${contextName}`,
    streamPrefix: `${contextName}.`,
    schemaSql: "",
    apiMounts: [],
    createServices: () => ({ contextName }),
    buildApis: () => [],
    projectors: () => [],
  };
}

const apiRegistry = [
  {
    contextName: "identity",
    packageName: "@test/identity",
    manifest: {
      contextName: "identity",
      apiDeployables: ["platform-api"],
    },
    module: createModule("identity"),
  },
  {
    contextName: "auth",
    packageName: "@test/auth",
    manifest: {
      contextName: "auth",
      apiDeployables: ["platform-api"],
      seedRequirements: ["identity"],
    },
    module: createModule("auth"),
  },
  {
    contextName: "catalog",
    packageName: "@test/catalog",
    manifest: {
      contextName: "catalog",
      apiDeployables: [],
    },
    module: createModule("catalog"),
  },
] as const satisfies ApiContextRegistry;

const webRegistry = [
  {
    contextName: "catalog",
    packageName: "@test/catalog",
    manifest: {
      contextName: "catalog",
      deployableContributions: [
        {
          deployable: "admin-web",
          routes: [
            {
              routeId: "catalog-dimensions",
              routePath: "dimensions",
              fileExport: "catalog-dimensions",
              routeType: "route",
              sourceContext: "catalog",
            },
          ],
        },
      ],
      shellContributions: [
        {
          deployable: "admin-web",
          slot: "primary-nav",
          key: "dimensions",
          label: "Dimensions",
          icon: "box",
          href: "/dimensions",
          order: 10,
          visibility: "always",
          requiredPermissions: [],
        },
      ],
    },
  },
  {
    contextName: "marketplace",
    packageName: "@test/marketplace",
    manifest: {
      contextName: "marketplace",
      deployableContributions: [
        {
          deployable: "marketplace-web",
          routes: [
            {
              routeId: "category",
              routePath: "categories/:categorySlug",
              fileExport: "./routes/search",
              routeType: "route",
              sourceContext: "marketplace",
            },
            {
              routeId: "search",
              routePath: "search",
              fileExport: "./routes/search",
              routeType: "route",
              sourceContext: "marketplace",
            },
          ],
        },
      ],
      shellContributions: [
        {
          deployable: "marketplace-web",
          slot: "top-nav",
          key: "inventory",
          label: "Inventory",
          icon: "package",
          href: "/account/inventory",
          order: 20,
          visibility: "signed-in",
          requiredPermissions: ["inventory.view"],
        },
        {
          deployable: "marketplace-web",
          slot: "top-nav",
          key: "sign-in",
          label: "Sign in",
          icon: "user",
          href: "/sign-in",
          order: 30,
          visibility: "signed-out",
          requiredPermissions: [],
        },
      ],
    },
  },
  {
    contextName: "public-presence",
    packageName: "@test/public-presence",
    manifest: {
      contextName: "public-presence",
      deployableContributions: [
        {
          deployable: "admin-web",
          routes: [
            {
              routeId: "waitlist",
              routePath: "waitlist",
              fileExport: "./routes/admin/waitlist",
              routeType: "route",
              sourceContext: "public-presence",
            },
          ],
        },
      ],
      shellContributions: [
        {
          deployable: "admin-web",
          slot: "primary-nav",
          key: "waitlist",
          label: "Waitlist",
          icon: "message",
          href: "/waitlist",
          order: 20,
          visibility: "signed-in",
          requiredPermissions: ["public-presence.view"],
        },
      ],
    },
  },
] as const satisfies WebContextRegistry;

describe("platform host api registry", () => {
  it("returns active contexts for a host", () => {
    expect(getApiHostContextNames(apiRegistry, "platform-api")).toEqual(["identity", "auth"]);
  });

  it("orders seeds by manifest dependencies", () => {
    expect(getApiHostSeedOrder(apiRegistry, "platform-api")).toEqual(["identity", "auth"]);
  });

  it("throws when a required pool is missing", () => {
    expect(() =>
      createApiHost(apiRegistry, "platform-api", {
        pools: {
          identity: {} as never,
        },
      }),
    ).toThrow(/missing a pool for context 'auth'/);
  });
});

describe("platform host web registry", () => {
  it("prefixes admin routes and nav items by section", () => {
    const routes = resolveWebHostRouteRecords(webRegistry, "admin-web");
    const navItems = resolveWebHostNavItems(webRegistry, "admin-web", "primary-nav", null, { section: "catalog" });

    expect(routes).toContainEqual(
      expect.objectContaining({
        routePath: "catalog/dimensions",
        section: "catalog",
      }),
    );
    expect(navItems).toEqual([
      expect.objectContaining({
        href: "/catalog/dimensions",
        label: "Dimensions",
      }),
    ]);
    expect(getWebHostSections("admin-web")).toEqual(["catalog", "identity", "experience"]);
  });

  it("places public-presence waitlist review in the experience admin section", () => {
    const routes = resolveWebHostRouteRecords(webRegistry, "admin-web");
    const navItems = resolveWebHostNavItems(
      webRegistry,
      "admin-web",
      "primary-nav",
      { permissions: ["public-presence.view"] },
      { section: "experience" },
    );

    expect(routes).toContainEqual(
      expect.objectContaining({
        contextName: "public-presence",
        routePath: "experience/waitlist",
        section: "experience",
      }),
    );
    expect(navItems).toEqual([
      expect.objectContaining({
        href: "/experience/waitlist",
        label: "Waitlist",
      }),
    ]);
  });

  it("filters marketplace nav items by actor visibility and permissions", () => {
    expect(resolveWebHostNavItems(webRegistry, "marketplace-web", "top-nav", null)).toEqual([
      expect.objectContaining({
        href: "/sign-in",
        label: "Sign in",
      }),
    ]);
    expect(
      resolveWebHostNavItems(webRegistry, "marketplace-web", "top-nav", {
        permissions: ["inventory.view"],
      }),
    ).toEqual([
      expect.objectContaining({
        href: "/account/inventory",
        label: "Inventory",
      }),
    ]);
    expect(
      resolveWebHostNavItems(webRegistry, "marketplace-web", "top-nav", {
        permissions: [],
      }),
    ).toEqual([]);
  });

  it("keeps route config ids unique when routes share a module file", () => {
    const routeConfig = resolveWebHostRouteConfigRecords(webRegistry, "marketplace-web").map((routeRecord) =>
      toRouteConfigEntry(routeRecord, {
        index: (file, options) => ({ file, index: true, ...options }),
        route: (path, file, options) => ({ path, file, ...options }),
      }),
    );

    expect(routeConfig).toEqual([
      expect.objectContaining({
        id: "marketplace/category",
        path: "categories/:categorySlug",
        file: "../../../bounded-contexts/marketplace/routes/search.tsx",
      }),
      expect.objectContaining({
        id: "marketplace/search",
        path: "search",
        file: "../../../bounded-contexts/marketplace/routes/search.tsx",
      }),
    ]);
  });
});

describe("platform worker runner loop", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("rotates runner scheduling so later runners are not starved", async () => {
    vi.useFakeTimers();
    const runOrder: string[] = [];
    const runners: WorkerRunner[] = Array.from({ length: 6 }, (_, index) => ({
      name: `runner-${index + 1}`,
      kind: "job",
      runOnce: vi.fn(async () => {
        runOrder.push(`runner-${index + 1}`);
        return { processed: 0, lastGlobalPosition: "0" as never };
      }),
    }));
    const controlPlane = {
      acquireLease: vi.fn(async (input) => ({
        leaseName: input.leaseName,
        ownerId: input.ownerId,
        fencingToken: "1",
        expiresAt: new Date(Date.now() + 1000).toISOString(),
      })),
      renewLease: vi.fn(async () => true),
      releaseLease: vi.fn(async () => undefined),
      recordRunnerStatus: vi.fn(async () => undefined),
      heartbeatWorker: vi.fn(async () => undefined),
      listWorkerHeartbeats: vi.fn(async () => []),
      listRunnerStatuses: vi.fn(async () => []),
      listLeases: vi.fn(async () => []),
    };

    const loop = createWorkerRunnerLoop({
      workerId: "worker-test",
      controlPlane,
      runners,
      maxConcurrentRunners: 2,
      leaseTtlMs: 1000,
      leaseRenewIntervalMs: 100,
      pollIntervalMs: 10,
    });

    loop.start();
    await vi.advanceTimersByTimeAsync(100);
    await loop.stop();

    expect(new Set(runOrder)).toEqual(new Set(runners.map((runner) => runner.name)));
  });
});
