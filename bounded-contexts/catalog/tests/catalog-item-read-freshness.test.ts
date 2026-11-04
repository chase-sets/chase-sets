import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  attachReadConsistencyMiddleware,
  type ReadConsistencyDependencyDeclaration,
  type ReadConsistencyProjectionGroup,
  type ReadConsistencyRouteDependency,
} from "@chase-sets/bounded-context-runtime";
import { CHASE_SETS_READ_AFTER_WRITE_HEADER, encodeFreshWriteReceipt } from "@chase-sets/http/responses";

type CatalogManifest = Readonly<{
  apiMounts: readonly Readonly<{
    mountPath: string;
    kind: string;
    readFreshnessRoutes?: readonly Readonly<{
      routePath: string;
      methods?: readonly ("GET" | "HEAD")[];
      dependencies: readonly ReadConsistencyDependencyDeclaration[];
    }>[];
  }>[];
  projectionGroups: readonly Readonly<{
    projectionName: string;
    ownedTables?: readonly string[];
  }>[];
  readAfterWriteRouteInventory?: readonly Readonly<{
    id: string;
    destination?: Readonly<{
      apiRoutePath?: string;
      readModelTables?: readonly string[];
      projectionDependencies?: readonly string[];
    }>;
    source?: Readonly<{ command?: string }>;
    proof?: Readonly<{ tests?: readonly string[] }>;
  }>[];
}>;

const repoRoot = resolve(fileURLToPath(new URL("../../..", import.meta.url)));

function catalogManifest(): CatalogManifest {
  return JSON.parse(
    readFileSync(resolve(repoRoot, "bounded-contexts/catalog/context.json"), "utf8"),
  ) as CatalogManifest;
}

const expectedRoutes = [
  {
    routePath: "/items/:id",
    dependencies: [
      { readModelTable: "catalog_admin_catalog_item_detail_pages" },
      { projectionName: "catalog-admin-catalog-item-projection" },
      { readModelTable: "catalog_items" },
      { readModelTable: "catalog_fields" },
      { readModelTable: "catalog_display_templates" },
      { readModelTable: "catalog_item_aliases" },
      { readModelTable: "catalog_reference_record_aliases" },
    ],
    groups: [
      "catalog-admin-catalog-item-projection",
      "catalog-item-projection",
      "catalog-field-projection",
      "catalog-display-template-projection",
      "catalog-alias-projection",
    ],
  },
  {
    routePath: "/items",
    dependencies: [
      { readModelTable: "catalog_admin_catalog_item_list_pages" },
      { readModelTable: "catalog_external_product_references" },
      { readModelTable: "catalog_external_catalog_item_references" },
      { readModelTable: "catalog_admin_catalog_item_detail_pages" },
      { readModelTable: "catalog_blueprints" },
    ],
    groups: ["catalog-admin-catalog-item-projection", "catalog-item-projection", "catalog-blueprint-projection"],
  },
  {
    routePath: "/product-contents/containers/:id",
    dependencies: [{ readModelTable: "catalog_resolved_product_contents" }],
    groups: ["catalog-product-contents-projection"],
  },
  {
    routePath: "/product-contents/contained/:id",
    dependencies: [{ readModelTable: "catalog_resolved_product_contents" }],
    groups: ["catalog-product-contents-projection"],
  },
] as const;

function manifestMount(manifest: CatalogManifest) {
  const mount = manifest.apiMounts.find(
    (candidate) => candidate.mountPath === "/api/catalog" && candidate.kind === "primary",
  );
  if (!mount?.readFreshnessRoutes) throw new Error("Catalog primary mount is missing freshness routes.");
  return mount;
}

function groupsForManifest(manifest: CatalogManifest, status: ReadonlyMap<string, "caught-up" | "behind" | "error">) {
  return manifest.projectionGroups.map<ReadConsistencyProjectionGroup>((group) => {
    const state = status.get(group.projectionName) ?? "caught-up";
    const refreshStatus = vi.fn(async () => ({
      lastGlobalPosition: state === "caught-up" ? "10" : "9",
      state,
      lastError: state === "error" ? "projection failed" : null,
    }));
    return {
      targetContextName: "catalog",
      projectionName: group.projectionName,
      ownedTables: group.ownedTables,
      subscriptionRunners: [
        { sourceContextName: "catalog", checkpointKey: `catalog-${group.projectionName}`, refreshStatus },
      ],
    };
  });
}

function requestFor(path: string, method: "GET" | "HEAD", receipt: string) {
  return {
    req: {
      method,
      path,
      header: (name: string) => (name === CHASE_SETS_READ_AFTER_WRITE_HEADER ? receipt : undefined),
    },
    json: (body: unknown, status: number) => ({ body, status }),
  };
}

function routeRequestPath(routePath: string) {
  return `/api/catalog${routePath.replace(":id", "cat_read_freshness")}`;
}

describe("Catalog item read freshness", () => {
  it("catalog receipted read dependency matrix matches complete response inputs", () => {
    const manifest = catalogManifest();
    const mount = manifestMount(manifest);
    const byTable = new Map(
      manifest.projectionGroups.flatMap((group) =>
        (group.ownedTables ?? []).map((table) => [table, group.projectionName] as const),
      ),
    );
    const actual = mount.readFreshnessRoutes!.map((route) => ({
      routePath: route.routePath,
      methods: route.methods ?? ["GET", "HEAD"],
      dependencies: route.dependencies,
    }));

    expect(actual).toEqual(
      expectedRoutes.map(({ routePath, dependencies }) => ({ routePath, methods: ["GET", "HEAD"], dependencies })),
    );
    for (const expected of expectedRoutes) {
      const route = mount.readFreshnessRoutes!.find((candidate) => candidate.routePath === expected.routePath)!;
      const resolvedGroups = route.dependencies.map((dependency) =>
        "projectionName" in dependency ? dependency.projectionName : byTable.get(dependency.readModelTable),
      );
      expect([...new Set(resolvedGroups)]).toEqual(expected.groups);
    }
    const selectedGroups = expectedRoutes.flatMap((expected) => expected.groups);
    expect(selectedGroups).not.toContain("catalog-source-observation-projection");
    expect(selectedGroups).not.toContain("catalog-attention-dismissal-projection");
  });

  it("catalog exact waits ignore unrelated lag but retain each required checkpoint", async () => {
    const manifest = catalogManifest();
    const mount = manifestMount(manifest);
    const receipt = encodeFreshWriteReceipt({
      observedAtMs: Date.now(),
      sources: [{ sourceContextName: "catalog", maxGlobalPosition: "10", eventIds: ["evt_catalog_10"] }],
    });

    for (const expected of expectedRoutes) {
      const required = new Set<string>(expected.groups);
      const status = new Map<string, "caught-up" | "behind">(
        manifest.projectionGroups.map((group) => [
          group.projectionName,
          required.has(group.projectionName) ? "caught-up" : "behind",
        ]),
      );
      const groups = groupsForManifest(manifest, status);
      const audits: unknown[] = [];
      const middlewares: ((context: unknown, next: () => Promise<void>) => Promise<unknown>)[] = [];
      attachReadConsistencyMiddleware(
        { use: (_path, middleware) => void middlewares.push(middleware) },
        [
          {
            contextName: "catalog",
            mountPath: mount.mountPath,
            readFreshnessRoutes: mount.readFreshnessRoutes as unknown as readonly ReadConsistencyRouteDependency[],
          },
        ],
        groups,
        { timeoutMs: 0, pollIntervalMs: 1, recordReadConsistencyAudit: (audit) => audits.push(audit) },
      );

      let nextCalls = 0;
      const result = await middlewares[0]!(
        requestFor(`${routeRequestPath(expected.routePath)}/`, "GET", receipt),
        async () => {
          nextCalls += 1;
        },
      );
      expect(result).toBeUndefined();
      expect(nextCalls).toBe(1);
      expect(audits[0]).toMatchObject({
        outcome: "fresh",
        waitMode: "exact-dependency",
        routePaths: [expected.routePath],
      });
      expect((audits[0] as { dependencies: readonly unknown[] }).dependencies).toHaveLength(expected.groups.length);
      for (const group of groups) {
        const calls = group.subscriptionRunners[0]!.refreshStatus;
        if (required.has(group.projectionName)) expect(calls).toHaveBeenCalledTimes(1);
        else expect(calls).not.toHaveBeenCalled();
      }

      for (const laggingGroup of expected.groups) {
        const lagging = new Map(status).set(laggingGroup, "behind");
        const timeoutGroups = groupsForManifest(manifest, lagging);
        const timeoutMiddlewares: ((context: unknown, next: () => Promise<void>) => Promise<unknown>)[] = [];
        const timeoutAudits: unknown[] = [];
        attachReadConsistencyMiddleware(
          { use: (_path, middleware) => void timeoutMiddlewares.push(middleware) },
          [
            {
              contextName: "catalog",
              mountPath: mount.mountPath,
              readFreshnessRoutes: mount.readFreshnessRoutes as unknown as readonly ReadConsistencyRouteDependency[],
            },
          ],
          timeoutGroups,
          { timeoutMs: 0, pollIntervalMs: 1, recordReadConsistencyAudit: (audit) => timeoutAudits.push(audit) },
        );
        const timeout = await timeoutMiddlewares[0]!(
          requestFor(routeRequestPath(expected.routePath), "HEAD", receipt),
          async () => undefined,
        );
        expect(timeout).toMatchObject({
          status: 503,
          body: { error: { code: "projection_freshness_timeout", waitMode: "exact-dependency" } },
        });
        expect(timeoutAudits[0]).toMatchObject({ outcome: "timeout", waitMode: "exact-dependency" });
      }
    }
  });

  it("receipted catalog reads bind freshness to committed application not row presence", async () => {
    const manifest = catalogManifest();
    const mount = manifestMount(manifest);
    const exercisedRoutes = ["/items/:id", "/product-contents/containers/:id", "/product-contents/contained/:id"];

    for (const routePath of exercisedRoutes) {
      const route = mount.readFreshnessRoutes!.find((candidate) => candidate.routePath === routePath);
      expect(route).toBeDefined();
      const required = new Set(
        route!.dependencies.map((dependency) =>
          "projectionName" in dependency
            ? dependency.projectionName
            : manifest.projectionGroups.find((group) => group.ownedTables?.includes(dependency.readModelTable))
                ?.projectionName,
        ),
      );
      expect(required).not.toContain(undefined);

      const invoke = async (
        states: ReadonlyMap<string, "caught-up" | "behind" | "error">,
        maxGlobalPosition = "10",
      ) => {
        const receipt = encodeFreshWriteReceipt({
          observedAtMs: Date.now(),
          sources: [{ sourceContextName: "catalog", maxGlobalPosition, eventIds: ["evt_catalog_10"] }],
        });
        const groups = groupsForManifest(manifest, states);
        const middlewares: ((context: unknown, next: () => Promise<void>) => Promise<unknown>)[] = [];
        const audits: unknown[] = [];
        attachReadConsistencyMiddleware(
          { use: (_path, middleware) => void middlewares.push(middleware) },
          [{ contextName: "catalog", mountPath: mount.mountPath, readFreshnessRoutes: mount.readFreshnessRoutes }],
          groups,
          { timeoutMs: 0, pollIntervalMs: 1, recordReadConsistencyAudit: (audit) => audits.push(audit) },
        );
        let handlerCalls = 0;
        const result = await middlewares[0]!(requestFor(routeRequestPath(routePath), "GET", receipt), async () => {
          handlerCalls += 1;
        });
        return { groups, audits, handlerCalls, result };
      };

      const behind = new Map<string, "caught-up" | "behind" | "error">(
        manifest.projectionGroups.map((group) => [group.projectionName, "caught-up"]),
      );
      behind.set([...required][0]!, "behind");
      const behindResult = await invoke(behind);
      expect(behindResult.handlerCalls).toBe(0);
      expect(behindResult.result).toMatchObject({
        status: 503,
        body: { error: { code: "projection_freshness_timeout", waitMode: "exact-dependency" } },
      });

      const failed = new Map(behind).set([...required][0]!, "error" as const);
      const failedResult = await invoke(failed);
      expect(failedResult.handlerCalls).toBe(0);
      expect(failedResult.result).toMatchObject({
        status: 503,
        body: { error: { code: "projection_freshness_timeout", waitMode: "exact-dependency" } },
      });

      const partialReceiptResult = await invoke(
        new Map<string, "caught-up" | "behind" | "error">(
          manifest.projectionGroups.map((group) => [group.projectionName, "caught-up"]),
        ),
        "11",
      );
      expect(partialReceiptResult.handlerCalls).toBe(0);
      expect(partialReceiptResult.audits[0]).toMatchObject({ outcome: "timeout", waitMode: "exact-dependency" });

      const unrelatedLag = new Map<string, "caught-up" | "behind" | "error">(
        manifest.projectionGroups.map((group) => [group.projectionName, "caught-up"]),
      );
      unrelatedLag.set("catalog-source-observation-projection", "behind");
      const freshResult = await invoke(unrelatedLag);
      expect(freshResult.result).toBeUndefined();
      expect(freshResult.handlerCalls).toBe(1);
      expect(freshResult.audits[0]).toMatchObject({ outcome: "fresh", waitMode: "exact-dependency" });
    }

    const detail = manifest.readAfterWriteRouteInventory?.find(
      (entry) => entry.id === "catalog.item-detail-self-refresh",
    );
    expect(detail).toMatchObject({
      source: { command: expect.stringContaining("catalog-item-api-command-snapshots") },
      destination: {
        apiRoutePath: "/items/:id",
        readModelTables: expect.arrayContaining(["catalog_admin_catalog_item_detail_pages", "catalog_items"]),
        projectionDependencies: ["catalog-admin-catalog-item-projection"],
      },
      proof: {
        tests: expect.arrayContaining([
          "bounded-contexts/catalog/tests/catalog-item-read-freshness.test.ts",
          "bounded-contexts/catalog/tests/catalog-item-read-freshness.db.test.ts",
        ]),
      },
    });
  });

  it("catalog exact routes preserve receipt and snapshot fallback contracts", () => {
    const manifest = catalogManifest();
    const inventory = manifest.readAfterWriteRouteInventory ?? [];
    expect(inventory.map((entry) => entry.id)).toEqual([
      "catalog.item-detail-self-refresh",
      "catalog.item-list-self-refresh",
      "catalog.product-contents-container-self-refresh",
      "catalog.product-contents-contained-self-refresh",
    ]);
    expect(inventory.every((entry) => entry.source?.command?.includes("command-snapshots"))).toBe(true);
    expect(
      inventory.every((entry) => entry.destination?.apiRoutePath && entry.destination.readModelTables?.length),
    ).toBe(true);
  });
});
