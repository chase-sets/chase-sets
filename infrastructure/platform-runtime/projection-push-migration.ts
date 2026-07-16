import type { ProjectionInterestOverride } from "./projection-interest-index";
import {
  requireSourceContextWakeRegistryEntry,
  sourceContextWakeRegistry,
  type SourceContextWakeRegistryEntry,
  type SourceContextWakeRolloutState,
  type SourceContextWakeRolloutWave,
} from "./source-context-wake-registry";
import type { WorkSignalPriorityLane } from "./work-signal-store";

/**
 * Push-first migration inventory.
 *
 * Sunset condition for deleting this module: every projection group derived
 * from the source-context wake registry must classify as `push-enabled`, with
 * zero `disabled` and zero `opted-out` groups. Wave 2 `fulfillment` and the
 * remaining wave 3 contexts (`discovery`, `public-presence`) still have
 * registry `eligible` rows with relay fan-out disabled, leaving 17 projection
 * groups `push-eligible`.
 *
 * Derives a push-first disposition for every projection group and every
 * read-after-write route inventory entry from the source-context wake
 * registry, which is itself test-pinned to the bounded-context
 * `context.json` inventories. This module is the machine-readable side of
 * `docs/architecture/push-first-projection-migration.md`; tests keep both in
 * lockstep with the bounded-context metadata so no projection group or route
 * entry can silently miss a migration disposition.
 */

export const PROJECTION_PUSH_MIGRATION_STATUSES = [
  // Every source context the projection consumes from has relay fan-out and
  // event-store wake emission enabled in the registry (environment kill
  // switches still gate where the loop actually runs).
  "push-enabled",
  // At least one source context is still waiting on its rollout wave; the
  // projection itself requires no further migration work.
  "push-eligible",
  // Every source context is registry-disabled or registry-opted-out.
  "disabled",
  // The projection group carries an explicit owner-approved opt-out.
  "opted-out",
] as const;

export type ProjectionPushMigrationStatus = (typeof PROJECTION_PUSH_MIGRATION_STATUSES)[number];

export type ProjectionPushOptOut = Readonly<{
  /** `<target-context>:<projection-name>` — registry `affectedProjectionNames` format. */
  projectionKey: string;
  owner: string;
  reason: string;
  /** ISO date the opt-out must be re-reviewed by. */
  reviewBy: string;
  /** The freshness contract that compensates for staying off push wakes. */
  compensatingFreshnessContract: string;
}>;

export type ProjectionPushMigrationSourceState = Readonly<{
  sourceContextName: string;
  rolloutState: SourceContextWakeRolloutState;
  rolloutWave: SourceContextWakeRolloutWave;
  priorityLane: WorkSignalPriorityLane;
  eventStoreWakeNotificationsEnabled: boolean;
  relayFanOutEnabled: boolean;
}>;

export type ProjectionPushMigrationEntry = Readonly<{
  projectionKey: string;
  targetContextName: string;
  projectionName: string;
  /** Owning team, from the target context's wake-registry entry. */
  owner: string;
  status: ProjectionPushMigrationStatus;
  sourceContexts: readonly ProjectionPushMigrationSourceState[];
  sourceContextCount: number;
  enabledSourceContextCount: number;
  /** True once any enabled source context fans out durable wake intents to this projection. */
  consumesDurableWakeIntents: boolean;
  /**
   * Always true: the worker `projections` runner group keeps polling every
   * projection group as reconciliation/fallback regardless of wake rollout.
   */
  fallbackPolling: true;
  optOut: ProjectionPushOptOut | null;
}>;

export type RouteDependencyPushDisposition = Readonly<{
  routeDependencyId: string;
  /** Bounded context whose read-after-write route inventory declares the entry. */
  sourceContextName: string;
  rolloutState: SourceContextWakeRolloutState;
  rolloutWave: SourceContextWakeRolloutWave;
  relayFanOutEnabled: boolean;
}>;

export type ProjectionPushMigrationSummary = Readonly<{
  projectionCount: number;
  statusCounts: readonly Readonly<{
    status: ProjectionPushMigrationStatus;
    count: number;
  }>[];
  optOutCount: number;
  routeDependencyCount: number;
  pushEnabledRouteDependencyCount: number;
}>;

export type ProjectionPushMigrationInput = Readonly<{
  registry?: readonly SourceContextWakeRegistryEntry[];
  optOuts?: readonly ProjectionPushOptOut[];
}>;

/**
 * Explicit owner-approved opt-outs. Currently empty: every projection group
 * on the platform is push-first eligible, so passive polling survives only as
 * reconciliation/fallback. Any future entry must carry an owner, a reason, a
 * review date, and a compensating freshness contract — the validator rejects
 * anything less.
 */
export const projectionPushOptOuts = [] as const satisfies readonly ProjectionPushOptOut[];

export function validateProjectionPushOptOuts(input: ProjectionPushMigrationInput = {}): void {
  const registry = input.registry ?? sourceContextWakeRegistry;
  const optOuts = input.optOuts ?? projectionPushOptOuts;
  const knownProjectionKeys = new Set(registry.flatMap((entry) => entry.affectedProjectionNames));
  const seenProjectionKeys = new Set<string>();

  for (const optOut of optOuts) {
    if (!knownProjectionKeys.has(optOut.projectionKey)) {
      throw new Error(
        `Projection push opt-out '${optOut.projectionKey}' does not match any registry projection group.`,
      );
    }
    if (seenProjectionKeys.has(optOut.projectionKey)) {
      throw new Error(`Projection push opt-out '${optOut.projectionKey}' is declared more than once.`);
    }
    seenProjectionKeys.add(optOut.projectionKey);

    assertOptOutField(optOut, optOut.owner, "owner");
    assertOptOutField(optOut, optOut.reason, "reason");
    assertOptOutField(optOut, optOut.compensatingFreshnessContract, "compensatingFreshnessContract");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(optOut.reviewBy) || Number.isNaN(Date.parse(optOut.reviewBy))) {
      throw new Error(
        `Projection push opt-out '${optOut.projectionKey}' requires an ISO reviewBy date, got '${optOut.reviewBy}'.`,
      );
    }
  }
}

export function listProjectionPushMigrationEntries(
  input: ProjectionPushMigrationInput = {},
): readonly ProjectionPushMigrationEntry[] {
  const registry = input.registry ?? sourceContextWakeRegistry;
  const optOuts = input.optOuts ?? projectionPushOptOuts;
  validateProjectionPushOptOuts({ registry, optOuts });

  const optOutsByProjectionKey = new Map(optOuts.map((optOut) => [optOut.projectionKey, optOut]));
  const sourcesByProjectionKey = new Map<string, SourceContextWakeRegistryEntry[]>();
  for (const entry of registry) {
    for (const projectionKey of entry.affectedProjectionNames) {
      const sources = sourcesByProjectionKey.get(projectionKey) ?? [];
      sources.push(entry);
      sourcesByProjectionKey.set(projectionKey, sources);
    }
  }

  return [...sourcesByProjectionKey.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([projectionKey, sources]) => {
      const { targetContextName, projectionName } = parseProjectionKey(projectionKey);
      const sourceContexts = sources
        .map(
          (source): ProjectionPushMigrationSourceState => ({
            sourceContextName: source.sourceContextName,
            rolloutState: source.rolloutState,
            rolloutWave: source.rolloutWave,
            priorityLane: source.priorityLane,
            eventStoreWakeNotificationsEnabled: source.enablement.eventStoreWakeNotifications,
            relayFanOutEnabled: source.enablement.relayFanOut,
          }),
        )
        .sort((left, right) => left.sourceContextName.localeCompare(right.sourceContextName));
      const enabledSourceContextCount = sourceContexts.filter((source) => source.relayFanOutEnabled).length;
      const optOut = optOutsByProjectionKey.get(projectionKey) ?? null;

      return {
        projectionKey,
        targetContextName,
        projectionName,
        owner: requireSourceContextWakeRegistryEntry(targetContextName, registry).owner,
        status: classifyProjectionPushMigration(sourceContexts, enabledSourceContextCount, optOut),
        sourceContexts,
        sourceContextCount: sourceContexts.length,
        enabledSourceContextCount,
        consumesDurableWakeIntents: enabledSourceContextCount > 0,
        fallbackPolling: true,
        optOut,
      };
    });
}

export function listRouteDependencyPushDispositions(
  input: ProjectionPushMigrationInput = {},
): readonly RouteDependencyPushDisposition[] {
  const registry = input.registry ?? sourceContextWakeRegistry;

  return registry
    .flatMap((entry) =>
      entry.routeDependencyIds.map(
        (routeDependencyId): RouteDependencyPushDisposition => ({
          routeDependencyId,
          sourceContextName: entry.sourceContextName,
          rolloutState: entry.rolloutState,
          rolloutWave: entry.rolloutWave,
          relayFanOutEnabled: entry.enablement.relayFanOut,
        }),
      ),
    )
    .sort((left, right) => left.routeDependencyId.localeCompare(right.routeDependencyId));
}

export function summarizeProjectionPushMigration(
  input: ProjectionPushMigrationInput = {},
): ProjectionPushMigrationSummary {
  const entries = listProjectionPushMigrationEntries(input);
  const routeDependencies = listRouteDependencyPushDispositions(input);

  return {
    projectionCount: entries.length,
    statusCounts: PROJECTION_PUSH_MIGRATION_STATUSES.map((status) => ({
      status,
      count: entries.filter((entry) => entry.status === status).length,
    })),
    optOutCount: entries.filter((entry) => entry.optOut !== null).length,
    routeDependencyCount: routeDependencies.length,
    pushEnabledRouteDependencyCount: routeDependencies.filter((dependency) => dependency.relayFanOutEnabled).length,
  };
}

/**
 * Feeds real rollout/owner/opt-out data from the wake registry and
 * the migration inventory into the projection interest index:
 *
 * - Explicit projection opt-outs disable the index entry with the opt-out
 *   reason, so the relay enqueues no wake intents for it.
 * - Registry-disabled or registry-opted-out source contexts disable only the
 *   matching (source, projection) entries, with the registry reason.
 * - Every remaining projection gets its owning team recorded on the entry.
 *
 * Order matters: `resolveProjectionInterestOverride` takes the first match
 * per scope, so disable overrides precede owner-only overrides.
 */
export function listProjectionInterestOverridesForPushMigration(
  input: ProjectionPushMigrationInput = {},
): readonly ProjectionInterestOverride[] {
  const registry = input.registry ?? sourceContextWakeRegistry;
  const optOuts = input.optOuts ?? projectionPushOptOuts;
  validateProjectionPushOptOuts({ registry, optOuts });

  const optOutOverrides = optOuts.map((optOut): ProjectionInterestOverride => {
    const { targetContextName, projectionName } = parseProjectionKey(optOut.projectionKey);
    return {
      targetContextName,
      projectionName,
      owner: optOut.owner,
      disabled: true,
      optOutReason: optOut.reason,
    };
  });

  const disabledSourceOverrides = registry
    .filter((entry) => entry.rolloutState === "disabled" || entry.rolloutState === "opted-out")
    .flatMap((entry) =>
      entry.affectedProjectionNames.map((projectionKey): ProjectionInterestOverride => {
        const { targetContextName, projectionName } = parseProjectionKey(projectionKey);
        return {
          sourceContextName: entry.sourceContextName,
          targetContextName,
          projectionName,
          owner: requireSourceContextWakeRegistryEntry(targetContextName, registry).owner,
          disabled: true,
          optOutReason:
            entry.rolloutState === "disabled"
              ? (entry.disabledReason ?? "Source context disabled in the wake registry.")
              : (entry.optOutReason ?? "Source context opted out in the wake registry."),
        };
      }),
    );

  const ownerOverrides = listProjectionPushMigrationEntries({ registry, optOuts })
    .filter((entry) => entry.optOut === null)
    .map(
      (entry): ProjectionInterestOverride => ({
        targetContextName: entry.targetContextName,
        projectionName: entry.projectionName,
        owner: entry.owner,
      }),
    );

  return [...optOutOverrides, ...disabledSourceOverrides, ...ownerOverrides];
}

function classifyProjectionPushMigration(
  sourceContexts: readonly ProjectionPushMigrationSourceState[],
  enabledSourceContextCount: number,
  optOut: ProjectionPushOptOut | null,
): ProjectionPushMigrationStatus {
  if (optOut) {
    return "opted-out";
  }
  if (sourceContexts.every((source) => source.rolloutState === "disabled" || source.rolloutState === "opted-out")) {
    return "disabled";
  }
  if (enabledSourceContextCount === sourceContexts.length) {
    return "push-enabled";
  }

  return "push-eligible";
}

function parseProjectionKey(projectionKey: string): Readonly<{ targetContextName: string; projectionName: string }> {
  const separatorIndex = projectionKey.indexOf(":");
  if (separatorIndex <= 0 || separatorIndex === projectionKey.length - 1) {
    throw new Error(`Projection key '${projectionKey}' must use the '<target-context>:<projection-name>' format.`);
  }

  return {
    targetContextName: projectionKey.slice(0, separatorIndex),
    projectionName: projectionKey.slice(separatorIndex + 1),
  };
}

function assertOptOutField(optOut: ProjectionPushOptOut, value: string, fieldName: string): void {
  if (!value.trim()) {
    throw new Error(`Projection push opt-out '${optOut.projectionKey}' requires a non-empty ${fieldName}.`);
  }
}
