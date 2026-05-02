import { Hono, type Context } from "hono";
import { streamSSE } from "hono/streaming";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type {
  RealtimeProjectionPatch,
  RealtimeSyncRequired,
} from "@chase-sets/realtime";
import type { ResolvedActor } from "./auth";
import {
  authorizeRealtimeTopics,
  DEFAULT_MAX_TOPICS_PER_STREAM,
  inspectRealtimeTopicNormalization,
  normalizeRealtimeTopics,
  resolveRealtimeTopicFamily,
  type RealtimeTopicNormalizationDiagnostic,
} from "./realtime-topic-policy";
import {
  compactRealtimeReplayMessages,
  coalesceRealtimeProjectionPatchInputs,
  defaultRealtimeRetentionMs,
  pruneExpiredRealtimePatches,
  pruneExpiredRealtimePatchesWithAdvisoryLock,
  readRealtimeContextHead,
  readRealtimeContextHeads,
  readRealtimePatches,
  realtimeOutboxSchemaSql,
  realtimeProjectionNotifyChannel,
  recordRealtimeProjectionPatch,
  recordRealtimeProjectionPatches,
  runRealtimeProjectionTransaction,
  selectRealtimeStoresForTopics,
  type RealtimeContextStore,
  type RealtimeCursor,
  type RealtimeTopicLag,
} from "./realtime-outbox-store";

const DEFAULT_BATCH_SIZE = 100;
const DEFAULT_POLL_INTERVAL_MS = 1_000;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 15_000;
const DEFAULT_RETENTION_PRUNE_INTERVAL_MS = 60_000;
const DEFAULT_MAX_CONSECUTIVE_FULL_BATCHES = 3;

export {
  authorizeRealtimeTopics,
  compactRealtimeReplayMessages,
  coalesceRealtimeProjectionPatchInputs,
  inspectRealtimeTopicNormalization,
  normalizeRealtimeTopics,
  pruneExpiredRealtimePatchesWithAdvisoryLock,
  readRealtimeContextHeads,
  readRealtimePatches,
  realtimeOutboxSchemaSql,
  realtimeProjectionNotifyChannel,
  recordRealtimeProjectionPatch,
  recordRealtimeProjectionPatches,
  runRealtimeProjectionTransaction,
  selectRealtimeStoresForTopics,
};

export type {
  RealtimeContextRegistration,
  RealtimeContextStore,
  RealtimeCursor,
  RealtimeTopicLag,
  RealtimeTopicManifest,
  RecordRealtimeProjectionPatchInput,
} from "./realtime-outbox-store";

export type {
  RealtimeMessage,
  RealtimeProjectionPatch,
  RealtimeProjectionPatchChange,
  RealtimeSyncRequired,
} from "@chase-sets/realtime";

export type RealtimeObserver = Readonly<{
  connectionOpened?: (event: RealtimeConnectionOpenedEvent) => void;
  connectionClosed?: (event: RealtimeConnectionClosedEvent) => void;
  authorizationRejected?: (event: RealtimeAuthorizationRejectedEvent) => void;
  topicNormalizationAdjusted?: (event: RealtimeTopicNormalizationAdjustedEvent) => void;
  batchRead?: (event: RealtimeBatchReadEvent) => void;
  messageSent?: (event: RealtimeMessageSentEvent) => void;
  syncRequired?: (event: RealtimeSyncRequiredEvent) => void;
  wakeWaitEnded?: (event: RealtimeWakeWaitEndedEvent) => void;
  retentionPruned?: (event: RealtimeRetentionPrunedEvent) => void;
  streamError?: (event: RealtimeStreamErrorEvent) => void;
}>;

export type RealtimeConnectionOpenedEvent = Readonly<{
  connectionKey: string;
  activeConnectionCount: number;
  topics: readonly string[];
  storeNames: readonly string[];
  actorAccountId: string | null;
}>;

export type RealtimeConnectionClosedEvent = Readonly<{
  connectionKey: string;
  activeConnectionCount: number;
  durationMs: number;
}>;

export type RealtimeAuthorizationRejectedEvent = Readonly<{
  topics: readonly string[];
  actorAccountId: string | null;
  reason: "forbidden" | "resource-limit";
}>;

export type RealtimeTopicNormalizationAdjustedEvent = Readonly<{
  requestedTopics: readonly string[];
  normalizedTopics: readonly string[];
  actorAccountId: string | null;
  diagnostic: RealtimeTopicNormalizationDiagnostic;
}>;

export type RealtimeBatchReadEvent = Readonly<{
  topics: readonly string[];
  storeNames: readonly string[];
  messageCount: number;
  expiredContextCount: number;
  topicLags: readonly RealtimeTopicLag[];
}>;

export type RealtimeMessageSentEvent = Readonly<{
  contextName: string;
  eventKind: RealtimeProjectionPatch["kind"];
  topicCount: number;
  payloadBytes: number;
}>;

export type RealtimeSyncRequiredEvent = Readonly<{
  reason: RealtimeSyncRequired["reason"];
  contexts: readonly string[];
  topicCount: number;
  payloadBytes: number;
}>;

export type RealtimeWakeWaitEndedEvent = Readonly<{
  result: RealtimeWakeResult;
}>;

export type RealtimeRetentionPrunedEvent = Readonly<{
  contextName: string;
  deletedCount: number;
}>;

export type RealtimeStreamErrorEvent = Readonly<{
  connectionKey: string;
  error: unknown;
}>;

export type RealtimeResourceLimits = Readonly<{
  maxTopicsPerStream?: number;
  maxActiveStreams?: number;
  maxActiveStreamsPerConnectionKey?: number;
}>;

export type RealtimeRouteTuning = Readonly<{
  pollIntervalMs?: number;
  heartbeatIntervalMs?: number;
  retentionPruneIntervalMs?: number;
  batchSize?: number;
  maxConsecutiveFullBatches?: number;
}>;

export type RealtimeTopicFamilyBudget = Readonly<{
  family: "public" | "account" | string;
  batchSize?: number;
  maxConsecutiveFullBatches?: number;
}>;

export type RealtimeRouteConfig = Readonly<Required<RealtimeRouteTuning> & {
  resourceLimits: Required<RealtimeResourceLimits>;
  topicFamilyBudgets: readonly RealtimeTopicFamilyBudget[];
}>;

export type RealtimeWakeSignal = Readonly<{
  wait: (timeoutMs: number) => Promise<RealtimeWakeResult>;
  stop?: () => void | Promise<void>;
}>;

export type RealtimeWakeResult = "notified" | "timeout";

export type RealtimeRetentionSweeper = Readonly<{
  sweep: () => Promise<void>;
  stop: () => void;
}>;

export type RealtimeStatusSnapshot = Readonly<{
  activeConnectionCount: number;
  retentionMs: number;
  wakeSignalConfigured: boolean;
  stores: readonly Readonly<{
    contextName: string;
    exactTopics: readonly string[];
    topicPrefixes: readonly string[];
    head: string;
  }>[];
  routeConfig: RealtimeRouteConfig;
  routeTuning: Required<RealtimeRouteTuning>;
  resourceLimits: Required<RealtimeResourceLimits>;
}>;

type PostgresRealtimeNotificationClient = PgQueryable & Readonly<{
  on: (
    event: "notification",
    listener: (message: Readonly<{ channel: string }>) => void,
  ) => unknown;
  off?: (
    event: "notification",
    listener: (message: Readonly<{ channel: string }>) => void,
  ) => unknown;
  removeListener?: (
    event: "notification",
    listener: (message: Readonly<{ channel: string }>) => void,
  ) => unknown;
  release?: () => void;
}>;

type RealtimeEndpointMode = "any" | "public" | "account";

export async function createPostgresRealtimeWakeSignal(
  client: PostgresRealtimeNotificationClient,
): Promise<RealtimeWakeSignal> {
  const waiters = new Set<() => void>();
  const notify = (message: Readonly<{ channel: string }>) => {
    if (message.channel !== realtimeProjectionNotifyChannel) {
      return;
    }

    const pending = [...waiters];
    waiters.clear();
    for (const resolve of pending) {
      resolve();
    }
  };

  client.on("notification", notify);
  await client.query(`LISTEN ${realtimeProjectionNotifyChannel}`);

  return {
    wait: (timeoutMs) =>
      new Promise((resolve) => {
        const waiter = () => done("notified");
        const timer = setTimeout(() => done("timeout"), timeoutMs);
        timer.unref?.();

        function done(result: RealtimeWakeResult) {
          clearTimeout(timer);
          waiters.delete(waiter);
          resolve(result);
        }

        waiters.add(waiter);
      }),
    stop: async () => {
      waiters.clear();
      if (client.off) {
        client.off("notification", notify);
      } else {
        client.removeListener?.("notification", notify);
      }
      await client.query(`UNLISTEN ${realtimeProjectionNotifyChannel}`);
      client.release?.();
    },
  };
}

export function createMergedRealtimeWakeSignal(
  wakeSignals: readonly RealtimeWakeSignal[],
): RealtimeWakeSignal | undefined {
  const activeWakeSignals = wakeSignals.filter(Boolean);
  if (activeWakeSignals.length === 0) {
    return undefined;
  }

  if (activeWakeSignals.length === 1) {
    return activeWakeSignals[0];
  }

  return {
    wait: async (timeoutMs) =>
      Promise.race(activeWakeSignals.map((signal) => signal.wait(timeoutMs))),
    stop: async () => {
      await Promise.all(activeWakeSignals.map((signal) => signal.stop?.()));
    },
  };
}

export function encodeRealtimeCursor(cursor: RealtimeCursor): string {
  const json = JSON.stringify(cursor);
  return Buffer.from(json, "utf8").toString("base64url");
}

export function decodeRealtimeCursor(value: string | null | undefined): RealtimeCursor {
  if (!value) {
    return {};
  }

  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }

    return Object.fromEntries(
      Object.entries(parsed)
        .filter((entry): entry is [string, string] => typeof entry[1] === "string")
        .filter(([, position]) => /^(0|[1-9]\d*)$/.test(position)),
    );
  } catch {
    return {};
  }
}

export function parseRealtimeTopics(searchParams: URLSearchParams): readonly string[] {
  return normalizeRealtimeTopics(readRealtimeTopicQueryValues(searchParams));
}

export function resolveRealtimeRouteConfig(input: Readonly<{
  routeTuning?: RealtimeRouteTuning;
  resourceLimits?: RealtimeResourceLimits;
  topicFamilyBudgets?: readonly RealtimeTopicFamilyBudget[];
}> = {}): RealtimeRouteConfig {
  const routeTuning = input.routeTuning ?? {};
  const resourceLimits = input.resourceLimits ?? {};
  const topicFamilyBudgets = input.topicFamilyBudgets ?? [];

  const config = {
    pollIntervalMs: routeTuning.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
    heartbeatIntervalMs: routeTuning.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS,
    retentionPruneIntervalMs:
      routeTuning.retentionPruneIntervalMs ?? DEFAULT_RETENTION_PRUNE_INTERVAL_MS,
    batchSize: routeTuning.batchSize ?? DEFAULT_BATCH_SIZE,
    maxConsecutiveFullBatches:
      routeTuning.maxConsecutiveFullBatches ?? DEFAULT_MAX_CONSECUTIVE_FULL_BATCHES,
    resourceLimits: {
      maxTopicsPerStream:
        resourceLimits.maxTopicsPerStream ?? DEFAULT_MAX_TOPICS_PER_STREAM,
      maxActiveStreams: resourceLimits.maxActiveStreams ?? 1_000,
      maxActiveStreamsPerConnectionKey:
        resourceLimits.maxActiveStreamsPerConnectionKey ?? 6,
    },
    topicFamilyBudgets,
  } satisfies RealtimeRouteConfig;

  assertPositiveIntegerConfig("pollIntervalMs", config.pollIntervalMs);
  assertNonNegativeIntegerConfig("heartbeatIntervalMs", config.heartbeatIntervalMs);
  assertPositiveIntegerConfig("retentionPruneIntervalMs", config.retentionPruneIntervalMs);
  assertPositiveIntegerConfig("batchSize", config.batchSize);
  assertPositiveIntegerConfig(
    "maxConsecutiveFullBatches",
    config.maxConsecutiveFullBatches,
  );
  assertPositiveIntegerConfig(
    "resourceLimits.maxTopicsPerStream",
    config.resourceLimits.maxTopicsPerStream,
  );
  assertNonNegativeIntegerConfig(
    "resourceLimits.maxActiveStreams",
    config.resourceLimits.maxActiveStreams,
  );
  assertNonNegativeIntegerConfig(
    "resourceLimits.maxActiveStreamsPerConnectionKey",
    config.resourceLimits.maxActiveStreamsPerConnectionKey,
  );
  for (const budget of config.topicFamilyBudgets) {
    if (budget.batchSize !== undefined) {
      assertPositiveIntegerConfig(`topicFamilyBudgets.${budget.family}.batchSize`, budget.batchSize);
    }
    if (budget.maxConsecutiveFullBatches !== undefined) {
      assertPositiveIntegerConfig(
        `topicFamilyBudgets.${budget.family}.maxConsecutiveFullBatches`,
        budget.maxConsecutiveFullBatches,
      );
    }
  }

  return config;
}

export async function createRealtimeStatusSnapshot(options: Readonly<{
  stores: readonly RealtimeContextStore[];
  activeConnectionCount?: number;
  wakeSignalConfigured?: boolean;
  routeTuning?: RealtimeRouteTuning;
  resourceLimits?: RealtimeResourceLimits;
  routeConfig?: RealtimeRouteConfig;
  retentionMs?: number;
}>): Promise<RealtimeStatusSnapshot> {
  const routeConfig = options.routeConfig ??
    resolveRealtimeRouteConfig({
      routeTuning: options.routeTuning,
      resourceLimits: options.resourceLimits,
    });

  return {
    activeConnectionCount: options.activeConnectionCount ?? 0,
    retentionMs: options.retentionMs ?? defaultRealtimeRetentionMs,
    wakeSignalConfigured: options.wakeSignalConfigured ?? false,
    routeConfig,
    routeTuning: {
      pollIntervalMs: routeConfig.pollIntervalMs,
      heartbeatIntervalMs: routeConfig.heartbeatIntervalMs,
      retentionPruneIntervalMs: routeConfig.retentionPruneIntervalMs,
      batchSize: routeConfig.batchSize,
      maxConsecutiveFullBatches: routeConfig.maxConsecutiveFullBatches,
    },
    resourceLimits: routeConfig.resourceLimits,
    stores: await Promise.all(
      options.stores.map(async (store) => ({
        contextName: store.contextName,
        exactTopics: store.exactTopics ?? [],
        topicPrefixes: store.topicPrefixes ?? [],
        head: await readRealtimeContextHead(store.db),
      })),
    ),
  };
}

export function createRealtimeRoutes(options: Readonly<{
  stores: readonly RealtimeContextStore[];
  resolveActor: (request: Request) => Promise<ResolvedActor | null>;
  observer?: RealtimeObserver;
  resourceLimits?: RealtimeResourceLimits;
  routeConfig?: RealtimeRouteConfig;
  topicFamilyBudgets?: readonly RealtimeTopicFamilyBudget[];
  wakeSignal?: RealtimeWakeSignal;
  pollIntervalMs?: number;
  heartbeatIntervalMs?: number;
  retentionPruneIntervalMs?: number;
  batchSize?: number;
  maxConsecutiveFullBatches?: number;
}>) {
  const app = new Hono();
  const routeConfig = options.routeConfig ??
    resolveRealtimeRouteConfig({
      routeTuning: {
        pollIntervalMs: options.pollIntervalMs,
        heartbeatIntervalMs: options.heartbeatIntervalMs,
        retentionPruneIntervalMs: options.retentionPruneIntervalMs,
        batchSize: options.batchSize,
        maxConsecutiveFullBatches: options.maxConsecutiveFullBatches,
      },
      resourceLimits: options.resourceLimits,
      topicFamilyBudgets: options.topicFamilyBudgets,
    });
  const nextPruneAtByContext = new Map<string, number>();
  let activeStreamCount = 0;
  const activeStreamsByConnectionKey = new Map<string, number>();

  const handleEvents = async (c: Context, mode: RealtimeEndpointMode) => {
    const url = new URL(c.req.url);
    const requestedTopics = readRealtimeTopicQueryValues(url.searchParams);
    const topics = normalizeRealtimeTopics(requestedTopics);
    const topicDiagnostic = inspectRealtimeTopicNormalization(requestedTopics);
    const actor = await options.resolveActor(c.req.raw);

    if (isRealtimeTopicNormalizationAdjusted(topicDiagnostic)) {
      options.observer?.topicNormalizationAdjusted?.({
        requestedTopics,
        normalizedTopics: topics,
        actorAccountId: actor?.accountId ?? null,
        diagnostic: topicDiagnostic,
      });
    }

    const authorizedTopics = authorizeRealtimeTopics(topics, actor);
    const modeAllowed = authorizedTopics
      ? areTopicsAllowedForEndpointMode(authorizedTopics, mode)
      : false;

    if (
      !authorizedTopics ||
      !modeAllowed ||
      authorizedTopics.length > routeConfig.resourceLimits.maxTopicsPerStream
    ) {
      options.observer?.authorizationRejected?.({
        topics,
        actorAccountId: actor?.accountId ?? null,
        reason: "forbidden",
      });
      return c.json({ error: { code: "authorization_forbidden", message: "Forbidden." } }, 403);
    }

    let cursor = decodeRealtimeCursor(c.req.header("last-event-id"));
    const matchingStores = selectRealtimeStoresForTopics(options.stores, authorizedTopics);
    const connectionKey = resolveRealtimeConnectionKey(c.req.raw, actor);
    const activeForConnectionKey = activeStreamsByConnectionKey.get(connectionKey) ?? 0;
    if (
      isRealtimeResourceLimitExceeded({
        activeStreamCount,
        activeForConnectionKey,
        resourceLimits: routeConfig.resourceLimits,
      })
    ) {
      options.observer?.authorizationRejected?.({
        topics: authorizedTopics,
        actorAccountId: actor?.accountId ?? null,
        reason: "resource-limit",
      });
      return c.json({ error: { code: "too_many_realtime_streams", message: "Too many realtime streams." } }, 429);
    }

    const topicBudget = resolveRealtimeTopicBudget(authorizedTopics, routeConfig);
    const batchSize = topicBudget.batchSize ?? routeConfig.batchSize;
    const maxConsecutiveFullBatches =
      topicBudget.maxConsecutiveFullBatches ?? routeConfig.maxConsecutiveFullBatches;

    return streamSSE(c, async (stream) => {
      const openedAt = performance.now();
      let nextHeartbeatAt = Date.now() + routeConfig.heartbeatIntervalMs;
      let consecutiveFullBatches = 0;
      activeStreamCount += 1;
      activeStreamsByConnectionKey.set(connectionKey, activeForConnectionKey + 1);
      options.observer?.connectionOpened?.({
        connectionKey,
        activeConnectionCount: activeStreamCount,
        topics: authorizedTopics,
        storeNames: matchingStores.map((store) => store.contextName),
        actorAccountId: actor?.accountId ?? null,
      });

      try {
        while (!stream.aborted && !stream.closed) {
          await pruneRealtimeStoresIfDue(
            matchingStores,
            nextPruneAtByContext,
            routeConfig.retentionPruneIntervalMs,
            options.observer,
          );
          const batch = await readRealtimePatches(
            matchingStores,
            authorizedTopics,
            cursor,
            batchSize,
            { pruneExpired: false, includeTopicLag: true },
          );
          cursor = batch.cursor;
          const cursorId = encodeRealtimeCursor(cursor);
          options.observer?.batchRead?.({
            topics: authorizedTopics,
            storeNames: matchingStores.map((store) => store.contextName),
            messageCount: batch.messages.length,
            expiredContextCount: batch.expiredContexts.length,
            topicLags: batch.topicLags,
          });

          if (batch.messages.length >= batchSize) {
            consecutiveFullBatches += 1;
          } else {
            consecutiveFullBatches = 0;
          }

          if (consecutiveFullBatches >= maxConsecutiveFullBatches) {
            const headCursor = await readRealtimeContextHeads(matchingStores);
            cursor = { ...cursor, ...headCursor };
            consecutiveFullBatches = 0;
            await writeRealtimeSyncRequired(stream, {
              cursor,
              reason: "replay-backpressure",
              contexts: matchingStores.map((store) => store.contextName),
              topicCount: authorizedTopics.length,
              observer: options.observer,
            });
            options.observer?.wakeWaitEnded?.({
              result: await sleepUntilRealtimeWake(
                stream,
                routeConfig.pollIntervalMs,
                options.wakeSignal,
              ),
            });
            continue;
          }

          if (batch.expiredContexts.length > 0) {
            await writeRealtimeSyncRequired(stream, {
              cursor,
              reason: "cursor-expired",
              contexts: batch.expiredContexts,
              topicCount: authorizedTopics.length,
              observer: options.observer,
            });
          }

          for (const message of batch.messages) {
            const outboundCursor = {
              ...cursor,
              [message.contextName]: message.outboxId,
            };
            const data = JSON.stringify(message.payload);
            await stream.writeSSE({
              id: encodeRealtimeCursor(outboundCursor),
              event: message.payload.kind,
              data,
            });
            options.observer?.messageSent?.({
              contextName: message.contextName,
              eventKind: message.payload.kind,
              topicCount: message.payload.topics.length,
              payloadBytes: byteLengthUtf8(data),
            });
          }

          if (
            batch.expiredContexts.length === 0 &&
            batch.messages.length === 0 &&
            Date.now() >= nextHeartbeatAt
          ) {
            await stream.writeSSE({
              id: cursorId,
              event: "heartbeat",
              data: "{}",
            });
            nextHeartbeatAt = Date.now() + routeConfig.heartbeatIntervalMs;
          }

          options.observer?.wakeWaitEnded?.({
            result: await sleepUntilRealtimeWake(
              stream,
              routeConfig.pollIntervalMs,
              options.wakeSignal,
            ),
          });
        }
      } catch (error) {
        options.observer?.streamError?.({ connectionKey, error });
        throw error;
      } finally {
        activeStreamCount = Math.max(0, activeStreamCount - 1);
        const nextActiveForConnectionKey = Math.max(
          0,
          (activeStreamsByConnectionKey.get(connectionKey) ?? 1) - 1,
        );
        if (nextActiveForConnectionKey === 0) {
          activeStreamsByConnectionKey.delete(connectionKey);
        } else {
          activeStreamsByConnectionKey.set(connectionKey, nextActiveForConnectionKey);
        }
        options.observer?.connectionClosed?.({
          connectionKey,
          activeConnectionCount: activeStreamCount,
          durationMs: performance.now() - openedAt,
        });
      }
    });
  };

  app.get("/events", (c) => handleEvents(c, "any"));
  app.get("/public/events", (c) => handleEvents(c, "public"));
  app.get("/account/events", (c) => handleEvents(c, "account"));

  return app;
}

export function createRealtimeRetentionSweeper(options: Readonly<{
  stores: readonly RealtimeContextStore[];
  intervalMs?: number;
  observer?: RealtimeObserver;
  onError?: (error: unknown) => void;
}>): RealtimeRetentionSweeper {
  const intervalMs = options.intervalMs ?? DEFAULT_RETENTION_PRUNE_INTERVAL_MS;
  let running = false;

  const sweep = async () => {
    if (running) {
      return;
    }

    running = true;
    try {
      for (const store of options.stores) {
        const deletedCount = await pruneExpiredRealtimePatches(store.db);
        options.observer?.retentionPruned?.({
          contextName: store.contextName,
          deletedCount,
        });
      }
    } catch (error) {
      options.onError?.(error);
      options.observer?.streamError?.({
        connectionKey: "retention-sweeper",
        error,
      });
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => {
    void sweep();
  }, intervalMs);
  timer.unref?.();

  return {
    sweep,
    stop: () => clearInterval(timer),
  };
}

function readRealtimeTopicQueryValues(searchParams: URLSearchParams): readonly string[] {
  return [
    ...searchParams.getAll("topic"),
    ...searchParams.getAll("topics").flatMap((value) => value.split(",")),
  ];
}

function isRealtimeTopicNormalizationAdjusted(
  diagnostic: RealtimeTopicNormalizationDiagnostic,
): boolean {
  return (
    diagnostic.duplicateCount > 0 ||
    diagnostic.blankCount > 0 ||
    diagnostic.invalidCount > 0 ||
    !diagnostic.sorted ||
    diagnostic.requestedCount !== diagnostic.normalizedCount
  );
}

function areTopicsAllowedForEndpointMode(
  topics: readonly string[],
  mode: RealtimeEndpointMode,
): boolean {
  if (mode === "any") {
    return true;
  }

  if (mode === "public") {
    return topics.every((topic) => resolveRealtimeTopicFamily(topic) !== "account");
  }

  return topics.every((topic) => resolveRealtimeTopicFamily(topic) === "account");
}

function resolveRealtimeTopicBudget(
  topics: readonly string[],
  routeConfig: RealtimeRouteConfig,
): Partial<RealtimeTopicFamilyBudget> {
  const families = new Set(topics.map(resolveRealtimeTopicFamily).filter(Boolean));
  if (families.has("account")) {
    return routeConfig.topicFamilyBudgets.find((budget) => budget.family === "account") ?? {};
  }

  if (families.size > 0) {
    return routeConfig.topicFamilyBudgets.find((budget) => budget.family === "public") ?? {};
  }

  return {};
}

async function writeRealtimeSyncRequired(
  stream: Readonly<{ writeSSE: (message: Readonly<{
    id: string;
    event: string;
    data: string;
  }>) => Promise<unknown> }>,
  input: Readonly<{
    cursor: RealtimeCursor;
    reason: RealtimeSyncRequired["reason"];
    contexts: readonly string[];
    topicCount: number;
    observer?: RealtimeObserver;
  }>,
): Promise<void> {
  const message = {
    kind: "sync.required",
    reason: input.reason,
    contexts: input.contexts,
  } satisfies RealtimeSyncRequired;
  const data = JSON.stringify(message);
  await stream.writeSSE({
    id: encodeRealtimeCursor(input.cursor),
    event: "sync.required",
    data,
  });
  input.observer?.syncRequired?.({
    reason: input.reason,
    contexts: input.contexts,
    topicCount: input.topicCount,
    payloadBytes: byteLengthUtf8(data),
  });
}

async function sleepUntilRealtimeWake(
  stream: Readonly<{ sleep: (ms: number) => Promise<unknown> }>,
  timeoutMs: number,
  wakeSignal?: RealtimeWakeSignal,
): Promise<RealtimeWakeResult> {
  if (!wakeSignal) {
    await stream.sleep(timeoutMs);
    return "timeout";
  }

  return Promise.race([
    stream.sleep(timeoutMs).then(() => "timeout" as const),
    wakeSignal.wait(timeoutMs),
  ]);
}

async function pruneRealtimeStoresIfDue(
  stores: readonly RealtimeContextStore[],
  nextPruneAtByContext: Map<string, number>,
  intervalMs: number,
  observer?: RealtimeObserver,
): Promise<void> {
  const now = Date.now();
  for (const store of stores) {
    const nextPruneAt = nextPruneAtByContext.get(store.contextName) ?? 0;
    if (now < nextPruneAt) {
      continue;
    }

    nextPruneAtByContext.set(store.contextName, now + intervalMs);
    const deletedCount = await pruneExpiredRealtimePatches(store.db);
    observer?.retentionPruned?.({
      contextName: store.contextName,
      deletedCount,
    });
  }
}

function resolveRealtimeConnectionKey(request: Request, actor: ResolvedActor | null): string {
  if (actor?.accountId) {
    return `account:${actor.accountId}`;
  }

  return `anonymous:${request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown"}`;
}

function isRealtimeResourceLimitExceeded(input: Readonly<{
  activeStreamCount: number;
  activeForConnectionKey: number;
  resourceLimits: Required<RealtimeResourceLimits>;
}>): boolean {
  return (
    input.activeStreamCount >= input.resourceLimits.maxActiveStreams ||
    input.activeForConnectionKey >= input.resourceLimits.maxActiveStreamsPerConnectionKey
  );
}

function assertPositiveIntegerConfig(name: string, value: number): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`Realtime route config ${name} must be a positive integer.`);
  }
}

function assertNonNegativeIntegerConfig(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`Realtime route config ${name} must be a non-negative integer.`);
  }
}

function byteLengthUtf8(value: string): number {
  return typeof Buffer !== "undefined"
    ? Buffer.byteLength(value, "utf8")
    : new TextEncoder().encode(value).byteLength;
}
