import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { ContextProjectionGroup } from "@chase-sets/bounded-context-runtime";
import { describe, expect, it } from "vitest";

import { buildProjectionInterestIndex } from "./projection-interest-index";
import {
  listProjectionInterestOverridesForPushMigration,
  listProjectionPushMigrationEntries,
  listRouteDependencyPushDispositions,
  projectionPushOptOuts,
  summarizeProjectionPushMigration,
  validateProjectionPushOptOuts,
  type ProjectionPushOptOut,
} from "./projection-push-migration";
import {
  sourceContextWakeRegistry,
  type SourceContextWakeEnablement,
  type SourceContextWakeRegistryEntry,
} from "./source-context-wake-registry";

const APPROVED_OPT_OUT: ProjectionPushOptOut = {
  projectionKey: "checkout:checkout.cart-projection",
  owner: "Checkout",
  reason: "Example owner-approved exception used by tests.",
  reviewBy: "2026-09-30",
  compensatingFreshnessContract: "Bounded worker polling at the projections-group poll interval.",
};

describe("projection push migration inventory", () => {
  const inventory = loadBoundedContextInventory();

  it("covers every projection group and read-after-write route inventory entry", () => {
    const entries = listProjectionPushMigrationEntries();
    expect(entries.map((entry) => entry.projectionKey)).toEqual(inventory.projectionKeys);

    const routeDispositions = listRouteDependencyPushDispositions();
    expect(routeDispositions.map((dependency) => dependency.routeDependencyId)).toEqual(inventory.routeDependencyIds);

    for (const entry of entries) {
      expect(entry.sourceContextCount).toBeGreaterThan(0);
      expect(entry.owner).toMatch(/\S/);
      // Polling never disappears: it is the reconciliation/fallback layer.
      expect(entry.fallbackPolling).toBe(true);
    }
  });

  it("classifies staging-enabled projections as push-enabled and the remainder as push-eligible", () => {
    const entries = listProjectionPushMigrationEntries();
    const byKey = new Map(entries.map((entry) => [entry.projectionKey, entry]));

    // All sources inside the staging-enabled set -> fully push-enabled.
    expect(byKey.get("checkout:checkout.session-projection")).toMatchObject({
      status: "push-enabled",
      owner: "Checkout",
      enabledSourceContextCount: 1,
      sourceContextCount: 1,
      consumesDurableWakeIntents: true,
    });
    expect(byKey.get("payments:payments-order-input-projection")).toMatchObject({
      status: "push-enabled",
      owner: "Payments",
    });
    expect(byKey.get("catalog:catalog-source-observation-projection")).toMatchObject({
      status: "push-enabled",
      owner: "Catalog",
      enabledSourceContextCount: 1,
      sourceContextCount: 1,
      consumesDurableWakeIntents: true,
    });

    // Mixed sources are fully push-enabled once catalog, checkout, identity,
    // inventory, marketplace, and ordering all have relay fan-out enabled.
    expect(byKey.get("discovery:discovery-market-projection")).toMatchObject({
      status: "push-enabled",
      owner: "Discovery",
      enabledSourceContextCount: 6,
      sourceContextCount: 6,
      consumesDurableWakeIntents: true,
    });

    expect(byKey.get("platform-operations:public-doc-review-queue-projection")).toMatchObject({
      status: "push-enabled",
      owner: "Platform Operations",
      enabledSourceContextCount: 2,
      sourceContextCount: 2,
      consumesDurableWakeIntents: true,
    });

    // Catalog is enabled, so Catalog-sourced projections receive wake-intent delivery.
    expect(byKey.get("pricing:pricing-catalog-input-projection")).toMatchObject({
      status: "push-enabled",
      enabledSourceContextCount: 1,
      consumesDurableWakeIntents: true,
    });

    expect(summarizeProjectionPushMigration()).toMatchObject({
      projectionCount: inventory.projectionKeys.length,
      optOutCount: 0,
      routeDependencyCount: inventory.routeDependencyIds.length,
    });
    const statusCounts = Object.fromEntries(
      summarizeProjectionPushMigration().statusCounts.map((entry) => [entry.status, entry.count]),
    );
    expect(statusCounts["disabled"]).toBe(0);
    expect(statusCounts["opted-out"]).toBe(0);
    expect((statusCounts["push-enabled"] ?? 0) + (statusCounts["push-eligible"] ?? 0)).toBe(
      inventory.projectionKeys.length,
    );
  });

  it("classifies explicit opt-outs and registry-disabled source contexts", () => {
    const optedOut = listProjectionPushMigrationEntries({ optOuts: [APPROVED_OPT_OUT] });
    expect(optedOut.find((entry) => entry.projectionKey === APPROVED_OPT_OUT.projectionKey)).toMatchObject({
      status: "opted-out",
      optOut: { owner: "Checkout", reviewBy: "2026-09-30" },
    });

    const registry = withRegistryEntryPatch("discovery", {
      rolloutState: "disabled",
      disabledReason: "Disabled for the migration-classification test.",
    });
    const disabled = listProjectionPushMigrationEntries({ registry });
    expect(
      disabled.find((entry) => entry.projectionKey === "discovery:discovery-product-alert-page-projection"),
    ).toMatchObject({
      status: "disabled",
      enabledSourceContextCount: 0,
    });
  });

  it("requires owner-approved evidence for explicit opt-outs", () => {
    expect(() => validateProjectionPushOptOuts()).not.toThrow();
    expect(projectionPushOptOuts).toEqual([]);

    expect(() =>
      validateProjectionPushOptOuts({ optOuts: [{ ...APPROVED_OPT_OUT, projectionKey: "nope:missing" }] }),
    ).toThrow(/does not match any registry projection group/);
    expect(() => validateProjectionPushOptOuts({ optOuts: [{ ...APPROVED_OPT_OUT, reason: " " }] })).toThrow(
      /non-empty reason/,
    );
    expect(() =>
      validateProjectionPushOptOuts({ optOuts: [{ ...APPROVED_OPT_OUT, compensatingFreshnessContract: "" }] }),
    ).toThrow(/compensatingFreshnessContract/);
    expect(() => validateProjectionPushOptOuts({ optOuts: [{ ...APPROVED_OPT_OUT, reviewBy: "soon" }] })).toThrow(
      /ISO reviewBy date/,
    );
    expect(() => validateProjectionPushOptOuts({ optOuts: [APPROVED_OPT_OUT, APPROVED_OPT_OUT] })).toThrow(
      /more than once/,
    );
  });

  it("derives interest-index overrides that record owners and disable opted-out projections", () => {
    const registry = withRegistryEntryPatch("discovery", {
      rolloutState: "disabled",
      disabledReason: "Disabled for the override-derivation test.",
    });
    const overrides = listProjectionInterestOverridesForPushMigration({
      registry,
      optOuts: [APPROVED_OPT_OUT],
    });

    const index = buildProjectionInterestIndex({
      generatedAt: new Date("2026-06-11T12:00:00.000Z"),
      projectionGroups: [
        projectionGroup({
          targetContextName: "checkout",
          projectionName: "checkout.cart-projection",
          sourceContextNames: ["checkout"],
        }),
        projectionGroup({
          targetContextName: "checkout",
          projectionName: "checkout.session-projection",
          sourceContextNames: ["checkout"],
        }),
        projectionGroup({
          targetContextName: "discovery",
          projectionName: "discovery-product-alert-page-projection",
          sourceContextNames: ["discovery"],
        }),
      ],
      projectionOverrides: overrides,
    });

    const entryByKey = new Map(index.entries.map((entry) => [entry.entryId, entry]));
    expect(
      entryByKey.get("checkout:checkout:checkout.cart-projection:checkout.cart-projection:checkout:v1"),
    ).toMatchObject({
      enabled: false,
      optOutReason: APPROVED_OPT_OUT.reason,
      owner: "Checkout",
    });
    expect(
      entryByKey.get("checkout:checkout:checkout.session-projection:checkout.session-projection:checkout:v1"),
    ).toMatchObject({
      enabled: true,
      owner: "Checkout",
      optOutReason: null,
    });
    expect(
      entryByKey.get(
        "discovery:discovery:discovery-product-alert-page-projection:discovery-product-alert-page-projection:discovery:v1",
      ),
    ).toMatchObject({
      enabled: false,
      optOutReason: "Disabled for the override-derivation test.",
      owner: "Discovery",
    });
  });

  it("keeps the migration report document covering every projection group and route entry", () => {
    const reportPath = fileURLToPath(
      new URL("../../docs/architecture/push-first-projection-migration.md", import.meta.url),
    );
    const report = readFileSync(reportPath, "utf8");

    for (const projectionKey of inventory.projectionKeys) {
      expect(report, `migration report must cover projection group '${projectionKey}'`).toContain(projectionKey);
    }
    for (const routeDependencyId of inventory.routeDependencyIds) {
      expect(report, `migration report must cover route inventory entry '${routeDependencyId}'`).toContain(
        routeDependencyId,
      );
    }
  });
});

type BoundedContextInventory = Readonly<{
  projectionKeys: readonly string[];
  routeDependencyIds: readonly string[];
}>;

type ContextJson = Readonly<{
  contextName: string;
  projectionGroups?: readonly Readonly<{
    projectionName?: string;
    sourceContextNames?: readonly string[];
  }>[];
  readAfterWriteRouteInventory?: readonly Readonly<{
    id?: string;
  }>[];
}>;

function loadBoundedContextInventory(): BoundedContextInventory {
  const boundedContextsDir = fileURLToPath(new URL("../../bounded-contexts", import.meta.url));
  const projectionKeys = new Set<string>();
  const routeDependencyIds = new Set<string>();

  for (const directoryName of readdirSync(boundedContextsDir).sort()) {
    const contextJsonPath = join(boundedContextsDir, directoryName, "context.json");
    if (!existsSync(contextJsonPath)) {
      continue;
    }

    const contextJson = JSON.parse(readFileSync(contextJsonPath, "utf8")) as ContextJson;
    for (const group of contextJson.projectionGroups ?? []) {
      if (group.projectionName) {
        projectionKeys.add(`${contextJson.contextName}:${group.projectionName}`);
      }
    }
    for (const routeInventoryEntry of contextJson.readAfterWriteRouteInventory ?? []) {
      if (routeInventoryEntry.id?.trim()) {
        routeDependencyIds.add(routeInventoryEntry.id);
      }
    }
  }

  return {
    projectionKeys: [...projectionKeys].sort((left, right) => left.localeCompare(right)),
    routeDependencyIds: [...routeDependencyIds].sort((left, right) => left.localeCompare(right)),
  };
}

type SourceContextWakeRegistryEntryPatch = Partial<Omit<SourceContextWakeRegistryEntry, "enablement">> &
  Readonly<{
    enablement?: Partial<SourceContextWakeEnablement>;
  }>;

function withRegistryEntryPatch(
  sourceContextName: string,
  patch: SourceContextWakeRegistryEntryPatch,
): SourceContextWakeRegistryEntry[] {
  return sourceContextWakeRegistry.map((entry) => {
    if (entry.sourceContextName !== sourceContextName) {
      return entry;
    }

    return {
      ...entry,
      ...patch,
      enablement: {
        ...entry.enablement,
        ...patch.enablement,
      },
    };
  });
}

function projectionGroup(
  input: Readonly<{
    targetContextName: string;
    projectionName: string;
    sourceContextNames: readonly string[];
  }>,
): ContextProjectionGroup {
  return {
    projectionName: input.projectionName,
    projectionRevision: 1,
    targetContextName: input.targetContextName,
    sourceContextNames: input.sourceContextNames,
    optionalSourceContextNames: [],
    ownedTables: [],
    requiredDuringBootstrap: false,
    subscriptionRunners: input.sourceContextNames.map((sourceContextName) => ({
      subscriptionName: `${input.targetContextName}.${input.projectionName}.${sourceContextName}`,
      projectionName: input.projectionName,
      sourceContextName,
      targetContextName: input.targetContextName,
      subscriptionVersion: 1,
      checkpointKey: `${input.projectionName}:${sourceContextName}:v1`,
      order: 0,
      runOnce: async () => ({}) as never,
      getStatus: () => ({}) as never,
      refreshStatus: async () => ({}) as never,
      reset: async () => {},
      retryBlockedStream: async () => ({}) as never,
    })),
    reset: async () => {},
    getStatus: () => ({}) as never,
    refreshStatus: async () => ({}) as never,
    markRevisionSynced: async () => {},
  };
}
