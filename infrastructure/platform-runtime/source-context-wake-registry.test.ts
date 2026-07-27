import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

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

  it("covers every bounded context with the staging-enabled wake sources explicit", () => {
    expect(() =>
      validateSourceContextWakeRegistry({
        boundedContextNames: inventory.contextNames,
      }),
    ).not.toThrow();

    expect(sourceContextWakeRegistry.map((entry) => entry.sourceContextName)).toEqual(inventory.contextNames);
    expect(listEventStoreWakeNotificationSourceContexts().map((entry) => entry.sourceContextName)).toEqual([
      "catalog",
      "checkout",
      "commercial-terms",
      "identity",
      "inventory",
      "marketplace",
      "ordering",
      "payments",
      "platform-operations",
      "public-presence",
      "settlement",
    ]);
    expect(listSourceContextWakeRelayConfigs()).toMatchObject([
      {
        sourceContextName: "catalog",
        rolloutState: "staging-enabled",
        rolloutWave: "wave-2-commerce-dependencies",
        relayFanOutEnabled: true,
        priorityLane: "standard",
      },
      {
        sourceContextName: "checkout",
        rolloutState: "staging-enabled",
        rolloutWave: "wave-1-checkout-hot-path",
        relayFanOutEnabled: true,
        priorityLane: "hot",
      },
      {
        sourceContextName: "commercial-terms",
        rolloutState: "staging-enabled",
        rolloutWave: "wave-2-commerce-dependencies",
        relayFanOutEnabled: true,
        priorityLane: "bulk",
      },
      {
        sourceContextName: "identity",
        rolloutState: "staging-enabled",
        rolloutWave: "wave-2-commerce-dependencies",
        relayFanOutEnabled: true,
        priorityLane: "standard",
      },
      {
        sourceContextName: "inventory",
        rolloutState: "staging-enabled",
        rolloutWave: "wave-2-commerce-dependencies",
        relayFanOutEnabled: true,
        priorityLane: "hot",
      },
      ...["marketplace", "ordering", "payments"].map((sourceContextName) => ({
        sourceContextName,
        rolloutState: "staging-enabled",
        rolloutWave: "wave-1-checkout-hot-path",
        relayFanOutEnabled: true,
        priorityLane: "hot",
      })),
      {
        sourceContextName: "platform-operations",
        rolloutState: "staging-enabled",
        rolloutWave: "wave-3-platform-expansion",
        relayFanOutEnabled: true,
        priorityLane: "standard",
      },
      {
        sourceContextName: "public-presence",
        rolloutState: "staging-enabled",
        rolloutWave: "wave-3-platform-expansion",
        relayFanOutEnabled: true,
        priorityLane: "bulk",
      },
      {
        sourceContextName: "settlement",
        rolloutState: "staging-enabled",
        rolloutWave: "wave-3-platform-expansion",
        relayFanOutEnabled: true,
        priorityLane: "standard",
      },
    ]);
    expect(listSourceContextWakeRelayConfigs({ includeInactive: true })).toHaveLength(inventory.contextNames.length);

    expect(summarizeSourceContextWakeRegistry()).toMatchObject({
      entryCount: inventory.contextNames.length,
      activeEntryCount: 11,
      enabledEventStoreWakeContextCount: 11,
      enabledRelayFanOutContextCount: 11,
    });
  });

  it("composes exactly one shard module per registry entry", () => {
    const shardDirectory = fileURLToPath(new URL("./source-context-wake-registry", import.meta.url));

    // Membership is derived from the shard directory rather than a hand-kept
    // list: a module dropped in without being composed into the aggregate, and
    // a composed entry with no module, must both fail here.
    expect(shardModuleNames(shardDirectory)).toEqual(
      [...sourceContextWakeRegistry.map((entry) => entry.sourceContextName)].sort(),
    );
  });

  it("names each shard module after the single entry it exports and composes", async () => {
    const shardDirectory = fileURLToPath(new URL("./source-context-wake-registry", import.meta.url));

    for (const moduleName of shardModuleNames(shardDirectory)) {
      const shard = (await import(`./source-context-wake-registry/${moduleName}.ts`)) as Record<string, unknown>;
      const exported = Object.values(shard);

      expect(exported, moduleName).toHaveLength(1);
      const entry = exported[0] as SourceContextWakeRegistryEntry;
      expect(entry.sourceContextName, moduleName).toBe(moduleName);
      // Reference equality: the aggregate composes this module's entry rather
      // than a re-declared copy of it.
      expect(sourceContextWakeRegistry).toContain(entry);
    }
  });

  it("rejects a shard directory that has drifted from the composed registry", () => {
    const composedNames = [...sourceContextWakeRegistry.map((entry) => entry.sourceContextName)].sort();

    // Negative controls for the partition above: the same derivation applied to
    // a directory holding an unwired module, and to one missing a composed
    // entry, must not agree with the aggregate.
    const strayDirectory = writeShardFixture([...composedNames, "unwired-context"]);
    expect(shardModuleNames(strayDirectory)).not.toEqual(composedNames);

    const missingDirectory = writeShardFixture(composedNames.slice(1));
    expect(shardModuleNames(missingDirectory)).not.toEqual(composedNames);

    const faithfulDirectory = writeShardFixture(composedNames);
    expect(shardModuleNames(faithfulDirectory)).toEqual(composedNames);
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
    delete process.env.PLATFORM_EVENT_STORE_WAKE_NOTIFICATIONS_ENABLED;
    delete process.env.PLATFORM_PROJECTION_WAKE_SOURCE_CONTEXTS;

    expect(createEventStoreWakeNotificationConfigForSourceContext({ sourceContextName: "inventory" })).toMatchObject({
      enabled: true,
      channel: "platform_event_store_commits",
      source: "event-core-postgres",
    });

    expect(createEventStoreWakeNotificationConfigForSourceContext({ sourceContextName: "checkout" })).toMatchObject({
      enabled: true,
      channel: "platform_event_store_commits",
      source: "event-core-postgres",
    });

    expect(listSourceContextWakeRelayConfigs()).toMatchObject([
      {
        sourceContextName: "catalog",
        relayFanOutEnabled: true,
        priorityLane: "standard",
      },
      {
        sourceContextName: "checkout",
        relayFanOutEnabled: true,
        priorityLane: "hot",
      },
      {
        sourceContextName: "commercial-terms",
        relayFanOutEnabled: true,
        priorityLane: "bulk",
      },
      {
        sourceContextName: "identity",
        relayFanOutEnabled: true,
        priorityLane: "standard",
      },
      {
        sourceContextName: "inventory",
        relayFanOutEnabled: true,
        priorityLane: "hot",
      },
      {
        sourceContextName: "marketplace",
        relayFanOutEnabled: true,
        priorityLane: "hot",
      },
      {
        sourceContextName: "ordering",
        relayFanOutEnabled: true,
        priorityLane: "hot",
      },
      {
        sourceContextName: "payments",
        relayFanOutEnabled: true,
        priorityLane: "hot",
      },
      {
        sourceContextName: "platform-operations",
        relayFanOutEnabled: true,
        priorityLane: "standard",
      },
      {
        sourceContextName: "public-presence",
        relayFanOutEnabled: true,
        priorityLane: "bulk",
      },
      {
        sourceContextName: "settlement",
        relayFanOutEnabled: true,
        priorityLane: "standard",
      },
    ]);
  });

  it("honors the deployment-level event-store wake emission kill switch", () => {
    const previousValue = process.env.PLATFORM_EVENT_STORE_WAKE_NOTIFICATIONS_ENABLED;
    const previousSourceContexts = process.env.PLATFORM_PROJECTION_WAKE_SOURCE_CONTEXTS;
    try {
      delete process.env.PLATFORM_PROJECTION_WAKE_SOURCE_CONTEXTS;
      for (const disabledValue of ["false", "0", "off", "no", "typo"]) {
        process.env.PLATFORM_EVENT_STORE_WAKE_NOTIFICATIONS_ENABLED = disabledValue;
        expect(createEventStoreWakeNotificationConfigForSourceContext({ sourceContextName: "checkout" })).toMatchObject(
          {
            enabled: false,
          },
        );
      }

      process.env.PLATFORM_EVENT_STORE_WAKE_NOTIFICATIONS_ENABLED = "true";
      expect(createEventStoreWakeNotificationConfigForSourceContext({ sourceContextName: "checkout" })).toMatchObject({
        enabled: true,
      });

      process.env.PLATFORM_PROJECTION_WAKE_SOURCE_CONTEXTS = "public-presence";
      expect(createEventStoreWakeNotificationConfigForSourceContext({ sourceContextName: "checkout" })).toMatchObject({
        enabled: false,
      });
      expect(
        createEventStoreWakeNotificationConfigForSourceContext({ sourceContextName: "public-presence" }),
      ).toMatchObject({
        enabled: true,
      });
      expect(listSourceContextWakeRelayConfigs().map((config) => config.sourceContextName)).toEqual([
        "public-presence",
      ]);
    } finally {
      if (previousValue === undefined) {
        delete process.env.PLATFORM_EVENT_STORE_WAKE_NOTIFICATIONS_ENABLED;
      } else {
        process.env.PLATFORM_EVENT_STORE_WAKE_NOTIFICATIONS_ENABLED = previousValue;
      }
      if (previousSourceContexts === undefined) {
        delete process.env.PLATFORM_PROJECTION_WAKE_SOURCE_CONTEXTS;
      } else {
        process.env.PLATFORM_PROJECTION_WAKE_SOURCE_CONTEXTS = previousSourceContexts;
      }
    }
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
        registry: withRegistryEntryPatch("auth", {
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

  it("wires registry-gated wake notification config into every runtime event store", () => {
    const boundedContextsDir = fileURLToPath(new URL("../../bounded-contexts", import.meta.url));
    const unwiredServiceFiles: string[] = [];
    let wiredServiceFileCount = 0;

    for (const directoryName of readdirSync(boundedContextsDir).sort()) {
      const contextJsonPath = join(boundedContextsDir, directoryName, "context.json");
      if (!existsSync(contextJsonPath)) {
        continue;
      }

      const contextJson = JSON.parse(readFileSync(contextJsonPath, "utf8")) as ContextJson;
      const wiringPattern = new RegExp(
        `createEventStoreWakeNotificationConfigForSourceContext\\(\\{\\s*sourceContextName: "${contextJson.contextName}",?\\s*\\}\\)`,
      );
      const supportDir = join(boundedContextsDir, directoryName, "support");
      for (const serviceFile of collectServiceFiles(supportDir)) {
        const content = readFileSync(serviceFile, "utf8");
        if (!content.includes("createPostgresEventStore(")) {
          continue;
        }

        if (wiringPattern.test(content)) {
          wiredServiceFileCount += 1;
        } else {
          unwiredServiceFiles.push(serviceFile);
        }
      }
    }

    expect(unwiredServiceFiles).toEqual([]);
    expect(wiredServiceFileCount).toBeGreaterThan(0);
  });

  it("surfaces failed and rejected event-store wake notifications to observability logs", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const config = createEventStoreWakeNotificationConfigForSourceContext({
      sourceContextName: "checkout",
    });

    config.observer?.notificationFailed?.({
      channel: "platform_event_store_commits",
      sourceContextName: "checkout",
      streamCategory: "checkout.checkout-session",
      firstGlobalPosition: "101" as never,
      lastGlobalPosition: "102" as never,
      eventCount: 2,
      correlationId: "trace_1",
      error: new Error("notify unavailable"),
    });
    config.observer?.payloadRejected?.({
      channel: "platform_event_store_commits",
      sourceContextName: "checkout",
      streamCategory: "checkout.checkout-session",
      firstGlobalPosition: "101" as never,
      lastGlobalPosition: "102" as never,
      eventCount: 2,
      correlationId: "trace_1",
      reason: "payload too large",
    });

    expect(warn).toHaveBeenCalledWith(
      "Event-store wake notification failed after commit; projections fall back to bounded polling.",
      expect.objectContaining({
        type: "event_store_wake.notification_failed",
        sourceContextName: "checkout",
        streamCategory: "checkout.checkout-session",
        firstGlobalPosition: "101",
        lastGlobalPosition: "102",
        eventCount: 2,
        correlationId: "trace_1",
        error: "notify unavailable",
      }),
    );
    expect(warn).toHaveBeenCalledWith(
      "Event-store wake notification payload rejected; projections fall back to bounded polling.",
      expect.objectContaining({
        type: "event_store_wake.payload_rejected",
        sourceContextName: "checkout",
        streamCategory: "checkout.checkout-session",
        firstGlobalPosition: "101",
        lastGlobalPosition: "102",
        eventCount: 2,
        correlationId: "trace_1",
        reason: "payload too large",
      }),
    );

    warn.mockRestore();
  });
});

function shardModuleNames(directory: string): readonly string[] {
  return readdirSync(directory)
    .filter((fileName) => fileName.endsWith(".ts"))
    .map((fileName) => fileName.replace(/\.ts$/, ""))
    .sort();
}

function writeShardFixture(moduleNames: readonly string[]): string {
  const directory = mkdtempSync(join(tmpdir(), "wake-registry-shards-"));
  for (const moduleName of moduleNames) {
    writeFileSync(join(directory, `${moduleName}.ts`), "", "utf8");
  }
  return directory;
}

// Seed/bootstrap scripts are exempt: they have no production wake path and the
// relay catches up from durable event-store rows regardless of emission.
const wakeWiringExemptFileNames = new Set(["seed.ts"]);

function collectServiceFiles(directory: string): readonly string[] {
  if (!existsSync(directory)) {
    return [];
  }

  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const entryPath = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectServiceFiles(entryPath));
      continue;
    }

    if (
      entry.isFile() &&
      entry.name.endsWith(".ts") &&
      !entry.name.endsWith(".test.ts") &&
      !wakeWiringExemptFileNames.has(entry.name)
    ) {
      files.push(entryPath);
    }
  }

  return files;
}

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
