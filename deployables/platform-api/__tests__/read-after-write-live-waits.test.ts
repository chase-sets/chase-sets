import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  resolveReadConsistencyDependency,
  type ReadConsistencyProjectionGroup,
} from "@chase-sets/bounded-context-runtime";
import type { BcReadFreshnessRoute } from "@chase-sets/bounded-context-module";
import { apiContextRegistry } from "../src/generated/api-context-registry";
import { CRITICAL_READ_CONSISTENCY_ROUTE_TUNING } from "../src/config";

/**
 * Guards issues #1225/#1233: every read-after-write inventory entry must be
 * backed by a live wait declaration. `pnpm run check:structure` validates the
 * inventory against context.json; this suite validates the half the structural
 * check cannot see: the runtime module declarations that
 * `attachReadConsistencyMiddleware` actually consumes inside platform-api.
 */

type ContextJsonDependency = Readonly<{
  projectionName?: string;
  readModelTable?: string;
  targetContextName?: string;
}>;

type ContextJsonFreshnessRoute = Readonly<{
  routePath?: string;
  methods?: readonly string[];
  dependencies?: readonly ContextJsonDependency[];
}>;

type ContextJsonApiMount = Readonly<{
  mountPath?: string;
  readFreshnessRoutes?: readonly ContextJsonFreshnessRoute[];
}>;

type ContextJsonInventoryEntry = Readonly<{
  id?: string;
  risk?: string;
  destination?: Readonly<{
    apiContextName?: string;
    apiRoutePath?: string;
    readModelTables?: readonly string[];
    projectionDependencies?: readonly string[];
  }>;
  exception?: Readonly<{ status?: string }>;
}>;

type ContextJson = Readonly<{
  contextName?: string;
  apiMounts?: readonly ContextJsonApiMount[];
  projectionGroups?: readonly Readonly<{ projectionName?: string; ownedTables?: readonly string[] }>[];
  readAfterWriteRouteInventory?: readonly ContextJsonInventoryEntry[];
}>;

type DiskContext = Readonly<{
  directoryName: string;
  manifest: ContextJson;
}>;

function loadDiskContexts(): readonly DiskContext[] {
  const boundedContextsDir = fileURLToPath(new URL("../../../bounded-contexts", import.meta.url));
  const contexts: DiskContext[] = [];

  for (const directoryName of readdirSync(boundedContextsDir).sort()) {
    const contextJsonPath = join(boundedContextsDir, directoryName, "context.json");
    if (!existsSync(contextJsonPath)) {
      continue;
    }

    contexts.push({
      directoryName,
      manifest: JSON.parse(readFileSync(contextJsonPath, "utf8")) as ContextJson,
    });
  }

  return contexts;
}

const diskContexts = loadDiskContexts();
const diskContextsByName = new Map(diskContexts.map((context) => [context.manifest.contextName, context]));
const registryByContextName = new Map(apiContextRegistry.map((entry) => [entry.contextName as string, entry]));

const liveInventoryEntries = diskContexts.flatMap((context) =>
  (context.manifest.readAfterWriteRouteInventory ?? [])
    .filter((entry) => entry.exception === undefined)
    .map((entry) => ({ contextName: context.manifest.contextName ?? context.directoryName, entry })),
);

const mountedProjectionGroups: readonly ReadConsistencyProjectionGroup[] = apiContextRegistry.flatMap((entry) =>
  (entry.module.projectionGroups ?? []).map((group) => ({
    targetContextName: entry.contextName as string,
    projectionName: group.projectionName,
    ownedTables: group.ownedTables,
    subscriptionRunners: [],
  })),
);

function findLiveFreshnessRoutes(
  contextName: string,
  apiRoutePath: string,
): readonly Readonly<{ mountPath: string; route: BcReadFreshnessRoute }>[] {
  const registryEntry = registryByContextName.get(contextName);
  if (!registryEntry) {
    return [];
  }

  return registryEntry.module.apiMounts.flatMap((mount) =>
    (mount.readFreshnessRoutes ?? [])
      .filter((route) => route.routePath === apiRoutePath)
      .map((route) => ({ mountPath: mount.mountPath, route })),
  );
}

describe("read-after-write live wait declarations", () => {
  it("has inventory entries to validate and live entries that point at projection-backed reads", () => {
    expect(diskContexts.length).toBeGreaterThan(0);
    expect(liveInventoryEntries.length).toBeGreaterThan(0);
  });

  it("serves every non-exception inventory destination from a context mounted in platform-api", () => {
    const violations: string[] = [];

    for (const { contextName, entry } of liveInventoryEntries) {
      const apiContextName = entry.destination?.apiContextName;
      if (!apiContextName) {
        violations.push(`${contextName} inventory '${entry.id}': destination.apiContextName is missing`);
        continue;
      }

      if (!registryByContextName.has(apiContextName)) {
        violations.push(
          `${contextName} inventory '${entry.id}': destination context '${apiContextName}' is not mounted in platform-api, so no read-consistency wait backs it`,
        );
      }
    }

    expect(violations).toEqual([]);
  });

  it("backs every non-exception inventory entry with a live module freshness route whose exact dependencies resolve", () => {
    const violations: string[] = [];

    for (const { contextName, entry } of liveInventoryEntries) {
      const entryLabel = `${contextName} inventory '${entry.id}'`;
      const apiContextName = entry.destination?.apiContextName;
      const apiRoutePath = entry.destination?.apiRoutePath;
      if (!apiContextName || !apiRoutePath) {
        violations.push(`${entryLabel}: destination.apiContextName/apiRoutePath are required for a live wait`);
        continue;
      }

      const liveRoutes = findLiveFreshnessRoutes(apiContextName, apiRoutePath);
      if (liveRoutes.length === 0) {
        violations.push(
          `${entryLabel}: '${apiContextName}' module apiMounts declare no readFreshnessRoutes entry for '${apiRoutePath}'; the middleware would not wait for this route`,
        );
        continue;
      }

      for (const { mountPath, route } of liveRoutes) {
        const methods = route.methods ?? ["GET", "HEAD"];
        if (!methods.includes("GET")) {
          violations.push(
            `${entryLabel}: freshness route '${mountPath}${apiRoutePath}' does not cover GET, so loader reads bypass the wait`,
          );
        }

        if (route.dependencies.length === 0) {
          violations.push(`${entryLabel}: freshness route '${mountPath}${apiRoutePath}' declares no dependencies`);
          continue;
        }

        const declaredTables = new Set<string>();
        const declaredProjections = new Set<string>();
        for (const dependency of route.dependencies) {
          if ("readModelTable" in dependency && dependency.readModelTable) {
            declaredTables.add(dependency.readModelTable);
          }
          if ("projectionName" in dependency && dependency.projectionName) {
            declaredProjections.add(dependency.projectionName);
          }

          try {
            const resolved = resolveReadConsistencyDependency(apiContextName, dependency, mountedProjectionGroups);
            if (resolved.length === 0) {
              violations.push(
                `${entryLabel}: freshness route '${mountPath}${apiRoutePath}' dependency resolved to no projection groups`,
              );
            }
          } catch (error) {
            violations.push(
              `${entryLabel}: freshness route '${mountPath}${apiRoutePath}' dependency does not resolve against mounted projection groups: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }

        for (const tableName of entry.destination?.readModelTables ?? []) {
          if (!declaredTables.has(tableName)) {
            violations.push(
              `${entryLabel}: inventory claims readModelTable '${tableName}' but the live freshness route '${mountPath}${apiRoutePath}' does not declare it`,
            );
          }
        }

        for (const projectionName of entry.destination?.projectionDependencies ?? []) {
          if (!declaredProjections.has(projectionName)) {
            violations.push(
              `${entryLabel}: inventory claims projection dependency '${projectionName}' but the live freshness route '${mountPath}${apiRoutePath}' does not declare it`,
            );
          }
        }
      }
    }

    expect(violations).toEqual([]);
  });

  it("keeps runtime module declarations identical to the structurally validated context.json", () => {
    for (const entry of apiContextRegistry) {
      const diskContext = diskContextsByName.get(entry.contextName);
      expect(diskContext, `bounded-contexts context.json for '${entry.contextName}'`).toBeDefined();
      expect(entry.module.contextName).toBe(entry.contextName);
      // check:structure validates context.json; these assertions extend that
      // guarantee to the module declarations the middleware consumes at runtime.
      expect(entry.module.apiMounts).toEqual(diskContext?.manifest.apiMounts);
      expect(entry.module.projectionGroups ?? []).toEqual(diskContext?.manifest.projectionGroups ?? []);
    }
  });
});

describe("checkout exact read-after-write waits (#1225)", () => {
  // Environment composition is covered by config.test.ts ("loads read
  // consistency rollout controls from environment variables" and "keeps
  // environment read consistency route tuning after critical defaults"):
  // these critical defaults are always prepended to loadConfig().routeTuning,
  // so pinning the constant here pins runtime behavior.
  it("pins the checkout session route to bounded exact-dependency waits", () => {
    expect(CRITICAL_READ_CONSISTENCY_ROUTE_TUNING).toContainEqual({
      mountPath: "/api/marketplace",
      routePath: "/account/checkout-sessions/:sessionId",
      timeoutMs: 900,
      pollIntervalMs: 50,
      exactDependencyMode: "enabled",
    });

    for (const tuning of CRITICAL_READ_CONSISTENCY_ROUTE_TUNING) {
      // A critical tuning entry must never downgrade a route to broader
      // target-context waits; that defeats the reason it is listed here.
      expect(tuning.exactDependencyMode).toBe("enabled");
    }
  });

  it("pins account cart self-refresh to the checkout cart projection dependency", () => {
    expect(CRITICAL_READ_CONSISTENCY_ROUTE_TUNING).toContainEqual({
      mountPath: "/api/marketplace",
      routePath: "/account/cart",
      timeoutMs: 900,
      pollIntervalMs: 50,
      exactDependencyMode: "enabled",
    });

    const checkoutCartLiveRoutes = findLiveFreshnessRoutes("checkout", "/account/cart");
    expect(checkoutCartLiveRoutes).toEqual([
      {
        mountPath: "/api/marketplace",
        route: {
          routePath: "/account/cart",
          methods: ["GET", "HEAD"],
          dependencies: [{ readModelTable: "checkout_cart_line_pages" }],
        },
      },
    ]);

    const resolvedDependencies = checkoutCartLiveRoutes.flatMap(({ route }) =>
      route.dependencies.flatMap((dependency) =>
        resolveReadConsistencyDependency("checkout", dependency, mountedProjectionGroups),
      ),
    );

    expect(resolvedDependencies).toEqual([
      { targetContextName: "checkout", projectionName: "checkout.cart-projection" },
    ]);
  });

  it("backs settlement payout detail freshness with the payout projection dependency", () => {
    const settlementPayoutLiveRoutes = findLiveFreshnessRoutes("settlement", "/payouts/:id");
    expect(settlementPayoutLiveRoutes).toEqual([
      {
        mountPath: "/api/settlement",
        route: {
          routePath: "/payouts/:id",
          methods: ["GET", "HEAD"],
          dependencies: [{ readModelTable: "settlement_payout_pages" }],
        },
      },
    ]);

    const resolvedDependencies = settlementPayoutLiveRoutes.flatMap(({ route }) =>
      route.dependencies.flatMap((dependency) =>
        resolveReadConsistencyDependency("settlement", dependency, mountedProjectionGroups),
      ),
    );

    expect(resolvedDependencies).toEqual([
      { targetContextName: "settlement", projectionName: "settlement-payout-projection" },
    ]);
  });

  it("keeps every critical route tuning entry matched to a live module freshness route", () => {
    const violations: string[] = [];

    for (const tuning of CRITICAL_READ_CONSISTENCY_ROUTE_TUNING) {
      const matchesLiveFreshnessRoute = apiContextRegistry.some((entry) =>
        entry.module.apiMounts.some(
          (mount) =>
            mount.mountPath === tuning.mountPath &&
            (mount.readFreshnessRoutes ?? []).some((route) => route.routePath === tuning.routePath),
        ),
      );
      if (!matchesLiveFreshnessRoute) {
        violations.push(
          `route tuning '${tuning.mountPath}${tuning.routePath}' does not match any live readFreshnessRoutes declaration; the critical tuning would silently stop applying`,
        );
      }
    }

    expect(violations).toEqual([]);
  });

  it("covers every critical non-exception checkout inventory route with exact-dependency tuning", () => {
    const checkoutManifest = diskContextsByName.get("checkout")?.manifest;
    expect(checkoutManifest).toBeDefined();

    const criticalCheckoutEntries = (checkoutManifest?.readAfterWriteRouteInventory ?? []).filter(
      (entry) => entry.risk === "critical" && entry.exception === undefined,
    );
    expect(criticalCheckoutEntries.length).toBeGreaterThan(0);

    const violations: string[] = [];
    for (const entry of criticalCheckoutEntries) {
      const apiRoutePath = entry.destination?.apiRoutePath;
      const liveRoutes = findLiveFreshnessRoutes(entry.destination?.apiContextName ?? "", apiRoutePath ?? "");
      const pinned = liveRoutes.some(({ mountPath }) =>
        CRITICAL_READ_CONSISTENCY_ROUTE_TUNING.some(
          (tuning) =>
            tuning.mountPath === mountPath &&
            tuning.routePath === apiRoutePath &&
            tuning.exactDependencyMode === "enabled",
        ),
      );
      if (!pinned) {
        violations.push(
          `checkout inventory '${entry.id}': critical route '${apiRoutePath}' is not pinned to exactDependencyMode 'enabled' by default route tuning`,
        );
      }
    }

    expect(violations).toEqual([]);
  });
});
