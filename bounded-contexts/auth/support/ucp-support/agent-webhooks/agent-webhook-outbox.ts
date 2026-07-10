import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type { AgentOrderUpdateStatus } from "./order-update-payload";

/**
 * Per-client delivery state for signed order-update webhooks.
 *
 * Reuses the outbox lessons from the notification pipeline: single-owner claims
 * via `FOR UPDATE SKIP LOCKED`, monotonic attempt accounting, crash recovery of
 * stranded `sending` rows, backoff via `next_attempt_at`, and a terminal
 * `failed` (dead-letter) state surfaced to ops. The signing secret is *never*
 * stored on a delivery row — the dispatcher resolves it per client at send time.
 */
const DEFAULT_TABLE_NAME = "identity_agent_webhook_deliveries";
const DEFAULT_MAX_ATTEMPTS = 8;
const STRANDED_SENDING_LAST_ERROR = "attempts exhausted after crash";

export const agentWebhookOutboxSchemaSql = `CREATE TABLE IF NOT EXISTS ${DEFAULT_TABLE_NAME} (
  outbox_id bigserial PRIMARY KEY,
  delivery_id text NOT NULL UNIQUE,
  idempotency_key text NOT NULL UNIQUE,
  client_id text NOT NULL,
  account_id text NOT NULL,
  callback_url text NOT NULL,
  source_event_id text NOT NULL,
  event_type text NOT NULL,
  order_id text NOT NULL,
  order_status text NOT NULL,
  payload_json text NOT NULL,
  status text NOT NULL CHECK (status IN ('pending', 'sending', 'sent', 'failed')),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  max_attempts integer NOT NULL DEFAULT ${DEFAULT_MAX_ATTEMPTS} CHECK (max_attempts > 0),
  claim_owner_id text NULL,
  claimed_until timestamptz NULL,
  next_attempt_at timestamptz NOT NULL,
  last_error text NULL,
  last_response_status integer NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  delivered_at timestamptz NULL
);

CREATE INDEX IF NOT EXISTS ${DEFAULT_TABLE_NAME}_pending_idx
  ON ${DEFAULT_TABLE_NAME} (status, next_attempt_at, outbox_id)
  WHERE status IN ('pending', 'sending');

CREATE INDEX IF NOT EXISTS ${DEFAULT_TABLE_NAME}_client_idx
  ON ${DEFAULT_TABLE_NAME} (client_id, created_at);

CREATE INDEX IF NOT EXISTS ${DEFAULT_TABLE_NAME}_dead_letter_idx
  ON ${DEFAULT_TABLE_NAME} (status, updated_at)
  WHERE status = 'failed';`;

export type EnqueueAgentWebhookDeliveryInput = Readonly<{
  clientId: string;
  accountId: string;
  callbackUrl: string;
  sourceEventId: string;
  eventType: string;
  orderId: string;
  orderStatus: AgentOrderUpdateStatus;
  /** Canonical JSON body that gets signed and sent verbatim. */
  payloadJson: string;
  /** Stable idempotency key, e.g. `${clientId}:${sourceEventId}:${orderId}`. */
  idempotencyKey: string;
  availableAt?: string;
  maxAttempts?: number;
}>;

export type ClaimedAgentWebhookDelivery = Readonly<{
  outboxId: string;
  deliveryId: string;
  clientId: string;
  accountId: string;
  callbackUrl: string;
  sourceEventId: string;
  eventType: string;
  orderId: string;
  orderStatus: string;
  payloadJson: string;
  status: "pending" | "sending" | "sent" | "failed";
  attemptCount: number;
  maxAttempts: number;
  nextAttemptAt: string;
  lastError: string | null;
}>;

export type AgentWebhookDeliverySummary = Readonly<{
  deliveryId: string;
  clientId: string;
  accountId: string;
  callbackUrl: string;
  sourceEventId: string;
  eventType: string;
  orderId: string;
  orderStatus: string;
  status: "pending" | "sending" | "sent" | "failed";
  attemptCount: number;
  maxAttempts: number;
  nextAttemptAt: string;
  lastError: string | null;
  lastResponseStatus: number | null;
  createdAt: string;
  updatedAt: string;
  deliveredAt: string | null;
}>;

export type ClaimAgentWebhookDeliveriesInput = Readonly<{
  limit: number;
  claimOwnerId: string;
  claimTtlMs: number;
  now?: string;
}>;

export type MarkAgentWebhookDeliverySentInput = Readonly<{
  deliveryId: string;
  responseStatus: number;
  now?: string;
}>;

export type MarkAgentWebhookDeliveryFailedInput = Readonly<{
  deliveryId: string;
  error: string;
  responseStatus?: number | null;
  /** When present the delivery returns to `pending` for retry at this time; otherwise it dead-letters. */
  retryAt?: string | null;
  now?: string;
}>;

export type AgentWebhookOutbox = Readonly<{
  enqueueDelivery: (input: EnqueueAgentWebhookDeliveryInput) => Promise<void>;
  claimPendingDeliveries: (input: ClaimAgentWebhookDeliveriesInput) => Promise<readonly ClaimedAgentWebhookDelivery[]>;
  renewClaim: (
    input: Readonly<{ deliveryId: string; claimOwnerId: string; claimTtlMs: number; now?: string }>,
  ) => Promise<boolean>;
  markDelivered: (input: MarkAgentWebhookDeliverySentInput) => Promise<void>;
  markFailed: (input: MarkAgentWebhookDeliveryFailedInput) => Promise<void>;
  listForClient: (clientId: string, limit?: number) => Promise<readonly AgentWebhookDeliverySummary[]>;
  listDeadLettered: (limit?: number) => Promise<readonly AgentWebhookDeliverySummary[]>;
}>;

export type PostgresAgentWebhookOutboxOptions = Readonly<{
  db: PgQueryable;
  tableName?: string;
  now?: () => Date;
}>;

type ClaimedRow = Readonly<{
  outbox_id: string | number | bigint;
  delivery_id: string;
  client_id: string;
  account_id: string;
  callback_url: string;
  source_event_id: string;
  event_type: string;
  order_id: string;
  order_status: string;
  payload_json: string;
  status: "pending" | "sending" | "sent" | "failed";
  attempt_count: number | string;
  max_attempts: number | string;
  next_attempt_at: Date | string;
  last_error: string | null;
}>;

type SummaryRow = ClaimedRow &
  Readonly<{
    last_response_status: number | string | null;
    created_at: Date | string;
    updated_at: Date | string;
    delivered_at: Date | string | null;
  }>;

export function createPostgresAgentWebhookOutbox(options: PostgresAgentWebhookOutboxOptions): AgentWebhookOutbox {
  const db = options.db;
  const tableName = assertSqlIdentifier(options.tableName ?? DEFAULT_TABLE_NAME);
  const now = options.now ?? (() => new Date());

  return {
    async enqueueDelivery(input) {
      const recordedAt = now().toISOString();
      const availableAt = input.availableAt ?? recordedAt;
      const maxAttempts = Math.max(1, input.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);

      await db.query(
        `INSERT INTO ${tableName} (
           delivery_id,
           idempotency_key,
           client_id,
           account_id,
           callback_url,
           source_event_id,
           event_type,
           order_id,
           order_status,
           payload_json,
           status,
           attempt_count,
           max_attempts,
           next_attempt_at,
           created_at,
           updated_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'pending', 0, $11, $12, $13, $13)
         ON CONFLICT (idempotency_key) DO NOTHING`,
        [
          input.idempotencyKey,
          input.idempotencyKey,
          input.clientId,
          input.accountId,
          input.callbackUrl,
          input.sourceEventId,
          input.eventType,
          input.orderId,
          input.orderStatus,
          input.payloadJson,
          maxAttempts,
          availableAt,
          recordedAt,
        ],
      );
    },

    async claimPendingDeliveries(input) {
      const claimStartedAt = input.now ?? now().toISOString();
      const claimedUntil = new Date(new Date(claimStartedAt).getTime() + input.claimTtlMs).toISOString();
      const limit = Math.max(1, Math.floor(input.limit));

      const result = await db.query<ClaimedRow>(
        `WITH exhausted AS (
           SELECT outbox_id
           FROM ${tableName}
           WHERE status = 'sending'
             AND claimed_until <= $1::timestamptz
             AND attempt_count >= max_attempts
           ORDER BY claimed_until ASC, outbox_id ASC
           LIMIT $2
           FOR UPDATE SKIP LOCKED
         ),
         recovered AS (
           UPDATE ${tableName} AS outbox
           SET status = 'failed',
               claim_owner_id = NULL,
               claimed_until = NULL,
               last_error = $5,
               updated_at = $1
           FROM exhausted
           WHERE outbox.outbox_id = exhausted.outbox_id
           RETURNING outbox.outbox_id
         ),
         claimable AS (
           SELECT outbox_id
           FROM ${tableName}
           WHERE (
               (status = 'pending' AND next_attempt_at <= $1::timestamptz AND attempt_count < max_attempts)
               OR (status = 'sending' AND claimed_until <= $1::timestamptz AND attempt_count < max_attempts)
             )
             AND NOT EXISTS (SELECT 1 FROM recovered WHERE recovered.outbox_id = ${tableName}.outbox_id)
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
           outbox.delivery_id,
           outbox.client_id,
           outbox.account_id,
           outbox.callback_url,
           outbox.source_event_id,
           outbox.event_type,
           outbox.order_id,
           outbox.order_status,
           outbox.payload_json,
           outbox.status,
           outbox.attempt_count,
           outbox.max_attempts,
           outbox.next_attempt_at,
           outbox.last_error`,
        [claimStartedAt, limit, input.claimOwnerId, claimedUntil, STRANDED_SENDING_LAST_ERROR],
      );

      return result.rows.map(rowToClaimedDelivery);
    },

    async renewClaim(input) {
      const updatedAt = input.now ?? now().toISOString();
      const claimedUntil = new Date(new Date(updatedAt).getTime() + input.claimTtlMs).toISOString();
      const result = await db.query(
        `UPDATE ${tableName}
         SET claimed_until = $4,
             updated_at = $1
         WHERE delivery_id = $2
           AND claim_owner_id = $3
           AND status = 'sending'
           AND claimed_until > $1::timestamptz`,
        [updatedAt, input.deliveryId, input.claimOwnerId, claimedUntil],
      );
      return Number(result.rowCount ?? 0) > 0;
    },

    async markDelivered(input) {
      const updatedAt = input.now ?? now().toISOString();
      await db.query(
        `UPDATE ${tableName}
         SET status = 'sent',
             last_response_status = $2,
             last_error = NULL,
             claim_owner_id = NULL,
             claimed_until = NULL,
             delivered_at = $1,
             updated_at = $1
         WHERE delivery_id = $3`,
        [updatedAt, input.responseStatus, input.deliveryId],
      );
    },

    async markFailed(input) {
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
             last_response_status = $5,
             updated_at = $1
         WHERE delivery_id = $6`,
        [updatedAt, status, retryAt, input.error, input.responseStatus ?? null, input.deliveryId],
      );
    },

    async listForClient(clientId, limit = 100) {
      const result = await db.query<SummaryRow>(
        `SELECT outbox_id, delivery_id, client_id, account_id, callback_url, source_event_id, event_type,
                order_id, order_status, payload_json, status, attempt_count, max_attempts, next_attempt_at,
                last_error, last_response_status, created_at, updated_at, delivered_at
         FROM ${tableName}
         WHERE client_id = $1
         ORDER BY created_at DESC, outbox_id DESC
         LIMIT $2`,
        [clientId, Math.max(1, Math.floor(limit))],
      );
      return result.rows.map(rowToSummary);
    },

    async listDeadLettered(limit = 100) {
      const result = await db.query<SummaryRow>(
        `SELECT outbox_id, delivery_id, client_id, account_id, callback_url, source_event_id, event_type,
                order_id, order_status, payload_json, status, attempt_count, max_attempts, next_attempt_at,
                last_error, last_response_status, created_at, updated_at, delivered_at
         FROM ${tableName}
         WHERE status = 'failed'
         ORDER BY updated_at DESC, outbox_id DESC
         LIMIT $1`,
        [Math.max(1, Math.floor(limit))],
      );
      return result.rows.map(rowToSummary);
    },
  };
}

function rowToClaimedDelivery(row: ClaimedRow): ClaimedAgentWebhookDelivery {
  return {
    outboxId: String(row.outbox_id),
    deliveryId: row.delivery_id,
    clientId: row.client_id,
    accountId: row.account_id,
    callbackUrl: row.callback_url,
    sourceEventId: row.source_event_id,
    eventType: row.event_type,
    orderId: row.order_id,
    orderStatus: row.order_status,
    payloadJson: row.payload_json,
    status: row.status,
    attemptCount: Number(row.attempt_count),
    maxAttempts: Number(row.max_attempts),
    nextAttemptAt: timestampToIso(row.next_attempt_at),
    lastError: row.last_error,
  };
}

function rowToSummary(row: SummaryRow): AgentWebhookDeliverySummary {
  return {
    deliveryId: row.delivery_id,
    clientId: row.client_id,
    accountId: row.account_id,
    callbackUrl: row.callback_url,
    sourceEventId: row.source_event_id,
    eventType: row.event_type,
    orderId: row.order_id,
    orderStatus: row.order_status,
    status: row.status,
    attemptCount: Number(row.attempt_count),
    maxAttempts: Number(row.max_attempts),
    nextAttemptAt: timestampToIso(row.next_attempt_at),
    lastError: row.last_error,
    lastResponseStatus: row.last_response_status === null ? null : Number(row.last_response_status),
    createdAt: timestampToIso(row.created_at),
    updatedAt: timestampToIso(row.updated_at),
    deliveredAt: row.delivered_at === null ? null : timestampToIso(row.delivered_at),
  };
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
