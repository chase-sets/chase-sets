import type { ProjectorRunResult } from "@chase-sets/event-core/projector";
import { ZERO_GLOBAL_POSITION } from "@chase-sets/event-core/storage";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import {
  createNotificationChannelAdapterRegistry,
  createNotificationDeliveryId,
  applyNotificationChannelPreferences,
  type ClaimNotificationDeliveriesInput,
  type ClaimedNotificationDelivery,
  type EnqueueNotificationInput,
  type MarkNotificationDeliveryFailedInput,
  type MarkNotificationDeliverySentInput,
  type NotificationChannel,
  type NotificationChannelAdapter,
  type NotificationMessage,
  type NotificationPreferenceResolver,
  type NotificationOutboxStore,
  isNotificationPreferenceMandatory,
  notificationRecipientAccountId,
  type RenewClaimedNotificationDeliveryInput,
} from "@chase-sets/outbound-messaging";

const DEFAULT_TABLE_NAME = "notification_outbox";
const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_BATCH_SIZE = 50;
const DEFAULT_CLAIM_TTL_MS = 60_000;
const STRANDED_SENDING_LAST_ERROR = "attempts exhausted after crash";

export const notificationOutboxSchemaSql = `CREATE TABLE IF NOT EXISTS ${DEFAULT_TABLE_NAME} (
  outbox_id bigserial PRIMARY KEY,
  delivery_id text NOT NULL UNIQUE,
  idempotency_key text NOT NULL,
  channel text NOT NULL,
  message_type text NOT NULL,
  criticality text NOT NULL,
  correlation_id text NOT NULL,
  message_json text NOT NULL,
  channel_json text NOT NULL,
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

CREATE INDEX IF NOT EXISTS ${DEFAULT_TABLE_NAME}_pending_idx
  ON ${DEFAULT_TABLE_NAME} (status, next_attempt_at, outbox_id)
  WHERE status IN ('pending', 'sending');

CREATE INDEX IF NOT EXISTS ${DEFAULT_TABLE_NAME}_source_idx
  ON ${DEFAULT_TABLE_NAME} (projection_name, source_global_position);

CREATE INDEX IF NOT EXISTS ${DEFAULT_TABLE_NAME}_message_idx
  ON ${DEFAULT_TABLE_NAME} (idempotency_key, channel);

CREATE INDEX IF NOT EXISTS ${DEFAULT_TABLE_NAME}_terminal_retention_idx
  ON ${DEFAULT_TABLE_NAME} (updated_at, outbox_id)
  WHERE status IN ('sent', 'failed');`;

export type PostgresNotificationOutboxOptions = Readonly<{
  db: PgQueryable;
  tableName?: string;
  now?: () => Date;
}>;

export type NotificationOutboxDispatcher = Readonly<{
  runOnce: () => Promise<ProjectorRunResult>;
}>;

type NotificationOutboxRow = Readonly<{
  outbox_id: string | number | bigint;
  delivery_id: string;
  message_json: string;
  channel_json: string;
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

export function createPostgresNotificationOutbox(options: PostgresNotificationOutboxOptions): NotificationOutboxStore {
  const db = options.db;
  const tableName = assertSqlIdentifier(options.tableName ?? DEFAULT_TABLE_NAME);
  const now = options.now ?? (() => new Date());

  return {
    async enqueueNotification(input: EnqueueNotificationInput) {
      const recordedAt = now().toISOString();
      const availableAt = input.availableAt ?? recordedAt;
      const maxAttempts = Math.max(1, input.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
      const messageJson = JSON.stringify(input.message);

      for (const [index, channel] of input.message.channels.entries()) {
        const deliveryId = createNotificationDeliveryId(input.message, channel, index);

        await db.query(
          `INSERT INTO ${tableName} (
             delivery_id,
             idempotency_key,
             channel,
             message_type,
             criticality,
             correlation_id,
             message_json,
             channel_json,
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
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::bigint, $11, $12, 'pending', 0, $13, $14, $15, $15)
           ON CONFLICT (delivery_id) DO UPDATE SET
             message_type = EXCLUDED.message_type,
             criticality = EXCLUDED.criticality,
             correlation_id = EXCLUDED.correlation_id,
             message_json = CASE
               WHEN ${tableName}.status = 'sent' THEN ${tableName}.message_json
               ELSE EXCLUDED.message_json
             END,
             channel_json = CASE
               WHEN ${tableName}.status = 'sent' THEN ${tableName}.channel_json
               ELSE EXCLUDED.channel_json
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
            deliveryId,
            input.message.idempotencyKey,
            channel.channel,
            input.message.messageType,
            input.message.criticality,
            input.message.correlationId,
            messageJson,
            JSON.stringify(channel),
            input.source.sourceEventId,
            input.source.sourceGlobalPosition,
            input.source.occurredAt,
            input.source.projectionName,
            maxAttempts,
            availableAt,
            recordedAt,
          ],
        );
      }
    },

    async claimPendingNotificationDeliveries(input: ClaimNotificationDeliveriesInput) {
      const claimStartedAt = input.now ?? now().toISOString();
      const claimedUntil = new Date(new Date(claimStartedAt).getTime() + input.claimTtlMs).toISOString();
      const limit = Math.max(1, Math.floor(input.limit));

      const result = await db.query<NotificationOutboxRow>(
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
               (
                 status = 'pending'
                 AND next_attempt_at <= $1::timestamptz
                 AND attempt_count < max_attempts
               )
               OR (
                 status = 'sending'
                 AND claimed_until <= $1::timestamptz
                 AND attempt_count < max_attempts
               )
             )
             AND NOT EXISTS (
               SELECT 1
               FROM recovered
               WHERE recovered.outbox_id = ${tableName}.outbox_id
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
           outbox.delivery_id,
           outbox.message_json,
           outbox.channel_json,
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
        [claimStartedAt, limit, input.claimOwnerId, claimedUntil, STRANDED_SENDING_LAST_ERROR],
      );

      return result.rows.map(rowToClaimedNotificationDelivery);
    },

    async renewClaimedNotificationDelivery(input: RenewClaimedNotificationDeliveryInput) {
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

    async markNotificationDeliverySent(input: MarkNotificationDeliverySentInput) {
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
         WHERE delivery_id = $5`,
        [
          updatedAt,
          input.receipt.providerName,
          input.receipt.providerMessageId,
          input.receipt.acceptedAt,
          input.deliveryId,
        ],
      );
    },

    async markNotificationDeliveryFailed(input: MarkNotificationDeliveryFailedInput) {
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
         WHERE delivery_id = $5`,
        [updatedAt, status, retryAt, input.error, input.deliveryId],
      );
    },
  };
}

export function createNotificationOutboxDispatcher(
  options: Readonly<{
    outbox: NotificationOutboxStore;
    adapters: readonly NotificationChannelAdapter[];
    claimOwnerId: string;
    batchSize?: number;
    claimTtlMs?: number;
    retryDelayMs?: (attemptCount: number) => number;
    now?: () => Date;
    preferenceResolver: NotificationPreferenceResolver;
  }>,
): NotificationOutboxDispatcher {
  const now = options.now ?? (() => new Date());
  const batchSize = Math.max(1, options.batchSize ?? DEFAULT_BATCH_SIZE);
  const claimTtlMs = Math.max(1, options.claimTtlMs ?? DEFAULT_CLAIM_TTL_MS);
  const retryDelayMs = options.retryDelayMs ?? ((attemptCount) => Math.min(15 * 60_000, attemptCount * 30_000));
  const adapterRegistry = createNotificationChannelAdapterRegistry(options.adapters);

  return {
    async runOnce() {
      const deliveries = await options.outbox.claimPendingNotificationDeliveries({
        limit: batchSize,
        claimOwnerId: options.claimOwnerId,
        claimTtlMs,
        now: now().toISOString(),
      });
      const preferencesByAccount = new Map<
        string,
        Awaited<ReturnType<NotificationPreferenceResolver["listPreferences"]>>
      >();

      async function preferencesForAccount(accountId: NonNullable<ReturnType<typeof notificationRecipientAccountId>>) {
        const cached = preferencesByAccount.get(accountId);
        if (cached) {
          return cached;
        }

        const preferences = await options.preferenceResolver.listPreferences(accountId);
        preferencesByAccount.set(accountId, preferences);
        return preferences;
      }

      for (const delivery of deliveries) {
        const claimRenewed = await options.outbox.renewClaimedNotificationDelivery({
          deliveryId: delivery.deliveryId,
          claimOwnerId: options.claimOwnerId,
          claimTtlMs,
          now: now().toISOString(),
        });

        if (!claimRenewed) {
          continue;
        }

        try {
          const recipientAccountId = notificationRecipientAccountId(delivery.message);
          const preferences = isNotificationPreferenceMandatory(delivery.message)
            ? []
            : recipientAccountId
              ? await preferencesForAccount(recipientAccountId)
              : [];
          const preferenceFilteredMessage = applyNotificationChannelPreferences(
            { ...delivery.message, channels: [delivery.channel] },
            preferences,
          );

          if (!preferenceFilteredMessage) {
            await options.outbox.markNotificationDeliverySent({
              deliveryId: delivery.deliveryId,
              receipt: {
                channel: delivery.channel.channel,
                providerName: "preference-filter",
                providerMessageId: `suppressed:${delivery.deliveryId}`,
                acceptedAt: now().toISOString(),
                attemptCount: 0,
              },
              now: now().toISOString(),
            });
            continue;
          }

          const adapter = adapterRegistry.adapterForChannel(delivery.channel.channel);
          if (!adapter) {
            throw new Error(`No notification adapter configured for '${delivery.channel.channel}'.`);
          }

          const receipt = await adapter.sendNotificationChannel(delivery);
          await options.outbox.markNotificationDeliverySent({
            deliveryId: delivery.deliveryId,
            receipt,
            now: now().toISOString(),
          });
        } catch (error) {
          const canRetry = delivery.attemptCount < delivery.maxAttempts;
          await options.outbox.markNotificationDeliveryFailed({
            deliveryId: delivery.deliveryId,
            error: error instanceof Error ? error.message : String(error),
            retryAt: canRetry ? new Date(now().getTime() + retryDelayMs(delivery.attemptCount)).toISOString() : null,
            now: now().toISOString(),
          });
        }
      }

      return {
        processed: deliveries.length,
        lastGlobalPosition: ZERO_GLOBAL_POSITION,
      };
    },
  };
}

function rowToClaimedNotificationDelivery(row: NotificationOutboxRow): ClaimedNotificationDelivery {
  const message = JSON.parse(row.message_json) as NotificationMessage;
  const channel = JSON.parse(row.channel_json) as NotificationChannel;

  return {
    outboxId: String(row.outbox_id),
    deliveryId: row.delivery_id,
    message,
    channel,
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

function timestampToIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

function assertSqlIdentifier(value: string): string {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(value)) {
    throw new Error(`Invalid SQL identifier '${value}'.`);
  }

  return value;
}
