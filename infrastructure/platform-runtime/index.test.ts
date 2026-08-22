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
import type { EnvironmentDataProfile } from "@chase-sets/bounded-context-module";
import { createWorkerHost, createWorkerRunnerLoop, type WorkerContextRegistry, type WorkerRunner } from "./worker";
import {
  getWebHostSections,
  resolveWebHostActiveKey,
  resolveWebHostNavItems,
  resolveWebHostRouteRecords,
  type WebContextRegistry,
  type WebHostShellResolutionErrorCode,
} from "./web";
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
    apiEntries?: readonly Readonly<{ mountPath: string; contextMountOrdinal: number; router: unknown }>[];
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
    projectionHandlerSets?: readonly {
      projectionName: string;
      handlers: Readonly<Record<string, never>>;
    }[];
    projectors?: readonly ReturnType<typeof createCountingProjector>["projector"][];
    seedProfiles?: readonly EnvironmentDataProfile[];
    seed?: () => Promise<void>;
  }> = {},
) {
  return {
    contextName,
    routePrefix: `/${contextName}`,
    streamPrefix: `${contextName}.`,
    schemaSql: "",
    apiMounts: options.apiMounts ?? [],
    eventSubscriptions: (options.subscriptions ?? []).map((subscription) => ({
      sourceContextName: subscription.sourceContextName,
      projectionName: subscription.projectionName,
      subscriptionVersion: subscription.subscriptionVersion,
      projectionHandlerSetNames: [subscription.projectionName],
      eventTypes: subscription.eventTypes,
      order: subscription.order,
    })),
    createServices: () => ({ contextName }),
    buildApis: () => options.apiEntries ?? [],
    buildSubscriptions: () => options.subscriptions ?? [],
    buildProjectionGroups: () => options.projectionGroups ?? [],
    projectionHandlerSets: () => options.projectionHandlerSets ?? [],
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

function shellItem(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    deployable: "marketplace-web",
    slot: "top-nav",
    key: "route",
    label: "Route",
    icon: "box",
    href: "/route",
    order: 10,
    visibility: "always",
    requiredPermissions: [],
    ...overrides,
  };
}

function shellRegistry(shellContributions: readonly unknown[]): WebContextRegistry {
  return [
    {
      contextName: "arbitrary-context",
      packageName: "@test/arbitrary-context",
      manifest: {
        contextName: "arbitrary-context",
        shellContributions,
      },
    },
  ] as unknown as WebContextRegistry;
}

function expectShellResolutionCode(
  shellContributions: readonly unknown[],
  code: WebHostShellResolutionErrorCode,
  options: Readonly<{ limit?: number }> = {},
) {
  expect(() =>
    resolveWebHostNavItems(shellRegistry(shellContributions), "marketplace-web", "top-nav", null, options),
  ).toThrowError(expect.objectContaining({ code }));
}

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

  it("fails API host mounting when an active module exposes an unresolved declaration", () => {
    const registry = [
      {
        contextName: "inventory",
        packageName: "@test/inventory",
        manifest: {
          contextName: "inventory",
          apiDeployables: ["platform-api"],
          apiRuntimeProfiles: ["public"],
        },
        module: {
          ...createModule("inventory"),
          eventSubscriptions: [
            {
              sourceContextName: "catalog",
              projectionName: "inventory-missing-projection",
              subscriptionVersion: 1,
              projectionHandlerSetNames: ["inventory-missing-projection"],
            },
          ],
        },
      },
    ] as const satisfies ApiContextRegistry;

    expect(() =>
      createApiHost(registry, "platform-api", {
        pools: { inventory: createPool() as never },
        runtimeProfile: "public",
      }),
    ).toThrow(
      "Context 'inventory' declares an event subscription from source context 'catalog' for projection 'inventory-missing-projection', but no registered handler can resolve it.",
    );
  });

  it("mounts and explicitly seeds source runtime contexts without activating their APIs or subscriptions", async () => {
    const policySourceSeed = vi.fn(async () => undefined);
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
          apiEntries: [{ mountPath: "/api/support", contextMountOrdinal: 1, router: "support-router" }],
          subscriptions: [
            createSubscription("support.policy-source-projection", "policy-source", "support-policies", 10),
          ],
          projectionGroups: [
            {
              projectionName: "support-policies",
              sourceContextNames: ["policy-source"],
              ownedTables: [],
              requiredDuringBootstrap: false,
            },
          ],
        }),
      },
      {
        contextName: "policy-source",
        packageName: "@test/policy-source",
        manifest: {
          contextName: "policy-source",
          apiDeployables: ["platform-api"],
          apiRuntimeProfiles: ["proof", "public"],
          sourceRuntimeDeployables: ["platform-api"],
          sourceRuntimeProfiles: ["landing"],
        },
        module: createModule("policy-source", {
          apiMounts: [{ mountPath: "/api/private-policies", kind: "primary", requiresAuth: true }],
          apiEntries: [{ mountPath: "/api/policy-source", contextMountOrdinal: 1, router: "policy-source-router" }],
          subscriptions: [createSubscription("policy-source.private-projection", "support", "private-policies", 20)],
          projectionHandlerSets: [{ projectionName: "policy-source-documents", handlers: {} }],
          seedProfiles: ["critical-bootstrap"],
          seed: policySourceSeed,
        }),
      },
    ] as const satisfies ApiContextRegistry;

    const runtime = createApiHost(registry, "platform-api", {
      pools: {
        support: createPool() as never,
        "policy-source": createPool() as never,
      },
      runtimeProfile: "landing",
    });

    expect(runtime.mountedContexts.map((entry) => [entry.contextName, entry.mountRole])).toEqual([
      ["support", "active"],
      ["policy-source", "source-only"],
    ]);
    expect(runtime.subscriptionRunners.map(({ checkpointKey }) => checkpointKey)).toEqual([
      "support-policies:policy-source:v1",
    ]);
    expect(
      runtime.mountedContexts.find(({ contextName }) => contextName === "policy-source")?.projectionHandlerSets,
    ).toHaveLength(1);
    expect(resolveApiHostMounts(runtime).map((mount) => mount.mountPath)).toEqual(["/api/support"]);
    expect(
      getApiHostSeedOrder(registry, "platform-api", "landing", {
        enabledDataProfiles: productionLikeDataProfiles,
        environmentName: "production",
      }),
    ).toEqual(["support", "policy-source"]);

    await seedApiHostIfEmpty(registry, "platform-api", runtime, {
      enabledDataProfiles: productionLikeDataProfiles,
      environmentName: "production",
      runtimeProfile: "landing",
    });

    expect(policySourceSeed).toHaveBeenCalledTimes(2);
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

  it("is a no-op for a mounted context with no representative catalog seed handler", async () => {
    const catalogSeed = vi.fn(async () => undefined);
    const registry = [
      {
        contextName: "catalog",
        packageName: "@test/catalog",
        manifest: {
          contextName: "catalog",
          apiDeployables: ["platform-api"],
        },
        module: createModule("catalog", { seed: catalogSeed }),
      },
    ] as const satisfies ApiContextRegistry;
    const runtime = createApiHost(registry, "platform-api", {
      pools: { catalog: createPool() as never },
    });

    await expect(
      seedApiHostIfEmpty(registry, "platform-api", runtime, {
        enabledDataProfiles: ["representative-catalog"],
        environmentName: "preview",
      }),
    ).resolves.toBeUndefined();

    expect(catalogSeed).not.toHaveBeenCalled();
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
  it("fails worker host mounting when an active module exposes an unresolved declaration", () => {
    const registry = [
      {
        contextName: "notifications",
        packageName: "@test/notifications",
        manifest: {
          contextName: "notifications",
          runtimeDeployables: ["platform-worker"],
          workerRuntimeProfiles: ["public"],
        },
        module: {
          ...createModule("notifications"),
          eventReactions: [
            {
              sourceContextName: "identity",
              reactionName: "notifications-missing-reaction",
              subscriptionVersion: 1,
              reactionHandlerSetNames: ["notifications-missing-reaction"],
              idempotencyPolicy: "idempotent-command-dispatch",
              retryPolicy: "retry-from-last-checkpoint",
              failurePolicy: "surface-as-reaction-failure",
            },
          ],
        },
      },
    ] as const satisfies WorkerContextRegistry;

    expect(() =>
      createWorkerHost(registry, "platform-worker", {
        pools: { notifications: createPool() as never },
        runtimeProfile: "public",
      }),
    ).toThrow(
      "Context 'notifications' declares an event reaction from source context 'identity' for reaction 'notifications-missing-reaction', but no registered handler can resolve it.",
    );
  });

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
  it("keeps an unchanged legacy manifest byte-equivalent without resolver options", () => {
    const legacyRegistry = shellRegistry([
      shellItem({ key: "zulu", label: "Zulu", href: "/zulu", order: 20 }),
      shellItem({ key: "alpha", label: "Alpha", href: "/alpha", order: 10 }),
    ]);

    expect(resolveWebHostNavItems(legacyRegistry, "marketplace-web", "top-nav", null)).toEqual([
      { key: "alpha", label: "Alpha", icon: "box", href: "/alpha" },
      { key: "zulu", label: "Zulu", icon: "box", href: "/zulu" },
    ]);
  });

  it("uses keys rather than localized labels to break display-order ties", () => {
    const registry = shellRegistry([
      shellItem({ key: "zulu", label: "Alpha label", href: "/zulu", order: 10 }),
      shellItem({ key: "alpha", label: "Zulu label", href: "/alpha", order: 10 }),
    ]);

    expect(resolveWebHostNavItems(registry, "marketplace-web", "top-nav", null).map((item) => item.key)).toEqual([
      "alpha",
      "zulu",
    ]);
  });

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

  it("resolves expanded parents, actions, role exclusions, placements, badges, and packing deterministically", () => {
    const registry = [
      {
        contextName: "identity",
        packageName: "@test/identity",
        manifest: {
          contextName: "identity",
          shellContributions: [
            shellItem({
              key: "account-menu",
              label: "Account",
              href: undefined,
              placements: ["top-nav", "bottom-nav"],
              order: 30,
              visibility: "signed-in",
              packingPriority: 50,
            }),
            shellItem({
              key: "account",
              parentKey: "account-menu",
              label: "Account home",
              href: "/account",
              placements: ["top-nav", "bottom-nav"],
              order: 10,
              visibility: "signed-in",
              packingPriority: 0,
            }),
          ],
        },
      },
      {
        contextName: "notifications",
        packageName: "@test/notifications",
        manifest: {
          contextName: "notifications",
          shellContributions: [
            shellItem({
              key: "notifications",
              label: "Notifications",
              href: undefined,
              activation: "action",
              placement: "utility",
              excludedRoleKeys: ["guest-buyer"],
              order: 20,
              visibility: "signed-in",
              packingPriority: 100,
            }),
            shellItem({
              key: "alerts",
              label: "Alerts",
              href: "/alerts",
              badge: { valueKey: "alerts.count", max: 99, hideWhenEmptyForSignedOut: false },
              order: 10,
              visibility: "signed-in",
              packingPriority: 90,
            }),
          ],
        },
      },
    ] as unknown as WebContextRegistry;

    expect(
      resolveWebHostNavItems(
        registry,
        "marketplace-web",
        "top-nav",
        { roleKey: "member", permissions: [] },
        {
          dynamicValues: { "alerts.count": 100 },
        },
      ),
    ).toEqual([
      { key: "alerts", label: "Alerts", icon: "box", href: "/alerts", badge: "99+" },
      { key: "notifications", label: "Notifications", icon: "box", placement: "utility" },
      {
        key: "account-menu",
        label: "Account",
        icon: "box",
        children: [{ key: "account", label: "Account home", icon: "box", href: "/account" }],
      },
    ]);
    expect(
      resolveWebHostNavItems(
        registry,
        "marketplace-web",
        "top-nav",
        { roleKey: "member" },
        {
          dynamicValues: { "alerts.count": 2 },
          limit: 2,
        },
      ).map((item) => item.key),
    ).toEqual(["alerts", "notifications"]);
    expect(
      resolveWebHostNavItems(
        registry,
        "marketplace-web",
        "top-nav",
        { roleKey: "guest-buyer" },
        {
          dynamicValues: { "alerts.count": -4 },
        },
      ).map((item) => item.key),
    ).toEqual(["alerts", "account-menu"]);
    expect(resolveWebHostNavItems(registry, "marketplace-web", "bottom-nav", { roleKey: "member" })).toEqual([
      {
        key: "account-menu",
        label: "Account",
        icon: "box",
        children: [{ key: "account", label: "Account home", icon: "box", href: "/account" }],
      },
    ]);
  });

  it("normalizes dynamic badges and signed-out empty-item hiding", () => {
    const registry = shellRegistry([
      shellItem({
        badge: { valueKey: "cart.count", max: 9, hideWhenEmptyForSignedOut: true },
        visibility: "always",
      }),
    ]);

    expect(resolveWebHostNavItems(registry, "marketplace-web", "top-nav", null)).toEqual([]);
    expect(
      resolveWebHostNavItems(registry, "marketplace-web", "top-nav", null, {
        dynamicValues: { "cart.count": Number.NaN },
      }),
    ).toEqual([]);
    expect(
      resolveWebHostNavItems(registry, "marketplace-web", "top-nav", null, {
        dynamicValues: { "cart.count": 10.8 },
      }),
    ).toEqual([{ key: "route", label: "Route", icon: "box", href: "/route", badge: "9+" }]);
    expect(resolveWebHostNavItems(registry, "marketplace-web", "top-nav", { permissions: [] })).toEqual([
      { key: "route", label: "Route", icon: "box", href: "/route" },
    ]);
  });

  it.each([
    {
      name: "duplicate expanded key",
      code: "SHELL_DUPLICATE_EXPANDED_KEY",
      contributions: [shellItem(), shellItem({ href: "/other" })],
    },
    {
      name: "duplicate expanded href",
      code: "SHELL_DUPLICATE_EXPANDED_HREF",
      contributions: [shellItem(), shellItem({ key: "other" })],
    },
    {
      name: "missing parent",
      code: "SHELL_PARENT_MISSING",
      contributions: [shellItem({ parentKey: "missing" })],
    },
    {
      name: "invalid leaf parent",
      code: "SHELL_PARENT_INVALID",
      contributions: [shellItem({ key: "parent" }), shellItem({ key: "child", href: "/child", parentKey: "parent" })],
    },
    {
      name: "self parent",
      code: "SHELL_PARENT_SELF",
      contributions: [shellItem({ key: "self", href: undefined, parentKey: "self" })],
    },
    {
      name: "parent cycle",
      code: "SHELL_PARENT_CYCLE",
      contributions: [
        shellItem({ key: "a", href: undefined, parentKey: "b" }),
        shellItem({ key: "b", href: undefined, parentKey: "a" }),
      ],
    },
    {
      name: "access widening",
      code: "SHELL_ACCESS_WIDENING",
      contributions: [
        shellItem({ key: "parent", href: undefined, visibility: "signed-in" }),
        shellItem({ key: "child", href: "/child", parentKey: "parent", visibility: "always" }),
      ],
    },
    {
      name: "malformed action",
      code: "SHELL_ACTION_MALFORMED",
      contributions: [shellItem({ activation: "action" })],
    },
    {
      name: "non-finite order",
      code: "SHELL_ORDER_NON_FINITE",
      contributions: [shellItem({ order: Number.NaN })],
    },
    {
      name: "non-finite priority",
      code: "SHELL_PACKING_PRIORITY_NON_FINITE",
      contributions: [shellItem({ packingPriority: Number.POSITIVE_INFINITY })],
    },
    {
      name: "non-finite badge max",
      code: "SHELL_BADGE_MAX_INVALID",
      contributions: [shellItem({ badge: { valueKey: "count", max: Number.NaN, hideWhenEmptyForSignedOut: false } })],
    },
    {
      name: "duplicate badge owner",
      code: "SHELL_DUPLICATE_BADGE_OWNER",
      contributions: [
        shellItem({ badge: { valueKey: "count", max: 9, hideWhenEmptyForSignedOut: false } }),
        shellItem({
          key: "other",
          href: "/other",
          badge: { valueKey: "count", max: 9, hideWhenEmptyForSignedOut: false },
        }),
      ],
    },
    {
      name: "malformed active path",
      code: "SHELL_ACTIVE_PATH_MALFORMED",
      contributions: [shellItem({ activePathPatterns: ["/route/:id"] })],
    },
    {
      name: "ambiguous active aliases",
      code: "SHELL_ACTIVE_AMBIGUITY",
      contributions: [
        shellItem({ activePathPatterns: ["/alias"] }),
        shellItem({ key: "other", href: "/other", activePathPatterns: ["/alias"] }),
      ],
    },
    {
      name: "limited resolution missing priority",
      code: "SHELL_LIMIT_PRIORITY_MISSING",
      contributions: [shellItem()],
      options: { limit: 1 },
    },
  ])("fails $name with a stable code", ({ contributions, code, options }) => {
    expectShellResolutionCode(contributions, code as WebHostShellResolutionErrorCode, options ?? {});
  });

  it("resolves active identity from the unfiltered tree before consulting rendered keys", () => {
    const registry = shellRegistry([
      shellItem({ key: "account", href: "/account", visibility: "signed-in" }),
      shellItem({
        key: "sales",
        href: "/account/sales",
        order: 20,
        visibility: "signed-in",
        requiredPermissions: ["sales.view"],
      }),
      shellItem({
        key: "notifications",
        label: "Notifications",
        href: undefined,
        activation: "action",
        order: 30,
        visibility: "signed-in",
      }),
    ]);
    const options = { defaultKey: "account" } as const;

    expect(
      resolveWebHostActiveKey(registry, "marketplace-web", "top-nav", "/account", { permissions: [] }, options),
    ).toBe("account");
    expect(
      resolveWebHostActiveKey(
        registry,
        "marketplace-web",
        "top-nav",
        "account/sales/123/?tab=open#history",
        { permissions: ["sales.view"] },
        options,
      ),
    ).toBe("sales");
    expect(
      resolveWebHostActiveKey(registry, "marketplace-web", "top-nav", "/account/sales", { permissions: [] }, options),
    ).toBeUndefined();
    expect(
      resolveWebHostActiveKey(registry, "marketplace-web", "top-nav", "/outside", { permissions: [] }, options),
    ).toBe("account");
    expect(
      resolveWebHostActiveKey(registry, "marketplace-web", "top-nav", "/notifications", { permissions: [] }, options),
    ).toBe("account");
  });

  it("prefixes Admin active aliases and permits aliases that resolve to the same key", () => {
    const registry = [
      {
        contextName: "catalog",
        packageName: "@test/catalog",
        manifest: {
          contextName: "catalog",
          shellContributions: [
            {
              ...shellItem({
                deployable: "admin-web",
                slot: "primary-nav",
                key: "reference-records",
                href: "/references",
                activePathPatterns: ["/reference-types", "/reference-types/"],
              }),
              section: "catalog",
            },
          ],
        },
      },
    ] as unknown as WebContextRegistry;

    expect(
      resolveWebHostActiveKey(registry, "admin-web", "primary-nav", "/catalog/reference-types/ref_1?tab=x", null, {
        section: "catalog",
        defaultKey: "dimensions",
      }),
    ).toBe("reference-records");
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
      readWorkerHeartbeatHistory: vi.fn(async () => ({
        snapshotAt: new Date().toISOString(),
        workers: [],
        summary: {
          activeOrStaleCount: 0,
          expiredTotalCount: 0,
          expiredWithinDiagnosticWindowCount: 0,
          expiredReturnedCount: 0,
          expiredTruncated: false,
          expiredDiagnosticLimit: 100,
          diagnosticWindowMs: 604_800_000,
        },
      })),
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
