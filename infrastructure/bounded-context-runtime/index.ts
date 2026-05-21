import type {
  BcApiModule,
  BcApiMount,
  BcEventSubscription,
  BcSeedOptions,
  EnvironmentDataProfile,
  BcProjectionGroup,
  BcProjector,
} from "@chase-sets/bounded-context-module";
import type {
  ProjectorRunResult,
} from "@chase-sets/event-core/projector";
import {
  getEventCommitMetadata,
  runWithEventCommitMetadata,
  ZERO_GLOBAL_POSITION,
  toTransportEvent,
} from "@chase-sets/event-core";
import {
  parseGlobalPosition,
  type GlobalPosition,
} from "@chase-sets/event-core/storage";
import {
  createPostgresEventStore,
  eventCorePostgresSchemaSql,
  type PgTransactionalPool,
} from "@chase-sets/event-core-postgres";

const RETRY_DELAY_MS = 1_000;
const MAX_RETRIES = 30;
const SUBSCRIPTION_CHECKPOINTS_TABLE = "event_subscription_checkpoints";
const PROJECTION_GROUP_REVISIONS_TABLE = "event_projection_group_revisions";
const SQL_IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export const allEnvironmentDataProfiles: readonly EnvironmentDataProfile[] = [
  "critical-bootstrap",
  "catalog-integration-bootstrap",
  "scenario-seed",
];

export const defaultSeedOptions: BcSeedOptions = {
  enabledDataProfiles: allEnvironmentDataProfiles,
  environmentName: null,
};

export function seedProfileEnabled(
  options: BcSeedOptions | undefined,
  profile: EnvironmentDataProfile,
): boolean {
  return (options ?? defaultSeedOptions).enabledDataProfiles.includes(profile);
}

export function seedProfilesOverlap(
  moduleProfiles: readonly EnvironmentDataProfile[] | undefined,
  options: BcSeedOptions | undefined,
): boolean {
  const profiles = moduleProfiles ?? ["scenario-seed"];
  const enabledProfiles = (options ?? defaultSeedOptions).enabledDataProfiles;

  return profiles.some((profile) => enabledProfiles.includes(profile));
}

export const eventSubscriptionSchemaSql = `CREATE TABLE IF NOT EXISTS ${SUBSCRIPTION_CHECKPOINTS_TABLE} (
  checkpoint_key text PRIMARY KEY,
  projection_name text NOT NULL,
  source_context_name text NOT NULL,
  subscription_version integer NOT NULL CHECK (subscription_version >= 1),
  last_global_position bigint NOT NULL CHECK (last_global_position >= 0),
  updated_at timestamptz NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS ${SUBSCRIPTION_CHECKPOINTS_TABLE}_projection_source_version_idx
  ON ${SUBSCRIPTION_CHECKPOINTS_TABLE} (projection_name, source_context_name, subscription_version);

CREATE TABLE IF NOT EXISTS ${PROJECTION_GROUP_REVISIONS_TABLE} (
  target_context_name text NOT NULL,
  projection_name text NOT NULL,
  projection_revision integer NOT NULL CHECK (projection_revision >= 1),
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (target_context_name, projection_name)
);`;

export type SubscriptionReplayState = "idle" | "running" | "caught-up" | "error";

export type ContextSubscriptionStatus = Readonly<{
  checkpointKey: string;
  subscriptionName: string;
  projectionName: string;
  sourceContextName: string;
  targetContextName: string;
  subscriptionVersion: number;
  initialized: boolean;
  lastGlobalPosition: GlobalPosition;
  sourceHeadGlobalPosition: GlobalPosition;
  processedEvents: number;
  state: SubscriptionReplayState;
  lastError: string | null;
  updatedAt: string;
}>;

export type ContextProjectionGroupStatus = Readonly<{
  projectionName: string;
  projectionRevision: number;
  storedProjectionRevision: number | null;
  revisionStale: boolean;
  targetContextName: string;
  sourceContextNames: readonly string[];
  ownedTables: readonly string[];
  requiredDuringBootstrap: boolean;
  initialized: boolean;
  caughtUp: boolean;
  state: SubscriptionReplayState;
  lastError: string | null;
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
  contexts: readonly ProjectionReplayContextSummary[];
}>;

type SubscriptionCheckpointRow = Readonly<{
  last_global_position: string | number | bigint;
}>;

type ProjectionGroupRevisionRow = Readonly<{
  projection_revision: string | number | bigint;
}>;

function assertSqlIdentifier(identifier: string): string {
  if (!SQL_IDENTIFIER_RE.test(identifier)) {
    throw new Error(
      `Invalid SQL identifier "${identifier}". Use letters, numbers, and underscores only.`,
    );
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

function createCheckpointKey(
  subscription: Pick<
    BcEventSubscription,
    "projectionName" | "sourceContextName" | "subscriptionVersion"
  >,
): string {
  return [
    subscription.projectionName,
    subscription.sourceContextName,
    `v${subscription.subscriptionVersion}`,
  ].join(":");
}

async function loadSubscriptionCheckpoint(
  db: PgTransactionalPool,
  checkpointKey: string,
): Promise<GlobalPosition | null> {
  const result = await db.query<SubscriptionCheckpointRow>(
    `SELECT last_global_position
     FROM ${SUBSCRIPTION_CHECKPOINTS_TABLE}
     WHERE checkpoint_key = $1`,
    [checkpointKey],
  );

  const row = result.rows[0];
  return row ? parseGlobalPosition(String(row.last_global_position)) : null;
}

async function saveSubscriptionCheckpoint(
  db: PgTransactionalPool,
  subscription: Pick<
    BcEventSubscription,
    "projectionName" | "sourceContextName" | "subscriptionVersion"
  >,
  lastGlobalPosition: GlobalPosition,
): Promise<void> {
  await db.query(
    `INSERT INTO ${SUBSCRIPTION_CHECKPOINTS_TABLE} (
       checkpoint_key,
       projection_name,
       source_context_name,
       subscription_version,
       last_global_position,
       updated_at
     ) VALUES ($1, $2, $3, $4, $5::bigint, now())
     ON CONFLICT (checkpoint_key)
     DO UPDATE SET
       last_global_position = GREATEST(
         ${SUBSCRIPTION_CHECKPOINTS_TABLE}.last_global_position,
         EXCLUDED.last_global_position
       ),
       updated_at = EXCLUDED.updated_at`,
    [
      createCheckpointKey(subscription),
      subscription.projectionName,
      subscription.sourceContextName,
      subscription.subscriptionVersion,
      lastGlobalPosition,
    ],
  );
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
    [
      targetContextName,
      projectionName,
      assertProjectionRevision(projectionRevision),
    ],
  );
}

async function deleteSubscriptionCheckpoint(
  db: PgTransactionalPool,
  checkpointKey: string,
): Promise<void> {
  await db.query(
    `DELETE FROM ${SUBSCRIPTION_CHECKPOINTS_TABLE}
     WHERE checkpoint_key = $1`,
    [checkpointKey],
  );
}

async function readSourceHeadGlobalPosition(
  pool: PgTransactionalPool,
): Promise<GlobalPosition> {
  const result = await pool.query<Readonly<{ head: string | number | bigint | null }>>(
    "SELECT COALESCE(MAX(global_position), 0) AS head FROM event_store_events",
  );

  return parseGlobalPosition(String(result.rows[0]?.head ?? ZERO_GLOBAL_POSITION));
}

function createDefaultProjectionGroupReset(
  pool: PgTransactionalPool,
  ownedTables: readonly string[],
): () => Promise<void> {
  const normalizedTables = [...new Set(ownedTables.map(assertSqlIdentifier))];

  if (normalizedTables.length === 0) {
    return async () => undefined;
  }

  return async () => {
    await pool.query(`TRUNCATE TABLE ${normalizedTables.join(", ")} RESTART IDENTITY CASCADE`);
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitForDatabase(
  pool: { query: (sql: string) => Promise<unknown> },
  label = "Database",
): Promise<void> {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt += 1) {
    try {
      await pool.query("SELECT 1");
      return;
    } catch (error) {
      if (attempt === MAX_RETRIES) {
        throw new Error(
          `${label} did not become ready after ${MAX_RETRIES} attempts.`,
          { cause: error },
        );
      }

      await sleep(RETRY_DELAY_MS);
    }
  }
}

export async function drainProjectors(
  projectors: readonly BcProjector[],
): Promise<void> {
  let processed = 0;

  do {
    processed = 0;

    for (const projector of projectors) {
      const result = await projector.runOnce();
      processed += result.processed;
    }
  } while (processed > 0);
}

export type ContextSubscriptionRunner = Readonly<{
  subscriptionName: string;
  projectionName: string;
  sourceContextName: string;
  targetContextName: string;
  subscriptionVersion: number;
  checkpointKey: string;
  order: number;
  runOnce: () => Promise<ProjectorRunResult>;
  getStatus: () => ContextSubscriptionStatus;
  refreshStatus: () => Promise<ContextSubscriptionStatus>;
  reset: () => Promise<void>;
}>;

export type ContextProjectionGroup = Readonly<{
  projectionName: string;
  projectionRevision: number;
  targetContextName: string;
  sourceContextNames: readonly string[];
  ownedTables: readonly string[];
  requiredDuringBootstrap: boolean;
  projectors: readonly BcProjector[];
  subscriptionRunners: readonly ContextSubscriptionRunner[];
  reset: () => Promise<void>;
  getStatus: () => ContextProjectionGroupStatus;
  refreshStatus: () => Promise<ContextProjectionGroupStatus>;
  markRevisionSynced: () => Promise<void>;
}>;

export type MountedContextRuntimeEntry = Readonly<{
  contextName: string;
  mountRole?: "active" | "source-only";
  module: BcApiModule;
  services: unknown;
  pool: PgTransactionalPool;
  projectors: readonly BcProjector[];
}>;

export type ContextProcessSet = Readonly<{
  projectors: readonly BcProjector[];
  subscriptionRunners?: readonly ContextSubscriptionRunner[];
}>;

function sortSubscriptionRunners(
  runners: readonly ContextSubscriptionRunner[],
): readonly ContextSubscriptionRunner[] {
  return [...runners].sort((left, right) => {
    if (left.order !== right.order) {
      return left.order - right.order;
    }

    if (left.sourceContextName !== right.sourceContextName) {
      return left.sourceContextName.localeCompare(right.sourceContextName);
    }

    if (left.targetContextName !== right.targetContextName) {
      return left.targetContextName.localeCompare(right.targetContextName);
    }

    if (left.projectionName !== right.projectionName) {
      return left.projectionName.localeCompare(right.projectionName);
    }

    if (left.subscriptionVersion !== right.subscriptionVersion) {
      return left.subscriptionVersion - right.subscriptionVersion;
    }

    return left.subscriptionName.localeCompare(right.subscriptionName);
  });
}

function sortProjectionGroups(
  groups: readonly ContextProjectionGroup[],
): readonly ContextProjectionGroup[] {
  return [...groups].sort((left, right) => {
    const leftOrder = Math.min(
      ...left.subscriptionRunners.map((runner) => runner.order),
      Number.MAX_SAFE_INTEGER,
    );
    const rightOrder = Math.min(
      ...right.subscriptionRunners.map((runner) => runner.order),
      Number.MAX_SAFE_INTEGER,
    );

    if (leftOrder !== rightOrder) {
      return leftOrder - rightOrder;
    }

    if (left.targetContextName !== right.targetContextName) {
      return left.targetContextName.localeCompare(right.targetContextName);
    }

    return left.projectionName.localeCompare(right.projectionName);
  });
}

function matchesSubscriptionEvent(
  event: Readonly<ReturnType<typeof toTransportEvent>>,
  subscription: Pick<BcEventSubscription, "eventTypes" | "streamPrefixes">,
): boolean {
  const matchesType =
    !subscription.eventTypes || subscription.eventTypes.includes(event.type);
  const matchesStreamPrefix =
    !subscription.streamPrefixes ||
    subscription.streamPrefixes.some((prefix) => event.streamId.startsWith(prefix));

  return matchesType && matchesStreamPrefix;
}

export function createSubscriptionRunner(
  targetContextName: string,
  targetPool: PgTransactionalPool,
  sourcePool: PgTransactionalPool,
  subscription: BcEventSubscription,
): ContextSubscriptionRunner {
  const sourceEventStore = createPostgresEventStore({ pool: sourcePool });
  const batchSize = subscription.batchSize ?? 100;
  const checkpointKey = createCheckpointKey(subscription);
  const status: {
    checkpointKey: string;
    subscriptionName: string;
    projectionName: string;
    sourceContextName: string;
    targetContextName: string;
    subscriptionVersion: number;
    initialized: boolean;
    lastGlobalPosition: GlobalPosition;
    sourceHeadGlobalPosition: GlobalPosition;
    processedEvents: number;
    state: SubscriptionReplayState;
    lastError: string | null;
    updatedAt: string;
  } = {
    checkpointKey,
    subscriptionName: subscription.subscriptionName,
    projectionName: subscription.projectionName,
    sourceContextName: subscription.sourceContextName,
    targetContextName,
    subscriptionVersion: subscription.subscriptionVersion,
    initialized: false,
    lastGlobalPosition: ZERO_GLOBAL_POSITION,
    sourceHeadGlobalPosition: ZERO_GLOBAL_POSITION,
    processedEvents: 0,
    state: "idle",
    lastError: null,
    updatedAt: new Date().toISOString(),
  };

  return {
    subscriptionName: subscription.subscriptionName,
    projectionName: subscription.projectionName,
    sourceContextName: subscription.sourceContextName,
    targetContextName,
    subscriptionVersion: subscription.subscriptionVersion,
    checkpointKey,
    order: subscription.order ?? 0,
    getStatus: () => ({ ...status }),
    refreshStatus: async () => {
      const storedCheckpoint = await loadSubscriptionCheckpoint(
        targetPool,
        checkpointKey,
      );
      const checkpoint = storedCheckpoint ?? ZERO_GLOBAL_POSITION;
      status.initialized = storedCheckpoint !== null;
      status.lastGlobalPosition = checkpoint;
      status.sourceHeadGlobalPosition =
        await readSourceHeadGlobalPosition(sourcePool);
      if (status.state !== "running" && status.state !== "error") {
        status.state =
          checkpoint === status.sourceHeadGlobalPosition ? "caught-up" : "idle";
      }
      status.updatedAt = new Date().toISOString();
      return { ...status };
    },
    reset: async () => {
      await deleteSubscriptionCheckpoint(targetPool, checkpointKey);
      status.initialized = false;
      status.lastGlobalPosition = ZERO_GLOBAL_POSITION;
      status.sourceHeadGlobalPosition = ZERO_GLOBAL_POSITION;
      status.processedEvents = 0;
      status.state = "idle";
      status.lastError = null;
      status.updatedAt = new Date().toISOString();
    },
    runOnce: async () => {
      status.state = "running";
      status.lastError = null;
      status.updatedAt = new Date().toISOString();

      try {
        const storedCheckpoint = await loadSubscriptionCheckpoint(
          targetPool,
          checkpointKey,
        );
        const checkpoint = storedCheckpoint ?? ZERO_GLOBAL_POSITION;
        status.initialized = storedCheckpoint !== null;
        status.lastGlobalPosition = checkpoint;
        status.sourceHeadGlobalPosition =
          await readSourceHeadGlobalPosition(sourcePool);

        const storedEvents = await sourceEventStore.readAll({
          afterGlobalPosition: checkpoint,
          limit: batchSize,
        });

        if (storedEvents.length === 0) {
          status.state =
            checkpoint === status.sourceHeadGlobalPosition ? "caught-up" : "idle";
          status.updatedAt = new Date().toISOString();

          return {
            processed: 0,
            lastGlobalPosition: checkpoint,
          };
        }

        let lastGlobalPosition = checkpoint;
        let processed = 0;

        for (const storedEvent of storedEvents) {
          const event = toTransportEvent(storedEvent);

          if (
            matchesSubscriptionEvent(event, subscription) &&
            subscription.handlers[event.type]
          ) {
            await subscription.handlers[event.type](event);
          }

          lastGlobalPosition = event.globalPosition;
          processed += 1;
          await saveSubscriptionCheckpoint(targetPool, subscription, lastGlobalPosition);
        }

        status.initialized = true;
        status.lastGlobalPosition = lastGlobalPosition;
        status.processedEvents += processed;
        status.state =
          lastGlobalPosition === status.sourceHeadGlobalPosition
            ? "caught-up"
            : "idle";
        status.updatedAt = new Date().toISOString();

        return {
          processed,
          lastGlobalPosition,
        };
      } catch (error) {
        status.state = "error";
        status.lastError =
          error instanceof Error ? error.message : "Unknown subscription replay failure.";
        status.updatedAt = new Date().toISOString();
        throw error;
      }
    },
  };
}

export function resolveModuleSubscriptions(
  mountedContexts: readonly MountedContextRuntimeEntry[],
): readonly ContextSubscriptionRunner[] {
  const contextsByName = new Map(
    mountedContexts.map((entry) => [entry.contextName, entry]),
  );
  const runners: ContextSubscriptionRunner[] = [];

  for (const entry of mountedContexts) {
    if (entry.mountRole === "source-only") {
      continue;
    }

    const subscriptions = entry.module.buildSubscriptions?.(entry.services) ?? [];

    for (const subscription of subscriptions) {
      const sourceEntry = contextsByName.get(subscription.sourceContextName);
      if (!sourceEntry) {
        throw new Error(
          `Context '${entry.contextName}' declared subscription '${subscription.subscriptionName}' for '${subscription.sourceContextName}', but that source context is not mounted in the runtime.`,
        );
      }

      runners.push(
        createSubscriptionRunner(
          entry.contextName,
          entry.pool,
          sourceEntry.pool,
          subscription,
        ),
      );
    }
  }

  return sortSubscriptionRunners(runners);
}

function resolveContextProjectionGroups(
  entry: MountedContextRuntimeEntry,
): readonly ContextProjectionGroup[] {
  const runtimeGroups: readonly BcProjectionGroup[] =
    entry.module.buildProjectionGroups?.(entry.services) ??
    (entry.module.projectionGroups ?? []).map((group) => ({ ...group }));

  const seenProjectionNames = new Set<string>();

  return runtimeGroups.map((group) => {
    if (seenProjectionNames.has(group.projectionName)) {
      throw new Error(
        `Context '${entry.contextName}' declared duplicate projection group '${group.projectionName}'.`,
      );
    }
    seenProjectionNames.add(group.projectionName);

    const sourceContextNames = [...new Set(group.sourceContextNames)];
    const ownedTables = [...new Set(group.ownedTables)];
    const projectionRevision = assertProjectionRevision(group.projectionRevision);
    const revisionState: {
      storedProjectionRevision: number | null;
      updatedAt: string;
    } = {
      storedProjectionRevision: null,
      updatedAt: new Date(0).toISOString(),
    };
    const revisionStale = () =>
      revisionState.storedProjectionRevision !== null &&
      revisionState.storedProjectionRevision !== projectionRevision;

    return {
      projectionName: group.projectionName,
      projectionRevision,
      targetContextName: entry.contextName,
      sourceContextNames,
      ownedTables,
      requiredDuringBootstrap: group.requiredDuringBootstrap ?? false,
      projectors: entry.projectors,
      subscriptionRunners: [],
      reset: group.reset ?? createDefaultProjectionGroupReset(entry.pool, ownedTables),
      getStatus: () => ({
        projectionName: group.projectionName,
        projectionRevision,
        storedProjectionRevision: revisionState.storedProjectionRevision,
        revisionStale: revisionStale(),
        targetContextName: entry.contextName,
        sourceContextNames,
        ownedTables,
        requiredDuringBootstrap: group.requiredDuringBootstrap ?? false,
        initialized: sourceContextNames.length === 0,
        caughtUp: sourceContextNames.length === 0,
        state: "caught-up",
        lastError: null,
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
          projectionRevision,
          storedProjectionRevision: revisionState.storedProjectionRevision,
          revisionStale: revisionStale(),
          targetContextName: entry.contextName,
          sourceContextNames,
          ownedTables,
          requiredDuringBootstrap: group.requiredDuringBootstrap ?? false,
          initialized: sourceContextNames.length === 0,
          caughtUp: sourceContextNames.length === 0,
          state: "caught-up",
          lastError: null,
          updatedAt: revisionState.updatedAt,
          subscriptions: [],
        };
      },
      markRevisionSynced: async () => {
        await saveProjectionGroupRevision(
          entry.pool,
          entry.contextName,
          group.projectionName,
          projectionRevision,
        );
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

  for (const entry of mountedContexts) {
    if (entry.mountRole === "source-only") {
      continue;
    }

    const contextGroups = resolveContextProjectionGroups(entry);

    for (const group of contextGroups) {
      const groupRunners = sortSubscriptionRunners(
        subscriptionRunners.filter(
          (runner) =>
            runner.targetContextName === entry.contextName &&
            runner.projectionName === group.projectionName,
        ),
      );
      const actualSources = [...new Set(groupRunners.map((runner) => runner.sourceContextName))];

      if (group.sourceContextNames.length === 0) {
        throw new Error(
          `Context '${entry.contextName}' projection group '${group.projectionName}' must declare at least one source context.`,
        );
      }

      if (groupRunners.length === 0) {
        throw new Error(
          `Context '${entry.contextName}' projection group '${group.projectionName}' does not have any matching subscriptions.`,
        );
      }

      const missingSources = group.sourceContextNames.filter(
        (sourceContextName) => !actualSources.includes(sourceContextName),
      );
      const unexpectedSources = actualSources.filter(
        (sourceContextName) => !group.sourceContextNames.includes(sourceContextName),
      );

      if (missingSources.length > 0 || unexpectedSources.length > 0) {
        throw new Error(
          `Context '${entry.contextName}' projection group '${group.projectionName}' sources do not match subscriptions. Missing: [${missingSources.join(", ")}]. Unexpected: [${unexpectedSources.join(", ")}].`,
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
            subscriptions.length > 0 &&
            subscriptions.every((subscription) => subscription.initialized);
          const caughtUp =
            subscriptions.length > 0 &&
            subscriptions.every(
              (subscription) =>
                subscription.lastGlobalPosition ===
                subscription.sourceHeadGlobalPosition,
            );
          const state: SubscriptionReplayState = subscriptions.some(
            (subscription) => subscription.state === "error",
          )
            ? "error"
            : subscriptions.some((subscription) => subscription.state === "running")
              ? "running"
              : caughtUp
                ? "caught-up"
                : "idle";
          const updatedAt = subscriptions.reduce(
            (latest, subscription) =>
              latest > subscription.updatedAt ? latest : subscription.updatedAt,
            new Date(0).toISOString(),
          );
          const lastError =
            subscriptions.find((subscription) => subscription.lastError)?.lastError ??
            null;

          return {
            projectionName: group.projectionName,
            projectionRevision: group.projectionRevision,
            storedProjectionRevision: baseStatus.storedProjectionRevision,
            revisionStale: baseStatus.revisionStale,
            targetContextName: entry.contextName,
            sourceContextNames: group.sourceContextNames,
            ownedTables: group.ownedTables,
            requiredDuringBootstrap: group.requiredDuringBootstrap,
            initialized,
            caughtUp,
            state,
            lastError,
            updatedAt:
              updatedAt > baseStatus.updatedAt ? updatedAt : baseStatus.updatedAt,
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

export async function drainSubscriptionRunners(
  runners: readonly ContextSubscriptionRunner[],
): Promise<void> {
  let processed = 0;

  do {
    processed = 0;

    for (const runner of sortSubscriptionRunners(runners)) {
      const result = await runner.runOnce();
      processed += result.processed;
    }
  } while (processed > 0);
}

export async function drainContextProcesses(
  processSet: ContextProcessSet,
): Promise<void> {
  let processed = 0;

  do {
    processed = 0;

    for (const runner of sortSubscriptionRunners(
      processSet.subscriptionRunners ?? [],
    )) {
      const result = await runner.runOnce();
      processed += result.processed;
    }

    for (const projector of processSet.projectors) {
      const result = await projector.runOnce();
      processed += result.processed;
    }
  } while (processed > 0);
}

export async function syncProjectionGroup(
  group: ContextProjectionGroup,
): Promise<void> {
  const status = await group.refreshStatus();

  if (status.revisionStale) {
    await rebuildProjectionGroup(group);
    return;
  }

  await drainContextProcesses({
    projectors: group.projectors,
    subscriptionRunners: group.subscriptionRunners,
  });
  await group.markRevisionSynced();
}

export async function resetProjectionGroup(
  group: ContextProjectionGroup,
): Promise<void> {
  await group.reset();

  for (const runner of sortSubscriptionRunners(group.subscriptionRunners)) {
    await runner.reset();
  }
}

export async function rebuildProjectionGroup(
  group: ContextProjectionGroup,
): Promise<void> {
  await resetProjectionGroup(group);
  await drainContextProcesses({
    projectors: group.projectors,
    subscriptionRunners: group.subscriptionRunners,
  });
  await group.markRevisionSynced();
}

export async function bootstrapContextDatabase(
  module: Pick<BcApiModule, "contextName" | "schemaSql">,
  pool: PgTransactionalPool,
): Promise<void> {
  await waitForDatabase(pool, module.contextName);
  await pool.query(composeModuleSchemaSql(module));
}

export function composeModuleSchemaSql(
  module: Pick<BcApiModule, "schemaSql">,
): string {
  const eventCoreSchemaSql = eventCorePostgresSchemaSql.trim();
  const moduleSchemaSql = module.schemaSql.trim();
  const normalizedModuleSchemaSql = moduleSchemaSql.startsWith(eventCoreSchemaSql)
    ? moduleSchemaSql.slice(eventCoreSchemaSql.length).trim()
    : moduleSchemaSql;

  return [
    eventCoreSchemaSql,
    eventSubscriptionSchemaSql.trim(),
    normalizedModuleSchemaSql,
  ]
    .filter((schemaSql) => schemaSql.length > 0)
    .join("\n\n");
}

export async function syncContextSubscriptions(
  runtime: Readonly<{
    mountedContexts: readonly MountedContextRuntimeEntry[];
    subscriptionRunners: readonly ContextSubscriptionRunner[];
  }>,
  contextName: string,
): Promise<void> {
  const targetContext = runtime.mountedContexts.find(
    (entry) => entry.contextName === contextName,
  );
  if (!targetContext) {
    throw new Error(`Runtime is missing mounted context '${contextName}'.`);
  }

  await drainContextProcesses({
    projectors: targetContext.projectors,
    subscriptionRunners: runtime.subscriptionRunners.filter(
      (runner) => runner.targetContextName === contextName,
    ),
  });
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
  const targetContext = runtime.mountedContexts.find(
    (entry) => entry.contextName === contextName,
  );
  if (!targetContext) {
    throw new Error(`Runtime is missing mounted context '${contextName}'.`);
  }

  const groups = sortProjectionGroups(
    runtime.projectionGroups.filter(
      (group) =>
        group.targetContextName === contextName &&
        (!options.requiredOnly || group.requiredDuringBootstrap),
    ),
  );

  if (groups.length === 0) {
    await drainContextProcesses({
      projectors: targetContext.projectors,
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
    (candidate) =>
      candidate.targetContextName === contextName &&
      candidate.projectionName === projectionName,
  );

  if (!group) {
    throw new Error(
      `Runtime is missing projection group '${projectionName}' for context '${contextName}'.`,
    );
  }

  return group;
}

export async function rebuildContextProjectionGroup(
  runtime: Readonly<{
    projectionGroups: readonly ContextProjectionGroup[];
  }>,
  contextName: string,
  projectionName: string,
): Promise<void> {
  await rebuildProjectionGroup(getProjectionGroup(runtime, contextName, projectionName));
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

  for (const group of groups) {
    await group.refreshStatus();

    for (const runner of sortSubscriptionRunners(group.subscriptionRunners)) {
      await runner.refreshStatus();
    }
  }

  return groups.map((group) => group.getStatus());
}

export function summarizeProjectionReplayStatuses(
  statuses: readonly ContextProjectionGroupStatus[],
): ProjectionReplaySummary {
  const contexts = [...new Set(statuses.map((status) => status.targetContextName))]
    .sort((left, right) => left.localeCompare(right))
    .map((contextName) => {
      const contextStatuses = statuses.filter(
        (status) => status.targetContextName === contextName,
      );

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
  const requiredStatuses = statuses.filter((status) => status.requiredDuringBootstrap);
  const status =
    requiredStatuses.some(
      (entry) => !entry.caughtUp || entry.revisionStale || entry.state === "error",
    )
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
  return summarizeProjectionReplayStatuses(
    listProjectionGroupStatuses(runtime, options),
  );
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
  return summarizeProjectionReplayStatuses(
    await refreshProjectionGroupStatuses(runtime, options),
  );
}

export async function rebuildAllContextProjectionGroups(
  runtime: Readonly<{
    projectionGroups: readonly ContextProjectionGroup[];
  }>,
  contextName: string,
  options: Readonly<{
    requiredOnly?: boolean;
  }> = {},
): Promise<void> {
  const groups = sortProjectionGroups(
    runtime.projectionGroups.filter(
      (group) =>
        group.targetContextName === contextName &&
        (!options.requiredOnly || group.requiredDuringBootstrap),
    ),
  );

  if (groups.length === 0) {
    throw new Error(`Runtime is missing projection groups for context '${contextName}'.`);
  }

  for (const group of groups) {
    await rebuildProjectionGroup(group);
  }
}

export async function drainContextRuntime(
  runtime: Readonly<{
    projectors: readonly BcProjector[];
    subscriptionRunners?: readonly ContextSubscriptionRunner[];
  }>,
): Promise<void> {
  await drainContextProcesses({
    projectors: runtime.projectors,
    subscriptionRunners: runtime.subscriptionRunners,
  });
}

export function collectProjectors<TServices extends {
  projectors: readonly BcProjector[];
}>(servicesList: readonly TServices[]): readonly BcProjector[] {
  return servicesList.flatMap((services) => services.projectors);
}

export function createContextServices<
  TServices,
  TPool,
  TPorts,
>(module: BcApiModule<TServices, TPool, TPorts>, pool: TPool, ports: TPorts): TServices {
  return module.createServices(pool, ports);
}

export function composeSchemaSql(
  modules: readonly Pick<BcApiModule, "schemaSql">[],
): string {
  const eventCoreSchemaSql = eventCorePostgresSchemaSql.trim();
  let eventCoreIncluded = false;

  const schemaParts = modules
    .map((module) => module.schemaSql.trim())
    .map((schemaSql) => {
      if (!schemaSql.startsWith(eventCoreSchemaSql)) {
        return schemaSql;
      }

      if (!eventCoreIncluded) {
        eventCoreIncluded = true;
        return schemaSql;
      }

      return schemaSql.slice(eventCoreSchemaSql.length).trim();
    })
    .filter((schemaSql) => schemaSql.length > 0);

  return schemaParts.join("\n\n");
}

export function composeApiModules<
  TPool,
  TModules extends readonly Readonly<{
    module: BcApiModule<unknown, TPool, unknown>;
    ports: unknown;
  }>[],
>(
  pool: TPool,
  modules: TModules,
): {
  [K in keyof TModules]: TModules[K] extends Readonly<{
    module: BcApiModule<infer TServices, TPool, infer _TPorts>;
    ports: infer _TProvidedPorts;
  }>
    ? Readonly<{
        module: TModules[K]["module"];
        services: TServices;
      }>
    : never;
} {
  return modules.map(({ module, ports }) => ({
    module,
    services: module.createServices(pool, ports),
  })) as {
    [K in keyof TModules]: TModules[K] extends Readonly<{
      module: BcApiModule<infer TServices, TPool, infer _TPorts>;
      ports: infer _TProvidedPorts;
    }>
      ? Readonly<{
          module: TModules[K]["module"];
          services: TServices;
        }>
      : never;
  };
}

export type ResolvedApiMount<TRouter = unknown> = BcApiMount & Readonly<{
  contextName: string;
  router: TRouter;
}>;

export function createResolvedApiMount<TRouter>(
  contextName: string,
  mount: Readonly<{
    mountPath: string;
    kind: string;
    requiresAuth: boolean;
    drainProjectorsOnWrite: boolean;
  }>,
  router: TRouter,
): ResolvedApiMount<TRouter> {
  if (mount.kind !== "primary" && mount.kind !== "additional") {
    throw new Error(
      `Invalid API mount kind '${mount.kind}' for context '${contextName}'.`,
    );
  }

  return {
    contextName,
    mountPath: mount.mountPath,
    kind: mount.kind,
    requiresAuth: mount.requiresAuth,
    drainProjectorsOnWrite: mount.drainProjectorsOnWrite,
    router,
  };
}

export function resolveContextApiMounts<TRouter>(
  contextName: string,
  mounts: readonly Readonly<{
    mountPath: string;
    kind: string;
    requiresAuth: boolean;
    drainProjectorsOnWrite: boolean;
  }>[],
  routers: readonly TRouter[],
): readonly ResolvedApiMount<TRouter>[] {
  if (mounts.length !== routers.length) {
    throw new Error(
      `Context '${contextName}' declared ${mounts.length} API mounts but provided ${routers.length} routers.`,
    );
  }

  return mounts.map((mount, index) =>
    createResolvedApiMount(contextName, mount, routers[index]),
  );
}

export function resolveModuleApiMounts<TServices, TPool, TPorts, TRouter>(
  module: Pick<
    BcApiModule<TServices, TPool, TPorts, TRouter>,
    "contextName" | "apiMounts" | "buildApis"
  >,
  services: TServices,
): readonly ResolvedApiMount<TRouter>[] {
  return resolveContextApiMounts(
    module.contextName,
    module.apiMounts,
    module.buildApis(services),
  );
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

export function attachWriteDrainMiddleware(
  app: Readonly<{
    use(path: string, middleware: (context: unknown, next: () => Promise<void>) => Promise<void>): unknown;
  }>,
  mounts: readonly Pick<ResolvedApiMount, "mountPath" | "drainProjectorsOnWrite">[],
  drain: () => Promise<void>,
): void {
  const writeDrainPaths = mounts
    .filter((mount) => mount.drainProjectorsOnWrite)
    .map((mount) => mount.mountPath);

  for (const mountPath of uniqueMountPaths(writeDrainPaths)) {
    app.use(normalizeMountWildcard(mountPath), async (context: unknown, next) => {
      await next();

      const req = (context as { req?: { method?: string } }).req;
      const method = req?.method?.toUpperCase() ?? "GET";

      if (method !== "GET" && method !== "HEAD") {
        await drain();
      }
    });
  }
}

export function attachWriteConsistencyMiddleware(
  app: Readonly<{
    use(path: string, middleware: (context: unknown, next: () => Promise<void>) => Promise<void>): unknown;
  }>,
  mounts: readonly Pick<ResolvedApiMount, "mountPath">[],
): void {
  for (const mountPath of uniqueMountPaths(mounts.map((mount) => mount.mountPath))) {
    app.use(normalizeMountWildcard(mountPath), async (context: unknown, next) => {
      await runWithEventCommitMetadata(next);

      const req = (context as { req?: { method?: string } }).req;
      const method = req?.method?.toUpperCase() ?? "GET";
      if (method === "GET" || method === "HEAD") {
        return;
      }

      const metadata = getEventCommitMetadata();
      if (metadata.eventIds.length === 0) {
        return;
      }

      const header = (context as { header?: (name: string, value: string) => void }).header;
      if (!header) {
        return;
      }

      header("Chase-Sets-Consistency", "eventual");
      if (metadata.maxGlobalPosition) {
        header("Chase-Sets-Commit-Position", metadata.maxGlobalPosition);
      }

      const compactEventIds = metadata.eventIds.join(",");
      if (compactEventIds.length <= 4_000) {
        header("Chase-Sets-Commit-Event-Ids", compactEventIds);
      }
    });
  }
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

export function createForwardedAuthHeaders(
  request: Request,
  initHeaders?: HeadersInit,
): Headers {
  const headers = new Headers(initHeaders);
  const cookie = request.headers.get("cookie");
  const authorization = request.headers.get("authorization");

  if (cookie && !headers.has("cookie")) {
    headers.set("cookie", cookie);
  }

  if (authorization && !headers.has("authorization")) {
    headers.set("authorization", authorization);
  }

  return headers;
}

export function createForwardedAuthFetch(
  request: Request,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
): typeof globalThis.fetch {
  return (input, init = {}) =>
    fetchImpl(input, {
      ...init,
      credentials: init.credentials ?? "include",
      headers: createForwardedAuthHeaders(request, init.headers),
    });
}

export function resolveRequestApiBaseUrl(request: Request, apiBasePath: string): string {
  const url = new URL(request.url);
  return `${url.origin}${apiBasePath}`;
}

export async function countEventsWithPrefix(
  pool: {
    query: (
      sql: string,
      params?: readonly unknown[],
    ) => Promise<{ rows?: readonly Readonly<{ count?: string | number }>[] }>;
  },
  prefix: string,
): Promise<number> {
  const result = await pool.query(
    "SELECT COUNT(*) AS count FROM event_store_events WHERE stream_id LIKE $1",
    [`${prefix}%`],
  );

  return Number(result.rows?.[0]?.count ?? 0);
}

export async function seedApiModuleIfEmpty<TPool>(
  module: Pick<
    BcApiModule<unknown, TPool, unknown>,
    "contextName" | "streamPrefix" | "seed" | "seedProfiles"
  >,
  pool: TPool & {
    query: (
      sql: string,
      params?: readonly unknown[],
    ) => Promise<{ rows?: readonly Readonly<{ count?: string | number }>[] }>;
  },
  services?: unknown,
  options: BcSeedOptions = defaultSeedOptions,
): Promise<void> {
  if (!module.seed) {
    return;
  }
  if (!seedProfilesOverlap(module.seedProfiles, options)) {
    console.log(
      `${module.contextName} seed skipped for data profiles: ${options.enabledDataProfiles.join(", ")}.`,
    );
    return;
  }

  const eventCount = await countEventsWithPrefix(pool, module.streamPrefix);

  if (eventCount === 0) {
    console.log(`Seeding ${module.contextName} data...`);
  } else {
    console.log(
      `${module.contextName} events already exist. Running seed reconciliation.`,
    );
  }

  await module.seed(pool, services, options);
}

export async function seedApiModulesIfEmpty<TPool>(
  modules: readonly Pick<
    BcApiModule<unknown, TPool, unknown>,
    "contextName" | "streamPrefix" | "seed" | "seedProfiles"
  >[],
  pool: TPool & {
    query: (
      sql: string,
      params?: readonly unknown[],
    ) => Promise<{ rows?: readonly Readonly<{ count?: string | number }>[] }>;
  },
  options: BcSeedOptions = defaultSeedOptions,
): Promise<void> {
  for (const module of modules) {
    await seedApiModuleIfEmpty(module, pool, undefined, options);
  }
}

export async function bootstrapApiModule<TServices, TPool, TPorts>(
  module: BcApiModule<TServices, TPool, TPorts>,
  pool: TPool & {
    query: (
      sql: string,
      params?: readonly unknown[],
    ) => Promise<{ rows?: readonly Readonly<{ count?: string | number }>[] }>;
  },
  ports: TPorts,
  options: Readonly<{
    databaseLabel?: string;
    completionLabel?: string;
  }> = {},
): Promise<TServices> {
  const completionLabel = options.completionLabel ?? module.contextName;
  await waitForDatabase(pool, options.databaseLabel ?? completionLabel);
  await pool.query(composeModuleSchemaSql(module));
  await seedApiModuleIfEmpty(module, pool);
  const services = module.createServices(pool, ports);
  await drainProjectors(module.projectors(services));
  console.log(`${completionLabel} projections are up to date.`);
  console.log(`${completionLabel} bootstrap complete.`);
  return services;
}

export function buildOpenGraphMeta({
  title,
  description = title,
  siteName = "Chase Sets",
  imageUrl,
  type = "website",
}: Readonly<{
  title: string;
  description?: string;
  siteName?: string;
  imageUrl?: string;
  type?: "website" | "product";
}>) {
  const meta = [
    { title },
    { name: "description", content: description },
    { property: "og:site_name", content: siteName },
    { property: "og:title", content: title },
    { property: "og:description", content: description },
    { property: "og:type", content: type },
    {
      name: "twitter:card",
      content: imageUrl ? "summary_large_image" : "summary",
    },
  ];

  if (imageUrl) {
    meta.push({ property: "og:image", content: imageUrl });
  }

  return meta;
}
