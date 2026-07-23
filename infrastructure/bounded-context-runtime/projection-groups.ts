import type {
  BcProjectionGroup,
  BcProjectionGroupResetStrategy,
  BcSubscriptionHandlerKind,
} from "@chase-sets/bounded-context-module";
import type { ProjectionRunContext } from "@chase-sets/event-core/projector";
import type { PgQueryable, PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { withProjectionTransaction } from "./projection-transactions";
import { PROJECTION_GROUP_GENERATIONS_TABLE, PROJECTION_GROUP_REVISIONS_TABLE, SQL_IDENTIFIER_RE } from "./schema";
import type {
  ContextSubscriptionRunner,
  ContextSubscriptionStatus,
  MountedContextRuntimeEntry,
  SubscriptionReplayState,
} from "./subscriptions";
import { drainContextProcesses, sortSubscriptionRunners } from "./subscriptions";

// Status-refresh fan-out is nested (groups x each group's subscription runners),
// so this bound squares: at 4 it demanded up to 4 x 4 = 16 concurrent status
// queries against the DOKS staging control pool (DATABASE_POOL_MAX=6),
// starving the readiness SELECT 1 and auth/actor traffic and flapping both API
// replicas to 503 under battery load (#4768). At 2 the single in-flight refresh
// (coalesced at the route) tops out at 2 x 2 = 4 concurrent queries, reserving
// >=2 pooled connections for readiness and auth. This throttles a read-only
// status snapshot, not projection draining (owned by the worker), so backlog
// throughput is unaffected.
const PROJECTION_STATUS_REFRESH_CONCURRENCY = 2;

type ProjectionGroupRevisionRow = Readonly<{
  projection_revision: string | number | bigint;
}>;

export type ContextProjectionGroupStatus = Readonly<{
  projectionName: string;
  handlerKind?: BcSubscriptionHandlerKind;
  projectionRevision: number;
  storedProjectionRevision: number | null;
  revisionStale: boolean;
  recoveryRequired?: boolean;
  targetContextName: string;
  sourceContextNames: readonly string[];
  ownedTables: readonly string[];
  requiredDuringBootstrap: boolean;
  initialized: boolean;
  caughtUp: boolean;
  state: SubscriptionReplayState;
  lastError: string | null;
  outstandingEventCount: string;
  sourceLagEventCount?: string;
  applicableLagEstimate?: string | null;
  blockedStreamCount: number;
  poisonEventCount: number;
  updatedAt: string;
  subscriptions: readonly ContextSubscriptionStatus[];
}>;

export type ProjectionReplayContextSummary = Readonly<{
  contextName: string;
  totalGroups: number;
  requiredGroups: number;
  initializedGroups: number;
  caughtUpGroups: number;
  behindGroups: number;
  staleGroups: number;
  runningGroups: number;
  errorGroups: number;
  outstandingEventCount: string;
  sourceLagEventCount?: string;
  applicableLagEstimate?: string | null;
}>;

export type ProjectionReplaySummary = Readonly<{
  status: "ok" | "degraded";
  totalGroups: number;
  requiredGroups: number;
  initializedGroups: number;
  caughtUpGroups: number;
  behindGroups: number;
  staleGroups: number;
  runningGroups: number;
  errorGroups: number;
  outstandingEventCount: string;
  sourceLagEventCount?: string;
  applicableLagEstimate?: string | null;
  contexts: readonly ProjectionReplayContextSummary[];
}>;

export type ContextProjectionGroup = Readonly<{
  projectionName: string;
  handlerKind?: BcSubscriptionHandlerKind;
  projectionRevision: number;
  targetContextName: string;
  sourceContextNames: readonly string[];
  sourceContextMount?: BcProjectionGroup["sourceContextMount"];
  optionalSourceContextNames: readonly string[];
  ownedTables: readonly string[];
  sideEffectOnly?: boolean;
  resetStrategy?: BcProjectionGroupResetStrategy;
  requiredDuringBootstrap: boolean;
  subscriptionRunners: readonly ContextSubscriptionRunner[];
  targetPool?: PgTransactionalPool;
  reset: (context?: ProjectionRunContext, options?: ProjectionResetOptions) => Promise<void>;
  getStatus: () => ContextProjectionGroupStatus;
  refreshStatus: () => Promise<ContextProjectionGroupStatus>;
  markRevisionSynced: () => Promise<void>;
  startGenerationRebuild?: (context?: ProjectionRunContext) => Promise<void>;
  completeGenerationRebuild?: (context?: ProjectionRunContext) => Promise<void>;
  failGenerationRebuild?: (context?: ProjectionRunContext) => Promise<void>;
}>;

type ProjectionResetOptions = Readonly<{
  db?: PgQueryable;
}>;

function assertSqlIdentifier(identifier: string): string {
  if (!SQL_IDENTIFIER_RE.test(identifier)) {
    throw new Error(`Invalid SQL identifier "${identifier}". Use letters, numbers, and underscores only.`);
  }

  return identifier;
}

function assertProjectionRevision(value: number | undefined): number {
  const revision = value ?? 1;

  if (!Number.isInteger(revision) || revision < 1) {
    throw new Error("projectionRevision must be a positive integer.");
  }

  return revision;
}

async function loadProjectionGroupRevision(
  db: PgTransactionalPool,
  targetContextName: string,
  projectionName: string,
): Promise<number | null> {
  const result = await db.query<ProjectionGroupRevisionRow>(
    `SELECT projection_revision
     FROM ${PROJECTION_GROUP_REVISIONS_TABLE}
     WHERE target_context_name = $1
       AND projection_name = $2`,
    [targetContextName, projectionName],
  );

  const row = result.rows[0];
  if (!row) {
    return null;
  }

  const revision = Number(row.projection_revision);
  return assertProjectionRevision(revision);
}

async function saveProjectionGroupRevision(
  db: PgTransactionalPool,
  targetContextName: string,
  projectionName: string,
  projectionRevision: number,
): Promise<void> {
  await db.query(
    `INSERT INTO ${PROJECTION_GROUP_REVISIONS_TABLE} (
       target_context_name,
       projection_name,
       projection_revision,
       updated_at
     ) VALUES ($1, $2, $3, now())
     ON CONFLICT (target_context_name, projection_name)
     DO UPDATE SET
       projection_revision = EXCLUDED.projection_revision,
       updated_at = EXCLUDED.updated_at`,
    [targetContextName, projectionName, assertProjectionRevision(projectionRevision)],
  );
}

async function startProjectionGroupGenerationRebuild(
  db: PgTransactionalPool,
  group: Pick<ContextProjectionGroup, "targetContextName" | "projectionName">,
  context?: ProjectionRunContext,
): Promise<void> {
  context?.throwIfLeaseLost?.();
  await db.query(
    `INSERT INTO ${PROJECTION_GROUP_GENERATIONS_TABLE} (
       target_context_name,
       projection_name,
       active_generation,
       rebuilding_generation,
       previous_generation,
       previous_generation_retain_until,
       state,
       operation_id,
       started_at,
       cutover_at,
       updated_at
     ) VALUES ($1, $2, 1, 2, NULL, NULL, 'rebuilding', $3, now(), NULL, now())
     ON CONFLICT (target_context_name, projection_name)
     DO UPDATE SET
       rebuilding_generation = ${PROJECTION_GROUP_GENERATIONS_TABLE}.active_generation + 1,
       state = 'rebuilding',
       operation_id = EXCLUDED.operation_id,
       started_at = EXCLUDED.started_at,
       cutover_at = NULL,
       updated_at = EXCLUDED.updated_at`,
    [group.targetContextName, group.projectionName, context?.operationId ?? null],
  );
}

async function completeProjectionGroupGenerationRebuild(
  db: PgTransactionalPool,
  group: Pick<ContextProjectionGroup, "targetContextName" | "projectionName">,
  context?: ProjectionRunContext,
): Promise<void> {
  context?.throwIfLeaseLost?.();
  await db.query(
    `INSERT INTO ${PROJECTION_GROUP_GENERATIONS_TABLE} (
       target_context_name,
       projection_name,
       active_generation,
       rebuilding_generation,
       previous_generation,
       previous_generation_retain_until,
       state,
       operation_id,
       started_at,
       cutover_at,
       updated_at
     ) VALUES ($1, $2, 1, NULL, NULL, NULL, 'active', $3, NULL, now(), now())
     ON CONFLICT (target_context_name, projection_name)
     DO UPDATE SET
       previous_generation = ${PROJECTION_GROUP_GENERATIONS_TABLE}.active_generation,
       previous_generation_retain_until = now() + interval '7 days',
       active_generation = COALESCE(${PROJECTION_GROUP_GENERATIONS_TABLE}.rebuilding_generation, ${PROJECTION_GROUP_GENERATIONS_TABLE}.active_generation),
       rebuilding_generation = NULL,
       state = 'active',
       operation_id = EXCLUDED.operation_id,
       cutover_at = EXCLUDED.cutover_at,
       updated_at = EXCLUDED.updated_at`,
    [group.targetContextName, group.projectionName, context?.operationId ?? null],
  );
}

async function failProjectionGroupGenerationRebuild(
  db: PgTransactionalPool,
  group: Pick<ContextProjectionGroup, "targetContextName" | "projectionName">,
  context?: ProjectionRunContext,
): Promise<void> {
  await db.query(
    `INSERT INTO ${PROJECTION_GROUP_GENERATIONS_TABLE} (
       target_context_name,
       projection_name,
       active_generation,
       rebuilding_generation,
       previous_generation,
       previous_generation_retain_until,
       state,
       operation_id,
       started_at,
       cutover_at,
       updated_at
     ) VALUES ($1, $2, 1, NULL, NULL, NULL, 'failed', $3, now(), NULL, now())
     ON CONFLICT (target_context_name, projection_name)
     DO UPDATE SET
       rebuilding_generation = NULL,
       state = 'failed',
       operation_id = EXCLUDED.operation_id,
       updated_at = EXCLUDED.updated_at`,
    [group.targetContextName, group.projectionName, context?.operationId ?? null],
  );
}

async function cleanupExpiredProjectionGroupGenerationRetention(db: PgTransactionalPool): Promise<number> {
  const result = await db.query(
    `UPDATE ${PROJECTION_GROUP_GENERATIONS_TABLE}
     SET previous_generation = NULL,
         previous_generation_retain_until = NULL,
         updated_at = now()
     WHERE previous_generation_retain_until IS NOT NULL
       AND previous_generation_retain_until <= now()`,
  );

  return result.rowCount ?? 0;
}

function sumDecimalCounts(counts: readonly string[]): string {
  return counts.reduce((total, count) => total + BigInt(count), 0n).toString();
}

function resetContextWithoutStatementTimeout(context?: ProjectionRunContext): ProjectionRunContext | undefined {
  if (!context || context.statementTimeoutMs === undefined) {
    return context;
  }

  const { statementTimeoutMs, ...resetContext } = context;
  void statementTimeoutMs;
  return resetContext;
}

function createDefaultProjectionGroupReset(
  pool: PgTransactionalPool,
  ownedTables: readonly string[],
  resetStrategy: BcProjectionGroupResetStrategy | undefined,
  targetContextName: string,
  projectionName: string,
): (context?: ProjectionRunContext, options?: ProjectionResetOptions) => Promise<void> {
  for (const tableName of ownedTables) {
    assertSqlIdentifier(tableName);
  }

  if (ownedTables.length > 0 && !resetStrategy) {
    throw new Error(
      `Projection group '${targetContextName}.${projectionName}' owns read-model tables but does not declare resetStrategy.`,
    );
  }

  if (resetStrategy === "generation-cutover") {
    throw new Error(
      `Projection group '${targetContextName}.${projectionName}' declares generation-cutover, but no generation cutover adapter is configured yet.`,
    );
  }

  if (resetStrategy === "truncate-owned-tables") {
    return async (context, options) => {
      context?.throwIfLeaseLost?.();
      const truncateOwnedTables = async (db: PgQueryable) => {
        for (const tableName of ownedTables) {
          context?.throwIfLeaseLost?.();
          await db.query(`TRUNCATE TABLE ${assertSqlIdentifier(tableName)}`);
        }
      };
      if (options?.db) {
        await truncateOwnedTables(options.db);
        return;
      }
      await withProjectionTransaction(pool, context, truncateOwnedTables);
    };
  }

  return async (context) => {
    context?.throwIfLeaseLost?.();
  };
}

function sortProjectionGroups(groups: readonly ContextProjectionGroup[]): readonly ContextProjectionGroup[] {
  return [...groups].sort((left, right) => {
    const leftOrder = Math.min(...left.subscriptionRunners.map((runner) => runner.order), Number.MAX_SAFE_INTEGER);
    const rightOrder = Math.min(...right.subscriptionRunners.map((runner) => runner.order), Number.MAX_SAFE_INTEGER);

    if (leftOrder !== rightOrder) {
      return leftOrder - rightOrder;
    }

    if (left.targetContextName !== right.targetContextName) {
      return left.targetContextName.localeCompare(right.targetContextName);
    }

    return left.projectionName.localeCompare(right.projectionName);
  });
}

function resolveContextProjectionGroups(entry: MountedContextRuntimeEntry): readonly ContextProjectionGroup[] {
  const declaredGroups: readonly BcProjectionGroup[] =
    entry.module.buildProjectionGroups?.(entry.services) ??
    (entry.module.projectionGroups ?? []).map((group) => ({ ...group }));
  const declaredProjectionNames = new Set(declaredGroups.map((group) => group.projectionName));
  const localGroups: readonly BcProjectionGroup[] = (entry.projectionHandlerSets ?? [])
    .filter((projection) => !declaredProjectionNames.has(projection.projectionName))
    .map((projection) => ({
      projectionName: projection.projectionName,
      projectionRevision: 1,
      sourceContextNames: [entry.contextName],
      ownedTables: [],
      requiredDuringBootstrap: false,
    }));
  const runtimeGroups = [...declaredGroups, ...localGroups];

  const seenProjectionNames = new Set<string>();

  return runtimeGroups.map((group) => {
    if (seenProjectionNames.has(group.projectionName)) {
      throw new Error(`Context '${entry.contextName}' declared duplicate projection group '${group.projectionName}'.`);
    }
    seenProjectionNames.add(group.projectionName);

    const sourceContextNames = [...new Set(group.sourceContextNames)];
    const optionalSourceContextNames = [...new Set(group.optionalSourceContextNames ?? [])];
    const ownedTables = [...new Set(group.ownedTables)];
    const handlerKind = group.handlerKind ?? "projection";
    const projectionRevision = assertProjectionRevision(group.projectionRevision);
    if (group.sideEffectOnly && ownedTables.length > 0) {
      throw new Error(
        `Context '${entry.contextName}' projection group '${group.projectionName}' is side-effect-only and cannot own read-model tables: ${ownedTables.join(", ")}.`,
      );
    }
    const revisionState: {
      storedProjectionRevision: number | null;
      updatedAt: string;
    } = {
      storedProjectionRevision: null,
      updatedAt: new Date(0).toISOString(),
    };
    const revisionStale = () =>
      revisionState.storedProjectionRevision !== null && revisionState.storedProjectionRevision !== projectionRevision;
    const customReset = group.reset;

    return {
      projectionName: group.projectionName,
      handlerKind,
      projectionRevision,
      targetContextName: entry.contextName,
      sourceContextNames,
      sourceContextMount: group.sourceContextMount,
      optionalSourceContextNames,
      ownedTables,
      sideEffectOnly: group.sideEffectOnly ?? false,
      resetStrategy: group.resetStrategy,
      requiredDuringBootstrap: group.requiredDuringBootstrap ?? false,
      subscriptionRunners: [],
      targetPool: entry.pool,
      reset: customReset
        ? async (context, options) => {
            if (!options?.db) {
              throw new Error(
                `Projection group '${entry.contextName}.${group.projectionName}' requires the runtime-supplied transaction database.`,
              );
            }
            await customReset.execute(options.db, context);
          }
        : createDefaultProjectionGroupReset(
            entry.pool,
            ownedTables,
            group.resetStrategy,
            entry.contextName,
            group.projectionName,
          ),
      getStatus: () => ({
        projectionName: group.projectionName,
        handlerKind,
        projectionRevision,
        storedProjectionRevision: revisionState.storedProjectionRevision,
        revisionStale: revisionStale(),
        recoveryRequired: false,
        targetContextName: entry.contextName,
        sourceContextNames,
        ownedTables,
        requiredDuringBootstrap: group.requiredDuringBootstrap ?? false,
        initialized: sourceContextNames.length === 0,
        caughtUp: sourceContextNames.length === 0,
        state: "caught-up",
        lastError: null,
        outstandingEventCount: "0",
        blockedStreamCount: 0,
        poisonEventCount: 0,
        updatedAt: revisionState.updatedAt,
        subscriptions: [],
      }),
      refreshStatus: async () => {
        revisionState.storedProjectionRevision = await loadProjectionGroupRevision(
          entry.pool,
          entry.contextName,
          group.projectionName,
        );
        revisionState.updatedAt = new Date().toISOString();
        return {
          projectionName: group.projectionName,
          handlerKind,
          projectionRevision,
          storedProjectionRevision: revisionState.storedProjectionRevision,
          revisionStale: revisionStale(),
          recoveryRequired: false,
          targetContextName: entry.contextName,
          sourceContextNames,
          ownedTables,
          requiredDuringBootstrap: group.requiredDuringBootstrap ?? false,
          initialized: sourceContextNames.length === 0,
          caughtUp: sourceContextNames.length === 0,
          state: "caught-up",
          lastError: null,
          outstandingEventCount: "0",
          blockedStreamCount: 0,
          poisonEventCount: 0,
          updatedAt: revisionState.updatedAt,
          subscriptions: [],
        };
      },
      startGenerationRebuild: (context) =>
        startProjectionGroupGenerationRebuild(
          entry.pool,
          { targetContextName: entry.contextName, projectionName: group.projectionName },
          context,
        ),
      completeGenerationRebuild: (context) =>
        completeProjectionGroupGenerationRebuild(
          entry.pool,
          { targetContextName: entry.contextName, projectionName: group.projectionName },
          context,
        ),
      failGenerationRebuild: (context) =>
        failProjectionGroupGenerationRebuild(
          entry.pool,
          { targetContextName: entry.contextName, projectionName: group.projectionName },
          context,
        ),
      markRevisionSynced: async () => {
        await saveProjectionGroupRevision(entry.pool, entry.contextName, group.projectionName, projectionRevision);
        revisionState.storedProjectionRevision = projectionRevision;
        revisionState.updatedAt = new Date().toISOString();
      },
    };
  });
}

export function resolveModuleProjectionGroups(
  mountedContexts: readonly MountedContextRuntimeEntry[],
  subscriptionRunners: readonly ContextSubscriptionRunner[],
): readonly ContextProjectionGroup[] {
  const groups: ContextProjectionGroup[] = [];
  const consumedCheckpointKeys = new Set<string>();
  const ownedTableOwners = new Map<string, string>();
  const mountedContextNames = new Set(mountedContexts.map((entry) => entry.contextName));

  for (const entry of mountedContexts) {
    if (entry.mountRole === "source-only") {
      continue;
    }

    const contextGroups = resolveContextProjectionGroups(entry);

    for (const group of contextGroups) {
      if (group.sourceContextNames.length === 0) {
        throw new Error(
          `Context '${entry.contextName}' projection group '${group.projectionName}' must declare at least one source context.`,
        );
      }

      const optionalSourceContextNames = new Set(group.optionalSourceContextNames);
      const groupRunners = sortSubscriptionRunners(
        subscriptionRunners.filter(
          (runner) => runner.targetContextName === entry.contextName && runner.projectionName === group.projectionName,
        ),
      );
      if (
        group.sourceContextMount === "when-all-sources-mounted" &&
        !group.sourceContextNames.every((sourceContextName) => mountedContextNames.has(sourceContextName))
      ) {
        continue;
      }

      if (groupRunners.length === 0) {
        const onlyUnmountedOptionalSources = group.sourceContextNames.every(
          (sourceContextName) =>
            optionalSourceContextNames.has(sourceContextName) && !mountedContextNames.has(sourceContextName),
        );
        if (onlyUnmountedOptionalSources) {
          continue;
        }
      }

      for (const tableName of group.ownedTables) {
        const ownershipKey = `${entry.contextName}.${tableName}`;
        const existingOwner = ownedTableOwners.get(ownershipKey);
        if (existingOwner && existingOwner !== group.projectionName) {
          throw new Error(
            `Context '${entry.contextName}' table '${tableName}' is owned by both projection groups '${existingOwner}' and '${group.projectionName}'. Each read-model table must have one projection group owner.`,
          );
        }
        ownedTableOwners.set(ownershipKey, group.projectionName);
      }

      const groupHandlerKind = group.handlerKind ?? "projection";
      const unexpectedHandlerKinds = [
        ...new Set(
          groupRunners.map((runner) => runner.handlerKind ?? "projection").filter((kind) => kind !== groupHandlerKind),
        ),
      ];
      const actualSources = [...new Set(groupRunners.map((runner) => runner.sourceContextName))];

      validateInlineApplyEligibility(entry.contextName, group, groupRunners);

      if (groupRunners.length === 0) {
        throw new Error(
          `Context '${entry.contextName}' projection group '${group.projectionName}' does not have any matching subscriptions.`,
        );
      }

      if (unexpectedHandlerKinds.length > 0) {
        throw new Error(
          `Context '${entry.contextName}' ${groupHandlerKind} group '${group.projectionName}' has mismatched subscription handler kind(s): ${unexpectedHandlerKinds.join(", ")}.`,
        );
      }

      const missingSources = group.sourceContextNames.filter(
        (sourceContextName) => !actualSources.includes(sourceContextName),
      );
      const unexpectedMissingSources = missingSources.filter(
        (sourceContextName) =>
          !optionalSourceContextNames.has(sourceContextName) || mountedContextNames.has(sourceContextName),
      );
      const unexpectedSources = actualSources.filter(
        (sourceContextName) => !group.sourceContextNames.includes(sourceContextName),
      );

      if (unexpectedMissingSources.length > 0 || unexpectedSources.length > 0) {
        throw new Error(
          `Context '${entry.contextName}' projection group '${group.projectionName}' sources do not match subscriptions. Missing: [${unexpectedMissingSources.join(", ")}]. Unexpected: [${unexpectedSources.join(", ")}].`,
        );
      }

      for (const runner of groupRunners) {
        consumedCheckpointKeys.add(runner.checkpointKey);
      }

      groups.push({
        ...group,
        subscriptionRunners: groupRunners,
        getStatus: () => {
          const baseStatus = group.getStatus();
          const subscriptions = groupRunners.map((runner) => runner.getStatus());
          const initialized =
            subscriptions.length > 0 && subscriptions.every((subscription) => subscription.initialized);
          const caughtUp =
            subscriptions.length > 0 &&
            subscriptions.every(
              (subscription) =>
                subscription.lastGlobalPosition === subscription.sourceHeadGlobalPosition &&
                subscription.blockedStreamCount === 0,
            );
          const recoveryRequired = subscriptions.some((subscription) => subscription.recoveryRequired);
          const blockedStreamCount = subscriptions.reduce(
            (total, subscription) => total + subscription.blockedStreamCount,
            0,
          );
          const poisonEventCount = subscriptions.reduce(
            (total, subscription) => total + subscription.poisonEventCount,
            0,
          );
          const outstandingEventCount = sumDecimalCounts(
            subscriptions.map((subscription) => subscription.outstandingEventCount),
          );
          const applicableLagEstimate = subscriptions.every(
            (subscription) => subscription.applicableLagEstimate !== null,
          )
            ? sumDecimalCounts(subscriptions.map((subscription) => subscription.applicableLagEstimate ?? "0"))
            : null;
          const state: SubscriptionReplayState = subscriptions.some((subscription) => subscription.state === "error")
            ? "error"
            : subscriptions.some((subscription) => subscription.state === "running")
              ? "running"
              : blockedStreamCount > 0 || subscriptions.some((subscription) => subscription.state === "degraded")
                ? "degraded"
                : caughtUp
                  ? "caught-up"
                  : "behind";
          const updatedAt = subscriptions.reduce(
            (latest, subscription) => (latest > subscription.updatedAt ? latest : subscription.updatedAt),
            new Date(0).toISOString(),
          );
          const lastError = subscriptions.find((subscription) => subscription.lastError)?.lastError ?? null;

          return {
            projectionName: group.projectionName,
            handlerKind: group.handlerKind ?? "projection",
            projectionRevision: group.projectionRevision,
            storedProjectionRevision: baseStatus.storedProjectionRevision,
            revisionStale: baseStatus.revisionStale,
            recoveryRequired,
            targetContextName: entry.contextName,
            sourceContextNames: group.sourceContextNames,
            ownedTables: group.ownedTables,
            requiredDuringBootstrap: group.requiredDuringBootstrap,
            initialized,
            caughtUp,
            state,
            lastError,
            outstandingEventCount,
            sourceLagEventCount: outstandingEventCount,
            applicableLagEstimate,
            blockedStreamCount,
            poisonEventCount,
            updatedAt: updatedAt > baseStatus.updatedAt ? updatedAt : baseStatus.updatedAt,
            subscriptions,
          };
        },
      });
    }
  }

  for (const runner of subscriptionRunners) {
    if (consumedCheckpointKeys.has(runner.checkpointKey)) {
      continue;
    }

    throw new Error(
      `Subscription '${runner.subscriptionName}' for context '${runner.targetContextName}' is missing a declared projection group for '${runner.projectionName}'.`,
    );
  }

  return sortProjectionGroups(groups);
}

function validateInlineApplyEligibility(
  targetContextName: string,
  group: Pick<BcProjectionGroup, "projectionName" | "handlerKind" | "sourceContextNames" | "sideEffectOnly">,
  runners: readonly ContextSubscriptionRunner[],
): void {
  const inlineRunners = runners.filter((runner) => runner.inlineApply === true);
  if (inlineRunners.length === 0) {
    return;
  }

  const errorPrefix = `Context '${targetContextName}' projection group '${group.projectionName}' cannot enable inlineApply`;
  if ((group.handlerKind ?? "projection") === "reaction") {
    throw new Error(`${errorPrefix} because reaction handlers are never eligible for write-path projection apply.`);
  }
  if (group.sideEffectOnly) {
    throw new Error(
      `${errorPrefix} because side-effect-only handlers are never eligible for write-path projection apply.`,
    );
  }
  // Inline Apply only enforces same-stream predecessors. Global-strict order
  // needs a global predecessor barrier and must remain on the async runner.
  if (inlineRunners.some((runner) => runner.errorPolicy === "global-strict")) {
    throw new Error(`${errorPrefix} because global-strict projections require total global order.`);
  }
  if (
    group.sourceContextNames.length !== 1 ||
    group.sourceContextNames[0] !== targetContextName ||
    runners.length !== 1 ||
    inlineRunners[0]?.sourceContextName !== targetContextName
  ) {
    throw new Error(`${errorPrefix} unless it is a single-source, same-context projection.`);
  }
  if (
    inlineRunners.some((runner) => runner.checkpointBatchSize === 1 || runner.projectionCascadeChunkSize !== undefined)
  ) {
    throw new Error(`${errorPrefix} because cascade-capable projections must remain on the asynchronous runner.`);
  }
}

export async function syncProjectionGroup(
  group: ContextProjectionGroup,
  context?: ProjectionRunContext,
): Promise<void> {
  await group.refreshStatus();
  await mapWithConcurrency(
    sortSubscriptionRunners(group.subscriptionRunners),
    PROJECTION_STATUS_REFRESH_CONCURRENCY,
    (runner) => runner.refreshStatus(),
  );
  const status = group.getStatus();

  if (status.revisionStale || status.recoveryRequired) {
    await rebuildProjectionGroup(group, context);
    return;
  }

  await drainContextProcesses({ subscriptionRunners: group.subscriptionRunners }, context);
  context?.throwIfLeaseLost?.();
  await group.markRevisionSynced();
}

export async function resetProjectionGroup(
  group: ContextProjectionGroup,
  context?: ProjectionRunContext,
): Promise<void> {
  context?.throwIfLeaseLost?.();
  const resetContext = resetContextWithoutStatementTimeout(context);
  const reset = async (db?: PgQueryable) => {
    await group.reset(resetContext, { db });

    for (const runner of sortSubscriptionRunners(group.subscriptionRunners)) {
      resetContext?.throwIfLeaseLost?.();
      await runner.reset(resetContext, { db });
    }
  };

  if (group.targetPool) {
    await withProjectionTransaction(group.targetPool, resetContext, reset);
    return;
  }

  await reset();
}

export async function rebuildProjectionGroup(
  group: ContextProjectionGroup,
  context?: ProjectionRunContext,
): Promise<void> {
  const useGenerationRebuild = group.resetStrategy === "generation-cutover";

  try {
    if (useGenerationRebuild) {
      await group.startGenerationRebuild?.(context);
    }

    await resetProjectionGroup(group, context);
    await drainContextProcesses({ subscriptionRunners: group.subscriptionRunners }, context);
    context?.throwIfLeaseLost?.();

    if (useGenerationRebuild) {
      await group.completeGenerationRebuild?.(context);
    }

    await group.markRevisionSynced();
  } catch (error) {
    if (useGenerationRebuild) {
      await group.failGenerationRebuild?.(context);
    }
    throw error;
  }
}

export async function syncContextProjectionGroups(
  runtime: Readonly<{
    mountedContexts: readonly MountedContextRuntimeEntry[];
    projectionGroups: readonly ContextProjectionGroup[];
  }>,
  contextName: string,
  options: Readonly<{
    requiredOnly?: boolean;
  }> = {},
): Promise<void> {
  const targetContext = runtime.mountedContexts.find((entry) => entry.contextName === contextName);
  if (!targetContext) {
    throw new Error(`Runtime is missing mounted context '${contextName}'.`);
  }

  const groups = sortProjectionGroups(
    runtime.projectionGroups.filter(
      (group) => group.targetContextName === contextName && (!options.requiredOnly || group.requiredDuringBootstrap),
    ),
  );

  if (groups.length === 0) {
    await drainContextProcesses({
      subscriptionRunners: runtime.projectionGroups
        .filter((group) => group.targetContextName === contextName)
        .flatMap((group) => group.subscriptionRunners),
    });
    return;
  }

  for (const group of groups) {
    await syncProjectionGroup(group);
  }
}

export function getProjectionGroup(
  runtime: Readonly<{
    projectionGroups: readonly ContextProjectionGroup[];
  }>,
  contextName: string,
  projectionName: string,
): ContextProjectionGroup {
  const group = runtime.projectionGroups.find(
    (candidate) => candidate.targetContextName === contextName && candidate.projectionName === projectionName,
  );

  if (!group) {
    throw new Error(`Runtime is missing projection group '${projectionName}' for context '${contextName}'.`);
  }

  return group;
}

export async function rebuildContextProjectionGroup(
  runtime: Readonly<{
    projectionGroups: readonly ContextProjectionGroup[];
  }>,
  contextName: string,
  projectionName: string,
  context?: ProjectionRunContext,
): Promise<void> {
  await rebuildProjectionGroup(getProjectionGroup(runtime, contextName, projectionName), context);
}

export function listProjectionGroupStatuses(
  runtime: Readonly<{
    projectionGroups: readonly ContextProjectionGroup[];
  }>,
  options: Readonly<{
    contextName?: string;
    requiredOnly?: boolean;
  }> = {},
): readonly ContextProjectionGroupStatus[] {
  return sortProjectionGroups(
    runtime.projectionGroups.filter(
      (group) =>
        (!options.contextName || group.targetContextName === options.contextName) &&
        (!options.requiredOnly || group.requiredDuringBootstrap),
    ),
  ).map((group) => group.getStatus());
}

export async function refreshProjectionGroupStatuses(
  runtime: Readonly<{
    projectionGroups: readonly ContextProjectionGroup[];
  }>,
  options: Readonly<{
    contextName?: string;
    requiredOnly?: boolean;
  }> = {},
): Promise<readonly ContextProjectionGroupStatus[]> {
  const groups = sortProjectionGroups(
    runtime.projectionGroups.filter(
      (group) =>
        (!options.contextName || group.targetContextName === options.contextName) &&
        (!options.requiredOnly || group.requiredDuringBootstrap),
    ),
  );

  await mapWithConcurrency(groups, PROJECTION_STATUS_REFRESH_CONCURRENCY, async (group) => {
    await group.refreshStatus();

    await mapWithConcurrency(
      sortSubscriptionRunners(group.subscriptionRunners),
      PROJECTION_STATUS_REFRESH_CONCURRENCY,
      (runner) => runner.refreshStatus(),
    );
  });

  return groups.map((group) => group.getStatus());
}

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  mapper: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      results[currentIndex] = await mapper(items[currentIndex] as T);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));

  return results;
}

export function summarizeProjectionReplayStatuses(
  statuses: readonly ContextProjectionGroupStatus[],
): ProjectionReplaySummary {
  const contexts = [...new Set(statuses.map((status) => status.targetContextName))]
    .sort((left, right) => left.localeCompare(right))
    .map((contextName) => {
      const contextStatuses = statuses.filter((status) => status.targetContextName === contextName);

      return {
        contextName,
        totalGroups: contextStatuses.length,
        requiredGroups: contextStatuses.filter((status) => status.requiredDuringBootstrap).length,
        initializedGroups: contextStatuses.filter((status) => status.initialized).length,
        caughtUpGroups: contextStatuses.filter((status) => status.caughtUp).length,
        behindGroups: contextStatuses.filter((status) => !status.caughtUp).length,
        staleGroups: contextStatuses.filter((status) => status.revisionStale).length,
        runningGroups: contextStatuses.filter((status) => status.state === "running").length,
        errorGroups: contextStatuses.filter((status) => status.state === "error").length,
        outstandingEventCount: sumDecimalCounts(contextStatuses.map((status) => status.outstandingEventCount)),
      } satisfies ProjectionReplayContextSummary;
    });

  const totalGroups = statuses.length;
  const requiredGroups = statuses.filter((status) => status.requiredDuringBootstrap).length;
  const initializedGroups = statuses.filter((status) => status.initialized).length;
  const caughtUpGroups = statuses.filter((status) => status.caughtUp).length;
  const behindGroups = statuses.filter((status) => !status.caughtUp).length;
  const staleGroups = statuses.filter((status) => status.revisionStale).length;
  const runningGroups = statuses.filter((status) => status.state === "running").length;
  const errorGroups = statuses.filter((status) => status.state === "error").length;
  const outstandingEventCount = sumDecimalCounts(statuses.map((status) => status.outstandingEventCount));
  const requiredStatuses = statuses.filter((status) => status.requiredDuringBootstrap);
  const status = requiredStatuses.some((entry) => !entry.caughtUp || entry.revisionStale || entry.state === "error")
    ? "degraded"
    : "ok";

  return {
    status,
    totalGroups,
    requiredGroups,
    initializedGroups,
    caughtUpGroups,
    behindGroups,
    staleGroups,
    runningGroups,
    errorGroups,
    outstandingEventCount,
    contexts,
  };
}

export function getProjectionReplaySummary(
  runtime: Readonly<{
    projectionGroups: readonly ContextProjectionGroup[];
  }>,
  options: Readonly<{
    contextName?: string;
    requiredOnly?: boolean;
  }> = {},
): ProjectionReplaySummary {
  return summarizeProjectionReplayStatuses(listProjectionGroupStatuses(runtime, options));
}

export async function refreshProjectionReplaySummary(
  runtime: Readonly<{
    projectionGroups: readonly ContextProjectionGroup[];
  }>,
  options: Readonly<{
    contextName?: string;
    requiredOnly?: boolean;
  }> = {},
): Promise<ProjectionReplaySummary> {
  return summarizeProjectionReplayStatuses(await refreshProjectionGroupStatuses(runtime, options));
}

export async function rebuildAllContextProjectionGroups(
  runtime: Readonly<{
    projectionGroups: readonly ContextProjectionGroup[];
  }>,
  contextName: string,
  options: Readonly<{
    requiredOnly?: boolean;
  }> = {},
  context?: ProjectionRunContext,
): Promise<void> {
  const groups = sortProjectionGroups(
    runtime.projectionGroups.filter(
      (group) => group.targetContextName === contextName && (!options.requiredOnly || group.requiredDuringBootstrap),
    ),
  );

  if (groups.length === 0) {
    throw new Error(`Runtime is missing projection groups for context '${contextName}'.`);
  }

  for (const group of groups) {
    context?.throwIfLeaseLost?.();
    await rebuildProjectionGroup(group, context);
  }
}

export async function cleanupRuntimeProjectionGenerations(
  runtime: Readonly<{
    mountedContexts: readonly MountedContextRuntimeEntry[];
    projectionGroups?: readonly Pick<ContextProjectionGroup, "targetContextName">[];
  }>,
): Promise<number> {
  const targetPools = runtime.projectionGroups
    ? uniqueProjectionGroupTargetPools(runtime.mountedContexts, runtime.projectionGroups)
    : uniqueMountedContextPools(runtime.mountedContexts);
  let cleaned = 0;

  for (const pool of targetPools) {
    cleaned += await cleanupExpiredProjectionGroupGenerationRetention(pool);
  }

  return cleaned;
}

function uniqueMountedContextPools(
  mountedContexts: readonly Pick<MountedContextRuntimeEntry, "pool">[],
): readonly PgTransactionalPool[] {
  return [...new Set(mountedContexts.map((entry) => entry.pool))];
}

function uniqueProjectionGroupTargetPools(
  mountedContexts: readonly Pick<MountedContextRuntimeEntry, "contextName" | "pool">[],
  projectionGroups: readonly Pick<ContextProjectionGroup, "targetContextName">[],
): readonly PgTransactionalPool[] {
  const poolsByContextName = new Map(mountedContexts.map((entry) => [entry.contextName, entry.pool]));
  return [
    ...new Set(
      projectionGroups
        .map((group) => poolsByContextName.get(group.targetContextName))
        .filter((pool): pool is PgTransactionalPool => Boolean(pool)),
    ),
  ];
}
