import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createApiHost,
  getApiHostContextNames,
  getApiHostSeedOrder,
  nonProductionDataProfiles,
  productionLikeDataProfiles,
  resolveApiHostMounts,
  representativeCommerceStateDataProfiles,
  seedApiHostIfEmpty,
  type ApiContextRegistry,
} from "./api";
import { createWorkerHost, createWorkerRunnerLoop, type WorkerContextRegistry, type WorkerRunner } from "./worker";
import { getWebHostSections, resolveWebHostNavItems, resolveWebHostRouteRecords, type WebContextRegistry } from "./web";
import { resolveWebHostRouteConfigRecords, toRouteConfigEntry } from "./web-route-config";

type FakeQueryResult = Readonly<{
  rows: readonly Readonly<Record<string, unknown>>[];
}>;

type FakePool = Readonly<{
  query: (sql: string, params?: readonly unknown[]) => Promise<FakeQueryResult>;
  connect: () => Promise<FakePoolClient>;
}>;

type FakePoolClient = Readonly<{
  query: (sql: string, params?: readonly unknown[]) => Promise<FakeQueryResult>;
  release: (error?: unknown) => void;
}>;

function createPool(): FakePool {
  const query = async (sql: string) => ({
    rows: sql.includes("pg_try_advisory_lock")
      ? [{ acquired: true }]
      : sql.includes("COUNT(*) AS count")
        ? [{ count: "0" }]
        : [],
  });
  return {
    query,
    connect: async () => ({
      query,
      release: () => undefined,
    }),
  };
}

function createCountingProjector() {
  const runOnce = vi.fn(async () => ({
    processed: 0,
    lastGlobalPosition: "0" as never,
  }));

  return {
    projector: {
      runOnce,
    },
    runOnce,
  };
}

function createModule(
  contextName: string,
  options: Readonly<{
    apiMounts?: readonly { mountPath: string; kind: "primary" | "additional"; requiresAuth: boolean }[];
    apiRouters?: readonly unknown[];
    subscriptions?: readonly {
      subscriptionName: string;
      sourceContextName: string;
      projectionName: string;
      subscriptionVersion: number;
      handlers: Readonly<Record<string, never>>;
      eventTypes: readonly string[];
      order: number;
    }[];
    projectionGroups?: readonly {
      projectionName: string;
      sourceContextNames: readonly string[];
      ownedTables: readonly string[];
      requiredDuringBootstrap: boolean;
    }[];
    projectors?: readonly ReturnType<typeof createCountingProjector>["projector"][];
    seedProfiles?: readonly (
      | "critical-bootstrap"
      | "catalog-integration-bootstrap"
      | "scenario-seed"
      | "representative-commerce-state"
    )[];
    seed?: () => Promise<void>;
  }> = {},
) {
  return {
    contextName,
    routePrefix: `/${contextName}`,
    streamPrefix: `${contextName}.`,
    schemaSql: "",
    apiMounts: options.apiMounts ?? [],
    createServices: () => ({ contextName }),
    buildApis: () => options.apiRouters ?? [],
    buildSubscriptions: () => options.subscriptions ?? [],
    buildProjectionGroups: () => options.projectionGroups ?? [],
    projectors: () => options.projectors ?? [],
    seedProfiles: options.seedProfiles,
    seed: options.seed,
  };
}

function createSubscription(
  subscriptionName: string,
  sourceContextName: string,
  projectionName: string,
  order: number,
) {
  return {
    subscriptionName,
    sourceContextName,
    projectionName,
    subscriptionVersion: 1,
    handlers: {},
    eventTypes: [],
    order,
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
              section: "catalog",
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
          section: "catalog",
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
              section: "growth",
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
          section: "growth",
        },
      ],
    },
  },
  {
    contextName: "support",
    packageName: "@test/support",
    manifest: {
      contextName: "support",
      deployableContributions: [
        {
          deployable: "admin-web",
          routes: [
            {
              routeId: "support-requests",
              routePath: "requests",
              fileExport: "./routes/admin/requests",
              routeType: "route",
              sourceContext: "support",
              section: "support",
            },
          ],
        },
      ],
      shellContributions: [
        {
          deployable: "admin-web",
          slot: "primary-nav",
          key: "support-requests",
          label: "Support",
          icon: "help",
          href: "/requests",
          section: "support",
          order: 30,
          visibility: "signed-in",
          requiredPermissions: ["support.manage"],
        },
      ],
    },
  },
  {
    contextName: "commercial-terms",
    packageName: "@test/commercial-terms",
    manifest: {
      contextName: "commercial-terms",
      deployableContributions: [
        {
          deployable: "admin-web",
          routes: [
            {
              routeId: "commercial-terms-schedules",
              routePath: "terms/schedules",
              fileExport: "./routes/admin/schedules",
              routeType: "route",
              sourceContext: "commercial-terms",
              section: "commerce",
            },
          ],
        },
      ],
      shellContributions: [
        {
          deployable: "admin-web",
          slot: "primary-nav",
          key: "commercial-terms",
          label: "Commercial Terms",
          icon: "settings",
          href: "/terms/schedules",
          section: "commerce",
          order: 50,
          visibility: "signed-in",
          requiredPermissions: ["commercial-terms.view"],
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
          identity: createPool() as never,
        },
      }),
    ).toThrow(/missing a pool for context 'auth'/);
  });

  it("mounts source runtime contexts without activating their APIs or subscriptions", () => {
    const registry = [
      {
        contextName: "support",
        packageName: "@test/support",
        manifest: {
          contextName: "support",
          apiDeployables: ["platform-api"],
          apiRuntimeProfiles: ["landing"],
        },
        module: createModule("support", {
          apiMounts: [{ mountPath: "/api/support", kind: "primary", requiresAuth: true }],
          apiRouters: ["support-router"],
          subscriptions: [createSubscription("support.order-source-projection", "ordering", "support-orders", 10)],
          projectionGroups: [
            {
              projectionName: "support-orders",
              sourceContextNames: ["ordering"],
              ownedTables: [],
              requiredDuringBootstrap: false,
            },
          ],
        }),
      },
      {
        contextName: "ordering",
        packageName: "@test/ordering",
        manifest: {
          contextName: "ordering",
          apiDeployables: ["platform-api"],
          apiRuntimeProfiles: ["proof", "public"],
          sourceRuntimeDeployables: ["platform-api"],
          sourceRuntimeProfiles: ["landing"],
        },
        module: createModule("ordering", {
          apiMounts: [{ mountPath: "/api/orders", kind: "primary", requiresAuth: true }],
          apiRouters: ["ordering-router"],
          subscriptions: [createSubscription("ordering.marketplace-source-projection", "marketplace", "orders", 20)],
        }),
      },
    ] as const satisfies ApiContextRegistry;

    const runtime = createApiHost(registry, "platform-api", {
      pools: {
        support: createPool() as never,
        ordering: createPool() as never,
      },
      runtimeProfile: "landing",
    });

    expect(runtime.mountedContexts.map((entry) => [entry.contextName, entry.mountRole])).toEqual([
      ["support", "active"],
      ["ordering", "source-only"],
    ]);
    expect(runtime.subscriptionRunners).toHaveLength(1);
    expect(resolveApiHostMounts(runtime).map((mount) => mount.mountPath)).toEqual(["/api/support"]);
  });

  it("keeps production-like bootstrap out of host-level projection drains", async () => {
    const identityProjector = createCountingProjector();
    const catalogProjector = createCountingProjector();
    const checkoutProjector = createCountingProjector();
    const registry = [
      {
        contextName: "identity",
        packageName: "@test/identity",
        manifest: {
          contextName: "identity",
          apiDeployables: ["platform-api"],
        },
        module: createModule("identity", { projectors: [identityProjector.projector] }),
      },
      {
        contextName: "catalog",
        packageName: "@test/catalog",
        manifest: {
          contextName: "catalog",
          apiDeployables: ["platform-api"],
        },
        module: createModule("catalog", {
          projectors: [catalogProjector.projector],
          seedProfiles: ["catalog-integration-bootstrap"],
          seed: async () => undefined,
        }),
      },
      {
        contextName: "checkout",
        packageName: "@test/checkout",
        manifest: {
          contextName: "checkout",
          apiDeployables: ["platform-api"],
          seedRequirements: ["catalog"],
        },
        module: createModule("checkout", {
          projectors: [checkoutProjector.projector],
          seedProfiles: ["scenario-seed"],
          seed: async () => undefined,
        }),
      },
    ] as const satisfies ApiContextRegistry;
    const runtime = createApiHost(registry, "platform-api", {
      pools: {
        identity: createPool() as never,
        catalog: createPool() as never,
        checkout: createPool() as never,
      },
    });

    await seedApiHostIfEmpty(registry, "platform-api", runtime, {
      enabledDataProfiles: productionLikeDataProfiles,
      environmentName: "staging",
    });

    expect(identityProjector.runOnce).not.toHaveBeenCalled();
    expect(catalogProjector.runOnce).not.toHaveBeenCalled();
    expect(checkoutProjector.runOnce).not.toHaveBeenCalled();
  });

  it("fails a stuck seed substep with a descriptive timeout instead of hanging silently", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const registry = [
      {
        contextName: "catalog",
        packageName: "@test/catalog",
        manifest: {
          contextName: "catalog",
          apiDeployables: ["platform-api"],
        },
        module: createModule("catalog", {
          seedProfiles: ["catalog-integration-bootstrap"],
          // Never resolves: models a seed blocked on a database lock or a projection no
          // running worker can apply (the #4638 failure mode).
          seed: () => new Promise<void>(() => undefined),
        }),
      },
    ] as const satisfies ApiContextRegistry;
    const runtime = createApiHost(registry, "platform-api", {
      pools: { catalog: createPool() as never },
    });

    try {
      await expect(
        seedApiHostIfEmpty(registry, "platform-api", runtime, {
          enabledDataProfiles: productionLikeDataProfiles,
          environmentName: "staging",
          substepTimeoutMs: 50,
        }),
      ).rejects.toThrow(/substep 'seed:catalog' exceeded 50ms/);

      expect(logSpy).toHaveBeenCalledWith("[seed-api-host] schema-bootstrap:catalog started.");
      expect(logSpy).toHaveBeenCalledWith("[seed-api-host] seed:catalog started.");
    } finally {
      logSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });

  it("keeps full runtime drains for scenario bootstrap", async () => {
    const identityProjector = createCountingProjector();
    const authProjector = createCountingProjector();
    const registry = [
      {
        contextName: "identity",
        packageName: "@test/identity",
        manifest: {
          contextName: "identity",
          apiDeployables: ["platform-api"],
        },
        module: createModule("identity", {
          projectors: [identityProjector.projector],
          seedProfiles: ["scenario-seed"],
          seed: async () => undefined,
        }),
      },
      {
        contextName: "auth",
        packageName: "@test/auth",
        manifest: {
          contextName: "auth",
          apiDeployables: ["platform-api"],
          seedRequirements: ["identity"],
        },
        module: createModule("auth", {
          projectors: [authProjector.projector],
          seedProfiles: ["scenario-seed"],
          seed: async () => undefined,
        }),
      },
    ] as const satisfies ApiContextRegistry;
    const runtime = createApiHost(registry, "platform-api", {
      pools: {
        identity: createPool() as never,
        auth: createPool() as never,
      },
    });

    await seedApiHostIfEmpty(registry, "platform-api", runtime, {
      enabledDataProfiles: nonProductionDataProfiles,
      environmentName: "preview",
    });

    expect(identityProjector.runOnce).toHaveBeenCalledTimes(0);
    expect(authProjector.runOnce).toHaveBeenCalledTimes(0);
  });

  it("runs representative commerce state only for explicitly opted-in seed modules", async () => {
    const identitySeed = vi.fn(async () => undefined);
    const marketplaceSeed = vi.fn(async () => undefined);
    const registry = [
      {
        contextName: "identity",
        packageName: "@test/identity",
        manifest: {
          contextName: "identity",
          apiDeployables: ["platform-api"],
        },
        module: createModule("identity", {
          seedProfiles: ["representative-commerce-state"],
          seed: identitySeed,
        }),
      },
      {
        contextName: "marketplace",
        packageName: "@test/marketplace",
        manifest: {
          contextName: "marketplace",
          apiDeployables: ["platform-api"],
          seedRequirements: ["identity"],
        },
        module: createModule("marketplace", {
          seed: marketplaceSeed,
        }),
      },
    ] as const satisfies ApiContextRegistry;
    const runtime = createApiHost(registry, "platform-api", {
      pools: {
        identity: createPool() as never,
        marketplace: createPool() as never,
      },
    });

    await seedApiHostIfEmpty(registry, "platform-api", runtime, {
      enabledDataProfiles: representativeCommerceStateDataProfiles,
      environmentName: "staging",
    });

    expect(identitySeed).toHaveBeenCalledTimes(1);
    expect(marketplaceSeed).not.toHaveBeenCalled();
  });

  it("forwards schema bootstrap options while seeding mounted contexts", async () => {
    vi.useFakeTimers();
    try {
      const query = vi.fn(async () => ({ rows: [] }));
      const client = {
        query: vi.fn(async (sql: string) => ({
          rows: sql.includes("pg_try_advisory_lock") ? [{ acquired: false }] : [],
        })),
        release: vi.fn(),
      };
      const contendedPool = {
        query,
        connect: vi.fn(async () => client),
      };
      const registry = [
        {
          contextName: "identity",
          packageName: "@test/identity",
          manifest: {
            contextName: "identity",
            apiDeployables: ["platform-api"],
          },
          module: createModule("identity"),
        },
      ] as const satisfies ApiContextRegistry;
      const runtime = createApiHost(registry, "platform-api", {
        pools: {
          identity: contendedPool as never,
        },
      });

      const seed = seedApiHostIfEmpty(registry, "platform-api", runtime, {
        enabledDataProfiles: productionLikeDataProfiles,
        environmentName: "staging",
        schemaBootstrap: {
          lockAcquisitionTimeoutMs: 1,
        },
      });
      const seedRejected = expect(seed).rejects.toThrow(/Schema bootstrap lock was not acquired within 1ms/);
      await vi.advanceTimersByTimeAsync(2);

      await seedRejected;
      expect(contendedPool.connect).toHaveBeenCalledTimes(1);
      expect(client.release).toHaveBeenCalledWith(expect.any(Error));
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("platform host worker registry", () => {
  it("mounts source runtime contexts without activating their subscriptions", () => {
    const registry = [
      {
        contextName: "support",
        packageName: "@test/support",
        manifest: {
          contextName: "support",
          runtimeDeployables: ["platform-worker"],
          workerRuntimeProfiles: ["landing"],
        },
        module: createModule("support", {
          subscriptions: [
            createSubscription("support.fulfillment-source-projection", "fulfillment", "support-shipments", 10),
          ],
          projectionGroups: [
            {
              projectionName: "support-shipments",
              sourceContextNames: ["fulfillment"],
              ownedTables: [],
              requiredDuringBootstrap: false,
            },
          ],
        }),
      },
      {
        contextName: "fulfillment",
        packageName: "@test/fulfillment",
        manifest: {
          contextName: "fulfillment",
          runtimeDeployables: ["platform-worker"],
          workerRuntimeProfiles: ["proof", "public"],
          sourceRuntimeDeployables: ["platform-worker"],
          sourceRuntimeProfiles: ["landing"],
        },
        module: createModule("fulfillment", {
          subscriptions: [
            createSubscription("fulfillment.ordering-source-projection", "ordering", "fulfillment-orders", 20),
          ],
        }),
      },
    ] as const satisfies WorkerContextRegistry;

    const runtime = createWorkerHost(registry, "platform-worker", {
      pools: {
        support: createPool() as never,
        fulfillment: createPool() as never,
      },
      runtimeProfile: "landing",
    });

    expect(runtime.mountedContexts.map((entry) => [entry.contextName, entry.mountRole])).toEqual([
      ["support", "active"],
      ["fulfillment", "source-only"],
    ]);
    expect(runtime.subscriptionRunners).toHaveLength(1);
    expect(runtime.projectionGroups.map((group) => [group.targetContextName, group.projectionName])).toEqual([
      ["support", "support-shipments"],
    ]);
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
    expect(getWebHostSections("admin-web")).toEqual(["access", "catalog", "commerce", "growth", "support", "platform"]);
  });

  it("resolves nested admin nav with section-prefixed child hrefs and permission filtering", () => {
    const registry = [
      {
        contextName: "catalog",
        packageName: "@test/catalog",
        manifest: {
          contextName: "catalog",
          shellContributions: [
            {
              deployable: "admin-web",
              slot: "primary-nav",
              key: "integrations",
              label: "Integrations",
              icon: "plug",
              order: 10,
              visibility: "signed-in",
              requiredPermissions: [],
              section: "catalog",
              children: [
                {
                  key: "integrations-providers",
                  label: "Providers",
                  icon: "plug",
                  href: "/integrations/providers",
                  order: 20,
                  visibility: "signed-in",
                  requiredPermissions: ["catalog.integrations.manage"],
                },
                {
                  key: "integrations-governance",
                  label: "Governance",
                  icon: "shield",
                  href: "/integrations/governance",
                  order: 10,
                  visibility: "signed-in",
                  requiredPermissions: ["catalog.integrations.govern"],
                },
              ],
            },
          ],
        },
      },
    ] as const satisfies WebContextRegistry;

    expect(
      resolveWebHostNavItems(
        registry,
        "admin-web",
        "primary-nav",
        { permissions: ["catalog.integrations.manage"] },
        { section: "catalog" },
      ),
    ).toEqual([
      {
        key: "integrations",
        label: "Integrations",
        icon: "plug",
        children: [
          {
            key: "integrations-providers",
            label: "Providers",
            icon: "plug",
            href: "/catalog/integrations/providers",
          },
        ],
      },
    ]);
  });

  it("hides nested nav parents when permission filtering removes every child", () => {
    const registry = [
      {
        contextName: "catalog",
        packageName: "@test/catalog",
        manifest: {
          contextName: "catalog",
          shellContributions: [
            {
              deployable: "admin-web",
              slot: "primary-nav",
              key: "integrations",
              label: "Integrations",
              icon: "plug",
              order: 10,
              visibility: "signed-in",
              requiredPermissions: [],
              section: "catalog",
              children: [
                {
                  key: "integrations-providers",
                  label: "Providers",
                  icon: "plug",
                  href: "/integrations/providers",
                  order: 10,
                  visibility: "signed-in",
                  requiredPermissions: ["catalog.integrations.manage"],
                },
              ],
            },
          ],
        },
      },
    ] as const satisfies WebContextRegistry;

    expect(
      resolveWebHostNavItems(registry, "admin-web", "primary-nav", { permissions: [] }, { section: "catalog" }),
    ).toEqual([]);
  });

  it("places public-presence waitlist review in the growth admin section", () => {
    const routes = resolveWebHostRouteRecords(webRegistry, "admin-web");
    const navItems = resolveWebHostNavItems(
      webRegistry,
      "admin-web",
      "primary-nav",
      { permissions: ["public-presence.view"] },
      { section: "growth" },
    );

    expect(routes).toContainEqual(
      expect.objectContaining({
        contextName: "public-presence",
        routePath: "growth/waitlist",
        section: "growth",
      }),
    );
    expect(navItems).toEqual([
      expect.objectContaining({
        href: "/growth/waitlist",
        label: "Waitlist",
      }),
    ]);
  });

  it("places support requests in the support admin section", () => {
    const routes = resolveWebHostRouteRecords(webRegistry, "admin-web");
    const navItems = resolveWebHostNavItems(
      webRegistry,
      "admin-web",
      "primary-nav",
      { permissions: ["support.manage"] },
      { section: "support" },
    );

    expect(routes).toContainEqual(
      expect.objectContaining({
        contextName: "support",
        routePath: "support/requests",
        section: "support",
      }),
    );
    expect(navItems).toEqual([
      expect.objectContaining({
        href: "/support/requests",
        label: "Support",
      }),
    ]);
  });

  it("uses explicit admin section placement for commercial terms", () => {
    const routes = resolveWebHostRouteRecords(webRegistry, "admin-web");
    const navItems = resolveWebHostNavItems(
      webRegistry,
      "admin-web",
      "primary-nav",
      { permissions: ["commercial-terms.view"] },
      { section: "commerce" },
    );

    expect(routes).toContainEqual(
      expect.objectContaining({
        contextName: "commercial-terms",
        routePath: "commerce/terms/schedules",
        section: "commerce",
      }),
    );
    expect(navItems).toEqual([
      expect.objectContaining({
        href: "/commerce/terms/schedules",
        label: "Commercial Terms",
      }),
    ]);
  });

  it("rejects unknown explicit admin sections", () => {
    expect(() =>
      resolveWebHostRouteRecords(
        [
          {
            contextName: "test-context",
            packageName: "@test/context",
            manifest: {
              contextName: "test-context",
              deployableContributions: [
                {
                  deployable: "admin-web",
                  routes: [
                    {
                      routeId: "broken",
                      routePath: "broken",
                      fileExport: "./routes/admin/broken",
                      routeType: "route",
                      sourceContext: "test-context",
                      section: "unknown",
                    },
                  ],
                },
              ],
            },
          },
        ],
        "admin-web",
      ),
    ).toThrow(/Unknown admin-web section 'unknown'/);
  });

  it("rejects missing explicit admin sections", () => {
    expect(() =>
      resolveWebHostRouteRecords(
        [
          {
            contextName: "test-context",
            packageName: "@test/context",
            manifest: {
              contextName: "test-context",
              deployableContributions: [
                {
                  deployable: "admin-web",
                  routes: [
                    {
                      routeId: "missing-section",
                      routePath: "missing-section",
                      fileExport: "./routes/admin/missing-section",
                      routeType: "route",
                      sourceContext: "test-context",
                    },
                  ],
                },
              ],
            },
          },
        ],
        "admin-web",
      ),
    ).toThrow(/Missing explicit admin-web section/);
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
        route: (path, file, options) => ({ path: path ?? undefined, file, ...options }),
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
      bootstrap: vi.fn(async () => undefined),
      acquireLease: vi.fn(async (input) => ({
        leaseName: input.leaseName,
        ownerId: input.ownerId,
        fencingToken: "1",
        expiresAt: new Date(Date.now() + 1000).toISOString(),
      })),
      renewLease: vi.fn(async () => true),
      releaseLease: vi.fn(async () => undefined),
      recordRunnerStatus: vi.fn(async () => undefined),
      recordProjectionStatusSnapshot: vi.fn(async () => undefined),
      heartbeatWorker: vi.fn(async () => undefined),
      listProjectionStatusSnapshots: vi.fn(async () => []),
      listWorkerHeartbeats: vi.fn(async () => []),
      listRunnerStatuses: vi.fn(async () => []),
      listLeases: vi.fn(async () => []),
      enqueueProjectionOperation: vi.fn(async () => {
        throw new Error("not used");
      }),
      claimProjectionOperation: vi.fn(async () => null),
      recordProjectionOperationProgress: vi.fn(async () => false),
      completeProjectionOperation: vi.fn(async () => false),
      failProjectionOperation: vi.fn(async () => false),
      cancelProjectionOperation: vi.fn(async () => false),
      getProjectionOperation: vi.fn(async () => null),
      listProjectionOperations: vi.fn(async () => []),
      listProjectionOperationEvents: vi.fn(async () => []),
      waitForProjectionOperationEvents: vi.fn(async () => undefined),
      summarizeProjectionOperations: vi.fn(async () => ({
        queuedCount: "0",
        runningCount: "0",
        failedCount: "0",
        cancelRequestedCount: "0",
        oldestQueuedAt: null,
        oldestRunningAt: null,
        averageDurationMs: null,
      })),
      claimScheduledRunner: vi.fn(async () => false),
      recordScheduledRunnerCompleted: vi.fn(async () => undefined),
      getProjectionWakeRelayCursor: vi.fn(async () => null),
      listProjectionWakeRelayCursors: vi.fn(async () => []),
      advanceProjectionWakeRelayCursor: vi.fn(async () => null),
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
