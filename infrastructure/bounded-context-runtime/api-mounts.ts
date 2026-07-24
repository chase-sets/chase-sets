import type { BcApiModule, BcApiMount } from "@chase-sets/bounded-context-module";
import { getEventCommitMetadata, runWithEventCommitMetadata, type EventCommitMetadata } from "@chase-sets/event-core";
import {
  CHASE_SETS_COMMIT_RECEIPT_HEADER,
  CHASE_SETS_READ_AFTER_WRITE_HEADER,
  CHASE_SETS_READ_TARGET_CONTEXT_HEADER,
  decodeCommitReceipt,
  decodeFreshWriteReceipt,
  encodeCommitReceipt,
  type FreshWriteReceipt,
  type SourceCommitPosition,
} from "@chase-sets/http/responses";
import {
  applyCommittedProjectionEventsInline,
  projectionInlineApplyEnabled,
  type ProjectionInlineApplyOutcomeSignal,
} from "./inline-apply";
import type { ContextProjectionGroup } from "./projection-groups";

export type ResolvedApiMount<TRouter = unknown> = BcApiMount &
  Readonly<{
    contextName: string;
    router: TRouter;
  }>;

export type ReadConsistencyDependencyDeclaration = Readonly<
  | {
      projectionName: string;
      readModelTable?: never;
      targetContextName?: string;
    }
  | {
      readModelTable: string;
      projectionName?: never;
      targetContextName?: string;
    }
>;

export type ReadConsistencyRouteDependency = Readonly<{
  routePath: string;
  methods?: readonly ("GET" | "HEAD")[];
  dependencies: readonly ReadConsistencyDependencyDeclaration[];
}>;

type ReadConsistencySubscriptionRunner = Readonly<{
  sourceContextName: string;
  checkpointKey?: string;
  inlineApply?: boolean;
  errorPolicy?: string;
  areReceiptEventsApplied?: (eventIds: readonly string[]) => Promise<boolean>;
  refreshStatus: () => Promise<
    Readonly<{
      lastGlobalPosition: string;
      sourceHeadGlobalPosition?: string;
      state: string;
      lastError?: string | null;
    }>
  >;
}>;

export type ReadConsistencyWakeRequest = Readonly<{
  sourceContextName: string;
  targetContextName: string;
  projectionName: string;
  checkpointKey: string;
  requiredPosition: string;
}>;

export type ReadConsistencyWorkSignalGateway = Readonly<{
  requestWake?: (
    input: Readonly<{
      requests: readonly ReadConsistencyWakeRequest[];
      metadata?: Readonly<Record<string, unknown>>;
    }>,
  ) => Promise<number>;
  registerWaiters?: (
    input: Readonly<{
      requests: readonly ReadConsistencyWakeRequest[];
      timeoutMs: number;
      metadata?: Readonly<Record<string, unknown>>;
    }>,
  ) => Promise<void>;
  waitForReadiness?: (
    input: Readonly<{
      requests: readonly ReadConsistencyWakeRequest[];
      timeoutMs: number;
      metadata?: Readonly<Record<string, unknown>>;
    }>,
  ) => Promise<"notified" | "timeout" | "aborted" | "listener-unavailable">;
}>;

export type ReadConsistencyWaitOutcome = Readonly<{
  wakeRequestCount: number;
  workSignalErrorPresent: boolean;
}>;

const WAKE_REQUEST_RACE_BUDGET_MS = 250;
const MAX_WAKE_REQUESTS_PER_WAIT = 16;

function collectWakeRequests(
  pending: readonly Readonly<{
    sourceContextName: string;
    targetContextName: string;
    projectionName: string;
    checkpointKey: string | null;
    requiredGlobalPosition: string;
    sourceHeadGlobalPosition: string | null;
  }>[],
): readonly ReadConsistencyWakeRequest[] {
  const requestsByCheckpoint = new Map<string, ReadConsistencyWakeRequest>();
  for (const item of pending) {
    if (!item.checkpointKey) {
      continue;
    }

    // Receipts are unauthenticated request input: clamp the requested
    // position to the durable source head so a forged receipt cannot poison
    // the shared coalesced wake intent with an unreachable position.
    const requiredPosition =
      item.sourceHeadGlobalPosition !== null &&
      BigInt(item.requiredGlobalPosition) > BigInt(item.sourceHeadGlobalPosition)
        ? item.sourceHeadGlobalPosition
        : item.requiredGlobalPosition;
    const dedupeKey = `${item.checkpointKey}:${item.sourceContextName}`;
    const existing = requestsByCheckpoint.get(dedupeKey);
    if (existing && BigInt(existing.requiredPosition) >= BigInt(requiredPosition)) {
      continue;
    }

    requestsByCheckpoint.set(dedupeKey, {
      sourceContextName: item.sourceContextName,
      targetContextName: item.targetContextName,
      projectionName: item.projectionName,
      checkpointKey: item.checkpointKey,
      requiredPosition,
    });
  }

  return [...requestsByCheckpoint.values()].slice(0, MAX_WAKE_REQUESTS_PER_WAIT);
}

export type ReadConsistencyProjectionGroup = Readonly<{
  targetContextName: string;
  projectionName: string;
  handlerKind?: string;
  sideEffectOnly?: boolean;
  ownedTables?: readonly string[];
  subscriptionRunners: readonly ReadConsistencySubscriptionRunner[];
}>;

export type ResolvedReadConsistencyDependency = Readonly<{
  targetContextName: string;
  projectionName: string;
}>;

type ReadConsistencyWaitMode = "target-context" | "exact-dependency";

export type ReadConsistencyExactDependencyMode = "enabled" | "target-context";

export type ReadConsistencyRouteTuning = Readonly<{
  mountPath: string;
  routePath: string;
  targetContextName?: string;
  methods?: readonly ("GET" | "HEAD")[];
  timeoutMs?: number;
  pollIntervalMs?: number;
  exactDependencyMode?: ReadConsistencyExactDependencyMode;
}>;

type ReadConsistencyAuditOutcome = "missing-receipt" | "fresh" | "timeout";

export type ReadConsistencyAuditRecord = Readonly<{
  type: "read-after-write.freshness";
  outcome: ReadConsistencyAuditOutcome;
  method: string;
  mountPath: string;
  routePaths: readonly string[];
  readAfterWriteHeaderPresent: boolean;
  readTargetContextHeaderPresent: boolean;
  readTargetContextHeaderValid: boolean;
  requestedTargetContextName: string | null;
  targetContextNames: readonly string[];
  waitMode: ReadConsistencyWaitMode;
  durationMs: number;
  receiptSourceContextNames: readonly string[];
  receiptSourceCount: number;
  receiptEventCount: number;
  dependencies: readonly ResolvedReadConsistencyDependency[];
  wakeRequestCount: number;
  workSignalError: "present" | null;
  pending: readonly Readonly<{
    targetContextName: string;
    projectionName: string;
    sourceContextName: string;
    checkpointKey: string | null;
    requiredGlobalPosition: string;
    lastGlobalPosition: string;
    globalPositionLag: string;
    state: string;
    lastError: "present" | null;
  }>[];
}>;

export type ReadConsistencyMiddlewareOptions = Readonly<{
  timeoutMs?: number;
  pollIntervalMs?: number;
  exactDependencyMode?: ReadConsistencyExactDependencyMode;
  routeTuning?: readonly ReadConsistencyRouteTuning[];
  workSignalGateway?: ReadConsistencyWorkSignalGateway;
  recordReadConsistencyAudit?: (record: ReadConsistencyAuditRecord) => void;
  nowMs?: () => number;
}>;

type ProjectionFreshnessTimeoutDetails = Readonly<{
  targetContextNames: readonly string[];
  pending: readonly Readonly<{
    targetContextName: string;
    projectionName: string;
    sourceContextName: string;
    checkpointKey: string | null;
    requiredGlobalPosition: string;
    lastGlobalPosition: string;
    state: string;
    lastError: string | null;
  }>[];
  waitMode: ReadConsistencyWaitMode;
  dependencies: readonly ResolvedReadConsistencyDependency[];
  wakeRequestCount: number;
  workSignalErrorPresent: boolean;
}>;

export class ProjectionFreshnessTimeoutError extends Error {
  public readonly details: ProjectionFreshnessTimeoutDetails;

  public constructor(details: ProjectionFreshnessTimeoutDetails) {
    super("Projection read model did not catch up to the requested write receipt before the freshness timeout.");
    this.name = "ProjectionFreshnessTimeoutError";
    this.details = details;
  }
}

export function createResolvedApiMount<TRouter>(
  contextName: string,
  mount: Readonly<{
    mountPath: string;
    kind: string;
    requiresAuth: boolean;
    readFreshnessRoutes?: BcApiMount["readFreshnessRoutes"];
  }>,
  router: TRouter,
): ResolvedApiMount<TRouter> {
  const kind = mount.kind;
  if (kind !== "primary" && kind !== "additional") {
    throw new Error(`Invalid API mount kind '${kind}' for context '${contextName}'.`);
  }

  return {
    contextName,
    mountPath: mount.mountPath,
    kind,
    requiresAuth: mount.requiresAuth,
    readFreshnessRoutes: mount.readFreshnessRoutes,
    router,
  };
}

export function resolveContextApiMounts<TRouter>(
  contextName: string,
  mounts: readonly Readonly<{
    mountPath: string;
    kind: string;
    requiresAuth: boolean;
  }>[],
  routers: readonly TRouter[],
): readonly ResolvedApiMount<TRouter>[] {
  if (mounts.length !== routers.length) {
    throw new Error(
      `Context '${contextName}' declared ${mounts.length} API mounts but provided ${routers.length} routers.`,
    );
  }

  return mounts.map((mount, index) => createResolvedApiMount(contextName, mount, routers[index]));
}

export function resolveModuleApiMounts<TServices, TPool, TPorts, TRouter>(
  module: Pick<BcApiModule<TServices, TPool, TPorts, TRouter>, "contextName" | "apiMounts" | "buildApis">,
  services: TServices,
): readonly ResolvedApiMount<TRouter>[] {
  return resolveContextApiMounts(module.contextName, module.apiMounts, module.buildApis(services));
}

function normalizeMountWildcard(mountPath: string) {
  return mountPath.endsWith("/*") ? mountPath : `${mountPath}/*`;
}

function uniqueMountPaths(paths: readonly string[]) {
  return [...new Set(paths)];
}

export function attachApiMountMiddleware(
  app: Readonly<{
    use(path: string, middleware: unknown): unknown;
  }>,
  mountPaths: readonly string[],
  middleware: unknown,
): void {
  for (const mountPath of uniqueMountPaths(mountPaths)) {
    app.use(normalizeMountWildcard(mountPath), middleware);
  }
}

export function attachWriteConsistencyMiddleware(
  app: Readonly<{
    use(path: string, middleware: (context: unknown, next: () => Promise<void>) => Promise<void>): unknown;
  }>,
  mounts: readonly Pick<ResolvedApiMount, "mountPath">[],
  projectionGroups: readonly ContextProjectionGroup[] = [],
  options: Readonly<{
    enabled?: boolean;
    env?: NodeJS.ProcessEnv;
    budgetMs?: number;
    recordInlineApplyOutcome?: (signal: ProjectionInlineApplyOutcomeSignal) => void;
  }> = {},
): void {
  for (const mountPath of uniqueMountPaths(mounts.map((mount) => mount.mountPath))) {
    app.use(normalizeMountWildcard(mountPath), async (context: unknown, next) => {
      const req = (context as { req?: { method?: string } }).req;
      const method = req?.method?.toUpperCase() ?? "GET";
      if (method === "GET" || method === "HEAD") {
        await next();
        return;
      }

      await runWithEventCommitMetadata(async () => {
        await next();

        const metadata = getEventCommitMetadata();
        if (metadata.eventIds.length === 0) {
          return;
        }

        if (options.enabled ?? projectionInlineApplyEnabled(options.env)) {
          await applyCommittedProjectionEventsInline({
            committedEvents: metadata.committedEvents,
            commitSources: metadata.sources,
            projectionGroups,
            budgetMs: options.budgetMs,
            recordOutcome: options.recordInlineApplyOutcome,
          });
        }

        setResponseHeaders(context, writeConsistencyHeaders(metadata, currentResponseHeaders(context)));
      });
    });
  }
}

function maxCommitPosition(left: string | undefined, right: string | undefined) {
  if (!left) {
    return right;
  }
  if (!right) {
    return left;
  }
  return BigInt(right) > BigInt(left) ? right : left;
}

function mergeSourceCommitPositions(sources: readonly SourceCommitPosition[]) {
  const byContext = new Map<string, SourceCommitPosition>();

  for (const source of sources) {
    const current = byContext.get(source.sourceContextName);
    if (!current) {
      byContext.set(source.sourceContextName, source);
      continue;
    }

    byContext.set(source.sourceContextName, {
      sourceContextName: source.sourceContextName,
      maxGlobalPosition:
        maxCommitPosition(current.maxGlobalPosition, source.maxGlobalPosition) ?? source.maxGlobalPosition,
      eventIds: [...new Set([...current.eventIds, ...source.eventIds])],
    });
  }

  return [...byContext.values()].sort((left, right) => left.sourceContextName.localeCompare(right.sourceContextName));
}

function commaSeparatedHeaderValues(value: string | null | undefined) {
  return (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function writeConsistencyHeaders(
  metadata: EventCommitMetadata,
  existingHeaders?: Headers | null,
): readonly [string, string][] {
  const headers: [string, string][] = [["Chase-Sets-Consistency", "eventual"]];
  const commitPosition = maxCommitPosition(
    existingHeaders?.get("Chase-Sets-Commit-Position") ?? undefined,
    metadata.maxGlobalPosition,
  );
  if (commitPosition) {
    headers.push(["Chase-Sets-Commit-Position", commitPosition]);
  }

  const commitPositions = mergeSourceCommitPositions([
    ...decodeCommitReceipt(existingHeaders?.get(CHASE_SETS_COMMIT_RECEIPT_HEADER)),
    ...metadata.sources,
  ]);
  if (commitPositions.length > 0) {
    headers.push([CHASE_SETS_COMMIT_RECEIPT_HEADER, encodeCommitReceipt(commitPositions)]);
  }

  const compactEventIds = [
    ...new Set([
      ...commaSeparatedHeaderValues(existingHeaders?.get("Chase-Sets-Commit-Event-Ids")),
      ...metadata.eventIds,
    ]),
  ].join(",");
  if (compactEventIds.length <= 4_000) {
    headers.push(["Chase-Sets-Commit-Event-Ids", compactEventIds]);
  }

  return headers;
}

function currentResponseHeaders(context: unknown): Headers | null {
  return (context as { res?: Response }).res?.headers ?? null;
}

function setResponseHeaders(context: unknown, headers: readonly [string, string][]) {
  const honoContext = context as {
    header?: (name: string, value: string) => void;
    res?: Response;
  };

  for (const [name, value] of headers) {
    honoContext.header?.(name, value);
  }

  if (!honoContext.res) {
    return;
  }

  const response = new Response(honoContext.res.body, honoContext.res);
  for (const [name, value] of headers) {
    response.headers.set(name, value);
  }
  honoContext.res = response;
}

export async function waitForProjectionFreshness(
  input: Readonly<{
    projectionGroups: readonly ReadConsistencyProjectionGroup[];
    targetContextNames: readonly string[];
    receipt: FreshWriteReceipt;
    dependencies?: readonly ResolvedReadConsistencyDependency[];
    timeoutMs?: number;
    pollIntervalMs?: number;
    workSignalGateway?: ReadConsistencyWorkSignalGateway;
    workSignalMetadata?: Readonly<Record<string, unknown>>;
    nowMs?: () => number;
  }>,
): Promise<ReadConsistencyWaitOutcome> {
  const timeoutMs = input.timeoutMs ?? 2_500;
  const pollIntervalMs = input.pollIntervalMs ?? 75;
  const nowMs = input.nowMs ?? Date.now;
  const startedAt = nowMs();
  const targetContextNames = [...new Set(input.targetContextNames)];
  let wakeRequestCount = 0;
  let workSignalErrorPresent = false;
  let workSignalsRequested = false;

  while (true) {
    const pending = await findPendingProjectionFreshness({
      projectionGroups: input.projectionGroups,
      targetContextNames,
      receipt: input.receipt,
      dependencies: input.dependencies,
    });

    if (pending.length === 0) {
      return { wakeRequestCount, workSignalErrorPresent };
    }

    // Check, then wake: only durable evidence of lagging checkpoints triggers
    // a single wake/waiter batch for exactly the pending dependencies. The
    // bounded durable poll below remains the unconditional fallback, so a
    // wake landing between the check and the registration cannot strand the
    // request.
    const requests = collectWakeRequests(pending);

    if (!workSignalsRequested && input.workSignalGateway) {
      workSignalsRequested = true;
      if (requests.length > 0) {
        const gateway = input.workSignalGateway;
        const gatewayWork = (async () => {
          wakeRequestCount = (await gateway.requestWake?.({ requests, metadata: input.workSignalMetadata })) ?? 0;
          await gateway.registerWaiters?.({
            requests,
            timeoutMs,
            metadata: input.workSignalMetadata,
          });
        })().catch(() => {
          // Wake acceleration is best-effort; the durable poll continues.
          workSignalErrorPresent = true;
        });

        // Bound the request-path cost: a slow control database must never
        // hold a freshness wait past its own budget. A batch that loses the
        // race keeps completing in the background.
        const raceBudgetMs = Math.min(WAKE_REQUEST_RACE_BUDGET_MS, Math.max(0, timeoutMs - (nowMs() - startedAt)));
        const settledInBudget = await Promise.race([
          gatewayWork.then(() => true),
          delay(raceBudgetMs).then(() => false),
        ]);
        if (!settledInBudget) {
          workSignalErrorPresent = true;
        }
      }
    }

    const elapsedMs = nowMs() - startedAt;
    if (elapsedMs >= timeoutMs) {
      throw new ProjectionFreshnessTimeoutError({
        targetContextNames,
        pending,
        waitMode: input.dependencies ? "exact-dependency" : "target-context",
        dependencies: input.dependencies ?? [],
        wakeRequestCount,
        workSignalErrorPresent,
      });
    }

    const waitMs = Math.min(pollIntervalMs, Math.max(0, timeoutMs - elapsedMs));
    await waitForNextFreshnessCheck({
      gateway: input.workSignalGateway,
      requests,
      timeoutMs: waitMs,
      metadata: input.workSignalMetadata,
      onError: () => {
        workSignalErrorPresent = true;
      },
    });
  }
}

async function waitForNextFreshnessCheck(
  input: Readonly<{
    gateway?: ReadConsistencyWorkSignalGateway;
    requests: readonly ReadConsistencyWakeRequest[];
    timeoutMs: number;
    metadata?: Readonly<Record<string, unknown>>;
    onError: () => void;
  }>,
): Promise<void> {
  if (!input.gateway?.waitForReadiness || input.requests.length === 0) {
    await delay(input.timeoutMs);
    return;
  }

  try {
    const result = await input.gateway.waitForReadiness({
      requests: input.requests,
      timeoutMs: input.timeoutMs,
      metadata: input.metadata,
    });
    if (result === "notified") {
      return;
    }
    return;
  } catch {
    input.onError();
  }

  await delay(input.timeoutMs);
}

async function findPendingProjectionFreshness(
  input: Readonly<{
    projectionGroups: readonly ReadConsistencyProjectionGroup[];
    targetContextNames: readonly string[];
    receipt: FreshWriteReceipt;
    dependencies?: readonly ResolvedReadConsistencyDependency[];
  }>,
) {
  const targetContextNameSet = new Set(input.targetContextNames);
  const dependencies = input.dependencies ? normalizeResolvedDependencies(input.dependencies) : null;
  const pending: {
    targetContextName: string;
    projectionName: string;
    sourceContextName: string;
    checkpointKey: string | null;
    requiredGlobalPosition: string;
    sourceHeadGlobalPosition: string | null;
    lastGlobalPosition: string;
    state: string;
    lastError: string | null;
  }[] = [];

  for (const group of input.projectionGroups) {
    if (!targetContextNameSet.has(group.targetContextName)) {
      continue;
    }

    if (
      dependencies &&
      !dependencies.some(
        (dependency) =>
          dependency.targetContextName === group.targetContextName &&
          dependency.projectionName === group.projectionName,
      )
    ) {
      continue;
    }

    for (const source of input.receipt.sources) {
      for (const runner of group.subscriptionRunners.filter(
        (candidate) => candidate.sourceContextName === source.sourceContextName,
      )) {
        const status = await runner.refreshStatus();
        if (BigInt(status.lastGlobalPosition) >= BigInt(source.maxGlobalPosition)) {
          continue;
        }

        if (
          source.eventIds.length > 0 &&
          runner.inlineApply === true &&
          runner.errorPolicy !== "global-strict" &&
          group.handlerKind !== "reaction" &&
          group.sideEffectOnly !== true &&
          runner.areReceiptEventsApplied
        ) {
          try {
            if (await runner.areReceiptEventsApplied(source.eventIds)) {
              continue;
            }
          } catch {
            // The application ledger is an optimization over the durable
            // checkpoint predicate. Query failures retain checkpoint-only
            // behavior so read consistency always fails closed.
          }
        }

        pending.push({
          targetContextName: group.targetContextName,
          projectionName: group.projectionName,
          sourceContextName: source.sourceContextName,
          checkpointKey: runner.checkpointKey ?? null,
          requiredGlobalPosition: source.maxGlobalPosition,
          sourceHeadGlobalPosition: status.sourceHeadGlobalPosition ?? null,
          lastGlobalPosition: status.lastGlobalPosition,
          state: status.state,
          lastError: status.lastError ?? null,
        });
      }
    }
  }

  return pending;
}

export function attachReadConsistencyMiddleware(
  app: Readonly<{
    use(path: string, middleware: (context: unknown, next: () => Promise<void>) => Promise<unknown>): unknown;
  }>,
  mounts: readonly Pick<ResolvedApiMount, "contextName" | "mountPath" | "readFreshnessRoutes">[],
  projectionGroups: readonly ReadConsistencyProjectionGroup[],
  options: ReadConsistencyMiddlewareOptions = {},
): void {
  const contextsByMountPath = new Map<string, string[]>();
  const routeDependenciesByMountPath = new Map<string, ReturnType<typeof createRouteDependencyMatcher>[]>();
  const routeTuningByMountPath = new Map<string, ReturnType<typeof createRouteTuningMatcher>[]>();
  const nowMs = options.nowMs ?? Date.now;
  for (const mount of mounts) {
    contextsByMountPath.set(mount.mountPath, [...(contextsByMountPath.get(mount.mountPath) ?? []), mount.contextName]);
    for (const route of mount.readFreshnessRoutes ?? []) {
      routeDependenciesByMountPath.set(mount.mountPath, [
        ...(routeDependenciesByMountPath.get(mount.mountPath) ?? []),
        createRouteDependencyMatcher(mount.contextName, mount.mountPath, route, projectionGroups),
      ]);
    }
  }
  for (const [index, tuning] of (options.routeTuning ?? []).entries()) {
    routeTuningByMountPath.set(tuning.mountPath, [
      ...(routeTuningByMountPath.get(tuning.mountPath) ?? []),
      createRouteTuningMatcher(tuning, index),
    ]);
  }

  for (const [mountPath, contextNames] of contextsByMountPath) {
    const routeDependencyMatchers = routeDependenciesByMountPath.get(mountPath) ?? [];
    const routeTuningMatchers = routeTuningByMountPath.get(mountPath) ?? [];

    app.use(normalizeMountWildcard(mountPath), async (context: unknown, next) => {
      const req = (
        context as {
          req?: {
            method?: string;
            header?: (name: string) => string | undefined;
            path?: string;
            url?: string;
          };
        }
      ).req;
      const startedAt = nowMs();
      const method = req?.method?.toUpperCase() ?? "GET";
      if (method !== "GET" && method !== "HEAD") {
        await next();
        return;
      }

      const readAfterWriteHeader = req?.header?.(CHASE_SETS_READ_AFTER_WRITE_HEADER);
      const receipt = decodeFreshWriteReceipt(readAfterWriteHeader);
      const requestedTargetContextHeader = req?.header?.(CHASE_SETS_READ_TARGET_CONTEXT_HEADER);
      const requestedTargetContextName =
        requestedTargetContextHeader && contextNames.includes(requestedTargetContextHeader)
          ? requestedTargetContextHeader
          : null;
      const targetContextNames = requestedTargetContextName ? [requestedTargetContextName] : contextNames;
      const routeFreshness = resolveRouteFreshnessForRequest({
        method,
        mountPath,
        path: req?.path,
        url: req?.url,
        requestedTargetContextName,
        matchers: routeDependencyMatchers,
      });
      const routeTuning = resolveRouteTuningForRequest({
        method,
        mountPath,
        path: req?.path,
        url: req?.url,
        requestedTargetContextName,
        matchers: routeTuningMatchers,
      });
      const effectiveExactDependencyMode = routeTuning?.exactDependencyMode ?? options.exactDependencyMode ?? "enabled";
      const exactDependencies = effectiveExactDependencyMode === "enabled" ? routeFreshness.dependencies : null;
      const waitTargetContextNames = exactDependencies
        ? [...new Set(exactDependencies.map((dependency) => dependency.targetContextName))]
        : targetContextNames;
      const waitMode: ReadConsistencyWaitMode = exactDependencies ? "exact-dependency" : "target-context";
      const timeoutMs = routeTuning?.timeoutMs ?? options.timeoutMs;
      const pollIntervalMs = routeTuning?.pollIntervalMs ?? options.pollIntervalMs;

      if (!receipt || receipt.sources.length === 0) {
        if (routeFreshness.routePaths.length > 0) {
          recordReadConsistencyAudit(options.recordReadConsistencyAudit, {
            type: "read-after-write.freshness",
            outcome: "missing-receipt",
            method,
            mountPath,
            routePaths: routeFreshness.routePaths,
            readAfterWriteHeaderPresent: Boolean(readAfterWriteHeader),
            readTargetContextHeaderPresent: Boolean(requestedTargetContextHeader),
            readTargetContextHeaderValid: Boolean(requestedTargetContextName),
            requestedTargetContextName,
            targetContextNames,
            waitMode,
            durationMs: nowMs() - startedAt,
            receiptSourceContextNames: [],
            receiptSourceCount: 0,
            receiptEventCount: 0,
            dependencies: exactDependencies ?? [],
            wakeRequestCount: 0,
            workSignalError: null,
            pending: [],
          });
        }
        await next();
        return;
      }

      let waitOutcome: ReadConsistencyWaitOutcome = { wakeRequestCount: 0, workSignalErrorPresent: false };
      try {
        waitOutcome = await waitForProjectionFreshness({
          projectionGroups,
          targetContextNames: waitTargetContextNames,
          receipt,
          dependencies: exactDependencies ?? undefined,
          timeoutMs,
          pollIntervalMs,
          workSignalGateway: options.workSignalGateway,
          workSignalMetadata: {
            mountPath,
            routePaths: routeFreshness.routePaths,
          },
          nowMs,
        });
      } catch (error) {
        if (error instanceof ProjectionFreshnessTimeoutError) {
          recordReadConsistencyAudit(options.recordReadConsistencyAudit, {
            type: "read-after-write.freshness",
            outcome: "timeout",
            method,
            mountPath,
            routePaths: routeFreshness.routePaths,
            readAfterWriteHeaderPresent: Boolean(readAfterWriteHeader),
            readTargetContextHeaderPresent: Boolean(requestedTargetContextHeader),
            readTargetContextHeaderValid: Boolean(requestedTargetContextName),
            requestedTargetContextName,
            targetContextNames: error.details.targetContextNames,
            waitMode: error.details.waitMode,
            durationMs: nowMs() - startedAt,
            receiptSourceContextNames: receipt.sources.map((source) => source.sourceContextName),
            receiptSourceCount: receipt.sources.length,
            receiptEventCount: receipt.sources.reduce((count, source) => count + source.eventIds.length, 0),
            dependencies: error.details.dependencies,
            wakeRequestCount: error.details.wakeRequestCount,
            workSignalError: error.details.workSignalErrorPresent ? "present" : null,
            pending: error.details.pending.map((pending) => ({
              ...pending,
              globalPositionLag: globalPositionLag(pending.requiredGlobalPosition, pending.lastGlobalPosition),
              lastError: pending.lastError ? "present" : null,
            })),
          });
          const json = (context as { json?: (body: unknown, status?: number) => unknown }).json;
          if (json) {
            return json(
              {
                error: {
                  code: "projection_freshness_timeout",
                  message: error.message,
                  // Public body: redact raw projection error text and internal
                  // checkpoint topology; the audit record keeps the detail.
                  pending: error.details.pending.map((pending) => ({
                    targetContextName: pending.targetContextName,
                    projectionName: pending.projectionName,
                    sourceContextName: pending.sourceContextName,
                    requiredGlobalPosition: pending.requiredGlobalPosition,
                    lastGlobalPosition: pending.lastGlobalPosition,
                    state: pending.state,
                    lastError: pending.lastError ? "present" : null,
                  })),
                  waitMode: error.details.waitMode,
                  dependencies: error.details.dependencies,
                },
              },
              503,
            );
          }
        }

        throw error;
      }

      recordReadConsistencyAudit(options.recordReadConsistencyAudit, {
        type: "read-after-write.freshness",
        outcome: "fresh",
        method,
        mountPath,
        routePaths: routeFreshness.routePaths,
        readAfterWriteHeaderPresent: Boolean(readAfterWriteHeader),
        readTargetContextHeaderPresent: Boolean(requestedTargetContextHeader),
        readTargetContextHeaderValid: Boolean(requestedTargetContextName),
        requestedTargetContextName,
        targetContextNames: waitTargetContextNames,
        waitMode,
        durationMs: nowMs() - startedAt,
        receiptSourceContextNames: receipt.sources.map((source) => source.sourceContextName),
        receiptSourceCount: receipt.sources.length,
        receiptEventCount: receipt.sources.reduce((count, source) => count + source.eventIds.length, 0),
        dependencies: exactDependencies ?? [],
        wakeRequestCount: waitOutcome.wakeRequestCount,
        workSignalError: waitOutcome.workSignalErrorPresent ? "present" : null,
        pending: [],
      });
      await next();
    });
  }
}

function recordReadConsistencyAudit(
  recorder: ((record: ReadConsistencyAuditRecord) => void) | undefined,
  record: ReadConsistencyAuditRecord,
): void {
  try {
    recorder?.(record);
  } catch {
    // Audit logging must never disrupt request handling.
  }
}

function normalizeResolvedDependencies(
  dependencies: readonly ResolvedReadConsistencyDependency[],
): readonly ResolvedReadConsistencyDependency[] {
  const seen = new Set<string>();
  const normalized: ResolvedReadConsistencyDependency[] = [];

  for (const dependency of dependencies) {
    const key = `${dependency.targetContextName}:${dependency.projectionName}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    normalized.push(dependency);
  }

  return normalized;
}

function createRouteDependencyMatcher(
  contextName: string,
  mountPath: string,
  route: ReadConsistencyRouteDependency,
  projectionGroups: readonly ReadConsistencyProjectionGroup[],
) {
  const methods = new Set((route.methods ?? ["GET", "HEAD"]).map((method) => method.toUpperCase()));
  const routePattern = compileMountRelativeRoutePattern(route.routePath);
  const dependencies = route.dependencies.flatMap((dependency) =>
    resolveReadConsistencyDependency(contextName, dependency, projectionGroups),
  );

  return {
    contextName,
    mountPath,
    routePath: normalizeRoutePath(route.routePath),
    methods,
    routePattern,
    dependencies,
  };
}

function createRouteTuningMatcher(tuning: ReadConsistencyRouteTuning, index: number) {
  const methods = new Set((tuning.methods ?? ["GET", "HEAD"]).map((method) => method.toUpperCase()));
  const routePath = normalizeRoutePath(tuning.routePath);

  return {
    ...tuning,
    routePath,
    index,
    methods,
    routePattern: compileMountRelativeRoutePattern(routePath),
  };
}

export function resolveReadConsistencyDependency(
  contextName: string,
  dependency: ReadConsistencyDependencyDeclaration,
  projectionGroups: readonly ReadConsistencyProjectionGroup[],
): readonly ResolvedReadConsistencyDependency[] {
  const targetContextName = dependency.targetContextName ?? contextName;

  if ("projectionName" in dependency && dependency.projectionName) {
    const group = projectionGroups.find(
      (candidate) =>
        candidate.targetContextName === targetContextName && candidate.projectionName === dependency.projectionName,
    );
    if (!group) {
      throw new Error(
        `Read freshness dependency '${targetContextName}.${dependency.projectionName}' does not match a mounted projection group.`,
      );
    }

    return [{ targetContextName, projectionName: dependency.projectionName }];
  }

  const tableName = dependency.readModelTable;
  if (!tableName) {
    throw new Error("Read freshness dependency must declare projectionName or readModelTable.");
  }
  const owners = projectionGroups.filter(
    (candidate) => candidate.targetContextName === targetContextName && candidate.ownedTables?.includes(tableName),
  );
  if (owners.length === 0) {
    throw new Error(
      `Read freshness dependency table '${targetContextName}.${tableName}' does not match a mounted projection group owned table.`,
    );
  }
  if (owners.length > 1) {
    throw new Error(
      `Read freshness dependency table '${targetContextName}.${tableName}' is owned by multiple mounted projection groups: ${owners
        .map((owner) => owner.projectionName)
        .join(", ")}.`,
    );
  }

  return [{ targetContextName, projectionName: owners[0].projectionName }];
}

function resolveRouteTuningForRequest(
  input: Readonly<{
    method: string;
    mountPath: string;
    path?: string;
    url?: string;
    requestedTargetContextName: string | null;
    matchers: readonly ReturnType<typeof createRouteTuningMatcher>[];
  }>,
): ReadConsistencyRouteTuning | null {
  const relativePath = normalizeRequestRelativePath(input.mountPath, input.path, input.url);
  const matches = input.matchers.filter(
    (matcher) =>
      matcher.methods.has(input.method) &&
      matcher.routePattern.test(relativePath) &&
      (!matcher.targetContextName || matcher.targetContextName === input.requestedTargetContextName),
  );
  if (matches.length === 0) {
    return null;
  }

  const [selected] = [...matches].sort((left, right) => {
    const targetContextScore = Number(Boolean(right.targetContextName)) - Number(Boolean(left.targetContextName));
    if (targetContextScore !== 0) {
      return targetContextScore;
    }

    const routeSpecificityScore = right.routePath.length - left.routePath.length;
    if (routeSpecificityScore !== 0) {
      return routeSpecificityScore;
    }

    return left.index - right.index;
  });

  return {
    mountPath: selected.mountPath,
    routePath: selected.routePath,
    ...(selected.targetContextName ? { targetContextName: selected.targetContextName } : {}),
    ...(selected.timeoutMs ? { timeoutMs: selected.timeoutMs } : {}),
    ...(selected.pollIntervalMs ? { pollIntervalMs: selected.pollIntervalMs } : {}),
    ...(selected.exactDependencyMode ? { exactDependencyMode: selected.exactDependencyMode } : {}),
  };
}

function resolveRouteFreshnessForRequest(
  input: Readonly<{
    method: string;
    mountPath: string;
    path?: string;
    url?: string;
    requestedTargetContextName: string | null;
    matchers: readonly ReturnType<typeof createRouteDependencyMatcher>[];
  }>,
): Readonly<{
  routePaths: readonly string[];
  dependencies: readonly ResolvedReadConsistencyDependency[] | null;
}> {
  const relativePath = normalizeRequestRelativePath(input.mountPath, input.path, input.url);
  const matches = input.matchers.filter(
    (matcher) => matcher.methods.has(input.method) && matcher.routePattern.test(relativePath),
  );
  const targetMatches = input.requestedTargetContextName
    ? matches.filter((matcher) => matcher.contextName === input.requestedTargetContextName)
    : matches;
  const dependencies = normalizeResolvedDependencies(targetMatches.flatMap((matcher) => matcher.dependencies));

  return {
    routePaths: [...new Set(targetMatches.map((matcher) => matcher.routePath))],
    dependencies: dependencies.length > 0 ? dependencies : null,
  };
}

function globalPositionLag(requiredGlobalPosition: string, lastGlobalPosition: string): string {
  const lag = BigInt(requiredGlobalPosition) - BigInt(lastGlobalPosition);
  return lag > 0n ? lag.toString() : "0";
}

function normalizeRequestRelativePath(mountPath: string, path?: string, url?: string): string {
  const requestPath = path ?? (url ? new URL(url).pathname : mountPath);
  const withoutMount = requestPath.startsWith(mountPath) ? requestPath.slice(mountPath.length) : requestPath;
  const normalized = withoutMount.startsWith("/") ? withoutMount : `/${withoutMount}`;
  return normalized === "/" ? "/" : normalized.replace(/\/+$/, "");
}

function compileMountRelativeRoutePattern(routePath: string): RegExp {
  const normalized = normalizeRoutePath(routePath);
  const parts = normalized.split("/").filter(Boolean);
  const source = parts
    .map((part) => {
      if (part === "*") {
        return ".+";
      }
      if (part.startsWith(":")) {
        return "[^/]+";
      }
      return escapeRegex(part);
    })
    .join("/");

  return new RegExp(`^/${source}$`);
}

function normalizeRoutePath(routePath: string): string {
  const trimmed = routePath.trim();
  if (!trimmed || trimmed === "/") {
    return "/";
  }
  const withLeadingSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  return withLeadingSlash.replace(/\/+$/, "");
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function mountApiRouters(
  app: Readonly<{
    route(path: string, router: unknown): unknown;
  }>,
  mounts: readonly ResolvedApiMount[],
): void {
  for (const mount of mounts) {
    app.route(mount.mountPath, mount.router);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
