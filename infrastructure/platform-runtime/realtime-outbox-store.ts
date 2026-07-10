import { type PgQueryable, type PgTransactionalPool, withPgTransaction } from "@chase-sets/event-core-postgres";
import type { GlobalPosition } from "@chase-sets/event-core/storage";
import {
  isRealtimeProjectionPatch,
  type RealtimeProjectionPatch,
  type RealtimeProjectionPatchChange,
} from "@chase-sets/realtime";
import {
  assertValidRealtimeTopics,
  normalizeRealtimeTopics,
  type RealtimeTopicPolicyManifest,
} from "./realtime-topic-policy";
import { emitPostgresWorkSignalNotification } from "./work-signal-composite";

const REALTIME_OUTBOX_TABLE = "realtime_projection_outbox";
const REALTIME_OUTBOX_TOPIC_TABLE = "realtime_projection_outbox_topics";
const REALTIME_TOPIC_HEAD_TABLE = "realtime_projection_topic_heads";
const REALTIME_OUTBOX_RETENTION_TABLE = "realtime_projection_outbox_retention";
const REALTIME_NOTIFY_CHANNEL = "realtime_projection_patch";
const DEFAULT_BATCH_SIZE = 100;
const DEFAULT_RETENTION_MS = 24 * 60 * 60 * 1_000;
const DEFAULT_MAX_PATCH_CHANGE_COUNT = 500;
const DEFAULT_MAX_PATCH_PAYLOAD_BYTES = 64 * 1_024;
const RETENTION_SWEEP_ADVISORY_LOCK_KEY = "8873012201";
const REALTIME_OUTBOX_APPEND_ADVISORY_LOCK_KEY = "-5927634652584768510";

export const realtimeProjectionNotifyChannel = REALTIME_NOTIFY_CHANNEL;
export const defaultRealtimeRetentionMs = DEFAULT_RETENTION_MS;

export const realtimeOutboxSchemaSql = `CREATE TABLE IF NOT EXISTS ${REALTIME_OUTBOX_TABLE} (
  outbox_id bigserial PRIMARY KEY,
  source_global_position bigint NOT NULL CHECK (source_global_position >= 0),
  projection_name text NOT NULL,
  patch_key text NOT NULL,
  topics jsonb NOT NULL,
  payload_json text NOT NULL,
  payload_kind text NOT NULL,
  payload_context text NOT NULL,
  payload_projection text NOT NULL,
  payload_bytes integer NOT NULL CHECK (payload_bytes >= 0),
  recorded_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  CONSTRAINT ${REALTIME_OUTBOX_TABLE}_source_patch_uk UNIQUE (
    projection_name,
    source_global_position,
    patch_key
  )
);

ALTER TABLE ${REALTIME_OUTBOX_TABLE}
  ADD COLUMN IF NOT EXISTS payload_json text;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_name = '${REALTIME_OUTBOX_TABLE}'
      AND column_name = 'payload'
  ) THEN
    EXECUTE 'UPDATE ${REALTIME_OUTBOX_TABLE} SET payload_json = payload::text WHERE payload_json IS NULL';
  END IF;
END $$;

ALTER TABLE ${REALTIME_OUTBOX_TABLE}
  ADD COLUMN IF NOT EXISTS payload_kind text;

ALTER TABLE ${REALTIME_OUTBOX_TABLE}
  ADD COLUMN IF NOT EXISTS payload_context text;

ALTER TABLE ${REALTIME_OUTBOX_TABLE}
  ADD COLUMN IF NOT EXISTS payload_projection text;

ALTER TABLE ${REALTIME_OUTBOX_TABLE}
  ADD COLUMN IF NOT EXISTS payload_bytes integer CHECK (payload_bytes >= 0);

UPDATE ${REALTIME_OUTBOX_TABLE}
SET payload_json = '{}'::jsonb::text
WHERE payload_json IS NULL;

UPDATE ${REALTIME_OUTBOX_TABLE}
SET payload_kind = COALESCE(payload_json::jsonb ->> 'kind', 'projection.patch')
WHERE payload_kind IS NULL;

UPDATE ${REALTIME_OUTBOX_TABLE}
SET payload_context = COALESCE(payload_json::jsonb ->> 'context', '')
WHERE payload_context IS NULL;

UPDATE ${REALTIME_OUTBOX_TABLE}
SET payload_projection = COALESCE(payload_json::jsonb ->> 'projection', projection_name)
WHERE payload_projection IS NULL;

UPDATE ${REALTIME_OUTBOX_TABLE}
SET payload_bytes = octet_length(payload_json)
WHERE payload_bytes IS NULL;

ALTER TABLE ${REALTIME_OUTBOX_TABLE}
  ALTER COLUMN payload_json SET NOT NULL;

ALTER TABLE ${REALTIME_OUTBOX_TABLE}
  ALTER COLUMN payload_kind SET NOT NULL;

ALTER TABLE ${REALTIME_OUTBOX_TABLE}
  ALTER COLUMN payload_context SET NOT NULL;

ALTER TABLE ${REALTIME_OUTBOX_TABLE}
  ALTER COLUMN payload_projection SET NOT NULL;

ALTER TABLE ${REALTIME_OUTBOX_TABLE}
  ALTER COLUMN payload_bytes SET NOT NULL;

ALTER TABLE ${REALTIME_OUTBOX_TABLE}
  DROP COLUMN IF EXISTS payload;

CREATE INDEX IF NOT EXISTS ${REALTIME_OUTBOX_TABLE}_expires_idx
  ON ${REALTIME_OUTBOX_TABLE} (expires_at);

CREATE INDEX IF NOT EXISTS ${REALTIME_OUTBOX_TABLE}_outbox_idx
  ON ${REALTIME_OUTBOX_TABLE} (outbox_id ASC);

CREATE INDEX IF NOT EXISTS ${REALTIME_OUTBOX_TABLE}_payload_contract_idx
  ON ${REALTIME_OUTBOX_TABLE} (payload_context, payload_projection, payload_kind);

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
);

CREATE TABLE IF NOT EXISTS ${REALTIME_OUTBOX_RETENTION_TABLE} (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  pruned_through_outbox_id bigint NOT NULL DEFAULT 0 CHECK (pruned_through_outbox_id >= 0),
  updated_at timestamptz NOT NULL
);`;

export const realtimeOutboxPartitionMetadataSql = `CREATE TABLE IF NOT EXISTS realtime_projection_outbox_partitions (
  partition_name text PRIMARY KEY,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  dropped_at timestamptz
);

CREATE INDEX IF NOT EXISTS realtime_projection_outbox_partitions_range_idx
  ON realtime_projection_outbox_partitions (starts_at, ends_at);`;
export const realtimeOutboxPartitionMaintenanceSql = realtimeOutboxPartitionMetadataSql;

export function createRealtimeOutboxPartitionName(day: string): string {
  if (!/^\d{4}_\d{2}_\d{2}$/.test(day)) {
    throw new Error("Realtime outbox partition day must use YYYY_MM_DD.");
  }

  return `${REALTIME_OUTBOX_TABLE}_${day}`;
}

export type RealtimeOutboxPartitionMaintainer = Readonly<{
  maintain: () => Promise<void>;
  stop: () => void;
}>;

export function createRealtimeOutboxPartitionMaintainer(
  options: Readonly<{
    db: PgQueryable;
    aheadDays?: number;
    retentionDays?: number;
    intervalMs?: number;
    now?: () => Date;
    onError?: (error: unknown) => void;
  }>,
): RealtimeOutboxPartitionMaintainer {
  const aheadDays = options.aheadDays ?? 2;
  const retentionDays = options.retentionDays ?? 2;
  const now = options.now ?? (() => new Date());
  let running = false;

  const maintain = async () => {
    if (running) {
      return;
    }

    running = true;
    try {
      await options.db.query(realtimeOutboxPartitionMetadataSql);
      const start = startOfUtcDay(now());
      for (let offset = 0; offset <= aheadDays; offset += 1) {
        const startsAt = addUtcDays(start, offset);
        const endsAt = addUtcDays(startsAt, 1);
        await options.db.query(
          `INSERT INTO realtime_projection_outbox_partitions (
             partition_name,
             starts_at,
             ends_at
           ) VALUES ($1, $2, $3)
           ON CONFLICT (partition_name) DO NOTHING`,
          [
            createRealtimeOutboxPartitionName(formatUtcPartitionDay(startsAt)),
            startsAt.toISOString(),
            endsAt.toISOString(),
          ],
        );
      }

      await options.db.query(
        `UPDATE realtime_projection_outbox_partitions
         SET dropped_at = $1
         WHERE ends_at < $2
           AND dropped_at IS NULL`,
        [now().toISOString(), addUtcDays(start, -retentionDays).toISOString()],
      );
    } catch (error) {
      options.onError?.(error);
    } finally {
      running = false;
    }
  };

  const timer = setInterval(
    () => {
      void maintain();
    },
    options.intervalMs ?? 60 * 60 * 1_000,
  );
  timer.unref?.();

  return {
    maintain,
    stop: () => clearInterval(timer),
  };
}

export type RealtimeContextRegistration = Readonly<{
  contextName: string;
  exactTopics?: readonly string[];
  topicPrefixes?: readonly string[];
}>;

export type RealtimeTopicManifest<TTopics extends Record<string, (...args: never[]) => string>> =
  RealtimeContextRegistration &
    Readonly<{
      topics: TTopics;
    }>;

export type RealtimeContextStore = RealtimeContextRegistration &
  Readonly<{
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
  topicPolicyManifest?: RealtimeTopicPolicyManifest;
  recordedAt?: string;
  retentionMs?: number;
  maxChangeCount?: number;
  maxPayloadBytes?: number;
}>;

export type RealtimeCursor = Readonly<Record<string, string>>;

export type ReadRealtimePatchesOptions = Readonly<{
  pruneExpired?: boolean;
  includeTopicLag?: boolean;
  compactSummaries?: boolean;
  abortSignal?: AbortSignal;
}>;

type RealtimeOutboxRow = Readonly<{
  outbox_id: string | number | bigint;
  payload?: unknown;
  payload_json?: string;
  payload_bytes?: string | number;
}>;

type RealtimeTopicHeadRow = Readonly<{
  topic: string;
  outbox_id: string | number | bigint;
}>;

export async function runRealtimeProjectionTransaction<T>(
  db: PgQueryable | PgTransactionalPool,
  work: (db: PgQueryable) => Promise<T>,
): Promise<T> {
  if (!isPgTransactionalPool(db)) {
    return work(db);
  }

  return withPgTransaction(db, work);
}

export async function recordRealtimeProjectionPatch(
  db: PgQueryable,
  input: RecordRealtimeProjectionPatchInput,
): Promise<void> {
  const topics = normalizeRealtimeTopics(input.topics);
  assertValidRealtimeTopics(topics, input.topicPolicyManifest);
  assertValidRealtimeProjectionPatch(input, topics);

  const recordedAt = input.recordedAt ?? new Date().toISOString();
  const expiresAt = new Date(
    new Date(recordedAt).getTime() + (input.retentionMs ?? DEFAULT_RETENTION_MS),
  ).toISOString();
  const patch = {
    ...input.patch,
    topics,
  } satisfies RealtimeProjectionPatch;
  const payloadJson = JSON.stringify(patch);
  assertRealtimePatchSizeLimits(input, payloadJson);

  await runRealtimeProjectionTransaction(db as PgQueryable | PgTransactionalPool, async (tx) => {
    await tx.query("SELECT pg_advisory_xact_lock($1::bigint)", [REALTIME_OUTBOX_APPEND_ADVISORY_LOCK_KEY]);
    const upserted = await tx.query<{ outbox_id: string | number | bigint }>(
      `INSERT INTO ${REALTIME_OUTBOX_TABLE} (
           source_global_position,
           projection_name,
           patch_key,
           topics,
           payload_json,
           payload_kind,
           payload_context,
           payload_projection,
           payload_bytes,
           recorded_at,
           expires_at
         ) VALUES ($1::bigint, $2, $3, $4::jsonb, $5, $8, $9, $2, $10, $6, $7)
         ON CONFLICT (projection_name, source_global_position, patch_key)
         DO UPDATE SET
           topics = EXCLUDED.topics,
           payload_json = EXCLUDED.payload_json,
           payload_kind = EXCLUDED.payload_kind,
           payload_context = EXCLUDED.payload_context,
           payload_projection = EXCLUDED.payload_projection,
           payload_bytes = EXCLUDED.payload_bytes,
           recorded_at = EXCLUDED.recorded_at,
           expires_at = EXCLUDED.expires_at
         RETURNING outbox_id`,
      [
        input.sourceGlobalPosition,
        input.projectionName,
        input.patchKey,
        JSON.stringify(topics),
        payloadJson,
        recordedAt,
        expiresAt,
        patch.kind,
        patch.context,
        byteLengthUtf8(payloadJson),
      ],
    );
    const outboxId = upserted.rows[0]?.outbox_id;
    if (outboxId === undefined) {
      throw new Error("Realtime projection outbox upsert did not return an outbox id.");
    }

    await tx.query(
      `DELETE FROM ${REALTIME_OUTBOX_TOPIC_TABLE}
         WHERE outbox_id = $1::bigint`,
      [outboxId],
    );
    await tx.query(
      `DELETE FROM ${REALTIME_TOPIC_HEAD_TABLE}
         WHERE outbox_id = $1::bigint
           AND NOT (topic = ANY($2::text[]))`,
      [outboxId, topics],
    );
    await tx.query(
      `INSERT INTO ${REALTIME_OUTBOX_TOPIC_TABLE} (outbox_id, topic)
         SELECT $1::bigint, unnest($2::text[])
         ON CONFLICT DO NOTHING`,
      [outboxId, topics],
    );
    await tx.query(
      `INSERT INTO ${REALTIME_TOPIC_HEAD_TABLE} (topic, outbox_id, updated_at)
         SELECT requested.topic, $1::bigint, $3
         FROM unnest($2::text[]) AS requested(topic)
         ON CONFLICT (topic) DO UPDATE SET
           outbox_id = GREATEST(${REALTIME_TOPIC_HEAD_TABLE}.outbox_id, EXCLUDED.outbox_id),
           updated_at = EXCLUDED.updated_at`,
      [outboxId, topics, recordedAt],
    );
    // Wake hint only: the outbox row above is the durable replay
    // source of truth, and SSE streams keep their polling fallback. Legacy
    // listeners that cannot read the envelope treat it as a wake-all signal.
    try {
      await emitPostgresWorkSignalNotification(tx, {
        channel: REALTIME_NOTIFY_CHANNEL,
        envelope: {
          kind: "realtime.outbox-wake",
          source: "realtime-outbox",
          payload: {
            context: patch.context,
            projection: input.projectionName,
            topics: [...topics],
          },
        },
      });
    } catch {
      // A wake hint must never abort the durable outbox write. Envelope
      // serialization throws client-side before any SQL (size cap), so
      // swallowing here cannot poison the transaction; SSE streams recover
      // through their polling fallback.
    }
  });
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
    const key = [input.projectionName, String(input.sourceGlobalPosition), input.patchKey, topics.join("\u001f")].join(
      "\u001e",
    );
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
        changes: compactRealtimePatchChanges([...previous.patch.changes, ...input.patch.changes]),
      },
    });
  }

  return [...coalescedByKey.values()].filter((input) => input.patch.changes.length > 0);
}

export async function readRealtimePatches(
  stores: readonly RealtimeContextStore[],
  topics: readonly string[],
  cursor: RealtimeCursor,
  batchSize = DEFAULT_BATCH_SIZE,
  options: ReadRealtimePatchesOptions = {},
): Promise<
  Readonly<{
    cursor: RealtimeCursor;
    expiredContexts: readonly string[];
    topicLags: readonly RealtimeTopicLag[];
    messages: readonly Readonly<{
      contextName: string;
      outboxId: string;
      payload: RealtimeProjectionPatch;
      payloadJson: string;
      payloadBytes: number;
    }>[];
  }>
> {
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
    payloadJson: string;
    payloadBytes: number;
  }> = [];

  for (const store of matchingStores) {
    throwIfRealtimeReadAborted(options.abortSignal);
    if (options.pruneExpired !== false) {
      await pruneExpiredRealtimePatches(store.db);
    }

    const afterOutboxId = cursor[store.contextName] ?? "0";
    const topicHeads = await readTopicHeads(store, normalizedTopics);
    const maxTopicHead = maxRealtimeOutboxId((topicHeads ?? []).map((head) => String(head.outbox_id)));
    if (topicHeads && topicHeads.length > 0 && BigInt(maxTopicHead) <= BigInt(afterOutboxId)) {
      if (options.includeTopicLag) {
        topicLags.push(
          ...topicHeads.map((head) => ({
            contextName: store.contextName,
            topic: head.topic,
            lag: 0,
          })),
        );
      }
      continue;
    }

    if (await isCursorExpired(store.db, afterOutboxId)) {
      expiredContexts.push(store.contextName);
      nextCursor[store.contextName] = await readContextHead(store.db);
      continue;
    }
    throwIfRealtimeReadAborted(options.abortSignal);

    const result = await store.db.query<RealtimeOutboxRow>(
      `SELECT outbox.outbox_id AS outbox_id, outbox.payload_json, outbox.payload_bytes
       FROM ${REALTIME_OUTBOX_TABLE} AS outbox
       INNER JOIN ${REALTIME_OUTBOX_TOPIC_TABLE} AS topic
         ON topic.outbox_id = outbox.outbox_id
       WHERE outbox.outbox_id > $1::bigint
         AND outbox.expires_at > now()
         AND topic.topic = ANY($2::text[])
       GROUP BY outbox.outbox_id, outbox.payload_json, outbox.payload_bytes
       ORDER BY outbox.outbox_id ASC
       LIMIT $3`,
      [afterOutboxId, normalizedTopics, batchSize],
    );
    throwIfRealtimeReadAborted(options.abortSignal);

    for (const row of result.rows) {
      const outboxId = String(row.outbox_id);
      nextCursor[store.contextName] = outboxId;
      const payloadJson = row.payload_json ?? JSON.stringify(row.payload);
      const payload = parseRealtimeProjectionPatchJson(payloadJson);
      if (payload) {
        messages.push({
          contextName: store.contextName,
          outboxId,
          payload,
          payloadJson,
          payloadBytes: Number(row.payload_bytes ?? byteLengthUtf8(payloadJson)),
        });
      }
    }

    if (options.includeTopicLag) {
      topicLags.push(...(await readTopicLags(store, normalizedTopics, nextCursor[store.contextName] ?? afterOutboxId)));
    }
  }

  const replayMessages = options.compactSummaries === false ? messages : compactRealtimeReplayMessages(messages);

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

    if (changes.length === 0) {
      return [];
    }

    const payload = {
      ...message.payload,
      changes,
    };
    const payloadJson = JSON.stringify(payload);
    return [
      {
        ...message,
        payload,
        ...("payloadJson" in message
          ? {
              payloadJson,
              payloadBytes: byteLengthUtf8(payloadJson),
            }
          : {}),
      } as TMessage,
    ];
  });
}

export async function readRealtimeContextHeads(stores: readonly RealtimeContextStore[]): Promise<RealtimeCursor> {
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

    return topics.some(
      (topic) => store.exactTopics?.includes(topic) || store.topicPrefixes?.some((prefix) => topic.startsWith(prefix)),
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
       RETURNING outbox_id
     ),
     watermark AS (
       INSERT INTO ${REALTIME_OUTBOX_RETENTION_TABLE} (
         singleton,
         pruned_through_outbox_id,
         updated_at
       )
       SELECT true,
              MAX(outbox_id),
              now()
       FROM deleted
       HAVING MAX(outbox_id) IS NOT NULL
       ON CONFLICT (singleton) DO UPDATE SET
         pruned_through_outbox_id = GREATEST(
           ${REALTIME_OUTBOX_RETENTION_TABLE}.pruned_through_outbox_id,
           EXCLUDED.pruned_through_outbox_id
         ),
         updated_at = EXCLUDED.updated_at
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

function assertRealtimePatchSizeLimits(input: RecordRealtimeProjectionPatchInput, payloadJson: string): void {
  const maxChangeCount = input.maxChangeCount ?? DEFAULT_MAX_PATCH_CHANGE_COUNT;
  const maxPayloadBytes = input.maxPayloadBytes ?? DEFAULT_MAX_PATCH_PAYLOAD_BYTES;
  if (input.patch.changes.length > maxChangeCount) {
    throw new Error(`Realtime projection patches cannot include more than ${maxChangeCount} changes.`);
  }

  const payloadBytes = byteLengthUtf8(payloadJson);
  if (payloadBytes > maxPayloadBytes) {
    throw new Error(`Realtime projection patch payload cannot exceed ${maxPayloadBytes} bytes.`);
  }
}

function compactRealtimePatchChanges(
  changes: readonly RealtimeProjectionPatchChange[],
): readonly RealtimeProjectionPatchChange[] {
  const latestIndexByEntity = new Map<string, number>();
  changes.forEach((change, index) => {
    latestIndexByEntity.set(`${change.entity}\u001f${change.id}`, index);
  });

  return changes.filter((change, index) => latestIndexByEntity.get(`${change.entity}\u001f${change.id}`) === index);
}

async function isCursorExpired(db: PgQueryable, afterOutboxId: string): Promise<boolean> {
  if (afterOutboxId === "0") {
    return false;
  }

  const result = await db.query<{ pruned_through_outbox_id: string | null }>(
    `SELECT pruned_through_outbox_id::text AS pruned_through_outbox_id
     FROM ${REALTIME_OUTBOX_RETENTION_TABLE}
     WHERE singleton = true`,
  );
  const prunedThroughOutboxId = result.rows[0]?.pruned_through_outbox_id ?? "0";

  return BigInt(afterOutboxId) < BigInt(prunedThroughOutboxId);
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

async function readTopicHeads(
  store: RealtimeContextStore,
  topics: readonly string[],
): Promise<RealtimeTopicHeadRow[] | null> {
  let result: { rows: RealtimeTopicHeadRow[] };
  try {
    result = await store.db.query<RealtimeTopicHeadRow>(
      `SELECT topic, outbox_id::text AS outbox_id
       FROM ${REALTIME_TOPIC_HEAD_TABLE}
       WHERE topic = ANY($1::text[])
       ORDER BY topic ASC`,
      [topics],
    );
  } catch {
    return null;
  }

  return result.rows;
}

function maxRealtimeOutboxId(outboxIds: readonly string[]): string {
  return outboxIds.reduce((max, outboxId) => (BigInt(outboxId) > BigInt(max) ? outboxId : max), "0");
}

function parseRealtimeProjectionPatchJson(payloadJson: string): RealtimeProjectionPatch | null {
  try {
    const parsed = JSON.parse(payloadJson) as unknown;
    return isRealtimeProjectionPatch(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function throwIfRealtimeReadAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new Error("Realtime replay read aborted.");
  }
}

function isPgTransactionalPool(db: PgQueryable | PgTransactionalPool): db is PgTransactionalPool {
  const candidate = db as {
    connect?: unknown;
    idleCount?: unknown;
    totalCount?: unknown;
    waitingCount?: unknown;
  };

  return (
    typeof candidate.connect === "function" &&
    typeof candidate.idleCount === "number" &&
    typeof candidate.totalCount === "number" &&
    typeof candidate.waitingCount === "number"
  );
}

function areStringArraysEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function byteLengthUtf8(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function startOfUtcDay(value: Date): Date {
  return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()));
}

function addUtcDays(value: Date, days: number): Date {
  const next = new Date(value);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function formatUtcPartitionDay(value: Date): string {
  return [
    value.getUTCFullYear(),
    String(value.getUTCMonth() + 1).padStart(2, "0"),
    String(value.getUTCDate()).padStart(2, "0"),
  ].join("_");
}
