import { Hono, type Context } from "hono";
import { streamSSE } from "hono/streaming";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type {
  RealtimeProjectionPatch,
  RealtimeSyncRequired,
} from "@chase-sets/realtime";
import type { ResolvedActor } from "./auth";
import {
  decodeRealtimeCursor,
  encodeRealtimeCursor,
  type RealtimeCursorSigningKeySet,
} from "./realtime-cursor";
import {
  createRealtimeReadHub,
  type RealtimeReadHub,
} from "./realtime-read-hub";
import {
  createInMemoryRealtimeStreamLimiter,
  createRedisRealtimeStreamLimiter,
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
  realtimeOutboxPartitionMaintenanceSql,
  realtimeProjectionNotifyChannel,
  recordRealtimeProjectionPatch,
  recordRealtimeProjectionPatches,
  runRealtimeProjectionTransaction,
  selectRealtimeStoresForTopics,
};
export {
  decodeRealtimeCursor,
  encodeRealtimeCursor,
  type RealtimeCursorSigningKeySet,
} from "./realtime-cursor";
export {
  createRealtimeReadHub,
  type RealtimeReadHub,
} from "./realtime-read-hub";
export {
  createInMemoryRealtimeStreamLimiter,
  createRedisRealtimeStreamLimiter,
  type RedisRealtimeStreamLimiterClient,
  type RealtimeStreamLimiter,
} from "./realtime-stream-limiter";

export type {
  RealtimeContextRegistration,
  RealtimeContextStore,
  RealtimeCursor,
  RealtimeTopicLag,
  RealtimeTopicManifest,
  RecordRealtimeProjectionPatchInput,
} from "./realtime-outbox-store";
export type {
  RealtimeTopicPolicy,
  RealtimeTopicPolicyManifest,
} from "./realtime-topic-policy";

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

export type RealtimeRouteConfig = Readonly<Required<RealtimeRouteTuning> & {
  resourceLimits: Required<RealtimeResourceLimits>;
  topicFamilyBudgets: readonly RealtimeTopicFamilyBudget[];
  cursorSigningSecret?: string;
  cursorSigningKeys?: RealtimeCursorSigningKeySet;
}>;

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

export type RealtimeStatusRouteConfig = Omit<
  RealtimeRouteConfig,
  "cursorSigningSecret" | "cursorSigningKeys"
> & Readonly<{
  cursorSigningConfigured: boolean;
}>;

type PostgresRealtimeNotificationClient = PgQueryable & Readonly<{
  on: (
    event: "notification",
    listener: (message: Readonly<{ channel: string; payload?: string }>) => void,
  ) => unknown;
  off?: (
    event: "notification",
    listener: (message: Readonly<{ channel: string; payload?: string }>) => void,
  ) => unknown;
  removeListener?: (
    event: "notification",
    listener: (message: Readonly<{ channel: string; payload?: string }>) => void,
  ) => unknown;
  release?: () => void;
}>;

type RealtimeEndpointMode = "any" | "public" | "account";

export async function createPostgresRealtimeWakeSignal(
  client: PostgresRealtimeNotificationClient,
  observer?: Pick<RealtimeObserver, "wakeNotificationReceived">,
): Promise<RealtimeWakeSignal> {
  const waiters = new Set<Readonly<{
    topics: readonly string[];
    resolve: () => void;
  }>>();
  const notify = (message: Readonly<{ channel: string; payload?: string }>) => {
    if (message.channel !== realtimeProjectionNotifyChannel) {
      return;
    }

    const notificationTopics = parseRealtimeNotificationTopics(message.payload);
    const pending = [...waiters];
    let matchedWaiterCount = 0;
    for (const waiter of pending) {
      if (realtimeTopicsIntersect(waiter.topics, notificationTopics)) {
        matchedWaiterCount += 1;
        waiters.delete(waiter);
        waiter.resolve();
      }
    }
    observer?.wakeNotificationReceived?.({
      notificationTopics,
      waiterCount: pending.length,
      matchedWaiterCount,
    });
  };

  client.on("notification", notify);
  await client.query(`LISTEN ${realtimeProjectionNotifyChannel}`);

  return {
    wait: (timeoutMs, topics = []) =>
      new Promise((resolve) => {
        const waiter = () => done("notified");
        const timer = setTimeout(() => done("timeout"), timeoutMs);
        timer.unref?.();
        const entry = {
          topics: normalizeRealtimeTopics(topics),
          resolve: waiter,
        };

        function done(result: RealtimeWakeResult) {
          clearTimeout(timer);
          waiters.delete(entry);
          resolve(result);
        }

        waiters.add(entry);
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
    wait: async (timeoutMs, topics) =>
      Promise.race(activeWakeSignals.map((signal) => signal.wait(timeoutMs, topics))),
    stop: async () => {
      await Promise.all(activeWakeSignals.map((signal) => signal.stop?.()));
    },
  };
}

export function parseRealtimeTopics(searchParams: URLSearchParams): readonly string[] {
  return normalizeRealtimeTopics(readRealtimeTopicQueryValues(searchParams));
}

export function resolveRealtimeRouteConfig(input: Readonly<{
  routeTuning?: RealtimeRouteTuning;
  resourceLimits?: RealtimeResourceLimits;
  topicFamilyBudgets?: readonly RealtimeTopicFamilyBudget[];
  cursorSigningSecret?: string;
  cursorSigningKeys?: RealtimeCursorSigningKeySet;
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

function redactRealtimeRouteConfig(
  routeConfig: RealtimeRouteConfig,
): RealtimeStatusRouteConfig {
  const { cursorSigningSecret, cursorSigningKeys, ...safeConfig } = routeConfig;
  return {
    ...safeConfig,
    cursorSigningConfigured: Boolean(cursorSigningSecret || cursorSigningKeys),
  };
}

export function createRealtimeRoutes(options: Readonly<{
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
      cursorSigningKeys: options.cursorSigningKeys ?? options.cursorSigningSecret,
    });
  const readHub = options.readHub ?? createRealtimeReadHub({
    observer: {
      readStarted: (event) => options.observer?.readStarted?.(event),
      readCoalesced: (event) => options.observer?.readCoalesced?.(event),
    },
  });
  const streamLimiter = options.streamLimiter ?? createInMemoryRealtimeStreamLimiter();
  const topicPolicyManifest = options.topicPolicyManifest ?? platformRealtimeTopicPolicyManifest;
  const nextPruneAtByContext = new Map<string, number>();

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

    const authorizedTopics = authorizeRealtimeTopics(topics, actor, topicPolicyManifest);
    const modeAllowed = authorizedTopics
      ? areTopicsAllowedForEndpointMode(authorizedTopics, mode, topicPolicyManifest)
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

    let cursor = decodeRealtimeCursor(
      c.req.header("last-event-id"),
      routeConfig.cursorSigningKeys ?? routeConfig.cursorSigningSecret,
    );
    const matchingStores = selectRealtimeStoresForTopics(options.stores, authorizedTopics);
    const connectionKey = resolveRealtimeConnectionKey(c.req.raw, actor);
    const streamLease = await streamLimiter.acquire({
      connectionKey,
      maxActiveStreams: routeConfig.resourceLimits.maxActiveStreams,
      maxActiveStreamsPerConnectionKey:
        routeConfig.resourceLimits.maxActiveStreamsPerConnectionKey,
    });
    if (!streamLease) {
      options.observer?.authorizationRejected?.({
        topics: authorizedTopics,
        actorAccountId: actor?.accountId ?? null,
        reason: "resource-limit",
      });
      return c.json({ error: { code: "too_many_realtime_streams", message: "Too many realtime streams." } }, 429);
    }

    const topicBudget = resolveRealtimeTopicBudget(
      authorizedTopics,
      routeConfig,
      topicPolicyManifest,
    );
    const batchSize = topicBudget.batchSize ?? routeConfig.batchSize;
    const maxConsecutiveFullBatches =
      topicBudget.maxConsecutiveFullBatches ?? routeConfig.maxConsecutiveFullBatches;

    return streamSSE(c, async (stream) => {
      const openedAt = performance.now();
      let nextHeartbeatAt = Date.now() + routeConfig.heartbeatIntervalMs;
      let consecutiveFullBatches = 0;
      options.observer?.connectionOpened?.({
        connectionKey,
        activeConnectionCount: streamLease.activeConnectionCount,
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
          const batch = await readHub.read(
            matchingStores,
            authorizedTopics,
            cursor,
            batchSize,
            { pruneExpired: false, includeTopicLag: true },
          );
          cursor = batch.cursor;
          const cursorId = encodeRealtimeCursor(cursor, routeConfig.cursorSigningKeys ?? routeConfig.cursorSigningSecret);
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
              id: encodeRealtimeCursor(outboundCursor, routeConfig.cursorSigningKeys ?? routeConfig.cursorSigningSecret),
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
              authorizedTopics,
              options.wakeSignal,
            ),
          });
        }
      } catch (error) {
        options.observer?.streamError?.({ connectionKey, error });
        throw error;
      } finally {
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
  topicPolicyManifest: RealtimeTopicPolicyManifest,
): boolean {
  if (mode === "any") {
    return true;
  }

  if (mode === "public") {
    return topics.every((topic) =>
      resolveRealtimeTopicFamily(topic, topicPolicyManifest) !== "account"
    );
  }

  return topics.every((topic) =>
    resolveRealtimeTopicFamily(topic, topicPolicyManifest) === "account"
  );
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
  stream: Readonly<{ sleep: (ms: number) => Promise<unknown> }>,
  timeoutMs: number,
  topics: readonly string[],
  wakeSignal?: RealtimeWakeSignal,
): Promise<RealtimeWakeResult> {
  if (!wakeSignal) {
    await stream.sleep(timeoutMs);
    return "timeout";
  }

  return Promise.race([
    stream.sleep(timeoutMs).then(() => "timeout" as const),
    wakeSignal.wait(timeoutMs, topics),
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

function realtimeTopicsIntersect(
  subscribedTopics: readonly string[],
  notificationTopics: readonly string[],
): boolean {
  if (subscribedTopics.length === 0 || notificationTopics.length === 0) {
    return true;
  }

  const subscribed = new Set(subscribedTopics);
  return notificationTopics.some((topic) =>
    subscribed.has(topic) ||
    subscribedTopics.some((pattern) => matchesRealtimeTopicPattern(topic, pattern)),
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
