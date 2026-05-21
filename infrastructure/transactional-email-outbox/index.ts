import type {
  ClaimTransactionalEmailsInput,
  ClaimedTransactionalEmail,
  EnqueueTransactionalEmailInput,
  MarkTransactionalEmailFailedInput,
  MarkTransactionalEmailSentInput,
  TransactionalEmailGateway,
  TransactionalEmailMessage,
  TransactionalEmailOutboxStore,
} from "@chase-sets/communications-email";
import { ZERO_GLOBAL_POSITION } from "@chase-sets/event-core/storage";
import type { ProjectorRunResult } from "@chase-sets/event-core/projector";
import type { PgQueryable } from "@chase-sets/event-core-postgres";

const DEFAULT_TABLE_NAME = "transactional_email_outbox";
const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_BATCH_SIZE = 50;
const DEFAULT_CLAIM_TTL_MS = 60_000;

export const transactionalEmailOutboxSchemaSql = `CREATE TABLE IF NOT EXISTS ${DEFAULT_TABLE_NAME} (
  outbox_id bigserial PRIMARY KEY,
  idempotency_key text NOT NULL UNIQUE,
  message_type text NOT NULL,
  criticality text NOT NULL,
  correlation_id text NOT NULL,
  message_json text NOT NULL,
  source_event_id text NOT NULL,
  source_global_position bigint NOT NULL CHECK (source_global_position >= 0),
  source_occurred_at timestamptz NOT NULL,
  projection_name text NOT NULL,
  status text NOT NULL CHECK (status IN ('pending', 'sending', 'sent', 'failed')),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  max_attempts integer NOT NULL DEFAULT ${DEFAULT_MAX_ATTEMPTS} CHECK (max_attempts > 0),
  claim_owner_id text NULL,
  claimed_until timestamptz NULL,
  next_attempt_at timestamptz NOT NULL,
  last_error text NULL,
  provider_name text NULL,
  provider_message_id text NULL,
  accepted_at timestamptz NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  sent_at timestamptz NULL
);

ALTER TABLE ${DEFAULT_TABLE_NAME}
  ADD COLUMN IF NOT EXISTS source_occurred_at timestamptz;

UPDATE ${DEFAULT_TABLE_NAME}
SET source_occurred_at = created_at
WHERE source_occurred_at IS NULL;

ALTER TABLE ${DEFAULT_TABLE_NAME}
  ALTER COLUMN source_occurred_at SET NOT NULL;

CREATE INDEX IF NOT EXISTS ${DEFAULT_TABLE_NAME}_pending_idx
  ON ${DEFAULT_TABLE_NAME} (status, next_attempt_at, outbox_id)
  WHERE status IN ('pending', 'sending');

CREATE INDEX IF NOT EXISTS ${DEFAULT_TABLE_NAME}_source_idx
  ON ${DEFAULT_TABLE_NAME} (projection_name, source_global_position);`;

export type PostgresTransactionalEmailOutboxOptions = Readonly<{
  db: PgQueryable;
  tableName?: string;
  now?: () => Date;
}>;

export type TransactionalEmailOutboxDispatcher = Readonly<{
  runOnce: () => Promise<ProjectorRunResult>;
}>;

type TransactionalEmailOutboxRow = Readonly<{
  outbox_id: string | number | bigint;
  idempotency_key: string;
  message_json: string;
  source_event_id: string;
  source_global_position: string | number | bigint;
  source_occurred_at: Date | string;
  projection_name: string;
  status: "pending" | "sending" | "sent" | "failed";
  attempt_count: number | string;
  max_attempts: number | string;
  created_at: Date | string;
  updated_at: Date | string;
  next_attempt_at: Date | string;
  last_error: string | null;
}>;

export function createPostgresTransactionalEmailOutbox(
  options: PostgresTransactionalEmailOutboxOptions,
): TransactionalEmailOutboxStore {
  const db = options.db;
  const tableName = assertSqlIdentifier(options.tableName ?? DEFAULT_TABLE_NAME);
  const now = options.now ?? (() => new Date());

  return {
    async enqueueTransactionalEmail(input: EnqueueTransactionalEmailInput) {
      const recordedAt = now().toISOString();
      const availableAt = input.availableAt ?? recordedAt;
      const maxAttempts = Math.max(1, input.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
      const messageJson = JSON.stringify(input.message);

      await db.query(
        `INSERT INTO ${tableName} (
           idempotency_key,
           message_type,
           criticality,
           correlation_id,
           message_json,
           source_event_id,
           source_global_position,
           source_occurred_at,
           projection_name,
           status,
           attempt_count,
           max_attempts,
           next_attempt_at,
           created_at,
           updated_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7::bigint, $8, $9, 'pending', 0, $10, $11, $12, $12)
         ON CONFLICT (idempotency_key) DO UPDATE SET
           message_type = EXCLUDED.message_type,
           criticality = EXCLUDED.criticality,
           correlation_id = EXCLUDED.correlation_id,
           message_json = CASE
             WHEN ${tableName}.status = 'sent' THEN ${tableName}.message_json
             ELSE EXCLUDED.message_json
           END,
           source_event_id = EXCLUDED.source_event_id,
           source_global_position = EXCLUDED.source_global_position,
           source_occurred_at = EXCLUDED.source_occurred_at,
           projection_name = EXCLUDED.projection_name,
           max_attempts = GREATEST(${tableName}.max_attempts, EXCLUDED.max_attempts),
           next_attempt_at = CASE
             WHEN ${tableName}.status = 'sent' THEN ${tableName}.next_attempt_at
             ELSE LEAST(${tableName}.next_attempt_at, EXCLUDED.next_attempt_at)
           END,
           updated_at = EXCLUDED.updated_at`,
        [
          input.message.idempotencyKey,
          input.message.messageType,
          input.message.criticality,
          input.message.correlationId,
          messageJson,
          input.source.sourceEventId,
          input.source.sourceGlobalPosition,
          input.source.occurredAt,
          input.source.projectionName,
          maxAttempts,
          availableAt,
          recordedAt,
        ],
      );
    },

    async claimPendingTransactionalEmails(input: ClaimTransactionalEmailsInput) {
      const claimStartedAt = input.now ?? now().toISOString();
      const claimedUntil = new Date(new Date(claimStartedAt).getTime() + input.claimTtlMs).toISOString();
      const limit = Math.max(1, Math.floor(input.limit));

      const result = await db.query<TransactionalEmailOutboxRow>(
        `WITH claimable AS (
           SELECT outbox_id
           FROM ${tableName}
           WHERE (
               status = 'pending'
               AND next_attempt_at <= $1::timestamptz
               AND attempt_count < max_attempts
             )
             OR (
               status = 'sending'
               AND claimed_until <= $1::timestamptz
               AND attempt_count < max_attempts
             )
           ORDER BY next_attempt_at ASC, outbox_id ASC
           LIMIT $2
           FOR UPDATE SKIP LOCKED
         )
         UPDATE ${tableName} AS outbox
         SET status = 'sending',
             attempt_count = outbox.attempt_count + 1,
             claim_owner_id = $3,
             claimed_until = $4,
             updated_at = $1
         FROM claimable
         WHERE outbox.outbox_id = claimable.outbox_id
         RETURNING
           outbox.outbox_id,
           outbox.idempotency_key,
           outbox.message_json,
           outbox.source_event_id,
           outbox.source_global_position,
           outbox.source_occurred_at,
           outbox.projection_name,
           outbox.status,
           outbox.attempt_count,
           outbox.max_attempts,
           outbox.created_at,
           outbox.updated_at,
           outbox.next_attempt_at,
           outbox.last_error`,
        [claimStartedAt, limit, input.claimOwnerId, claimedUntil],
      );

      return result.rows.map(rowToClaimedTransactionalEmail);
    },

    async markTransactionalEmailSent(input: MarkTransactionalEmailSentInput) {
      const updatedAt = input.now ?? now().toISOString();

      await db.query(
        `UPDATE ${tableName}
         SET status = 'sent',
             provider_name = $2,
             provider_message_id = $3,
             accepted_at = $4,
             sent_at = $1,
             claim_owner_id = NULL,
             claimed_until = NULL,
             last_error = NULL,
             updated_at = $1
         WHERE idempotency_key = $5`,
        [
          updatedAt,
          input.receipt.providerName,
          input.receipt.providerMessageId,
          input.receipt.acceptedAt,
          input.idempotencyKey,
        ],
      );
    },

    async markTransactionalEmailFailed(input: MarkTransactionalEmailFailedInput) {
      const updatedAt = input.now ?? now().toISOString();
      const retryAt = input.retryAt ?? null;
      const status = retryAt ? "pending" : "failed";

      await db.query(
        `UPDATE ${tableName}
         SET status = $2,
             claim_owner_id = NULL,
             claimed_until = NULL,
             next_attempt_at = COALESCE($3::timestamptz, next_attempt_at),
             last_error = $4,
             updated_at = $1
         WHERE idempotency_key = $5`,
        [updatedAt, status, retryAt, input.error, input.idempotencyKey],
      );
    },
  };
}

export function createTransactionalEmailOutboxDispatcher(
  options: Readonly<{
    outbox: TransactionalEmailOutboxStore;
    gateway: TransactionalEmailGateway;
    claimOwnerId: string;
    batchSize?: number;
    claimTtlMs?: number;
    retryDelayMs?: (attemptCount: number) => number;
    now?: () => Date;
  }>,
): TransactionalEmailOutboxDispatcher {
  const now = options.now ?? (() => new Date());
  const batchSize = Math.max(1, options.batchSize ?? DEFAULT_BATCH_SIZE);
  const claimTtlMs = Math.max(1, options.claimTtlMs ?? DEFAULT_CLAIM_TTL_MS);
  const retryDelayMs = options.retryDelayMs ?? ((attemptCount) => Math.min(15 * 60_000, attemptCount * 30_000));

  return {
    async runOnce() {
      const messages = await options.outbox.claimPendingTransactionalEmails({
        limit: batchSize,
        claimOwnerId: options.claimOwnerId,
        claimTtlMs,
        now: now().toISOString(),
      });

      for (const item of messages) {
        try {
          const receipt = await options.gateway.sendTransactionalEmail(item.message);
          await options.outbox.markTransactionalEmailSent({
            idempotencyKey: item.message.idempotencyKey,
            receipt,
            now: now().toISOString(),
          });
        } catch (error) {
          const canRetry = item.attemptCount < item.maxAttempts;
          await options.outbox.markTransactionalEmailFailed({
            idempotencyKey: item.message.idempotencyKey,
            error: error instanceof Error ? error.message : String(error),
            retryAt: canRetry ? new Date(now().getTime() + retryDelayMs(item.attemptCount)).toISOString() : null,
            now: now().toISOString(),
          });
        }
      }

      return {
        processed: messages.length,
        lastGlobalPosition: ZERO_GLOBAL_POSITION,
      };
    },
  };
}

function rowToClaimedTransactionalEmail(row: TransactionalEmailOutboxRow): ClaimedTransactionalEmail {
  return {
    outboxId: String(row.outbox_id),
    message: parseTransactionalEmailMessage(row.message_json),
    source: {
      sourceEventId: row.source_event_id,
      sourceGlobalPosition: String(row.source_global_position),
      projectionName: row.projection_name,
      occurredAt: timestampToIso(row.source_occurred_at),
    },
    status: row.status,
    attemptCount: Number(row.attempt_count),
    maxAttempts: Number(row.max_attempts),
    createdAt: timestampToIso(row.created_at),
    updatedAt: timestampToIso(row.updated_at),
    nextAttemptAt: timestampToIso(row.next_attempt_at),
    lastError: row.last_error,
  };
}

function parseTransactionalEmailMessage(value: string): TransactionalEmailMessage {
  return JSON.parse(value) as TransactionalEmailMessage;
}

function timestampToIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

function assertSqlIdentifier(value: string): string {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(value)) {
    throw new Error(`Invalid SQL identifier '${value}'.`);
  }

  return value;
}
