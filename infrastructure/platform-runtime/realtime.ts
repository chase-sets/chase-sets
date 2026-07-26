import { Hono, type Context } from "hono";
import { streamSSE } from "hono/streaming";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import type { RealtimeProjectionPatch, RealtimeSyncRequired } from "@chase-sets/realtime";
import {
  createPostgresWorkSignalWaiter,
  type PostgresWorkSignalNotification,
  type WorkSignalListenerUnavailableEvent,
  type WorkSignalNotificationReceivedEvent,
} from "./work-signal-composite";
import type { ResolvedActor } from "./auth";
import { decodeRealtimeCursor, encodeRealtimeCursor } from "./realtime-cursor";
import type { SigningKeySet } from "./signed-payload";
import { createRealtimeReadHub, type RealtimeReadHub } from "./realtime-read-hub";
import {
  createInMemoryRealtimeStreamLimiter,
  createPostgresRealtimeStreamLimiter,
  createRedisRealtimeStreamLimiter,
  type PostgresRealtimeStreamLimiterPool,
  type RedisRealtimeStreamLimiterClient,
  type RealtimeStreamLimiter,
} from "./realtime-stream-limiter";
import {
  authorizeRealtimeTopics,
  DEFAULT_MAX_TOPICS_PER_STREAM,
  inspectRealtimeTopicNormalization,
  matchesRealtimeTopicPattern,
  normalizeRealtimeTopics,
  platformRealtimeTopicPolicyManifest,
  resolveRealtimeTopicFamily,
  composeRealtimeTopicPolicyManifest,
  type RealtimeTopicPolicyManifest,
  type RealtimeTopicNormalizationDiagnostic,
} from "./realtime-topic-policy";
import { resolveClientAddress } from "./http";
import {
  compactRealtimeReplayMessages,
  coalesceRealtimeProjectionPatchInputs,
  createRealtimeOutboxPartitionName,
  createRealtimeOutboxPartitionMaintainer,
  defaultRealtimeRetentionMs,
  pruneExpiredRealtimePatches,
  pruneExpiredRealtimePatchesWithAdvisoryLock,
  readRealtimeContextHead,
  readRealtimeContextHeads,
  readRealtimePatches,
  realtimeOutboxSchemaSql,
  realtimeOutboxPartitionMetadataSql,
  realtimeOutboxPartitionMaintenanceSql,
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

/** The realtime cursor's rotating signing keys -- the shared platform signing key set. */
export type RealtimeCursorSigningKeySet = SigningKeySet;

export {
  authorizeRealtimeTopics,
  compactRealtimeReplayMessages,
  coalesceRealtimeProjectionPatchInputs,
  createRealtimeOutboxPartitionName,
  createRealtimeOutboxPartitionMaintainer,
  inspectRealtimeTopicNormalization,
  matchesRealtimeTopicPattern,
  normalizeRealtimeTopics,
  platformRealtimeTopicPolicyManifest,
  composeRealtimeTopicPolicyManifest,
  pruneExpiredRealtimePatchesWithAdvisoryLock,
  readRealtimeContextHeads,
  readRealtimePatches,
  realtimeOutboxSchemaSql,
  realtimeOutboxPartitionMetadataSql,
  realtimeOutboxPartitionMaintenanceSql,
  realtimeProjectionNotifyChannel,
  recordRealtimeProjectionPatch,
  recordRealtimeProjectionPatches,
  runRealtimeProjectionTransaction,
  selectRealtimeStoresForTopics,
};
export {
  createInMemoryRealtimeStreamLimiter,
  createPostgresRealtimeStreamLimiter,
  createRedisRealtimeStreamLimiter,
  type PostgresRealtimeStreamLimiterPool,
  type RedisRealtimeStreamLimiterClient,
  type RealtimeStreamLimiter,
} from "./realtime-stream-limiter";
export {
  createRealtimeRouteSubscriptionPreset,
  type RealtimeRouteSubscriptionPreset,
} from "./realtime-route-subscriptions";

export type {
  RealtimeContextRegistration,
  RealtimeContextStore,
  RealtimeCursor,
  RealtimeTopicLag,
  RealtimeTopicManifest,
  RecordRealtimeProjectionPatchInput,
} from "./realtime-outbox-store";
export type { RealtimeTopicPolicy, RealtimeTopicPolicyManifest } from "./realtime-topic-policy";

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
  readStarted?: (event: RealtimeReadHubObservedEvent) => void;
  readCoalesced?: (event: RealtimeReadHubObservedEvent) => void;
  messageSent?: (event: RealtimeMessageSentEvent) => void;
  syncRequired?: (event: RealtimeSyncRequiredEvent) => void;
  wakeNotificationReceived?: (event: RealtimeWakeNotificationReceivedEvent) => void;
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

export type RealtimeReadHubObservedEvent = Readonly<{
  storeNames: readonly string[];
  topics: readonly string[];
  batchSize: number;
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

export type RealtimeWakeNotificationReceivedEvent = Readonly<{
  notificationTopics: readonly string[];
  waiterCount: number;
  matchedWaiterCount: number;
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

export type RealtimeRouteConfig = Readonly<
  Required<RealtimeRouteTuning> & {
    resourceLimits: Required<RealtimeResourceLimits>;
    topicFamilyBudgets: readonly RealtimeTopicFamilyBudget[];
    cursorSigningSecret?: string;
    cursorSigningKeys?: RealtimeCursorSigningKeySet;
  }
>;

export type RealtimeWakeSignal = Readonly<{
  wait: (timeoutMs: number, topics?: readonly string[]) => Promise<RealtimeWakeResult>;
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
  routeConfig: RealtimeStatusRouteConfig;
  routeTuning: Required<RealtimeRouteTuning>;
  resourceLimits: Required<RealtimeResourceLimits>;
}>;

export type RealtimeStatusRouteConfig = Omit<RealtimeRouteConfig, "cursorSigningSecret" | "cursorSigningKeys"> &
  Readonly<{
    cursorSigningConfigured: boolean;
  }>;

type RealtimeEndpointMode = "any" | "public" | "account";

export type RealtimeOutboxWakeSignalOptions = Readonly<{
  observer?: Pick<RealtimeObserver, "wakeNotificationReceived">;
  /** Invoked when a listener connect/LISTEN attempt fails (at most once per cooldown). */
  onListenerUnavailable?: (error: unknown) => void;
  /** Reconnect circuit-breaker passed through to the composite waiter. */
  listenRetryCooldownMs?: number;
}>;

// Realtime SSE wake signal on the platform work-signal composite: one lazily
// connected composite waiter per realtime context pool, listening on
// `realtime_projection_patch`. Wakes are latency hints —
// the durable outbox rows remain the replay source of truth and SSE streams
// keep their bounded polling fallback, so listener loss only costs latency.
export function createRealtimeOutboxWakeSignal(
  db: PgTransactionalPool,
  options: RealtimeOutboxWakeSignalOptions = {},
): RealtimeWakeSignal {
  const observer = options.observer;
  const waiter = createPostgresWorkSignalWaiter(db, {
    channel: realtimeProjectionNotifyChannel,
    listenRetryCooldownMs: options.listenRetryCooldownMs ?? DEFAULT_REALTIME_WAKE_LISTEN_RETRY_COOLDOWN_MS,
    observer: {
      ...(observer?.wakeNotificationReceived
        ? {
            notificationReceived: (event: WorkSignalNotificationReceivedEvent) => {
              observer.wakeNotificationReceived?.({
                notificationTopics: readRealtimeWakeNotificationTopics(event.notification),
                waiterCount: event.waiterCount,
                matchedWaiterCount: event.matchedWaiterCount,
              });
            },
          }
        : {}),
      ...(options.onListenerUnavailable
        ? {
            listenerUnavailable: (event: WorkSignalListenerUnavailableEvent) => {
              options.onListenerUnavailable?.(event.error);
            },
          }
        : {}),
    },
  });

  return {
    wait: async (timeoutMs, topics = []) => {
      const subscribedTopics = normalizeRealtimeTopics(topics);
      const result = await waiter.wait({
        timeoutMs,
        matches: (notification) =>
          realtimeTopicsIntersect(subscribedTopics, readRealtimeWakeNotificationTopics(notification)),
      });
      return result === "notified" ? "notified" : "timeout";
    },
    stop: async () => {
      await waiter.stop();
    },
  };
}

const DEFAULT_REALTIME_WAKE_LISTEN_RETRY_COOLDOWN_MS = 60_000;

function readRealtimeWakeNotificationTopics(notification: PostgresWorkSignalNotification): readonly string[] {
  if (notification.envelope) {
    if (notification.envelope.kind !== "realtime.outbox-wake") {
      return [];
    }

    const topics = (notification.envelope.payload as { topics?: unknown }).topics;
    return Array.isArray(topics)
      ? normalizeRealtimeTopics(topics.filter((topic): topic is string => typeof topic === "string"))
      : [];
  }

  // Rolling-deploy compatibility: pre-composite emitters send a raw
  // { context, projection, topics } payload.
  return parseRealtimeNotificationTopics(notification.payload);
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
    wait: async (timeoutMs, topics) => Promise.race(activeWakeSignals.map((signal) => signal.wait(timeoutMs, topics))),
    stop: async () => {
      await Promise.all(activeWakeSignals.map((signal) => signal.stop?.()));
    },
  };
}

export function parseRealtimeTopics(searchParams: URLSearchParams): readonly string[] {
  return normalizeRealtimeTopics(readRealtimeTopicQueryValues(searchParams));
}

export function resolveRealtimeRouteConfig(
  input: Readonly<{
    routeTuning?: RealtimeRouteTuning;
    resourceLimits?: RealtimeResourceLimits;
    topicFamilyBudgets?: readonly RealtimeTopicFamilyBudget[];
    cursorSigningSecret?: string;
    cursorSigningKeys?: RealtimeCursorSigningKeySet;
  }> = {},
): RealtimeRouteConfig {
  const routeTuning = input.routeTuning ?? {};
  const resourceLimits = input.resourceLimits ?? {};
  const topicFamilyBudgets = input.topicFamilyBudgets ?? [];

  const config = {
    pollIntervalMs: routeTuning.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
    heartbeatIntervalMs: routeTuning.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS,
    retentionPruneIntervalMs: routeTuning.retentionPruneIntervalMs ?? DEFAULT_RETENTION_PRUNE_INTERVAL_MS,
    batchSize: routeTuning.batchSize ?? DEFAULT_BATCH_SIZE,
    maxConsecutiveFullBatches: routeTuning.maxConsecutiveFullBatches ?? DEFAULT_MAX_CONSECUTIVE_FULL_BATCHES,
    resourceLimits: {
      maxTopicsPerStream: resourceLimits.maxTopicsPerStream ?? DEFAULT_MAX_TOPICS_PER_STREAM,
      maxActiveStreams: resourceLimits.maxActiveStreams ?? 1_000,
      maxActiveStreamsPerConnectionKey: resourceLimits.maxActiveStreamsPerConnectionKey ?? 6,
    },
    topicFamilyBudgets,
    ...(input.cursorSigningKeys
      ? { cursorSigningKeys: input.cursorSigningKeys }
      : input.cursorSigningSecret
        ? { cursorSigningSecret: input.cursorSigningSecret }
        : {}),
  } satisfies RealtimeRouteConfig;

  assertPositiveIntegerConfig("pollIntervalMs", config.pollIntervalMs);
  assertNonNegativeIntegerConfig("heartbeatIntervalMs", config.heartbeatIntervalMs);
  assertPositiveIntegerConfig("retentionPruneIntervalMs", config.retentionPruneIntervalMs);
  assertPositiveIntegerConfig("batchSize", config.batchSize);
  assertPositiveIntegerConfig("maxConsecutiveFullBatches", config.maxConsecutiveFullBatches);
  assertPositiveIntegerConfig("resourceLimits.maxTopicsPerStream", config.resourceLimits.maxTopicsPerStream);
  assertNonNegativeIntegerConfig("resourceLimits.maxActiveStreams", config.resourceLimits.maxActiveStreams);
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

export async function createRealtimeStatusSnapshot(
  options: Readonly<{
    stores: readonly RealtimeContextStore[];
    activeConnectionCount?: number;
    wakeSignalConfigured?: boolean;
    routeTuning?: RealtimeRouteTuning;
    resourceLimits?: RealtimeResourceLimits;
    routeConfig?: RealtimeRouteConfig;
    retentionMs?: number;
  }>,
): Promise<RealtimeStatusSnapshot> {
  const routeConfig =
    options.routeConfig ??
    resolveRealtimeRouteConfig({
      routeTuning: options.routeTuning,
      resourceLimits: options.resourceLimits,
    });

  return {
    activeConnectionCount: options.activeConnectionCount ?? 0,
    retentionMs: options.retentionMs ?? defaultRealtimeRetentionMs,
    wakeSignalConfigured: options.wakeSignalConfigured ?? false,
    routeConfig: redactRealtimeRouteConfig(routeConfig),
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

function redactRealtimeRouteConfig(routeConfig: RealtimeRouteConfig): RealtimeStatusRouteConfig {
  const { cursorSigningSecret, cursorSigningKeys, ...safeConfig } = routeConfig;
  return {
    ...safeConfig,
    cursorSigningConfigured: Boolean(cursorSigningSecret || cursorSigningKeys),
  };
}

export function createRealtimeRoutes(
  options: Readonly<{
    stores: readonly RealtimeContextStore[];
    resolveActor: (request: Request) => Promise<ResolvedActor | null>;
    observer?: RealtimeObserver;
    resourceLimits?: RealtimeResourceLimits;
    routeConfig?: RealtimeRouteConfig;
    topicPolicyManifest?: RealtimeTopicPolicyManifest;
    topicFamilyBudgets?: readonly RealtimeTopicFamilyBudget[];
    cursorSigningSecret?: string;
    cursorSigningKeys?: RealtimeCursorSigningKeySet;
    readHub?: RealtimeReadHub;
    streamLimiter?: RealtimeStreamLimiter;
    wakeSignal?: RealtimeWakeSignal;
    pollIntervalMs?: number;
    heartbeatIntervalMs?: number;
    retentionPruneIntervalMs?: number;
    batchSize?: number;
    maxConsecutiveFullBatches?: number;
    isDraining?: () => boolean;
  }>,
) {
  const app = new Hono();
  const routeConfig =
    options.routeConfig ??
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
      cursorSigningKeys: options.cursorSigningKeys ?? options.cursorSigningSecret,
    });
  const readHub =
    options.readHub ??
    createRealtimeReadHub({
      observer: {
        readStarted: (event) => options.observer?.readStarted?.(event),
        readCoalesced: (event) => options.observer?.readCoalesced?.(event),
      },
    });
  const streamLimiter = options.streamLimiter ?? createInMemoryRealtimeStreamLimiter();
  const topicPolicyManifest = options.topicPolicyManifest ?? platformRealtimeTopicPolicyManifest;

  const handleEvents = async (c: Context, mode: RealtimeEndpointMode) => {
    if (options.isDraining?.()) {
      return c.json(
        {
          error: {
            code: "process_draining",
            message: "Process is draining for shutdown.",
          },
        },
        503,
      );
    }

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

    const authorizedTopics = authorizeRealtimeTopics(topics, actor, topicPolicyManifest);
    const modeAllowed = authorizedTopics
      ? areTopicsAllowedForEndpointMode(authorizedTopics, mode, topicPolicyManifest)
      : false;

    if (!authorizedTopics || !modeAllowed || authorizedTopics.length > routeConfig.resourceLimits.maxTopicsPerStream) {
      options.observer?.authorizationRejected?.({
        topics,
        actorAccountId: actor?.accountId ?? null,
        reason: "forbidden",
      });
      return c.json({ error: { code: "authorization_forbidden", message: "Forbidden." } }, 403);
    }

    const requestedCursor = c.req.header("last-event-id") ?? url.searchParams.get("cursor");
    let cursor = decodeRealtimeCursor(
      requestedCursor,
      routeConfig.cursorSigningKeys ?? routeConfig.cursorSigningSecret,
    );
    const matchingStores = selectRealtimeStoresForTopics(options.stores, authorizedTopics);
    if (!requestedCursor) {
      cursor = {
        ...cursor,
        ...(await readRealtimeContextHeads(matchingStores)),
      };
    }
    const connectionKey = resolveRealtimeConnectionKey(c.req.raw, actor);
    let streamLease;
    try {
      streamLease = await streamLimiter.acquire({
        connectionKey,
        maxActiveStreams: routeConfig.resourceLimits.maxActiveStreams,
        maxActiveStreamsPerConnectionKey: routeConfig.resourceLimits.maxActiveStreamsPerConnectionKey,
      });
    } catch (error) {
      options.observer?.streamError?.({ connectionKey, error });
      return c.json(
        {
          error: {
            code: "realtime_limiter_unavailable",
            message: "Realtime stream limiter is unavailable.",
          },
        },
        503,
      );
    }
    if (!streamLease) {
      options.observer?.authorizationRejected?.({
        topics: authorizedTopics,
        actorAccountId: actor?.accountId ?? null,
        reason: "resource-limit",
      });
      return c.json({ error: { code: "too_many_realtime_streams", message: "Too many realtime streams." } }, 429);
    }

    const topicBudget = resolveRealtimeTopicBudget(authorizedTopics, routeConfig, topicPolicyManifest);
    const batchSize = topicBudget.batchSize ?? routeConfig.batchSize;
    const maxConsecutiveFullBatches = topicBudget.maxConsecutiveFullBatches ?? routeConfig.maxConsecutiveFullBatches;

    return streamSSE(c, async (stream) => {
      const openedAt = performance.now();
      let nextHeartbeatAt = Date.now() + routeConfig.heartbeatIntervalMs;
      let consecutiveFullBatches = 0;
      const retryMs = Math.max(1_000, routeConfig.pollIntervalMs);
      const abortStream = () => stream.abort();
      c.req.raw.signal.addEventListener("abort", abortStream, { once: true });
      options.observer?.connectionOpened?.({
        connectionKey,
        activeConnectionCount: streamLease.activeConnectionCount,
        topics: authorizedTopics,
        storeNames: matchingStores.map((store) => store.contextName),
        actorAccountId: actor?.accountId ?? null,
      });
      await writeRealtimeHeartbeat(stream, {
        cursor,
        retryMs,
        cursorSigningKeys: routeConfig.cursorSigningKeys ?? routeConfig.cursorSigningSecret,
      });

      try {
        while (!stream.aborted && !stream.closed) {
          let batch: Awaited<ReturnType<RealtimeReadHub["read"]>>;
          try {
            batch = await readHub.read(matchingStores, authorizedTopics, cursor, batchSize, {
              pruneExpired: false,
              includeTopicLag: true,
              abortSignal: c.req.raw.signal,
            });
          } catch (error) {
            if (stream.aborted || stream.closed || c.req.raw.signal.aborted) {
              throw error;
            }

            options.observer?.streamError?.({ connectionKey, error });
            await writeRealtimeHeartbeat(stream, {
              cursor,
              retryMs,
              cursorSigningKeys: routeConfig.cursorSigningKeys ?? routeConfig.cursorSigningSecret,
            });
            options.observer?.wakeWaitEnded?.({
              result: await sleepUntilRealtimeWake(
                stream,
                routeConfig.pollIntervalMs,
                authorizedTopics,
                options.wakeSignal,
              ),
            });
            continue;
          }
          cursor = batch.cursor;
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
              cursorSigningKeys: routeConfig.cursorSigningKeys ?? routeConfig.cursorSigningSecret,
              observer: options.observer,
            });
            options.observer?.wakeWaitEnded?.({
              result: await sleepUntilRealtimeWake(
                stream,
                routeConfig.pollIntervalMs,
                authorizedTopics,
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
              cursorSigningKeys: routeConfig.cursorSigningKeys ?? routeConfig.cursorSigningSecret,
              observer: options.observer,
            });
          }

          for (const message of batch.messages) {
            const outboundCursor = {
              ...cursor,
              [message.contextName]: message.outboxId,
            };
            await stream.writeSSE({
              id: encodeRealtimeCursor(
                outboundCursor,
                routeConfig.cursorSigningKeys ?? routeConfig.cursorSigningSecret,
              ),
              event: message.payload.kind,
              data: message.payloadJson,
            });
            options.observer?.messageSent?.({
              contextName: message.contextName,
              eventKind: message.payload.kind,
              topicCount: message.payload.topics.length,
              payloadBytes: message.payloadBytes,
            });
          }

          if (batch.expiredContexts.length === 0 && batch.messages.length === 0 && Date.now() >= nextHeartbeatAt) {
            await writeRealtimeHeartbeat(stream, {
              cursor,
              retryMs,
              cursorSigningKeys: routeConfig.cursorSigningKeys ?? routeConfig.cursorSigningSecret,
            });
            nextHeartbeatAt = Date.now() + routeConfig.heartbeatIntervalMs;
          }

          options.observer?.wakeWaitEnded?.({
            result: await sleepUntilRealtimeWake(
              stream,
              routeConfig.pollIntervalMs,
              authorizedTopics,
              options.wakeSignal,
            ),
          });
        }
      } catch (error) {
        options.observer?.streamError?.({ connectionKey, error });
        throw error;
      } finally {
        c.req.raw.signal.removeEventListener("abort", abortStream);
        await streamLease.release();
        options.observer?.connectionClosed?.({
          connectionKey,
          activeConnectionCount: streamLimiter.activeConnectionCount?.() ?? 0,
          durationMs: performance.now() - openedAt,
        });
      }
    });
  };

  app.get("/public/events", (c) => handleEvents(c, "public"));
  app.get("/account/events", (c) => handleEvents(c, "account"));

  return app;
}

export function createRealtimeRetentionSweeper(
  options: Readonly<{
    stores: readonly RealtimeContextStore[];
    intervalMs?: number;
    observer?: RealtimeObserver;
    onError?: (error: unknown) => void;
  }>,
): RealtimeRetentionSweeper {
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

async function writeRealtimeHeartbeat(
  stream: Readonly<{
    writeSSE: (
      message: Readonly<{
        id: string;
        event: string;
        data: string;
        retry?: number;
      }>,
    ) => Promise<unknown>;
  }>,
  input: Readonly<{
    cursor: RealtimeCursor;
    retryMs: number;
    cursorSigningKeys?: RealtimeCursorSigningKeySet;
  }>,
): Promise<void> {
  await stream.writeSSE({
    id: encodeRealtimeCursor(input.cursor, input.cursorSigningKeys),
    event: "heartbeat",
    data: "{}",
    retry: input.retryMs,
  });
}

function readRealtimeTopicQueryValues(searchParams: URLSearchParams): readonly string[] {
  return [...searchParams.getAll("topic"), ...searchParams.getAll("topics").flatMap((value) => value.split(","))];
}

function isRealtimeTopicNormalizationAdjusted(diagnostic: RealtimeTopicNormalizationDiagnostic): boolean {
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
  topicPolicyManifest: RealtimeTopicPolicyManifest,
): boolean {
  if (mode === "any") {
    return true;
  }

  if (mode === "public") {
    return topics.every((topic) => resolveRealtimeTopicFamily(topic, topicPolicyManifest) !== "account");
  }

  return topics.every((topic) => resolveRealtimeTopicFamily(topic, topicPolicyManifest) === "account");
}

function resolveRealtimeTopicBudget(
  topics: readonly string[],
  routeConfig: RealtimeRouteConfig,
  topicPolicyManifest: RealtimeTopicPolicyManifest,
): Partial<RealtimeTopicFamilyBudget> {
  const families = new Set(
    topics.map((topic) => resolveRealtimeTopicFamily(topic, topicPolicyManifest)).filter(Boolean),
  );
  if (families.has("account")) {
    return routeConfig.topicFamilyBudgets.find((budget) => budget.family === "account") ?? {};
  }

  if (families.size > 0) {
    return routeConfig.topicFamilyBudgets.find((budget) => budget.family === "public") ?? {};
  }

  return {};
}

async function writeRealtimeSyncRequired(
  stream: Readonly<{
    writeSSE: (
      message: Readonly<{
        id: string;
        event: string;
        data: string;
      }>,
    ) => Promise<unknown>;
  }>,
  input: Readonly<{
    cursor: RealtimeCursor;
    reason: RealtimeSyncRequired["reason"];
    contexts: readonly string[];
    topicCount: number;
    cursorSigningKeys?: RealtimeCursorSigningKeySet;
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
    id: encodeRealtimeCursor(input.cursor, input.cursorSigningKeys),
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
  stream: Readonly<{
    onAbort?: (listener: () => void | Promise<void>) => void;
  }>,
  timeoutMs: number,
  topics: readonly string[],
  wakeSignal?: RealtimeWakeSignal,
): Promise<RealtimeWakeResult> {
  const slept = sleepRealtimeStream(timeoutMs, stream).then(() => "timeout" as const);
  if (!wakeSignal) {
    return slept;
  }

  return Promise.race([slept, wakeSignal.wait(timeoutMs, topics)]);
}

function sleepRealtimeStream(
  timeoutMs: number,
  stream: Readonly<{ onAbort?: (listener: () => void | Promise<void>) => void }>,
): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    timer.unref?.();
    stream.onAbort?.(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function resolveRealtimeConnectionKey(request: Request, actor: ResolvedActor | null): string {
  if (actor?.accountId) {
    return `account:${actor.accountId}`;
  }

  return `anonymous:${resolveClientAddress(request) ?? "unknown"}`;
}

function parseRealtimeNotificationTopics(payload: string | undefined): readonly string[] {
  if (!payload) {
    return [];
  }

  try {
    const parsed = JSON.parse(payload) as unknown;
    if (!parsed || typeof parsed !== "object" || !("topics" in parsed)) {
      return [];
    }

    const topics = (parsed as { topics?: unknown }).topics;
    return Array.isArray(topics)
      ? normalizeRealtimeTopics(topics.filter((topic): topic is string => typeof topic === "string"))
      : [];
  } catch {
    return [];
  }
}

function realtimeTopicsIntersect(subscribedTopics: readonly string[], notificationTopics: readonly string[]): boolean {
  if (subscribedTopics.length === 0 || notificationTopics.length === 0) {
    return true;
  }

  const subscribed = new Set(subscribedTopics);
  return notificationTopics.some(
    (topic) => subscribed.has(topic) || subscribedTopics.some((pattern) => matchesRealtimeTopicPattern(topic, pattern)),
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
  return typeof Buffer !== "undefined" ? Buffer.byteLength(value, "utf8") : new TextEncoder().encode(value).byteLength;
}
