import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type {
  NotificationChannelAdapter,
  NotificationDelivery,
  SentNotificationReceipt,
  WebNotificationChannel,
} from "@chase-sets/outbound-messaging";

const DEFAULT_TABLE_NAME = "web_notifications";

export const webNotificationsSchemaSql = `CREATE TABLE IF NOT EXISTS ${DEFAULT_TABLE_NAME} (
  notification_id bigserial PRIMARY KEY,
  delivery_id text NOT NULL UNIQUE,
  user_id text NULL,
  account_id text NULL,
  message_type text NOT NULL,
  criticality text NOT NULL,
  title text NOT NULL,
  body text NOT NULL,
  action_href text NULL,
  correlation_id text NOT NULL,
  source_idempotency_key text NOT NULL,
  read_at timestamptz NULL,
  created_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS ${DEFAULT_TABLE_NAME}_account_unread_idx
  ON ${DEFAULT_TABLE_NAME} (account_id, created_at DESC)
  WHERE read_at IS NULL;

CREATE INDEX IF NOT EXISTS ${DEFAULT_TABLE_NAME}_user_unread_idx
  ON ${DEFAULT_TABLE_NAME} (user_id, created_at DESC)
  WHERE read_at IS NULL;`;

export type PostgresWebNotificationAdapterOptions = Readonly<{
  db: PgQueryable;
  tableName?: string;
  now?: () => Date;
}>;

export type WebNotificationFeedScope = Readonly<{
  userId?: string | null;
  accountId?: string | null;
}>;

export type WebNotificationFeedItem = Readonly<{
  notificationId: string;
  deliveryId: string;
  userId: string | null;
  accountId: string | null;
  messageType: string;
  criticality: string;
  title: string;
  body: string;
  actionHref: string | null;
  correlationId: string;
  sourceIdempotencyKey: string;
  readAt: string | null;
  createdAt: string;
}>;

export type ListWebNotificationsInput = WebNotificationFeedScope &
  Readonly<{
    limit?: number;
    offset?: number;
    includeRead?: boolean;
  }>;

export type MarkWebNotificationReadInput = WebNotificationFeedScope &
  Readonly<{
    deliveryId: string;
    readAt?: string;
  }>;

export type MarkAllWebNotificationsReadInput = WebNotificationFeedScope &
  Readonly<{
    readAt?: string;
  }>;

export interface WebNotificationFeed {
  listWebNotifications(input: ListWebNotificationsInput): Promise<readonly WebNotificationFeedItem[]>;
  countUnreadWebNotifications(input: WebNotificationFeedScope): Promise<number>;
  markWebNotificationRead(input: MarkWebNotificationReadInput): Promise<void>;
  markAllWebNotificationsRead(input: MarkAllWebNotificationsReadInput): Promise<void>;
}

export function createPostgresWebNotificationAdapter(
  options: PostgresWebNotificationAdapterOptions,
): NotificationChannelAdapter {
  const db = options.db;
  const tableName = assertSqlIdentifier(options.tableName ?? DEFAULT_TABLE_NAME);
  const now = options.now ?? (() => new Date());

  return {
    channel: "web",
    providerName: "web-notification-feed",
    async sendNotificationChannel(delivery: NotificationDelivery): Promise<SentNotificationReceipt> {
      const channel = assertWebChannel(delivery.channel);
      const createdAt = now().toISOString();
      const title = channel.title?.trim() || delivery.message.title;
      const body = channel.body?.trim() || delivery.message.body;
      const actionHref = channel.actionHref?.trim() || delivery.message.actionHref?.trim() || null;

      await db.query(
        `INSERT INTO ${tableName} (
           delivery_id,
           user_id,
           account_id,
           message_type,
           criticality,
           title,
           body,
           action_href,
           correlation_id,
           source_idempotency_key,
           created_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         ON CONFLICT (delivery_id) DO NOTHING`,
        [
          delivery.deliveryId,
          channel.recipient.userId ?? null,
          channel.recipient.accountId ?? null,
          delivery.message.messageType,
          delivery.message.criticality,
          title,
          body,
          actionHref,
          delivery.message.correlationId,
          delivery.message.idempotencyKey,
          createdAt,
        ],
      );

      return {
        channel: "web",
        providerName: "web-notification-feed",
        providerMessageId: delivery.deliveryId,
        acceptedAt: createdAt,
        attemptCount: 1,
      };
    },
  };
}

export function createPostgresWebNotificationFeed(options: PostgresWebNotificationAdapterOptions): WebNotificationFeed {
  const db = options.db;
  const tableName = assertSqlIdentifier(options.tableName ?? DEFAULT_TABLE_NAME);
  const now = options.now ?? (() => new Date());

  return {
    async listWebNotifications(input) {
      const scope = webNotificationScopeClause(input, 1);
      const values: unknown[] = [...scope.values];
      const includeRead = input.includeRead ?? true;
      const unreadClause = includeRead ? "" : "AND read_at IS NULL";
      const limit = Math.max(1, Math.min(100, Math.floor(input.limit ?? 25)));
      const offset = Math.max(0, Math.floor(input.offset ?? 0));
      values.push(limit, offset);

      const result = await db.query<WebNotificationRow>(
        `SELECT
           notification_id,
           delivery_id,
           user_id,
           account_id,
           message_type,
           criticality,
           title,
           body,
           action_href,
           correlation_id,
           source_idempotency_key,
           read_at,
           created_at
         FROM ${tableName}
         WHERE ${scope.sql}
           ${unreadClause}
         ORDER BY created_at DESC, notification_id DESC
         LIMIT $${values.length - 1}
         OFFSET $${values.length}`,
        values,
      );

      return result.rows.map(rowToWebNotificationFeedItem);
    },

    async countUnreadWebNotifications(input) {
      const scope = webNotificationScopeClause(input, 1);
      const result = await db.query<{ unread_count: string | number | bigint }>(
        `SELECT COUNT(*) AS unread_count
         FROM ${tableName}
         WHERE ${scope.sql}
           AND read_at IS NULL`,
        scope.values,
      );

      return Number(result.rows[0]?.unread_count ?? 0);
    },

    async markWebNotificationRead(input) {
      const readAt = input.readAt ?? now().toISOString();
      const scope = webNotificationScopeClause(input, 2);

      await db.query(
        `UPDATE ${tableName}
         SET read_at = COALESCE(read_at, $1)
         WHERE delivery_id = $${scope.values.length + 2}
           AND ${scope.sql}`,
        [readAt, ...scope.values, input.deliveryId],
      );
    },

    async markAllWebNotificationsRead(input) {
      const readAt = input.readAt ?? now().toISOString();
      const scope = webNotificationScopeClause(input, 2);

      await db.query(
        `UPDATE ${tableName}
         SET read_at = COALESCE(read_at, $1)
         WHERE ${scope.sql}
           AND read_at IS NULL`,
        [readAt, ...scope.values],
      );
    },
  };
}

function assertWebChannel(channel: NotificationDelivery["channel"]): WebNotificationChannel {
  if (channel.channel !== "web") {
    throw new Error(`Web notification adapter cannot send '${channel.channel}'.`);
  }

  const webChannel = channel as WebNotificationChannel;
  if (!webChannel.recipient.userId && !webChannel.recipient.accountId) {
    throw new Error("Web notification recipient requires a user or account.");
  }

  return webChannel;
}

type WebNotificationRow = Readonly<{
  notification_id: string | number | bigint;
  delivery_id: string;
  user_id: string | null;
  account_id: string | null;
  message_type: string;
  criticality: string;
  title: string;
  body: string;
  action_href: string | null;
  correlation_id: string;
  source_idempotency_key: string;
  read_at: Date | string | null;
  created_at: Date | string;
}>;

function rowToWebNotificationFeedItem(row: WebNotificationRow): WebNotificationFeedItem {
  return {
    notificationId: String(row.notification_id),
    deliveryId: row.delivery_id,
    userId: row.user_id,
    accountId: row.account_id,
    messageType: row.message_type,
    criticality: row.criticality,
    title: row.title,
    body: row.body,
    actionHref: row.action_href,
    correlationId: row.correlation_id,
    sourceIdempotencyKey: row.source_idempotency_key,
    readAt: row.read_at ? timestampToIso(row.read_at) : null,
    createdAt: timestampToIso(row.created_at),
  };
}

function webNotificationScopeClause(scope: WebNotificationFeedScope, firstParameterIndex: number) {
  const clauses: string[] = [];
  const values: unknown[] = [];

  if (scope.userId) {
    values.push(scope.userId);
    clauses.push(`user_id = $${firstParameterIndex + values.length - 1}`);
  }

  if (scope.accountId) {
    values.push(scope.accountId);
    clauses.push(`account_id = $${firstParameterIndex + values.length - 1}`);
  }

  if (clauses.length === 0) {
    throw new Error("Web notification feed scope requires a user or account.");
  }

  return {
    sql: `(${clauses.join(" OR ")})`,
    values,
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
