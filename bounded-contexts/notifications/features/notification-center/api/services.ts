import { createPostgresEventStore, type PgQueryable, type PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { createEventStoreWakeNotificationConfigForSourceContext } from "@chase-sets/platform-runtime/source-context-wake-registry";
import { createPostgresNotificationOutbox } from "@chase-sets/notification-outbox";
import {
  createNoopEmailWebhookGateway,
  createNoopMobileMessageWebhookGateway,
  type EmailProviderWebhookEvent,
  type EmailWebhookGateway,
  type MobileMessageProviderWebhookEvent,
  type MobileMessageWebhookGateway,
  type NotificationChannelPreference,
  type NotificationPreferenceResolver,
  type NotificationDeliveryOutcomeReporter,
} from "@chase-sets/outbound-messaging";
import { createPostgresWebNotificationFeed } from "@chase-sets/web-notifications";
import {
  defaultNotificationPreferences,
  type NotificationPreference,
  type NotificationPreferenceKey,
} from "../../preferences/domain/preferences";
import { createCustomerFeedbackNotificationDeliveryOutcomeReporter } from "../domain/customer-feedback-delivery";

export {
  defaultNotificationPreferences,
  type NotificationPreference,
  type NotificationPreferenceKey,
} from "../../preferences/domain/preferences";

export interface NotificationPreferenceStore {
  listPreferences(accountId: string): Promise<readonly NotificationPreference[]>;
  setPreference(
    input: Readonly<{
      accountId: string;
      key: NotificationPreferenceKey;
      enabled: boolean;
    }>,
  ): Promise<NotificationPreference>;
}

export type NotificationsServices = Readonly<{
  emailMessages: EmailProviderEventStore;
  emailWebhookGateway: EmailWebhookGateway;
  feed: ReturnType<typeof createPostgresWebNotificationFeed>;
  mobileMessages: MobileMessageProviderEventStore;
  mobileMessageWebhookGateway: MobileMessageWebhookGateway;
  notificationOutbox: ReturnType<typeof createPostgresNotificationOutbox>;
  notificationDeliveryOutcomeReporter: NotificationDeliveryOutcomeReporter;
  notificationPreferenceResolver: NotificationPreferenceResolver;
  preferences: NotificationPreferenceStore;
}>;

export type NotificationsHostPorts = Readonly<{
  emailWebhookGateway?: EmailWebhookGateway;
  mobileMessageWebhookGateway?: MobileMessageWebhookGateway;
}>;

export interface EmailProviderEventStore {
  recordProviderEvent(event: EmailProviderWebhookEvent): Promise<Readonly<{ recorded: boolean }>>;
}

export interface MobileMessageProviderEventStore {
  recordProviderEvent(event: MobileMessageProviderWebhookEvent): Promise<Readonly<{ recorded: boolean }>>;
}

export function createNotificationsServices(
  pool: PgTransactionalPool,
  ports: NotificationsHostPorts = {},
): NotificationsServices {
  const db = pool as PgQueryable;
  const preferences = createPostgresNotificationPreferenceStore(db);
  const eventStore = createPostgresEventStore({
    pool,
    wakeNotifications: createEventStoreWakeNotificationConfigForSourceContext({ sourceContextName: "notifications" }),
  });

  return {
    emailMessages: createPostgresEmailProviderEventStore(db),
    emailWebhookGateway: ports.emailWebhookGateway ?? createNoopEmailWebhookGateway(),
    feed: createPostgresWebNotificationFeed({ db }),
    mobileMessages: createPostgresMobileMessageProviderEventStore(db),
    mobileMessageWebhookGateway: ports.mobileMessageWebhookGateway ?? createNoopMobileMessageWebhookGateway(),
    notificationOutbox: createPostgresNotificationOutbox({ db }),
    notificationDeliveryOutcomeReporter: createCustomerFeedbackNotificationDeliveryOutcomeReporter(eventStore),
    notificationPreferenceResolver: createNotificationPreferenceResolver(preferences),
    preferences,
  };
}

function createNotificationPreferenceResolver(store: NotificationPreferenceStore): NotificationPreferenceResolver {
  return {
    async listPreferences(accountId) {
      const preferences = await store.listPreferences(accountId);
      return preferences.map(toChannelPreference);
    },
  };
}

function toChannelPreference(preference: NotificationPreference): NotificationChannelPreference {
  if (preference.key === "product-alerts") {
    return {
      channel: null,
      category: "product-alerts",
      enabled: preference.enabled,
    };
  }

  return {
    channel: preference.key,
    enabled: preference.enabled,
  };
}

function createPostgresEmailProviderEventStore(db: PgQueryable): EmailProviderEventStore {
  return {
    async recordProviderEvent(event) {
      const receivedAt = event.receivedAt ?? new Date().toISOString();
      const result = await db.query(
        `INSERT INTO notification_email_provider_events (
           provider_event_id,
           provider_name,
           event_kind,
           provider_object_reference,
           recipients_json,
           occurred_at,
           received_at,
           payload_json
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (provider_event_id) DO NOTHING`,
        [
          event.providerEventId,
          event.providerName,
          event.eventKind,
          event.providerMessageId,
          JSON.stringify(event.recipients),
          event.occurredAt,
          receivedAt,
          JSON.stringify(event),
        ],
      );

      return { recorded: (result.rowCount ?? 0) > 0 };
    },
  };
}

function createPostgresMobileMessageProviderEventStore(db: PgQueryable): MobileMessageProviderEventStore {
  return {
    async recordProviderEvent(event) {
      const receivedAt = event.receivedAt ?? new Date().toISOString();
      const result = await db.query(
        `INSERT INTO notification_mobile_message_provider_events (
           provider_event_id,
           provider_name,
           event_kind,
           provider_object_reference,
           delivery_id,
           status,
           failure_code,
           failure_message,
           from_phone_number,
           to_phone_number,
           message_body,
           occurred_at,
           received_at,
           payload_json
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
         ON CONFLICT (provider_event_id) DO NOTHING`,
        [
          event.providerEventId,
          event.providerName,
          event.eventKind,
          event.providerMessageId,
          event.deliveryId ?? null,
          event.status ?? null,
          event.failureCode ?? null,
          event.failureMessage ?? null,
          event.fromPhoneNumber ?? null,
          event.toPhoneNumber ?? null,
          event.body ?? null,
          event.occurredAt,
          receivedAt,
          JSON.stringify(event),
        ],
      );

      return { recorded: (result.rowCount ?? 0) > 0 };
    },
  };
}

function createPostgresNotificationPreferenceStore(db: PgQueryable): NotificationPreferenceStore {
  return {
    async listPreferences(accountId) {
      const result = await db.query<{
        preference_key: string;
        enabled: boolean;
      }>(
        `SELECT preference_key, enabled
         FROM notification_preferences
         WHERE account_id = $1`,
        [accountId],
      );
      const saved = new Map(result.rows.map((row) => [row.preference_key, Boolean(row.enabled)]));

      return defaultNotificationPreferences.map((preference) => ({
        ...preference,
        enabled: saved.get(preference.key) ?? preference.enabled,
      }));
    },

    async setPreference(input) {
      await db.query(
        `INSERT INTO notification_preferences (
           account_id,
           preference_key,
           enabled,
           updated_at
         ) VALUES ($1, $2, $3, $4)
         ON CONFLICT (account_id, preference_key)
         DO UPDATE SET enabled = EXCLUDED.enabled, updated_at = EXCLUDED.updated_at`,
        [input.accountId, input.key, input.enabled, new Date().toISOString()],
      );

      return {
        key: input.key,
        enabled: input.enabled,
      };
    },
  };
}
