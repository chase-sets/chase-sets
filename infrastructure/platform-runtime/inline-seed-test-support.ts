import { vi } from "vitest";
import type { ProjectionRunContext } from "@chase-sets/event-core/projector";
import {
  createMockPool,
  createStoredEvent,
  getCheckpointStore,
  getProjectionRevisionStore,
  sourceEventsByPool,
  type MockPool,
} from "../bounded-context-runtime/index-test-harness";
import type { SchemaBootstrapLockAcquisition } from "../bounded-context-runtime/index";
import { createApiHost, type ApiContextRegistry, type ProjectionGroupLeasePort } from "./api";

// Writes that reset, truncate, delete checkpoints, record revisions, or advance a runner.
const GROUP_WRITE_SQL =
  /^TRUNCATE TABLE |DELETE FROM event_subscription_checkpoints|INSERT INTO event_subscription_checkpoints|WITH saved_checkpoint AS|WITH event_input AS|INSERT INTO event_projection_group_revisions|INSERT INTO event_projection_group_generations|UPDATE event_projection_group_generations|INSERT INTO event_subscription_applications|UPDATE event_subscription_applications|DELETE FROM event_subscription_applications/u;

export type SeedGroupWrite = Readonly<{ groupKey: string; operation: string; held: boolean; substep: string }>;

/** Tracks the seed substep that is running from the `[seed-api-host] <label> started.` log line. */
export function captureSeedSubsteps() {
  const substeps = { current: "", started: [] as string[] };
  vi.spyOn(console, "log").mockImplementation((message?: unknown) => {
    const match = typeof message === "string" ? /^\[seed-api-host\] (.+) started\.$/u.exec(message) : null;
    if (match) {
      substeps.current = match[1]!;
      substeps.started.push(match[1]!);
    }
  });
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  return substeps;
}

/** A lease port that records each call by substep and which group keys are held while work runs. */
export function createRecordingLeasePort(substeps: Readonly<{ current: string }>) {
  const held = new Set<string>();
  const leaseCalls: string[] = [];
  const port: ProjectionGroupLeasePort = {
    runWithLease: async (group, signal, work) => {
      const groupKey = `${group.targetContextName}.${group.projectionName}`;
      leaseCalls.push(`${substeps.current} ${groupKey}`);
      if (held.has(groupKey)) {
        throw new Error(`Recording lease port re-entered '${groupKey}'.`);
      }
      held.add(groupKey);
      try {
        return await work({
          signal,
          throwIfLeaseLost: () => {
            if (signal?.aborted) throw new Error(`Lost lease '${groupKey}'.`);
          },
        } satisfies ProjectionRunContext);
      } finally {
        held.delete(groupKey);
      }
    },
  };
  return { port, held, leaseCalls };
}

type SyntheticContextName = "alpha" | "beta" | "gamma" | "delta";

export const syntheticGroupKeys: Readonly<Record<SyntheticContextName, string>> = {
  alpha: "alpha.alpha-items",
  beta: "beta.beta-alpha-view",
  gamma: "gamma.gamma-items",
  delta: "delta.delta-items",
};

/**
 * Four synthetic contexts on the bounded-context-runtime mock pool, mounted through the real
 * createApiHost so the real projection-groups.ts sync, reset, and drain paths run. Each context owns
 * one group on its own pool, so every write on a pool belongs to that pool's group.
 * - alpha: active, local truncate-owned group required during bootstrap, revision-stale so its first
 *   sync truncates and deletes checkpoints, plus a narrow bootstrap reconciler.
 * - beta: active, cross-context group over alpha that is not required during bootstrap, so a
 *   required-only sync takes the no-groups drain path.
 * - gamma: source-only with a local group, so only syncLocalProjectionGroups reaches it.
 * - delta: active, local group, no reconciler, so a queued twin drains it without seeding.
 */
export function createSyntheticSeedRuntime(
  options: Readonly<{ held: ReadonlySet<string>; substeps: { current: string } }>,
) {
  const writes: SeedGroupWrite[] = [];
  const queries: string[] = [];
  const seeds: string[] = [];
  const reconciles: string[] = [];
  const pools: Record<SyntheticContextName, MockPool> = {
    alpha: createMockPool(),
    beta: createMockPool(),
    gamma: createMockPool(),
    delta: createMockPool(),
  };
  const record = (groupKey: string, operation: string) => {
    writes.push({ groupKey, operation, held: options.held.has(groupKey), substep: options.substeps.current });
  };

  for (const [contextName, pool] of Object.entries(pools) as [SyntheticContextName, MockPool][]) {
    const query = pool.query;
    pool.query = async (sql, params) => {
      const operation = sql.trim().split("\n")[0]!.trim();
      queries.push(`${contextName}: ${operation}`);
      if (GROUP_WRITE_SQL.test(sql.trim())) {
        record(syntheticGroupKeys[contextName], operation);
      }
      return query(sql, params);
    };
  }

  getProjectionRevisionStore(pools.alpha).set("alpha:alpha-items", 1);
  getCheckpointStore(pools.alpha).set("alpha-items:alpha:v1", "0");

  let position = 0;
  const append = (contextName: SyntheticContextName) => {
    position += 1;
    const events = sourceEventsByPool.get(pools[contextName]) ?? [];
    events.push(
      createStoredEvent(
        String(position),
        `${contextName}.item.created`,
        { position },
        `${contextName}.item-${position}`,
      ),
    );
    sourceEventsByPool.set(pools[contextName], events);
  };
  const localProjection = (contextName: SyntheticContextName, projectionName: string) => ({
    projectionName,
    handlers: { [`${contextName}.item.created`]: async () => record(syntheticGroupKeys[contextName], "handler") },
    eventTypes: [`${contextName}.item.created`],
  });
  const module = (contextName: SyntheticContextName, extra: Record<string, unknown>) => ({
    contextName,
    routePrefix: `/${contextName}`,
    streamPrefix: `${contextName}.`,
    schemaSql: "",
    apiMounts: [],
    seedProfiles: ["critical-bootstrap"],
    createServices: () => ({ contextName }),
    buildApis: () => [],
    seed: async () => {
      seeds.push(contextName);
      append(contextName);
    },
    ...extra,
  });

  const registry = [
    {
      contextName: "alpha",
      packageName: "@test/alpha",
      manifest: { contextName: "alpha", apiDeployables: ["platform-api"] },
      module: module("alpha", {
        projectionHandlerSets: () => [localProjection("alpha", "alpha-items")],
        projectionGroups: [
          {
            projectionName: "alpha-items",
            projectionRevision: 2,
            sourceContextNames: ["alpha"],
            ownedTables: ["alpha_items"],
            resetStrategy: "truncate-owned-tables",
            requiredDuringBootstrap: true,
          },
        ],
        reconcileBootstrapState: async () => {
          reconciles.push("alpha");
        },
      }),
    },
    {
      contextName: "beta",
      packageName: "@test/beta",
      manifest: { contextName: "beta", apiDeployables: ["platform-api"], seedRequirements: ["alpha"] },
      module: module("beta", {
        eventSubscriptions: [
          {
            sourceContextName: "alpha",
            projectionName: "beta-alpha-view",
            subscriptionVersion: 1,
            projectionHandlerSetNames: ["beta-alpha-view"],
            eventTypes: ["alpha.item.created"],
            order: 20,
          },
        ],
        buildSubscriptions: () => [
          {
            subscriptionName: "beta.alpha-view",
            sourceContextName: "alpha",
            projectionName: "beta-alpha-view",
            subscriptionVersion: 1,
            handlers: { "alpha.item.created": async () => record(syntheticGroupKeys.beta, "handler") },
            eventTypes: ["alpha.item.created"],
            order: 20,
          },
        ],
        projectionGroups: [
          {
            projectionName: "beta-alpha-view",
            sourceContextNames: ["alpha"],
            ownedTables: ["beta_alpha_view"],
            resetStrategy: "replay-only",
            requiredDuringBootstrap: false,
          },
        ],
      }),
    },
    {
      contextName: "gamma",
      packageName: "@test/gamma",
      manifest: {
        contextName: "gamma",
        apiDeployables: [],
        sourceRuntimeDeployables: ["platform-api"],
        sourceRuntimeProfiles: ["public"],
      },
      module: module("gamma", {
        projectionHandlerSets: () => [localProjection("gamma", "gamma-items")],
        projectionGroups: [
          {
            projectionName: "gamma-items",
            sourceContextNames: ["gamma"],
            ownedTables: ["gamma_items"],
            resetStrategy: "replay-only",
            requiredDuringBootstrap: true,
          },
        ],
      }),
    },
    {
      contextName: "delta",
      packageName: "@test/delta",
      manifest: { contextName: "delta", apiDeployables: ["platform-api"] },
      module: module("delta", {
        projectionHandlerSets: () => [localProjection("delta", "delta-items")],
        projectionGroups: [
          {
            projectionName: "delta-items",
            sourceContextNames: ["delta"],
            ownedTables: ["delta_items"],
            resetStrategy: "replay-only",
            requiredDuringBootstrap: true,
          },
        ],
      }),
    },
  ] as unknown as ApiContextRegistry;

  const runtime = createApiHost(registry, "platform-api", { pools: pools as never });
  return { registry, runtime, pools, writes, queries, seeds, reconciles, append };
}

/** Builds a seed harness whose lease port and pools share one held-key view and substep log. */
export function createInlineSeedHarness() {
  const substeps = captureSeedSubsteps();
  const lease = createRecordingLeasePort(substeps);
  const runtime = createSyntheticSeedRuntime({ held: lease.held, substeps });
  const groupKeysBySubstep = () => {
    const grouped: Record<string, string[]> = {};
    for (const call of lease.leaseCalls) {
      const [substep, groupKey] = call.split(" ") as [string, string];
      (grouped[substep] ??= []).push(groupKey);
    }
    return grouped;
  };
  return { ...lease, ...runtime, substeps, groupKeysBySubstep };
}

export function heldBootstrapLock(waited: boolean): SchemaBootstrapLockAcquisition {
  return { attempts: waited ? 2 : 1, waited };
}
