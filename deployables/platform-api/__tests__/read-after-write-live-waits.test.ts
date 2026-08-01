import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { CHASE_SETS_READ_AFTER_WRITE_HEADER, encodeFreshWriteReceipt } from "@chase-sets/http/responses";
import {
  attachReadConsistencyMiddleware,
  resolveReadConsistencyDependency,
  type ReadConsistencyProjectionGroup,
} from "@chase-sets/bounded-context-runtime";
import type { BcReadFreshnessRoute } from "@chase-sets/bounded-context-module";
import { projectionFreshnessWakeEnqueueMetricRecord } from "@chase-sets/observability";
import { apiContextRegistry } from "../src/context-registry";
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

function expectCriticalRouteTuning(mountPath: string, routePath: string) {
  expect(CRITICAL_READ_CONSISTENCY_ROUTE_TUNING).toContainEqual({
    mountPath,
    routePath,
    timeoutMs: 900,
    pollIntervalMs: 50,
    exactDependencyMode: "enabled",
  });
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

  it("has no accepted read-after-write inventory exceptions left to burn down", () => {
    const acceptedExceptions = diskContexts.flatMap((context) =>
      (context.manifest.readAfterWriteRouteInventory ?? [])
        .filter((entry) => entry.exception?.status === "accepted")
        .map((entry) => `${context.manifest.contextName ?? context.directoryName}:${entry.id ?? "(missing id)"}`),
    );

    expect(acceptedExceptions).toEqual([]);
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

describe("critical exact read-after-write waits", () => {
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
          dependencies: [
            { readModelTable: "checkout_cart_line_pages" },
            { readModelTable: "checkout_marketplace_seller_options" },
            { projectionName: "checkout-inventory-supply-projection" },
            { readModelTable: "checkout_seller_accounts" },
          ],
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
      { targetContextName: "checkout", projectionName: "checkout-marketplace-listing-options-projection" },
      { targetContextName: "checkout", projectionName: "checkout-inventory-supply-projection" },
      { targetContextName: "checkout", projectionName: "checkout-seller-accounts-projection" },
    ]);
  });

  it("pins guest cart add-line handoffs to the checkout cart projection dependency", () => {
    expect(CRITICAL_READ_CONSISTENCY_ROUTE_TUNING).toContainEqual({
      mountPath: "/api/marketplace",
      routePath: "/guest/cart",
      timeoutMs: 900,
      pollIntervalMs: 50,
      exactDependencyMode: "enabled",
    });

    const guestCartLiveRoutes = findLiveFreshnessRoutes("checkout", "/guest/cart");
    expect(guestCartLiveRoutes).toEqual([
      {
        mountPath: "/api/marketplace",
        route: {
          routePath: "/guest/cart",
          methods: ["GET", "HEAD"],
          dependencies: [
            { readModelTable: "checkout_cart_line_pages" },
            { readModelTable: "checkout_marketplace_seller_options" },
            { projectionName: "checkout-inventory-supply-projection" },
            { readModelTable: "checkout_seller_accounts" },
          ],
        },
      },
    ]);

    const resolvedDependencies = guestCartLiveRoutes.flatMap(({ route }) =>
      route.dependencies.flatMap((dependency) =>
        resolveReadConsistencyDependency("checkout", dependency, mountedProjectionGroups),
      ),
    );

    expect(resolvedDependencies).toEqual([
      { targetContextName: "checkout", projectionName: "checkout.cart-projection" },
      { targetContextName: "checkout", projectionName: "checkout-marketplace-listing-options-projection" },
      { targetContextName: "checkout", projectionName: "checkout-inventory-supply-projection" },
      { targetContextName: "checkout", projectionName: "checkout-seller-accounts-projection" },
    ]);
  });

  it("pins account Sell List add-line handoffs to the checkout Sell List projection dependency", () => {
    expect(CRITICAL_READ_CONSISTENCY_ROUTE_TUNING).toContainEqual({
      mountPath: "/api/marketplace",
      routePath: "/account/sell-list",
      timeoutMs: 900,
      pollIntervalMs: 50,
      exactDependencyMode: "enabled",
    });

    const accountSellListLiveRoutes = findLiveFreshnessRoutes("checkout", "/account/sell-list");
    expect(accountSellListLiveRoutes).toEqual([
      {
        mountPath: "/api/marketplace",
        route: {
          routePath: "/account/sell-list",
          methods: ["GET", "HEAD"],
          dependencies: [
            { readModelTable: "checkout_sell_list_line_pages" },
            { readModelTable: "checkout_sell_list_confirmation_pages" },
            { readModelTable: "checkout_sell_payout_readiness_pages" },
            { readModelTable: "checkout_sell_offer_pages" },
            { readModelTable: "checkout_marketplace_seller_options" },
            { readModelTable: "checkout_supply_items" },
            { readModelTable: "checkout_supply_locations" },
            { readModelTable: "checkout_seller_accounts" },
            { readModelTable: "checkout_ship_from_addresses" },
          ],
        },
      },
    ]);

    const resolvedDependencies = [
      ...new Map(
        accountSellListLiveRoutes
          .flatMap(({ route }) =>
            route.dependencies.flatMap((dependency) =>
              resolveReadConsistencyDependency("checkout", dependency, mountedProjectionGroups),
            ),
          )
          .map((dependency) => [`${dependency.targetContextName}:${dependency.projectionName}`, dependency]),
      ).values(),
    ];

    expect(resolvedDependencies).toEqual([
      { targetContextName: "checkout", projectionName: "checkout.sell-list-projection" },
      { targetContextName: "checkout", projectionName: "checkout-marketplace-listing-options-projection" },
      { targetContextName: "checkout", projectionName: "checkout-inventory-supply-projection" },
      { targetContextName: "checkout", projectionName: "checkout-seller-accounts-projection" },
    ]);
  });

  it("pins guest Sell List add-line handoffs to the checkout Sell List projection dependency", () => {
    expect(CRITICAL_READ_CONSISTENCY_ROUTE_TUNING).toContainEqual({
      mountPath: "/api/marketplace",
      routePath: "/guest/sell-list",
      timeoutMs: 900,
      pollIntervalMs: 50,
      exactDependencyMode: "enabled",
    });

    const guestSellListLiveRoutes = findLiveFreshnessRoutes("checkout", "/guest/sell-list");
    expect(guestSellListLiveRoutes).toEqual([
      {
        mountPath: "/api/marketplace",
        route: {
          routePath: "/guest/sell-list",
          methods: ["GET", "HEAD"],
          dependencies: [{ readModelTable: "checkout_sell_list_line_pages" }],
        },
      },
    ]);

    const resolvedDependencies = guestSellListLiveRoutes.flatMap(({ route }) =>
      route.dependencies.flatMap((dependency) =>
        resolveReadConsistencyDependency("checkout", dependency, mountedProjectionGroups),
      ),
    );

    expect(resolvedDependencies).toEqual([
      { targetContextName: "checkout", projectionName: "checkout.sell-list-projection" },
    ]);
  });

  it("backs accepted-offer sales list freshness with the offer process and sale list read models", () => {
    const salesLiveRoutes = findLiveFreshnessRoutes("ordering", "/sales");
    expect(salesLiveRoutes).toEqual([
      {
        mountPath: "/api/marketplace",
        route: {
          routePath: "/sales",
          methods: ["GET", "HEAD"],
          dependencies: [
            { projectionName: "ordering-marketplace-offer-acceptance" },
            { readModelTable: "ordering_order_pages" },
            { readModelTable: "ordering_order_line_pages" },
          ],
        },
      },
    ]);

    const resolvedDependencies = [
      ...new Map(
        salesLiveRoutes
          .flatMap(({ route }) =>
            route.dependencies.flatMap((dependency) =>
              resolveReadConsistencyDependency("ordering", dependency, mountedProjectionGroups),
            ),
          )
          .map((dependency) => [`${dependency.targetContextName}:${dependency.projectionName}`, dependency]),
      ).values(),
    ];

    expect(resolvedDependencies).toEqual([
      { targetContextName: "ordering", projectionName: "ordering-marketplace-offer-acceptance" },
      { targetContextName: "ordering", projectionName: "ordering-order-projection" },
    ]);
  });

  it("backs settlement payout detail freshness with the payout projection dependency", () => {
    expectCriticalRouteTuning("/api/settlement", "/payouts/:id");

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

  it("pins settlement payout readiness freshness to the readiness projection dependency", () => {
    expectCriticalRouteTuning("/api/settlement", "/payout-readiness");

    const settlementPayoutReadinessLiveRoutes = findLiveFreshnessRoutes("settlement", "/payout-readiness");
    expect(settlementPayoutReadinessLiveRoutes).toEqual([
      {
        mountPath: "/api/settlement",
        route: {
          routePath: "/payout-readiness",
          methods: ["GET", "HEAD"],
          dependencies: [{ readModelTable: "settlement_payout_readiness_pages" }],
        },
      },
    ]);

    const resolvedDependencies = settlementPayoutReadinessLiveRoutes.flatMap(({ route }) =>
      route.dependencies.flatMap((dependency) =>
        resolveReadConsistencyDependency("settlement", dependency, mountedProjectionGroups),
      ),
    );

    expect(resolvedDependencies).toEqual([
      { targetContextName: "settlement", projectionName: "settlement-payout-readiness-projection" },
    ]);
  });

  it("pins payment detail freshness to the payment projection dependency", () => {
    expectCriticalRouteTuning("/api/marketplace", "/account/payments/:id");

    const paymentDetailLiveRoutes = findLiveFreshnessRoutes("payments", "/account/payments/:id");
    expect(paymentDetailLiveRoutes).toEqual([
      {
        mountPath: "/api/marketplace",
        route: {
          routePath: "/account/payments/:id",
          methods: ["GET", "HEAD"],
          dependencies: [{ readModelTable: "payments_payment_pages" }],
        },
      },
    ]);

    const resolvedDependencies = paymentDetailLiveRoutes.flatMap(({ route }) =>
      route.dependencies.flatMap((dependency) =>
        resolveReadConsistencyDependency("payments", dependency, mountedProjectionGroups),
      ),
    );

    expect(resolvedDependencies).toEqual([
      { targetContextName: "payments", projectionName: "payments-payment-projection" },
    ]);
  });

  it("pins Marketplace listing detail freshness to the listing projection dependency", () => {
    expectCriticalRouteTuning("/api/marketplace", "/account/listings/:id");

    const listingDetailLiveRoutes = findLiveFreshnessRoutes("marketplace", "/account/listings/:id");
    expect(listingDetailLiveRoutes).toEqual([
      {
        mountPath: "/api/marketplace",
        route: {
          routePath: "/account/listings/:id",
          methods: ["GET", "HEAD"],
          dependencies: [{ readModelTable: "marketplace_listing_pages" }],
        },
      },
    ]);

    const resolvedDependencies = listingDetailLiveRoutes.flatMap(({ route }) =>
      route.dependencies.flatMap((dependency) =>
        resolveReadConsistencyDependency("marketplace", dependency, mountedProjectionGroups),
      ),
    );

    expect(resolvedDependencies).toEqual([
      { targetContextName: "marketplace", projectionName: "marketplace-listing-projection" },
    ]);
  });

  it("pins Public Presence waitlist review freshness to the waitlist projection dependency", () => {
    expectCriticalRouteTuning("/api/public-presence/admin", "/waitlist");

    const waitlistReviewLiveRoutes = findLiveFreshnessRoutes("public-presence", "/waitlist");
    expect(waitlistReviewLiveRoutes).toEqual([
      {
        mountPath: "/api/public-presence/admin",
        route: {
          routePath: "/waitlist",
          methods: ["GET", "HEAD"],
          dependencies: [{ readModelTable: "public_presence_waitlist_signups" }],
        },
      },
    ]);

    const resolvedDependencies = waitlistReviewLiveRoutes.flatMap(({ route }) =>
      route.dependencies.flatMap((dependency) =>
        resolveReadConsistencyDependency("public-presence", dependency, mountedProjectionGroups),
      ),
    );

    expect(resolvedDependencies).toEqual([
      { targetContextName: "public-presence", projectionName: "public-presence-waitlist-projection" },
    ]);
  });

  it("blocks stale non-cart platform API command-to-GET reads before the handler runs", async () => {
    const middlewares: ((context: unknown, next: () => Promise<void>) => Promise<unknown>)[] = [];
    const settlementProjectionLag = async () => ({
      lastGlobalPosition: "7",
      sourceHeadGlobalPosition: "42",
      state: "behind",
      lastError: "settlement payout projection is behind",
    });
    const receipt = encodeFreshWriteReceipt({
      observedAtMs: Date.now(),
      sources: [{ sourceContextName: "settlement", maxGlobalPosition: "42", eventIds: ["evt_payout_requested"] }],
    });
    const settlementMounts = apiContextRegistry
      .filter((entry) => entry.contextName === "settlement")
      .flatMap((entry) =>
        entry.module.apiMounts.map((mount) => ({
          contextName: entry.contextName as string,
          mountPath: mount.mountPath,
          readFreshnessRoutes: mount.readFreshnessRoutes,
        })),
      );
    const platformProjectionGroups: readonly ReadConsistencyProjectionGroup[] = mountedProjectionGroups.map((group) =>
      group.targetContextName === "settlement" && group.projectionName === "settlement-payout-projection"
        ? {
            ...group,
            subscriptionRunners: [{ sourceContextName: "settlement", refreshStatus: settlementProjectionLag }],
          }
        : group,
    );

    attachReadConsistencyMiddleware(
      {
        use: (_path, middleware) => {
          middlewares.push(middleware);
        },
      },
      settlementMounts,
      platformProjectionGroups,
      { timeoutMs: 0, pollIntervalMs: 1, exactDependencyMode: "enabled" },
    );

    let handlerRan = false;
    const result = await middlewares[0]?.(
      {
        req: {
          method: "GET",
          path: "/api/settlement/payouts/pay_1",
          header: (name: string) => (name === CHASE_SETS_READ_AFTER_WRITE_HEADER ? receipt : undefined),
        },
        json: (body: unknown, status: number) => ({ body, status }),
      },
      async () => {
        handlerRan = true;
      },
    );

    expect(handlerRan).toBe(false);
    expect(result).toMatchObject({
      status: 503,
      body: {
        error: {
          code: "projection_freshness_timeout",
          waitMode: "exact-dependency",
          dependencies: [{ targetContextName: "settlement", projectionName: "settlement-payout-projection" }],
          pending: [
            {
              targetContextName: "settlement",
              projectionName: "settlement-payout-projection",
              sourceContextName: "settlement",
              requiredGlobalPosition: "42",
              lastGlobalPosition: "7",
              lastError: "present",
            },
          ],
        },
      },
    });
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

  it("maps every critical route tuning entry into bounded wake enqueue telemetry labels", () => {
    const violations: string[] = [];
    const records: unknown[] = [];

    for (const tuning of CRITICAL_READ_CONSISTENCY_ROUTE_TUNING) {
      const matchingFreshnessRoutes = apiContextRegistry.flatMap((entry) =>
        entry.module.apiMounts
          .filter((mount) => mount.mountPath === tuning.mountPath)
          .flatMap((mount) =>
            (mount.readFreshnessRoutes ?? [])
              .filter((route) => route.routePath === tuning.routePath)
              .map((route) => ({ contextName: entry.contextName as string, route })),
          ),
      );

      if (matchingFreshnessRoutes.length === 0) {
        violations.push(`critical route '${tuning.mountPath}${tuning.routePath}' has no live freshness route`);
        continue;
      }

      for (const { contextName, route } of matchingFreshnessRoutes) {
        const dependencies = (route.dependencies ?? []).flatMap((dependency) =>
          resolveReadConsistencyDependency(contextName, dependency, mountedProjectionGroups),
        );
        if (dependencies.length === 0) {
          violations.push(
            `critical route '${tuning.mountPath}${tuning.routePath}' has no exact dependency telemetry target`,
          );
          continue;
        }

        for (const dependency of dependencies) {
          const record = projectionFreshnessWakeEnqueueMetricRecord({
            outcome: "completed",
            priorityLane: "hot",
            requestCount: 1,
            enqueuedCount: 1,
            durationMs: 12.4,
            sourceContextName: dependency.targetContextName,
            targetContextName: dependency.targetContextName,
            projectionName: dependency.projectionName,
            mountPath: tuning.mountPath,
            routePath: tuning.routePath,
          });

          records.push(record);
          expect(record).toMatchObject({
            attributes: {
              mount_path: tuning.mountPath,
              route_path: tuning.routePath,
              target_context: dependency.targetContextName,
              projection: dependency.projectionName,
            },
          });
        }
      }
    }

    expect(violations).toEqual([]);
    expect(records.length).toBeGreaterThanOrEqual(CRITICAL_READ_CONSISTENCY_ROUTE_TUNING.length);
    expect(JSON.stringify(records)).not.toContain("ord_");
    expect(JSON.stringify(records)).not.toContain("pay_");
    expect(JSON.stringify(records)).not.toContain("chk_");
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
