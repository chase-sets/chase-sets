import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type {
  PgPoolClient,
  PgQueryable,
  PgTransactionalPool,
} from "@chase-sets/event-core-postgres";
import type { GlobalPosition } from "@chase-sets/event-core/storage";
import {
  isRealtimeProjectionPatch,
  type RealtimeMessage,
  type RealtimeProjectionPatch,
  type RealtimeProjectionPatchChange,
  type RealtimeSyncRequired,
} from "@chase-sets/realtime";
import type { ResolvedActor } from "./auth";

const REALTIME_OUTBOX_TABLE = "realtime_projection_outbox";
const REALTIME_OUTBOX_TOPIC_TABLE = "realtime_projection_outbox_topics";
const REALTIME_TOPIC_HEAD_TABLE = "realtime_projection_topic_heads";
const REALTIME_NOTIFY_CHANNEL = "realtime_projection_patch";
const DEFAULT_BATCH_SIZE = 100;
const DEFAULT_POLL_INTERVAL_MS = 1_000;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 15_000;
const DEFAULT_RETENTION_PRUNE_INTERVAL_MS = 60_000;
const DEFAULT_RETENTION_MS = 24 * 60 * 60 * 1_000;
const DEFAULT_MAX_CONSECUTIVE_FULL_BATCHES = 3;
const RETENTION_SWEEP_ADVISORY_LOCK_KEY = "8873012201";
const MAX_TOPIC_COUNT = 16;
const MAX_TOPIC_LENGTH = 160;
const TOPIC_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

export const realtimeProjectionNotifyChannel = REALTIME_NOTIFY_CHANNEL;

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
  ON ${REALTIME_OUTBOX_TOPIC_TABLE} (outbox_id);

CREATE TABLE IF NOT EXISTS ${REALTIME_TOPIC_HEAD_TABLE} (
  topic text PRIMARY KEY,
  outbox_id bigint NOT NULL REFERENCES ${REALTIME_OUTBOX_TABLE} (outbox_id) ON DELETE CASCADE,
  updated_at timestamptz NOT NULL
);`;

export type {
  RealtimeMessage,
  RealtimeProjectionPatch,
  RealtimeProjectionPatchChange,
  RealtimeSyncRequired,
} from "@chase-sets/realtime";

export type RealtimeContextRegistration = Readonly<{
  contextName: string;
  exactTopics?: readonly string[];
  topicPrefixes?: readonly string[];
}>;

export type RealtimeTopicManifest<TTopics extends Record<string, (...args: any[]) => string>> =
  RealtimeContextRegistration & Readonly<{
    topics: TTopics;
  }>;

export type RealtimeContextStore = RealtimeContextRegistration & Readonly<{
  db: PgQueryable;
}>;

export type RealtimeObserver = Readonly<{
  connectionOpened?: (event: RealtimeConnectionOpenedEvent) => void;
  connectionClosed?: (event: RealtimeConnectionClosedEvent) => void;
  authorizationRejected?: (event: RealtimeAuthorizationRejectedEvent) => void;
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

export type RealtimeBatchReadEvent = Readonly<{
  topics: readonly string[];
  storeNames: readonly string[];
  messageCount: number;
  expiredContextCount: number;
  topicLags: readonly RealtimeTopicLag[];
}>;

export type RealtimeTopicLag = Readonly<{
  contextName: string;
  topic: string;
  lag: number;
}>;

export type RealtimeMessageSentEvent = Readonly<{
  contextName: string;
  eventKind: RealtimeProjectionPatch["kind"];
  topicCount: number;
}>;

export type RealtimeSyncRequiredEvent = Readonly<{
  reason: RealtimeSyncRequired["reason"];
  contexts: readonly string[];
  topicCount: number;
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
  routeTuning: Required<RealtimeRouteTuning>;
  resourceLimits: Required<RealtimeResourceLimits>;
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
  includeTopicLag?: boolean;
  compactSummaries?: boolean;
}>;

type RealtimeTopicPolicy = Readonly<{
  name: string;
  match: (topic: string) => RealtimeTopicMatch | null;
  authorize: (match: RealtimeTopicMatch, actor: ResolvedActor | null) => boolean;
}>;

type RealtimeTopicMatch = Readonly<{
  family: string;
  accountId?: string;
  permission?: "listings.view" | "offers.view";
}>;

const realtimeTopicPolicies: readonly RealtimeTopicPolicy[] = [
  {
    name: "public-market",
    match: (topic) => topic === "public:market" ? { family: "public" } : null,
    authorize: () => true,
  },
  {
    name: "public-entity",
    match: (topic) => {
      const segments = topic.split(":");
      if (
        segments.length === 2 &&
        (segments[0] === "item" || segments[0] === "listing" || segments[0] === "seller") &&
        TOPIC_ID_PATTERN.test(segments[1] ?? "")
      ) {
        return { family: segments[0] };
      }

      return null;
    },
    authorize: () => true,
  },
  {
    name: "account-surface",
    match: (topic) => {
      const segments = topic.split(":");
      if (
        segments.length !== 3 ||
        segments[0] !== "account" ||
        !TOPIC_ID_PATTERN.test(segments[1] ?? "")
      ) {
        return null;
      }

      if (segments[2] === "listings") {
        return { family: "account", accountId: segments[1], permission: "listings.view" };
      }

      if (segments[2] === "offers") {
        return { family: "account", accountId: segments[1], permission: "offers.view" };
      }

      return null;
    },
    authorize: (match, actor) =>
      Boolean(
        actor &&
        match.accountId === actor.accountId &&
        match.permission &&
        actor.permissions.includes(match.permission),
      ),
  },
];

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

export async function runRealtimeProjectionTransaction<T>(
  db: PgQueryable | PgTransactionalPool,
  work: (db: PgQueryable) => Promise<T>,
): Promise<T> {
  if (!isPgTransactionalPool(db)) {
    return work(db);
  }

  const client = await db.connect();
  return withPgTransaction(client, work);
}

export async function createPostgresRealtimeWakeSignal(
  client: PostgresRealtimeNotificationClient,
): Promise<RealtimeWakeSignal> {
  const waiters = new Set<() => void>();
  const notify = (message: Readonly<{ channel: string }>) => {
    if (message.channel !== REALTIME_NOTIFY_CHANNEL) {
      return;
    }

    const pending = [...waiters];
    waiters.clear();
    for (const resolve of pending) {
      resolve();
    }
  };

  client.on("notification", notify);
  await client.query(`LISTEN ${REALTIME_NOTIFY_CHANNEL}`);

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
      await client.query(`UNLISTEN ${REALTIME_NOTIFY_CHANNEL}`);
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
    wait: async (timeoutMs) => {
      const result = await Promise.race(
        activeWakeSignals.map((signal) => signal.wait(timeoutMs)),
      );
      return result;
    },
    stop: async () => {
      await Promise.all(activeWakeSignals.map((signal) => signal.stop?.()));
    },
  };
}

export async function recordRealtimeProjectionPatch(
  db: PgQueryable,
  input: RecordRealtimeProjectionPatchInput,
): Promise<void> {
  const topics = normalizeRealtimeTopics(input.topics);
  assertValidRealtimeTopics(topics);
  assertValidRealtimeProjectionPatch(input, topics);

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
       RETURNING 1
     ),
     inserted_topics AS (
       INSERT INTO ${REALTIME_OUTBOX_TOPIC_TABLE} (outbox_id, topic)
       SELECT outbox_id, unnest($8::text[])
       FROM upserted
       ON CONFLICT DO NOTHING
       RETURNING 1
     ),
     updated_topic_heads AS (
       INSERT INTO ${REALTIME_TOPIC_HEAD_TABLE} (topic, outbox_id, updated_at)
       SELECT requested.topic, outbox_id, $6
       FROM upserted, unnest($8::text[]) AS requested(topic)
       ON CONFLICT (topic) DO UPDATE SET
         outbox_id = GREATEST(${REALTIME_TOPIC_HEAD_TABLE}.outbox_id, EXCLUDED.outbox_id),
         updated_at = EXCLUDED.updated_at
       RETURNING 1
     ),
     notified AS (
       SELECT pg_notify(
         $9,
         json_build_object(
           'context', $10::text,
           'projection', $2::text
         )::text
       )
     )
     SELECT
       (SELECT COUNT(*) FROM inserted_topics)::integer AS inserted_topic_count,
       (SELECT COUNT(*) FROM removed_topics)::integer AS replaced_topic_count,
       (SELECT COUNT(*) FROM updated_topic_heads)::integer AS updated_topic_head_count
     FROM notified`,
    [
      input.sourceGlobalPosition,
      input.projectionName,
      input.patchKey,
      JSON.stringify(topics),
      JSON.stringify(patch),
      recordedAt,
      expiresAt,
      topics,
      REALTIME_NOTIFY_CHANNEL,
      patch.context,
    ],
  );
}

export async function recordRealtimeProjectionPatches(
  db: PgQueryable | PgTransactionalPool,
  inputs: readonly RecordRealtimeProjectionPatchInput[],
): Promise<void> {
  const coalescedInputs = coalesceRealtimeProjectionPatchInputs(inputs);
  if (coalescedInputs.length === 0) {
    return;
  }

  await runRealtimeProjectionTransaction(db, async (tx) => {
    for (const input of coalescedInputs) {
      await recordRealtimeProjectionPatch(tx, input);
    }
  });
}

export function coalesceRealtimeProjectionPatchInputs(
  inputs: readonly RecordRealtimeProjectionPatchInput[],
): readonly RecordRealtimeProjectionPatchInput[] {
  const coalescedByKey = new Map<string, RecordRealtimeProjectionPatchInput>();

  for (const input of inputs) {
    const topics = normalizeRealtimeTopics(input.topics);
    const key = [
      input.projectionName,
      String(input.sourceGlobalPosition),
      input.patchKey,
      topics.join("\u001f"),
    ].join("\u001e");
    const previous = coalescedByKey.get(key);
    if (!previous) {
      coalescedByKey.set(key, {
        ...input,
        topics,
        patch: {
          ...input.patch,
          topics,
          changes: compactRealtimePatchChanges(input.patch.changes),
        },
      });
      continue;
    }

    coalescedByKey.set(key, {
      ...previous,
      recordedAt: input.recordedAt ?? previous.recordedAt,
      retentionMs: input.retentionMs ?? previous.retentionMs,
      patch: {
        ...previous.patch,
        changes: compactRealtimePatchChanges([
          ...previous.patch.changes,
          ...input.patch.changes,
        ]),
      },
    });
  }

  return [...coalescedByKey.values()];
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
    !normalizedTopics.every((topic) => resolveRealtimeTopicPolicy(topic))
  ) {
    return null;
  }

  const allowed = normalizedTopics.every((topic) => {
    const policyMatch = resolveRealtimeTopicPolicy(topic);
    return policyMatch ? policyMatch.policy.authorize(policyMatch.match, actor) : false;
  });
  return allowed ? normalizedTopics : null;
}

export function normalizeRealtimeTopics(topics: readonly string[]): readonly string[] {
  return [...new Set(topics.map((topic) => topic.trim()).filter(Boolean))].sort();
}

function assertValidRealtimeTopics(topics: readonly string[]): void {
  if (topics.length > MAX_TOPIC_COUNT) {
    throw new Error(`Realtime subscriptions cannot include more than ${MAX_TOPIC_COUNT} topics.`);
  }

  const invalidTopic = topics.find((topic) => !resolveRealtimeTopicPolicy(topic));
  if (invalidTopic) {
    throw new Error(`Invalid realtime topic "${invalidTopic}".`);
  }
}

function resolveRealtimeTopicPolicy(topic: string): Readonly<{
  policy: RealtimeTopicPolicy;
  match: RealtimeTopicMatch;
}> | null {
  if (topic.length > MAX_TOPIC_LENGTH) {
    return null;
  }

  for (const policy of realtimeTopicPolicies) {
    const match = policy.match(topic);
    if (match) {
      return { policy, match };
    }
  }

  return null;
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
  topicLags: readonly RealtimeTopicLag[];
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
  const topicLags: RealtimeTopicLag[] = [];
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

    if (options.includeTopicLag) {
      topicLags.push(
        ...(await readTopicLags(store, normalizedTopics, nextCursor[store.contextName] ?? afterOutboxId)),
      );
    }
  }

  const replayMessages =
    options.compactSummaries === false
      ? messages
      : compactRealtimeReplayMessages(messages);

  return {
    cursor: nextCursor,
    expiredContexts,
    topicLags,
    messages: replayMessages,
  };
}

export function compactRealtimeReplayMessages<
  TMessage extends Readonly<{
    payload: RealtimeProjectionPatch;
  }>,
>(messages: readonly TMessage[]): readonly TMessage[] {
  const remainingSummaryCounts = new Map<string, number>();
  for (const message of messages) {
    for (const change of message.payload.changes) {
      if (change.op === "summary") {
        const key = `${change.entity}\u001f${change.id}`;
        remainingSummaryCounts.set(key, (remainingSummaryCounts.get(key) ?? 0) + 1);
      }
    }
  }

  return messages.flatMap((message) => {
    const changes = message.payload.changes.filter((change) => {
      if (change.op !== "summary") {
        return true;
      }

      const key = `${change.entity}\u001f${change.id}`;
      const remaining = remainingSummaryCounts.get(key) ?? 0;
      remainingSummaryCounts.set(key, Math.max(0, remaining - 1));
      if (remaining > 1) {
        return false;
      }

      return true;
    });

    return changes.length === 0
      ? []
      : [{
          ...message,
          payload: {
            ...message.payload,
            changes,
          },
        } as TMessage];
  });
}

function compactRealtimePatchChanges(
  changes: readonly RealtimeProjectionPatchChange[],
): readonly RealtimeProjectionPatchChange[] {
  const latestIndexByEntity = new Map<string, number>();
  changes.forEach((change, index) => {
    latestIndexByEntity.set(`${change.entity}\u001f${change.id}`, index);
  });

  return changes.filter((change, index) =>
    latestIndexByEntity.get(`${change.entity}\u001f${change.id}`) === index,
  );
}

export async function readRealtimeContextHeads(
  stores: readonly RealtimeContextStore[],
): Promise<RealtimeCursor> {
  const entries = await Promise.all(
    stores.map(async (store) => [store.contextName, await readContextHead(store.db)] as const),
  );

  return Object.fromEntries(entries);
}

export async function createRealtimeStatusSnapshot(options: Readonly<{
  stores: readonly RealtimeContextStore[];
  activeConnectionCount?: number;
  wakeSignalConfigured?: boolean;
  routeTuning?: RealtimeRouteTuning;
  resourceLimits?: RealtimeResourceLimits;
  retentionMs?: number;
}>): Promise<RealtimeStatusSnapshot> {
  return {
    activeConnectionCount: options.activeConnectionCount ?? 0,
    retentionMs: options.retentionMs ?? DEFAULT_RETENTION_MS,
    wakeSignalConfigured: options.wakeSignalConfigured ?? false,
    routeTuning: {
      pollIntervalMs: options.routeTuning?.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
      heartbeatIntervalMs: options.routeTuning?.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS,
      retentionPruneIntervalMs:
        options.routeTuning?.retentionPruneIntervalMs ?? DEFAULT_RETENTION_PRUNE_INTERVAL_MS,
      batchSize: options.routeTuning?.batchSize ?? DEFAULT_BATCH_SIZE,
      maxConsecutiveFullBatches:
        options.routeTuning?.maxConsecutiveFullBatches ?? DEFAULT_MAX_CONSECUTIVE_FULL_BATCHES,
    },
    resourceLimits: {
      maxTopicsPerStream: options.resourceLimits?.maxTopicsPerStream ?? MAX_TOPIC_COUNT,
      maxActiveStreams: options.resourceLimits?.maxActiveStreams ?? 1_000,
      maxActiveStreamsPerConnectionKey:
        options.resourceLimits?.maxActiveStreamsPerConnectionKey ?? 6,
    },
    stores: await Promise.all(
      options.stores.map(async (store) => ({
        contextName: store.contextName,
        exactTopics: store.exactTopics ?? [],
        topicPrefixes: store.topicPrefixes ?? [],
        head: await readContextHead(store.db),
      })),
    ),
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

function assertValidRealtimeProjectionPatch(
  input: RecordRealtimeProjectionPatchInput,
  topics: readonly string[],
): void {
  const patch = input.patch;
  if (patch.kind !== "projection.patch") {
    throw new Error("Realtime projection patch kind must be projection.patch.");
  }

  if (!patch.context.trim()) {
    throw new Error("Realtime projection patch context is required.");
  }

  if (patch.projection !== input.projectionName) {
    throw new Error("Realtime projection patch projection must match the outbox projection name.");
  }

  if (!areStringArraysEqual(normalizeRealtimeTopics(patch.topics), topics)) {
    throw new Error("Realtime projection patch topics must match the outbox topics.");
  }

  if (topics.length === 0) {
    throw new Error("Realtime projection patches require at least one topic.");
  }

  if (patch.changes.length === 0) {
    throw new Error("Realtime projection patches require at least one change.");
  }

  for (const change of patch.changes) {
    if (!change.entity.trim() || !change.id.trim()) {
      throw new Error("Realtime projection patch changes require entity and id.");
    }

    if ((change.op === "upsert" || change.op === "summary") && !("value" in change)) {
      throw new Error("Realtime projection patch upsert and summary changes require value.");
    }
  }
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

async function readTopicLags(
  store: RealtimeContextStore,
  topics: readonly string[],
  afterOutboxId: string,
): Promise<RealtimeTopicLag[]> {
  const result = await store.db.query<{
    topic: string;
    lag: string | number;
  }>(
    `SELECT requested.topic,
            GREATEST(COALESCE(head.outbox_id, 0) - $1::bigint, 0)::text AS lag
     FROM unnest($2::text[]) AS requested(topic)
     LEFT JOIN ${REALTIME_TOPIC_HEAD_TABLE} AS head
       ON head.topic = requested.topic
     LEFT JOIN ${REALTIME_OUTBOX_TABLE} AS outbox
       ON outbox.outbox_id = head.outbox_id
      AND outbox.expires_at > now()
     WHERE outbox.outbox_id IS NOT NULL OR head.outbox_id IS NULL
     ORDER BY requested.topic ASC`,
    [afterOutboxId, topics],
  );

  return result.rows.map((row) => ({
    contextName: store.contextName,
    topic: row.topic,
    lag: Number(row.lag),
  }));
}

export function createRealtimeRoutes(options: Readonly<{
  stores: readonly RealtimeContextStore[];
  resolveActor: (request: Request) => Promise<ResolvedActor | null>;
  observer?: RealtimeObserver;
  resourceLimits?: RealtimeResourceLimits;
  wakeSignal?: RealtimeWakeSignal;
  pollIntervalMs?: number;
  heartbeatIntervalMs?: number;
  retentionPruneIntervalMs?: number;
  batchSize?: number;
  maxConsecutiveFullBatches?: number;
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
    const maxConsecutiveFullBatches =
      options.maxConsecutiveFullBatches ?? DEFAULT_MAX_CONSECUTIVE_FULL_BATCHES;
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
      const openedAt = performance.now();
      let nextHeartbeatAt = Date.now() + heartbeatIntervalMs;
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
            retentionPruneIntervalMs,
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
            await stream.writeSSE({
              id: encodeRealtimeCursor(cursor),
              event: "sync.required",
              data: JSON.stringify({
                kind: "sync.required",
                reason: "replay-backpressure",
                contexts: matchingStores.map((store) => store.contextName),
              } satisfies RealtimeSyncRequired),
            });
            options.observer?.syncRequired?.({
              reason: "replay-backpressure",
              contexts: matchingStores.map((store) => store.contextName),
              topicCount: authorizedTopics.length,
            });
            options.observer?.wakeWaitEnded?.({
              result: await sleepUntilRealtimeWake(stream, pollIntervalMs, options.wakeSignal),
            });
            continue;
          }

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
            options.observer?.syncRequired?.({
              reason: "cursor-expired",
              contexts: batch.expiredContexts,
              topicCount: authorizedTopics.length,
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
            options.observer?.messageSent?.({
              contextName: message.contextName,
              eventKind: message.payload.kind,
              topicCount: message.payload.topics.length,
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

          options.observer?.wakeWaitEnded?.({
            result: await sleepUntilRealtimeWake(stream, pollIntervalMs, options.wakeSignal),
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

async function withPgTransaction<T>(
  client: PgPoolClient,
  work: (client: PgPoolClient) => Promise<T>,
): Promise<T> {
  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

function isPgTransactionalPool(db: PgQueryable | PgTransactionalPool): db is PgTransactionalPool {
  return typeof (db as { connect?: unknown }).connect === "function";
}

function areStringArraysEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
