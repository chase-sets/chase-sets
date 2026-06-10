import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  createEventStoreWakeNotificationConfigForSourceContext,
  listEventStoreWakeNotificationSourceContexts,
  listSourceContextWakeRegistryEntries,
  listSourceContextWakeRelayConfigs,
  requireSourceContextWakeRegistryEntry,
  sourceContextWakeRegistry,
  SOURCE_CONTEXT_WAKE_PRODUCTION_GATE_ISSUES,
  summarizeSourceContextWakeRegistry,
  validateSourceContextWakeRegistry,
  type SourceContextWakeEnablement,
  type SourceContextWakeRegistryEntry,
} from "./source-context-wake-registry";

describe("source-context wake registry", () => {
  const inventory = loadBoundedContextInventory();

  it("covers every bounded context while keeping runtime wake behavior disabled by default", () => {
    expect(() =>
      validateSourceContextWakeRegistry({
        boundedContextNames: inventory.contextNames,
      }),
    ).not.toThrow();

    expect(sourceContextWakeRegistry.map((entry) => entry.sourceContextName)).toEqual(inventory.contextNames);
    expect(listEventStoreWakeNotificationSourceContexts()).toEqual([]);
    expect(listSourceContextWakeRelayConfigs()).toEqual([]);
    expect(listSourceContextWakeRelayConfigs({ includeInactive: true })).toHaveLength(inventory.contextNames.length);

    expect(summarizeSourceContextWakeRegistry()).toMatchObject({
      entryCount: inventory.contextNames.length,
      activeEntryCount: 0,
      enabledEventStoreWakeContextCount: 0,
      enabledRelayFanOutContextCount: 0,
    });
  });

  it("matches bounded-context projection and read-after-write route inventory", () => {
    for (const sourceContextName of inventory.contextNames) {
      const entry = requireSourceContextWakeRegistryEntry(sourceContextName);
      expect(entry.affectedProjectionNames).toEqual(inventory.projectionsBySource.get(sourceContextName) ?? []);
      expect(entry.routeDependencyIds).toEqual(inventory.routeDependencyIdsBySource.get(sourceContextName) ?? []);
    }
  });

  it("prioritizes the checkout and payment hot path before broader platform expansion", () => {
    expect(
      listSourceContextWakeRegistryEntries({
        rolloutWaves: ["wave-1-checkout-hot-path"],
      }).map((entry) => `${entry.sourceContextName}:${entry.priorityLane}:${entry.phase}`),
    ).toEqual([
      "checkout:hot:phase-1-checkout-hot-path",
      "marketplace:hot:phase-1-checkout-hot-path",
      "ordering:hot:phase-1-checkout-hot-path",
      "payments:hot:phase-1-checkout-hot-path",
    ]);

    const checkout = requireSourceContextWakeRegistryEntry("checkout");
    expect(checkout.routeDependencyIds).toContain("checkout.session-start-to-detail");
    expect(checkout.routeDependencyIds).toContain("checkout.session-self-refresh");
    expect(checkout.requiredIssueNumbers).toEqual(
      expect.arrayContaining([1219, 1220, 1221, 1223, 1225, 1227, 1239, 1240, 1242, 1245, 1246]),
    );
  });

  it("creates write-side and relay configs from the same source-context entry", () => {
    expect(createEventStoreWakeNotificationConfigForSourceContext({ sourceContextName: "checkout" })).toMatchObject({
      enabled: false,
      channel: "platform_event_store_commits",
      source: "event-core-postgres",
    });

    const registry = withRegistryEntryPatch("checkout", {
      rolloutState: "staging-enabled",
      enablement: {
        eventStoreWakeNotifications: true,
        relayFanOut: true,
      },
    });

    expect(() =>
      validateSourceContextWakeRegistry({ registry, boundedContextNames: inventory.contextNames }),
    ).not.toThrow();
    expect(
      createEventStoreWakeNotificationConfigForSourceContext({
        sourceContextName: "checkout",
        registry,
      }),
    ).toMatchObject({
      enabled: true,
      channel: "platform_event_store_commits",
    });
    expect(listSourceContextWakeRelayConfigs({ registry })).toMatchObject([
      {
        sourceContextName: "checkout",
        relayFanOutEnabled: true,
        priorityLane: "hot",
      },
    ]);
  });

  it("rejects partial enablement and production rollout without gate evidence", () => {
    expect(() =>
      validateSourceContextWakeRegistry({
        registry: withRegistryEntryPatch("checkout", {
          rolloutState: "staging-enabled",
          enablement: {
            eventStoreWakeNotifications: false,
            relayFanOut: true,
          },
        }),
      }),
    ).toThrow(/cannot enable relay fan-out/);

    expect(() =>
      validateSourceContextWakeRegistry({
        registry: withRegistryEntryPatch("checkout", {
          enablement: {
            eventStoreWakeNotifications: true,
            relayFanOut: true,
          },
        }),
      }),
    ).toThrow(/cannot enable runtime wake behavior/);

    expect(() =>
      validateSourceContextWakeRegistry({
        registry: withRegistryEntryPatch("checkout", {
          rolloutState: "production-enabled",
          productionEvidenceIssueNumbers: SOURCE_CONTEXT_WAKE_PRODUCTION_GATE_ISSUES.filter(
            (issueNumber) => issueNumber !== 1246,
          ),
          enablement: {
            eventStoreWakeNotifications: true,
            relayFanOut: true,
          },
        }),
      }),
    ).toThrow(/1246/);
  });
});

type BoundedContextInventory = Readonly<{
  contextNames: readonly string[];
  projectionsBySource: ReadonlyMap<string, readonly string[]>;
  routeDependencyIdsBySource: ReadonlyMap<string, readonly string[]>;
}>;

type SourceContextWakeRegistryEntryPatch = Partial<Omit<SourceContextWakeRegistryEntry, "enablement">> &
  Readonly<{
    enablement?: Partial<SourceContextWakeEnablement>;
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
  const contextNames: string[] = [];
  const projectionsBySource = new Map<string, string[]>();
  const routeDependencyIdsBySource = new Map<string, string[]>();

  for (const directoryName of readdirSync(boundedContextsDir).sort()) {
    const contextJsonPath = join(boundedContextsDir, directoryName, "context.json");
    if (!existsSync(contextJsonPath)) {
      continue;
    }

    const contextJson = JSON.parse(readFileSync(contextJsonPath, "utf8")) as ContextJson;
    contextNames.push(contextJson.contextName);

    for (const projectionGroup of contextJson.projectionGroups ?? []) {
      if (!projectionGroup.projectionName) {
        continue;
      }
      for (const sourceContextName of projectionGroup.sourceContextNames ?? []) {
        if (!sourceContextName.trim()) {
          continue;
        }
        appendSorted(
          projectionsBySource,
          sourceContextName,
          `${contextJson.contextName}:${projectionGroup.projectionName}`,
        );
      }
    }

    for (const routeInventoryEntry of contextJson.readAfterWriteRouteInventory ?? []) {
      if (!routeInventoryEntry.id?.trim()) {
        continue;
      }
      appendSorted(routeDependencyIdsBySource, contextJson.contextName, routeInventoryEntry.id);
    }
  }

  return {
    contextNames: contextNames.sort((left, right) => left.localeCompare(right)),
    projectionsBySource: sortMapValues(projectionsBySource),
    routeDependencyIdsBySource: sortMapValues(routeDependencyIdsBySource),
  };
}

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

function appendSorted(map: Map<string, string[]>, key: string, value: string): void {
  const values = map.get(key) ?? [];
  values.push(value);
  map.set(key, values);
}

function sortMapValues(map: Map<string, string[]>): ReadonlyMap<string, readonly string[]> {
  return new Map(
    [...map].map(([key, values]) => [key, [...new Set(values)].sort((left, right) => left.localeCompare(right))]),
  );
}
