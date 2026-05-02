import type {
  PgPoolClient,
  PgQueryable,
  PgTransactionalPool,
} from "@chase-sets/event-core-postgres";
import type { GlobalPosition } from "@chase-sets/event-core/storage";
import {
  isRealtimeProjectionPatch,
  type RealtimeProjectionPatch,
  type RealtimeProjectionPatchChange,
} from "@chase-sets/realtime";
import {
  assertValidRealtimeTopics,
  normalizeRealtimeTopics,
} from "./realtime-topic-policy";

const REALTIME_OUTBOX_TABLE = "realtime_projection_outbox";
const REALTIME_OUTBOX_TOPIC_TABLE = "realtime_projection_outbox_topics";
const REALTIME_TOPIC_HEAD_TABLE = "realtime_projection_topic_heads";
const REALTIME_NOTIFY_CHANNEL = "realtime_projection_patch";
const DEFAULT_BATCH_SIZE = 100;
const DEFAULT_RETENTION_MS = 24 * 60 * 60 * 1_000;
const RETENTION_SWEEP_ADVISORY_LOCK_KEY = "8873012201";

export const realtimeProjectionNotifyChannel = REALTIME_NOTIFY_CHANNEL;
export const defaultRealtimeRetentionMs = DEFAULT_RETENTION_MS;

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

export type RealtimeTopicLag = Readonly<{
  contextName: string;
  topic: string;
  lag: number;
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

export type RealtimeCursor = Readonly<Record<string, string>>;

export type ReadRealtimePatchesOptions = Readonly<{
  pruneExpired?: boolean;
  includeTopicLag?: boolean;
  compactSummaries?: boolean;
}>;

type RealtimeOutboxRow = Readonly<{
  outbox_id: string | number | bigint;
  payload: unknown;
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

  return [...coalescedByKey.values()]
    .filter((input) => input.patch.changes.length > 0);
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
      return remaining <= 1;
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

export async function readRealtimeContextHeads(
  stores: readonly RealtimeContextStore[],
): Promise<RealtimeCursor> {
  const entries = await Promise.all(
    stores.map(async (store) => [store.contextName, await readContextHead(store.db)] as const),
  );

  return Object.fromEntries(entries);
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

export async function readRealtimeContextHead(db: PgQueryable): Promise<string> {
  return readContextHead(db);
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
