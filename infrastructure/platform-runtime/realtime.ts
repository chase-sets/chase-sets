import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type { GlobalPosition } from "@chase-sets/event-core/storage";
import type { ResolvedActor } from "./auth";

const REALTIME_OUTBOX_TABLE = "realtime_projection_outbox";
const REALTIME_OUTBOX_TOPIC_TABLE = "realtime_projection_outbox_topics";
const DEFAULT_BATCH_SIZE = 100;
const DEFAULT_POLL_INTERVAL_MS = 1_000;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 15_000;
const DEFAULT_RETENTION_PRUNE_INTERVAL_MS = 60_000;
const DEFAULT_RETENTION_MS = 24 * 60 * 60 * 1_000;
const RETENTION_SWEEP_ADVISORY_LOCK_KEY = "8873012201";
const MAX_TOPIC_COUNT = 16;
const MAX_TOPIC_LENGTH = 160;
const TOPIC_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

export const realtimeOutboxSchemaSql = `CREATE TABLE IF NOT EXISTS ${REALTIME_OUTBOX_TABLE} (
  outbox_id bigserial PRIMARY KEY,
  source_global_position bigint NOT NULL CHECK (source_global_position >= 0),
  projection_name text NOT NULL,
  patch_key text NOT NULL,
  topics jsonb NOT NULL,
  payload jsonb NOT NULL,
  recorded_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  CONSTRAINT ${REALTIME_OUTBOX_TABLE}_source_patch_uk UNIQUE (
    projection_name,
    source_global_position,
    patch_key
  )
);

CREATE INDEX IF NOT EXISTS ${REALTIME_OUTBOX_TABLE}_expires_idx
  ON ${REALTIME_OUTBOX_TABLE} (expires_at);

CREATE INDEX IF NOT EXISTS ${REALTIME_OUTBOX_TABLE}_outbox_idx
  ON ${REALTIME_OUTBOX_TABLE} (outbox_id ASC);

CREATE TABLE IF NOT EXISTS ${REALTIME_OUTBOX_TOPIC_TABLE} (
  topic text NOT NULL,
  outbox_id bigint NOT NULL REFERENCES ${REALTIME_OUTBOX_TABLE} (outbox_id) ON DELETE CASCADE,
  PRIMARY KEY (topic, outbox_id)
);

CREATE INDEX IF NOT EXISTS ${REALTIME_OUTBOX_TOPIC_TABLE}_outbox_idx
  ON ${REALTIME_OUTBOX_TOPIC_TABLE} (outbox_id);`;

export type RealtimeProjectionPatchChange =
  | Readonly<{ op: "upsert"; entity: string; id: string; value: unknown }>
  | Readonly<{ op: "remove"; entity: string; id: string }>
  | Readonly<{ op: "summary"; entity: string; id: string; value: unknown }>;

export type RealtimeProjectionPatch = Readonly<{
  kind: "projection.patch";
  context: string;
  projection: string;
  topics: readonly string[];
  changes: readonly RealtimeProjectionPatchChange[];
}>;

export type RealtimeSyncRequired = Readonly<{
  kind: "sync.required";
  reason: "cursor-expired";
  contexts: readonly string[];
}>;

export type RealtimeMessage = RealtimeProjectionPatch | RealtimeSyncRequired;

export type RealtimeContextRegistration = Readonly<{
  contextName: string;
  exactTopics?: readonly string[];
  topicPrefixes?: readonly string[];
}>;

export type RealtimeContextStore = RealtimeContextRegistration & Readonly<{
  db: PgQueryable;
}>;

export type RealtimeObserver = Readonly<{
  connectionOpened?: (event: RealtimeConnectionOpenedEvent) => void;
  connectionClosed?: (event: RealtimeConnectionClosedEvent) => void;
  authorizationRejected?: (event: RealtimeAuthorizationRejectedEvent) => void;
  batchRead?: (event: RealtimeBatchReadEvent) => void;
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
}>;

export type RealtimeAuthorizationRejectedEvent = Readonly<{
  topics: readonly string[];
  actorAccountId: string | null;
  reason: "forbidden" | "resource-limit";
}>;

export type RealtimeBatchReadEvent = Readonly<{
  topics: readonly string[];
  storeNames: readonly string[];
  messageCount: number;
  expiredContextCount: number;
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

export type RealtimeRetentionSweeper = Readonly<{
  sweep: () => Promise<void>;
  stop: () => void;
}>;

export type RecordRealtimeProjectionPatchInput = Readonly<{
  sourceGlobalPosition: GlobalPosition | string;
  projectionName: string;
  patchKey: string;
  topics: readonly string[];
  patch: RealtimeProjectionPatch;
  recordedAt?: string;
  retentionMs?: number;
}>;

type RealtimeOutboxRow = Readonly<{
  outbox_id: string | number | bigint;
  payload: unknown;
}>;

type RealtimeCursor = Readonly<Record<string, string>>;

type ReadRealtimePatchesOptions = Readonly<{
  pruneExpired?: boolean;
}>;

export async function recordRealtimeProjectionPatch(
  db: PgQueryable,
  input: RecordRealtimeProjectionPatchInput,
): Promise<void> {
  const topics = normalizeRealtimeTopics(input.topics);
  assertValidRealtimeTopics(topics);

  if (topics.length === 0 || input.patch.changes.length === 0) {
    return;
  }

  const recordedAt = input.recordedAt ?? new Date().toISOString();
  const expiresAt = new Date(
    new Date(recordedAt).getTime() + (input.retentionMs ?? DEFAULT_RETENTION_MS),
  ).toISOString();
  const patch = {
    ...input.patch,
    topics,
  } satisfies RealtimeProjectionPatch;

  await db.query(
    `WITH upserted AS (
       INSERT INTO ${REALTIME_OUTBOX_TABLE} (
       source_global_position,
       projection_name,
       patch_key,
       topics,
       payload,
       recorded_at,
       expires_at
       ) VALUES ($1::bigint, $2, $3, $4::jsonb, $5::jsonb, $6, $7)
       ON CONFLICT (projection_name, source_global_position, patch_key)
       DO UPDATE SET
         topics = EXCLUDED.topics,
         payload = EXCLUDED.payload,
         recorded_at = EXCLUDED.recorded_at,
         expires_at = EXCLUDED.expires_at
       RETURNING outbox_id
     ),
     removed_topics AS (
       DELETE FROM ${REALTIME_OUTBOX_TOPIC_TABLE}
       WHERE outbox_id IN (SELECT outbox_id FROM upserted)
     )
     INSERT INTO ${REALTIME_OUTBOX_TOPIC_TABLE} (outbox_id, topic)
     SELECT outbox_id, unnest($8::text[])
     FROM upserted
     ON CONFLICT DO NOTHING`,
    [
      input.sourceGlobalPosition,
      input.projectionName,
      input.patchKey,
      JSON.stringify(topics),
      JSON.stringify(patch),
      recordedAt,
      expiresAt,
      topics,
    ],
  );
}

export function encodeRealtimeCursor(cursor: RealtimeCursor): string {
  const json = JSON.stringify(cursor);
  return Buffer.from(json, "utf8")
    .toString("base64url");
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
  const values = [
    ...searchParams.getAll("topic"),
    ...searchParams.getAll("topics").flatMap((value) => value.split(",")),
  ];

  return normalizeRealtimeTopics(values);
}

export function authorizeRealtimeTopics(
  topics: readonly string[],
  actor: ResolvedActor | null,
): readonly string[] | null {
  const normalizedTopics = normalizeRealtimeTopics(topics);
  if (
    normalizedTopics.length === 0 ||
    normalizedTopics.length > MAX_TOPIC_COUNT ||
    !normalizedTopics.every(isRealtimeTopicShapeAllowed)
  ) {
    return null;
  }

  const allowed = normalizedTopics.every((topic) => isRealtimeTopicAllowed(topic, actor));
  return allowed ? normalizedTopics : null;
}

export function normalizeRealtimeTopics(topics: readonly string[]): readonly string[] {
  return [...new Set(topics.map((topic) => topic.trim()).filter(Boolean))].sort();
}

function assertValidRealtimeTopics(topics: readonly string[]): void {
  if (topics.length > MAX_TOPIC_COUNT) {
    throw new Error(`Realtime subscriptions cannot include more than ${MAX_TOPIC_COUNT} topics.`);
  }

  const invalidTopic = topics.find((topic) => !isRealtimeTopicShapeAllowed(topic));
  if (invalidTopic) {
    throw new Error(`Invalid realtime topic "${invalidTopic}".`);
  }
}

function isRealtimeTopicShapeAllowed(topic: string): boolean {
  if (topic.length > MAX_TOPIC_LENGTH) {
    return false;
  }

  if (topic === "public:market") {
    return true;
  }

  const segments = topic.split(":");
  if (
    segments.length === 2 &&
    (segments[0] === "item" || segments[0] === "listing" || segments[0] === "seller")
  ) {
    return TOPIC_ID_PATTERN.test(segments[1] ?? "");
  }

  return (
    segments.length === 3 &&
    segments[0] === "account" &&
    TOPIC_ID_PATTERN.test(segments[1] ?? "") &&
    (segments[2] === "listings" || segments[2] === "offers")
  );
}

function isRealtimeTopicAllowed(topic: string, actor: ResolvedActor | null): boolean {
  if (
    topic === "public:market" ||
    topic.startsWith("item:") ||
    topic.startsWith("listing:") ||
    topic.startsWith("seller:")
  ) {
    return true;
  }

  if (!actor || !topic.startsWith(`account:${actor.accountId}:`)) {
    return false;
  }

  if (topic.endsWith(":listings")) {
    return actor.permissions.includes("listings.view");
  }

  if (topic.endsWith(":offers")) {
    return actor.permissions.includes("offers.view");
  }

  return false;
}

export async function readRealtimePatches(
  stores: readonly RealtimeContextStore[],
  topics: readonly string[],
  cursor: RealtimeCursor,
  batchSize = DEFAULT_BATCH_SIZE,
  options: ReadRealtimePatchesOptions = {},
): Promise<Readonly<{
  cursor: RealtimeCursor;
  expiredContexts: readonly string[];
  messages: readonly Readonly<{
    contextName: string;
    outboxId: string;
    payload: RealtimeProjectionPatch;
  }>[];
}>> {
  const normalizedTopics = normalizeRealtimeTopics(topics);
  const matchingStores = selectRealtimeStoresForTopics(stores, normalizedTopics);
  const storeNames = new Set(matchingStores.map((store) => store.contextName));
  const nextCursor: Record<string, string> = Object.fromEntries(
    Object.entries(cursor).filter(([contextName]) => storeNames.has(contextName)),
  );
  const expiredContexts: string[] = [];
  const messages: Array<{
    contextName: string;
    outboxId: string;
    payload: RealtimeProjectionPatch;
  }> = [];

  for (const store of matchingStores) {
    if (options.pruneExpired !== false) {
      await pruneExpiredRealtimePatches(store.db);
    }

    const afterOutboxId = cursor[store.contextName] ?? "0";
    if (await isCursorExpired(store.db, afterOutboxId)) {
      expiredContexts.push(store.contextName);
      nextCursor[store.contextName] = await readContextHead(store.db);
      continue;
    }

    const result = await store.db.query<RealtimeOutboxRow>(
      `SELECT outbox_id, payload
       FROM ${REALTIME_OUTBOX_TABLE} AS outbox
       INNER JOIN ${REALTIME_OUTBOX_TOPIC_TABLE} AS topic
         ON topic.outbox_id = outbox.outbox_id
       WHERE outbox.outbox_id > $1::bigint
         AND outbox.expires_at > now()
         AND topic.topic = ANY($2::text[])
       GROUP BY outbox.outbox_id, outbox.payload
       ORDER BY outbox.outbox_id ASC
       LIMIT $3`,
      [afterOutboxId, normalizedTopics, batchSize],
    );

    for (const row of result.rows) {
      const outboxId = String(row.outbox_id);
      nextCursor[store.contextName] = outboxId;
      if (isRealtimeProjectionPatch(row.payload)) {
        messages.push({
          contextName: store.contextName,
          outboxId,
          payload: row.payload,
        });
      }
    }
  }

  return {
    cursor: nextCursor,
    expiredContexts,
    messages,
  };
}

export function selectRealtimeStoresForTopics(
  stores: readonly RealtimeContextStore[],
  topics: readonly string[],
): readonly RealtimeContextStore[] {
  return stores.filter((store) => {
    if (!store.exactTopics && !store.topicPrefixes) {
      return true;
    }

    return topics.some((topic) =>
      store.exactTopics?.includes(topic) ||
      store.topicPrefixes?.some((prefix) => topic.startsWith(prefix)),
    );
  });
}

function isRealtimeProjectionPatch(value: unknown): value is RealtimeProjectionPatch {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { kind?: unknown }).kind === "projection.patch" &&
    Array.isArray((value as { changes?: unknown }).changes)
  );
}

export async function pruneExpiredRealtimePatches(db: PgQueryable): Promise<number> {
  return pruneExpiredRealtimePatchesWithAdvisoryLock(db);
}

export async function pruneExpiredRealtimePatchesWithAdvisoryLock(
  db: PgQueryable,
  lockKey: string = RETENTION_SWEEP_ADVISORY_LOCK_KEY,
): Promise<number> {
  const result = await db.query<{ deleted_count: number | string }>(
    `WITH lock AS (
       SELECT pg_try_advisory_lock($1::bigint) AS acquired
     ),
     deleted AS (
       DELETE FROM ${REALTIME_OUTBOX_TABLE}
       WHERE expires_at <= now()
         AND (SELECT acquired FROM lock)
       RETURNING 1
     ),
     unlocked AS (
       SELECT CASE
         WHEN (SELECT acquired FROM lock) THEN pg_advisory_unlock($1::bigint)
         ELSE false
       END AS released
     )
     SELECT (SELECT COUNT(*) FROM deleted)::integer AS deleted_count
     FROM unlocked`,
    [lockKey],
  );

  return Number(result.rows[0]?.deleted_count ?? 0);
}

async function isCursorExpired(db: PgQueryable, afterOutboxId: string): Promise<boolean> {
  if (afterOutboxId === "0") {
    return false;
  }

  const result = await db.query<{ min_outbox_id: string | null }>(
    `SELECT MIN(outbox_id)::text AS min_outbox_id
     FROM ${REALTIME_OUTBOX_TABLE}
     WHERE expires_at > now()`,
  );
  const minOutboxId = result.rows[0]?.min_outbox_id;

  return minOutboxId !== null && BigInt(afterOutboxId) < BigInt(minOutboxId) - 1n;
}

async function readContextHead(db: PgQueryable): Promise<string> {
  const result = await db.query<{ head: string | null }>(
    `SELECT COALESCE(MAX(outbox_id), 0)::text AS head FROM ${REALTIME_OUTBOX_TABLE}`,
  );
  return result.rows[0]?.head ?? "0";
}

export function createRealtimeRoutes(options: Readonly<{
  stores: readonly RealtimeContextStore[];
  resolveActor: (request: Request) => Promise<ResolvedActor | null>;
  observer?: RealtimeObserver;
  resourceLimits?: RealtimeResourceLimits;
  pollIntervalMs?: number;
  heartbeatIntervalMs?: number;
  retentionPruneIntervalMs?: number;
  batchSize?: number;
}>) {
  const app = new Hono();
  const nextPruneAtByContext = new Map<string, number>();
  let activeStreamCount = 0;
  const activeStreamsByConnectionKey = new Map<string, number>();

  app.get("/events", async (c) => {
    const url = new URL(c.req.url);
    const topics = parseRealtimeTopics(url.searchParams);
    const actor = await options.resolveActor(c.req.raw);
    const authorizedTopics = authorizeRealtimeTopics(topics, actor);
    const maxTopicsPerStream =
      options.resourceLimits?.maxTopicsPerStream ?? MAX_TOPIC_COUNT;

    if (!authorizedTopics || authorizedTopics.length > maxTopicsPerStream) {
      options.observer?.authorizationRejected?.({
        topics,
        actorAccountId: actor?.accountId ?? null,
        reason: "forbidden",
      });
      return c.json({ error: { code: "authorization_forbidden", message: "Forbidden." } }, 403);
    }

    let cursor = decodeRealtimeCursor(c.req.header("last-event-id"));
    const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    const heartbeatIntervalMs =
      options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
    const retentionPruneIntervalMs =
      options.retentionPruneIntervalMs ?? DEFAULT_RETENTION_PRUNE_INTERVAL_MS;
    const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
    const matchingStores = selectRealtimeStoresForTopics(options.stores, authorizedTopics);
    const connectionKey = resolveRealtimeConnectionKey(c.req.raw, actor);
    const activeForConnectionKey = activeStreamsByConnectionKey.get(connectionKey) ?? 0;
    if (
      isRealtimeResourceLimitExceeded({
        activeStreamCount,
        activeForConnectionKey,
        resourceLimits: options.resourceLimits,
      })
    ) {
      options.observer?.authorizationRejected?.({
        topics: authorizedTopics,
        actorAccountId: actor?.accountId ?? null,
        reason: "resource-limit",
      });
      return c.json({ error: { code: "too_many_realtime_streams", message: "Too many realtime streams." } }, 429);
    }

    return streamSSE(c, async (stream) => {
      let nextHeartbeatAt = Date.now() + heartbeatIntervalMs;
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
            retentionPruneIntervalMs,
            options.observer,
          );
          const batch = await readRealtimePatches(
            matchingStores,
            authorizedTopics,
            cursor,
            batchSize,
            { pruneExpired: false },
          );
          cursor = batch.cursor;
          const cursorId = encodeRealtimeCursor(cursor);
          options.observer?.batchRead?.({
            topics: authorizedTopics,
            storeNames: matchingStores.map((store) => store.contextName),
            messageCount: batch.messages.length,
            expiredContextCount: batch.expiredContexts.length,
          });

          if (batch.expiredContexts.length > 0) {
            await stream.writeSSE({
              id: cursorId,
              event: "sync.required",
              data: JSON.stringify({
                kind: "sync.required",
                reason: "cursor-expired",
                contexts: batch.expiredContexts,
              } satisfies RealtimeSyncRequired),
            });
          }

          for (const message of batch.messages) {
            await stream.writeSSE({
              id: encodeRealtimeCursor({
                ...cursor,
                [message.contextName]: message.outboxId,
              }),
              event: message.payload.kind,
              data: JSON.stringify(message.payload),
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
            nextHeartbeatAt = Date.now() + heartbeatIntervalMs;
          }

          await stream.sleep(pollIntervalMs);
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
        });
      }
    });
  });

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
  resourceLimits?: RealtimeResourceLimits;
}>): boolean {
  const maxActiveStreams = input.resourceLimits?.maxActiveStreams;
  if (
    typeof maxActiveStreams === "number" &&
    input.activeStreamCount >= maxActiveStreams
  ) {
    return true;
  }

  const maxActiveStreamsPerConnectionKey =
    input.resourceLimits?.maxActiveStreamsPerConnectionKey;
  return (
    typeof maxActiveStreamsPerConnectionKey === "number" &&
    input.activeForConnectionKey >= maxActiveStreamsPerConnectionKey
  );
}
