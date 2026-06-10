import { createHash } from "node:crypto";

import {
  resolveReadConsistencyDependency,
  type ContextProjectionGroup,
  type ReadConsistencyDependencyDeclaration,
  type ResolvedApiMount,
} from "@chase-sets/bounded-context-runtime";

import type {
  EnqueueProjectionWakeIntentInput,
  JsonRecord,
  WorkSignalPriorityLane,
  WorkSignalWakeOrigin,
} from "./work-signal-store";

export type ProjectionInterestIndexStatus = "active" | "stale";

export type ProjectionInterestOverride = Readonly<{
  targetContextName: string;
  projectionName: string;
  sourceContextName?: string;
  owner?: string | null;
  priorityLane?: WorkSignalPriorityLane;
  disabled?: boolean;
  optOutReason?: string | null;
}>;

export type ProjectionRouteDependency = Readonly<{
  dependencyId: string;
  contextName: string;
  mountPath: string;
  routePath: string;
  routePattern: string;
  methods: readonly ("GET" | "HEAD")[];
  targetContextName: string;
  projectionName: string;
  dependencyKind: "projection" | "read-model-table";
  dependencyName: string;
}>;

export type ProjectionInterestEntry = Readonly<{
  entryId: string;
  sourceContextName: string;
  targetContextName: string;
  projectionName: string;
  checkpointKey: string;
  subscriptionName: string;
  subscriptionVersion: number;
  projectionRevision: number;
  priorityLane: WorkSignalPriorityLane;
  requiredDuringBootstrap: boolean;
  ownedTables: readonly string[];
  eventTypes?: readonly string[];
  streamPrefixes?: readonly string[];
  routeDependencies: readonly ProjectionRouteDependency[];
  owner: string | null;
  enabled: boolean;
  optOutReason: string | null;
}>;

export type ProjectionInterestIndex = Readonly<{
  indexVersion: string;
  schemaVersion: number;
  payloadVersion: number;
  generatedAt: string;
  status: ProjectionInterestIndexStatus;
  staleReason: string | null;
  entries: readonly ProjectionInterestEntry[];
  routeDependencies: readonly ProjectionRouteDependency[];
  enabledSourceContextNames: readonly string[];
  bySourceContextName: ReadonlyMap<string, readonly ProjectionInterestEntry[]>;
  bySourceEventType: ReadonlyMap<string, readonly ProjectionInterestEntry[]>;
  bySourceWildcardEventType: ReadonlyMap<string, readonly ProjectionInterestEntry[]>;
  byMountPath: ReadonlyMap<string, readonly ProjectionRouteDependency[]>;
  byRouteDependency: ReadonlyMap<string, readonly ProjectionInterestEntry[]>;
  routePatternsByDependency: ReadonlyMap<string, RegExp>;
}>;

export type ProjectionInterestIndexSummary = Readonly<{
  indexVersion: string;
  schemaVersion: number;
  payloadVersion: number;
  generatedAt: string;
  status: ProjectionInterestIndexStatus;
  staleReason: string | null;
  entryCount: number;
  enabledEntryCount: number;
  disabledEntryCount: number;
  routeDependencyCount: number;
  enabledSourceContextNames: readonly string[];
  sourceContextCounts: readonly Readonly<{
    sourceContextName: string;
    enabledEntryCount: number;
  }>[];
  priorityLaneCounts: readonly Readonly<{
    priorityLane: WorkSignalPriorityLane;
    enabledEntryCount: number;
  }>[];
}>;

export type ProjectionInterestPrioritySeed = Readonly<{
  sourceContextName: string;
  targetContextName: string;
  projectionName: string;
  checkpointKey: string;
  requiredDuringBootstrap: boolean;
  routeDependencies: readonly ProjectionRouteDependency[];
}>;

export type BuildProjectionInterestIndexInput = Readonly<{
  projectionGroups: readonly ContextProjectionGroup[];
  apiMounts?: readonly ResolvedApiMount[];
  projectionOverrides?: readonly ProjectionInterestOverride[];
  resolvePriorityLane?: (seed: ProjectionInterestPrioritySeed) => WorkSignalPriorityLane;
  indexVersion?: string;
  schemaVersion?: number;
  payloadVersion?: number;
  generatedAt?: Date | string;
  status?: ProjectionInterestIndexStatus;
  staleReason?: string | null;
}>;

export type LookupProjectionInterestsInput = Readonly<{
  sourceContextName: string;
  eventType?: string;
  eventTypes?: readonly string[];
  streamId?: string;
  streamIds?: readonly string[];
  includeDisabled?: boolean;
  allowStale?: boolean;
}>;

export type LookupRouteProjectionInterestsInput = Readonly<{
  contextName?: string;
  mountPath: string;
  method?: string;
  path?: string;
  routePath?: string;
  sourceContextNames?: readonly string[];
  includeDisabled?: boolean;
  allowStale?: boolean;
}>;

export type ProjectionSourceWakeInput = Omit<LookupProjectionInterestsInput, "includeDisabled"> &
  Readonly<{
    requiredPosition: bigint | number | string;
    requiredCursor?: string | null;
    origin?: WorkSignalWakeOrigin;
    priorityLane?: WorkSignalPriorityLane;
    correlationId?: string | null;
    metadata?: JsonRecord;
    schemaVersion?: number;
    payloadVersion?: number;
    nextEligibleAt?: Date | string;
    expiresAt?: Date | string;
  }>;

export type ProjectionSourcePosition = Readonly<{
  sourceContextName: string;
  requiredPosition: bigint | number | string;
  requiredCursor?: string | null;
}>;

export type RouteProjectionWakeInput = Omit<
  LookupRouteProjectionInterestsInput,
  "sourceContextNames" | "includeDisabled"
> &
  Readonly<{
    sourcePositions: readonly ProjectionSourcePosition[];
    origin?: WorkSignalWakeOrigin;
    priorityLane?: WorkSignalPriorityLane;
    correlationId?: string | null;
    metadata?: JsonRecord;
    schemaVersion?: number;
    payloadVersion?: number;
    nextEligibleAt?: Date | string;
    expiresAt?: Date | string;
  }>;

export class ProjectionInterestIndexStaleError extends Error {
  public constructor(index: Pick<ProjectionInterestIndex, "indexVersion" | "staleReason">) {
    super(
      `Projection interest index '${index.indexVersion}' is stale${index.staleReason ? `: ${index.staleReason}` : "."}`,
    );
    this.name = "ProjectionInterestIndexStaleError";
  }
}

export class ProjectionInterestIndexNotLoadedError extends Error {
  public constructor() {
    super("Projection interest index has not been loaded.");
    this.name = "ProjectionInterestIndexNotLoadedError";
  }
}

export type ProjectionInterestIndexCache = Readonly<{
  getSnapshot: () => ProjectionInterestIndex | null;
  requireSnapshot: (options?: Readonly<{ allowStale?: boolean }>) => ProjectionInterestIndex;
  reload: () => Promise<ProjectionInterestIndex>;
  markStale: (reason?: string | null) => ProjectionInterestIndex | null;
}>;

export function buildProjectionInterestIndex(input: BuildProjectionInterestIndexInput): ProjectionInterestIndex {
  const schemaVersion = input.schemaVersion ?? 1;
  const payloadVersion = input.payloadVersion ?? 1;
  const generatedAt = normalizeInstant(input.generatedAt ?? new Date());
  const routeDependencies = resolveProjectionRouteDependencies(input.apiMounts ?? [], input.projectionGroups);
  const routeDependenciesByProjection = groupRouteDependenciesByProjection(routeDependencies);
  const entries = sortEntries(
    input.projectionGroups.flatMap((group) =>
      group.subscriptionRunners.map((runner) => {
        const routeDependenciesForProjection =
          routeDependenciesByProjection.get(projectionKey(group.targetContextName, group.projectionName)) ?? [];
        const override = resolveProjectionInterestOverride(input.projectionOverrides ?? [], {
          sourceContextName: runner.sourceContextName,
          targetContextName: group.targetContextName,
          projectionName: group.projectionName,
        });
        const seed: ProjectionInterestPrioritySeed = {
          sourceContextName: runner.sourceContextName,
          targetContextName: group.targetContextName,
          projectionName: group.projectionName,
          checkpointKey: runner.checkpointKey,
          requiredDuringBootstrap: group.requiredDuringBootstrap,
          routeDependencies: routeDependenciesForProjection,
        };
        const priorityLane = override?.priorityLane ?? input.resolvePriorityLane?.(seed) ?? defaultPriorityLane(seed);
        const optOutReason = normalizeNullableText(override?.optOutReason);
        const enabled = !override?.disabled && !optOutReason;

        return {
          entryId: [runner.sourceContextName, group.targetContextName, group.projectionName, runner.checkpointKey].join(
            ":",
          ),
          sourceContextName: runner.sourceContextName,
          targetContextName: group.targetContextName,
          projectionName: group.projectionName,
          checkpointKey: runner.checkpointKey,
          subscriptionName: runner.subscriptionName,
          subscriptionVersion: runner.subscriptionVersion,
          projectionRevision: group.projectionRevision,
          priorityLane,
          requiredDuringBootstrap: group.requiredDuringBootstrap,
          ownedTables: normalizeTextList(group.ownedTables) ?? [],
          eventTypes: normalizeTextList(runner.eventTypes),
          streamPrefixes: normalizeTextList(runner.streamPrefixes),
          routeDependencies: routeDependenciesForProjection,
          owner: normalizeNullableText(override?.owner),
          enabled,
          optOutReason,
        } satisfies ProjectionInterestEntry;
      }),
    ),
  );
  const indexVersion =
    input.indexVersion ??
    `pi_${hashStableValue({
      schemaVersion,
      payloadVersion,
      entries: entries.map(entryVersionValue),
      routeDependencies: routeDependencies.map(routeDependencyVersionValue),
    })}`;

  return createProjectionInterestIndex({
    indexVersion,
    schemaVersion,
    payloadVersion,
    generatedAt,
    status: input.status ?? "active",
    staleReason: input.staleReason ?? null,
    entries,
    routeDependencies,
  });
}

export function resolveProjectionRouteDependencies(
  apiMounts: readonly ResolvedApiMount[],
  projectionGroups: readonly ContextProjectionGroup[],
): readonly ProjectionRouteDependency[] {
  const dependencies: ProjectionRouteDependency[] = [];

  for (const mount of apiMounts) {
    for (const route of mount.readFreshnessRoutes ?? []) {
      const routePath = normalizeRoutePath(route.routePath);
      const methods = normalizeMethods(route.methods);

      for (const dependency of route.dependencies) {
        for (const resolved of resolveReadConsistencyDependency(mount.contextName, dependency, projectionGroups)) {
          dependencies.push({
            dependencyId: [
              mount.contextName,
              mount.mountPath,
              routePath,
              methods.join(","),
              resolved.targetContextName,
              resolved.projectionName,
              dependencyName(dependency),
            ].join("|"),
            contextName: mount.contextName,
            mountPath: normalizeRoutePath(mount.mountPath),
            routePath,
            routePattern: compileMountRelativeRoutePattern(routePath).source,
            methods,
            targetContextName: resolved.targetContextName,
            projectionName: resolved.projectionName,
            dependencyKind: dependency.projectionName ? "projection" : "read-model-table",
            dependencyName: dependencyName(dependency),
          });
        }
      }
    }
  }

  return sortRouteDependencies(uniqueBy(dependencies, (dependency) => dependency.dependencyId));
}

export function lookupProjectionInterests(
  index: ProjectionInterestIndex,
  input: LookupProjectionInterestsInput,
): readonly ProjectionInterestEntry[] {
  assertUsableIndex(index, input.allowStale);
  const eventTypes = normalizeTextList([input.eventType, ...(input.eventTypes ?? [])].filter(isPresentString));
  const streamIds = normalizeTextList([input.streamId, ...(input.streamIds ?? [])].filter(isPresentString));

  return sortEntries(
    sourceEventCandidates(index, input.sourceContextName, eventTypes).filter(
      (entry) =>
        (input.includeDisabled || entry.enabled) &&
        matchesEventTypes(entry, eventTypes) &&
        matchesStreamIds(entry, streamIds),
    ),
  );
}

export function lookupRouteProjectionInterests(
  index: ProjectionInterestIndex,
  input: LookupRouteProjectionInterestsInput,
): readonly ProjectionInterestEntry[] {
  assertUsableIndex(index, input.allowStale);
  const routeDependencies = lookupRouteDependencies(index, input);
  const sourceContextNames = input.sourceContextNames ? new Set(input.sourceContextNames) : null;
  const entries = routeDependencies.flatMap((dependency) => index.byRouteDependency.get(dependency.dependencyId) ?? []);

  return sortEntries(
    uniqueBy(entries, (entry) => entry.entryId).filter(
      (entry) =>
        (input.includeDisabled || entry.enabled) &&
        (!sourceContextNames || sourceContextNames.has(entry.sourceContextName)),
    ),
  );
}

export function lookupRouteDependencies(
  index: ProjectionInterestIndex,
  input: LookupRouteProjectionInterestsInput,
): readonly ProjectionRouteDependency[] {
  assertUsableIndex(index, input.allowStale);
  const mountPath = normalizeRoutePath(input.mountPath);
  const method = normalizeMethod(input.method ?? "GET");
  const routePath = input.routePath ? normalizeRoutePath(input.routePath) : null;
  const relativePath = input.path ? normalizeRequestRelativePath(mountPath, input.path) : null;

  return (index.byMountPath.get(mountPath) ?? []).filter((dependency) => {
    if (input.contextName && dependency.contextName !== input.contextName) {
      return false;
    }
    if (!dependency.methods.includes(method)) {
      return false;
    }
    if (routePath) {
      return dependency.routePath === routePath;
    }
    if (relativePath) {
      return (index.routePatternsByDependency.get(dependency.dependencyId) ?? new RegExp(dependency.routePattern)).test(
        relativePath,
      );
    }

    return false;
  });
}

export function createProjectionWakeIntentInputs(
  index: ProjectionInterestIndex,
  input: ProjectionSourceWakeInput,
): readonly EnqueueProjectionWakeIntentInput[] {
  return lookupProjectionInterests(index, input).map((entry) =>
    createWakeIntentInput(index, entry, {
      requiredPosition: input.requiredPosition,
      requiredCursor: input.requiredCursor ?? null,
      origin: input.origin ?? "relay",
      priorityLane: input.priorityLane ?? entry.priorityLane,
      correlationId: input.correlationId ?? null,
      metadata: input.metadata,
      schemaVersion: input.schemaVersion,
      payloadVersion: input.payloadVersion,
      nextEligibleAt: input.nextEligibleAt,
      expiresAt: input.expiresAt,
    }),
  );
}

export function createRouteProjectionWakeIntentInputs(
  index: ProjectionInterestIndex,
  input: RouteProjectionWakeInput,
): readonly EnqueueProjectionWakeIntentInput[] {
  const sourcePositionsByContext = new Map(
    input.sourcePositions.map((position) => [position.sourceContextName, position]),
  );
  const interests = lookupRouteProjectionInterests(index, {
    ...input,
    sourceContextNames: [...sourcePositionsByContext.keys()],
  });

  return interests.flatMap((entry) => {
    const sourcePosition = sourcePositionsByContext.get(entry.sourceContextName);
    if (!sourcePosition) {
      return [];
    }

    return [
      createWakeIntentInput(index, entry, {
        requiredPosition: sourcePosition.requiredPosition,
        requiredCursor: sourcePosition.requiredCursor ?? null,
        origin: input.origin ?? "api-wait",
        priorityLane: input.priorityLane ?? entry.priorityLane,
        correlationId: input.correlationId ?? null,
        metadata: input.metadata,
        schemaVersion: input.schemaVersion,
        payloadVersion: input.payloadVersion,
        nextEligibleAt: input.nextEligibleAt,
        expiresAt: input.expiresAt,
      }),
    ];
  });
}

export function summarizeProjectionInterestIndex(index: ProjectionInterestIndex): ProjectionInterestIndexSummary {
  const enabledEntries = index.entries.filter((entry) => entry.enabled);

  return {
    indexVersion: index.indexVersion,
    schemaVersion: index.schemaVersion,
    payloadVersion: index.payloadVersion,
    generatedAt: index.generatedAt,
    status: index.status,
    staleReason: index.staleReason,
    entryCount: index.entries.length,
    enabledEntryCount: enabledEntries.length,
    disabledEntryCount: index.entries.length - enabledEntries.length,
    routeDependencyCount: index.routeDependencies.length,
    enabledSourceContextNames: index.enabledSourceContextNames,
    sourceContextCounts: countBy(enabledEntries, (entry) => entry.sourceContextName, "sourceContextName"),
    priorityLaneCounts: countBy(enabledEntries, (entry) => entry.priorityLane, "priorityLane"),
  };
}

export function markProjectionInterestIndexStale(
  index: ProjectionInterestIndex,
  reason: string | null = null,
): ProjectionInterestIndex {
  return createProjectionInterestIndex({
    ...index,
    status: "stale",
    staleReason: reason,
  });
}

export function createProjectionInterestIndexCache(
  load: () => ProjectionInterestIndex | Promise<ProjectionInterestIndex>,
): ProjectionInterestIndexCache {
  let snapshot: ProjectionInterestIndex | null = null;

  return {
    getSnapshot: () => snapshot,
    requireSnapshot: (options = {}) => {
      if (!snapshot) {
        throw new ProjectionInterestIndexNotLoadedError();
      }
      assertUsableIndex(snapshot, options.allowStale);
      return snapshot;
    },
    reload: async () => {
      snapshot = await load();
      return snapshot;
    },
    markStale: (reason = null) => {
      if (!snapshot) {
        return null;
      }
      snapshot = markProjectionInterestIndexStale(snapshot, reason);
      return snapshot;
    },
  };
}

function createProjectionInterestIndex(
  input: Pick<
    ProjectionInterestIndex,
    | "indexVersion"
    | "schemaVersion"
    | "payloadVersion"
    | "generatedAt"
    | "status"
    | "staleReason"
    | "entries"
    | "routeDependencies"
  >,
): ProjectionInterestIndex {
  const enabledEntries = input.entries.filter((entry) => entry.enabled);
  const bySourceContextName = groupEntries(input.entries, (entry) => entry.sourceContextName);
  const bySourceEventType = groupEntries(
    input.entries.flatMap((entry) =>
      (entry.eventTypes ?? []).map((eventType) => ({
        sourceEventTypeKey: sourceEventTypeKey(entry.sourceContextName, eventType),
        entry,
      })),
    ),
    ({ sourceEventTypeKey }) => sourceEventTypeKey,
    ({ entry }) => entry,
  );
  const bySourceWildcardEventType = groupEntries(
    input.entries.filter((entry) => !entry.eventTypes),
    (entry) => entry.sourceContextName,
  );
  const byMountPath = groupEntries(input.routeDependencies, (dependency) => dependency.mountPath);
  const byRouteDependency = groupEntries(
    input.entries.flatMap((entry) => entry.routeDependencies.map((dependency) => ({ dependency, entry }))),
    ({ dependency }) => dependency.dependencyId,
    ({ entry }) => entry,
  );
  const routePatternsByDependency = new Map(
    input.routeDependencies.map((dependency) => [dependency.dependencyId, new RegExp(dependency.routePattern)]),
  );

  return {
    ...input,
    enabledSourceContextNames: [...new Set(enabledEntries.map((entry) => entry.sourceContextName))].sort(),
    bySourceContextName,
    bySourceEventType,
    bySourceWildcardEventType,
    byMountPath,
    byRouteDependency,
    routePatternsByDependency,
  };
}

function createWakeIntentInput(
  index: ProjectionInterestIndex,
  entry: ProjectionInterestEntry,
  input: Readonly<{
    requiredPosition: bigint | number | string;
    requiredCursor: string | null;
    origin: WorkSignalWakeOrigin;
    priorityLane: WorkSignalPriorityLane;
    correlationId: string | null;
    metadata?: JsonRecord;
    schemaVersion?: number;
    payloadVersion?: number;
    nextEligibleAt?: Date | string;
    expiresAt?: Date | string;
  }>,
): EnqueueProjectionWakeIntentInput {
  return {
    sourceContextName: entry.sourceContextName,
    targetContextName: entry.targetContextName,
    projectionName: entry.projectionName,
    checkpointKey: entry.checkpointKey,
    requiredPosition: input.requiredPosition,
    requiredCursor: input.requiredCursor,
    priorityLane: input.priorityLane,
    origin: input.origin,
    correlationId: input.correlationId,
    metadata: {
      ...(input.metadata ?? {}),
      projectionInterestIndexVersion: index.indexVersion,
    },
    schemaVersion: input.schemaVersion ?? index.schemaVersion,
    payloadVersion: input.payloadVersion ?? index.payloadVersion,
    nextEligibleAt: input.nextEligibleAt,
    expiresAt: input.expiresAt,
  };
}

function resolveProjectionInterestOverride(
  overrides: readonly ProjectionInterestOverride[],
  entry: Readonly<{
    sourceContextName: string;
    targetContextName: string;
    projectionName: string;
  }>,
): ProjectionInterestOverride | null {
  return (
    overrides.find(
      (override) =>
        override.sourceContextName === entry.sourceContextName &&
        override.targetContextName === entry.targetContextName &&
        override.projectionName === entry.projectionName,
    ) ??
    overrides.find(
      (override) =>
        !override.sourceContextName &&
        override.targetContextName === entry.targetContextName &&
        override.projectionName === entry.projectionName,
    ) ??
    null
  );
}

function defaultPriorityLane(seed: ProjectionInterestPrioritySeed): WorkSignalPriorityLane {
  return seed.routeDependencies.length > 0 ? "hot" : "standard";
}

function groupRouteDependenciesByProjection(
  dependencies: readonly ProjectionRouteDependency[],
): ReadonlyMap<string, readonly ProjectionRouteDependency[]> {
  return groupEntries(dependencies, (dependency) =>
    projectionKey(dependency.targetContextName, dependency.projectionName),
  );
}

function projectionKey(targetContextName: string, projectionName: string): string {
  return `${targetContextName}:${projectionName}`;
}

function sourceEventTypeKey(sourceContextName: string, eventType: string): string {
  return `${sourceContextName}:${eventType}`;
}

function sourceEventCandidates(
  index: ProjectionInterestIndex,
  sourceContextName: string,
  eventTypes: readonly string[] | undefined,
): readonly ProjectionInterestEntry[] {
  if (!eventTypes || eventTypes.length === 0) {
    return index.bySourceContextName.get(sourceContextName) ?? [];
  }

  return uniqueBy(
    [
      ...(index.bySourceWildcardEventType.get(sourceContextName) ?? []),
      ...eventTypes.flatMap(
        (eventType) => index.bySourceEventType.get(sourceEventTypeKey(sourceContextName, eventType)) ?? [],
      ),
    ],
    (entry) => entry.entryId,
  );
}

function dependencyName(dependency: ReadConsistencyDependencyDeclaration): string {
  if (dependency.projectionName) {
    return dependency.projectionName;
  }
  if (dependency.readModelTable) {
    return dependency.readModelTable;
  }

  throw new Error("Read freshness dependency must declare projectionName or readModelTable.");
}

function matchesEventTypes(entry: ProjectionInterestEntry, eventTypes: readonly string[] | undefined): boolean {
  if (!entry.eventTypes) {
    return true;
  }
  if (entry.eventTypes.length === 0) {
    return false;
  }
  if (!eventTypes || eventTypes.length === 0) {
    return true;
  }

  return eventTypes.some((eventType) => entry.eventTypes?.includes(eventType));
}

function matchesStreamIds(entry: ProjectionInterestEntry, streamIds: readonly string[] | undefined): boolean {
  if (!entry.streamPrefixes) {
    return true;
  }
  if (entry.streamPrefixes.length === 0) {
    return false;
  }
  if (!streamIds || streamIds.length === 0) {
    return true;
  }

  return streamIds.some((streamId) => entry.streamPrefixes?.some((prefix) => streamId.startsWith(prefix)));
}

function assertUsableIndex(index: ProjectionInterestIndex, allowStale = false): void {
  if (index.status === "stale" && !allowStale) {
    throw new ProjectionInterestIndexStaleError(index);
  }
}

function normalizeInstant(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function normalizeNullableText(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function normalizeTextList(values: readonly string[] | undefined): readonly string[] | undefined {
  if (!values) {
    return undefined;
  }

  return [...new Set(values.map((value) => value.trim()).filter((value) => value.length > 0))].sort((left, right) =>
    left.localeCompare(right),
  );
}

function normalizeMethods(methods: readonly ("GET" | "HEAD")[] | undefined): readonly ("GET" | "HEAD")[] {
  return [...uniqueBy((methods ?? ["GET", "HEAD"]).map(normalizeMethod), (method) => method)].sort();
}

function normalizeMethod(method: string): "GET" | "HEAD" {
  const normalized = method.toUpperCase();
  if (normalized !== "GET" && normalized !== "HEAD") {
    throw new Error(`Projection interest route dependencies only support GET and HEAD, got '${method}'.`);
  }

  return normalized;
}

function normalizeRoutePath(routePath: string): string {
  const trimmed = routePath.trim();
  if (!trimmed || trimmed === "/") {
    return "/";
  }
  const withLeadingSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  return withLeadingSlash.replace(/\/+$/, "");
}

function normalizeRequestRelativePath(mountPath: string, path: string): string {
  const requestPath = normalizeRoutePath(path.split("?")[0] ?? "/");
  if (mountPath !== "/" && requestPath.startsWith(`${mountPath}/`)) {
    return normalizeRoutePath(requestPath.slice(mountPath.length));
  }
  if (requestPath === mountPath) {
    return "/";
  }

  return requestPath;
}

function compileMountRelativeRoutePattern(routePath: string): RegExp {
  const normalized = normalizeRoutePath(routePath);
  if (normalized === "/") {
    return /^\/?$/;
  }

  const pattern = normalized
    .slice(1)
    .split("/")
    .map((segment) => {
      if (segment === "*") {
        return ".*";
      }
      if (segment.startsWith(":")) {
        return "[^/]+";
      }

      return escapeRegex(segment);
    })
    .join("/");

  return new RegExp(`^/${pattern}/?$`);
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function groupEntries<T, V = T>(
  entries: readonly T[],
  keySelector: (entry: T) => string,
  valueSelector: (entry: T) => V = (entry) => entry as unknown as V,
): ReadonlyMap<string, readonly V[]> {
  const grouped = new Map<string, V[]>();
  for (const entry of entries) {
    const key = keySelector(entry);
    const group = grouped.get(key);
    if (group) {
      group.push(valueSelector(entry));
    } else {
      grouped.set(key, [valueSelector(entry)]);
    }
  }

  return new Map([...grouped.entries()].sort(([left], [right]) => left.localeCompare(right)));
}

function countBy<T, K extends string, V extends string>(
  entries: readonly T[],
  keySelector: (entry: T) => V,
  keyName: K,
): readonly (Readonly<Record<K, V>> & Readonly<{ enabledEntryCount: number }>)[] {
  return [...groupEntries(entries, keySelector).entries()].map(([key, values]) => ({
    [keyName]: key,
    enabledEntryCount: values.length,
  })) as unknown as readonly (Readonly<Record<K, V>> & Readonly<{ enabledEntryCount: number }>)[];
}

function uniqueBy<T>(values: readonly T[], keySelector: (value: T) => string): readonly T[] {
  const seen = new Set<string>();
  const result: T[] = [];

  for (const value of values) {
    const key = keySelector(value);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(value);
  }

  return result;
}

function sortEntries(entries: readonly ProjectionInterestEntry[]): readonly ProjectionInterestEntry[] {
  return [...entries].sort((left, right) => {
    if (left.sourceContextName !== right.sourceContextName) {
      return left.sourceContextName.localeCompare(right.sourceContextName);
    }
    if (left.targetContextName !== right.targetContextName) {
      return left.targetContextName.localeCompare(right.targetContextName);
    }
    if (left.projectionName !== right.projectionName) {
      return left.projectionName.localeCompare(right.projectionName);
    }

    return left.checkpointKey.localeCompare(right.checkpointKey);
  });
}

function sortRouteDependencies(
  dependencies: readonly ProjectionRouteDependency[],
): readonly ProjectionRouteDependency[] {
  return [...dependencies].sort((left, right) => left.dependencyId.localeCompare(right.dependencyId));
}

function entryVersionValue(entry: ProjectionInterestEntry): unknown {
  return {
    sourceContextName: entry.sourceContextName,
    targetContextName: entry.targetContextName,
    projectionName: entry.projectionName,
    checkpointKey: entry.checkpointKey,
    subscriptionName: entry.subscriptionName,
    subscriptionVersion: entry.subscriptionVersion,
    projectionRevision: entry.projectionRevision,
    priorityLane: entry.priorityLane,
    requiredDuringBootstrap: entry.requiredDuringBootstrap,
    ownedTables: entry.ownedTables,
    eventTypes: entry.eventTypes,
    streamPrefixes: entry.streamPrefixes,
    owner: entry.owner,
    enabled: entry.enabled,
    optOutReason: entry.optOutReason,
  };
}

function routeDependencyVersionValue(dependency: ProjectionRouteDependency): unknown {
  return {
    dependencyId: dependency.dependencyId,
    contextName: dependency.contextName,
    mountPath: dependency.mountPath,
    routePath: dependency.routePath,
    methods: dependency.methods,
    targetContextName: dependency.targetContextName,
    projectionName: dependency.projectionName,
    dependencyKind: dependency.dependencyKind,
    dependencyName: dependency.dependencyName,
  };
}

function hashStableValue(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex").slice(0, 16);
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }

  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort((left, right) => left.localeCompare(right))
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(",")}}`;
}

function isPresentString(value: string | undefined): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
