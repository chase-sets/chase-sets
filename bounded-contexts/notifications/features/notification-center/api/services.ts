import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { createPostgresNotificationOutbox } from "@chase-sets/notification-outbox";
import { createPostgresWebNotificationFeed } from "@chase-sets/web-notifications";
import {
  defaultNotificationPreferences,
  type NotificationPreference,
  type NotificationPreferenceKey,
} from "../../preferences/domain/preferences";

export {
  defaultNotificationPreferences,
  type NotificationPreference,
  type NotificationPreferenceKey,
} from "../../preferences/domain/preferences";

export interface NotificationPreferenceStore {
  listPreferences(accountId: string): Promise<readonly NotificationPreference[]>;
  setPreference(input: Readonly<{
    accountId: string;
    key: NotificationPreferenceKey;
    enabled: boolean;
  }>): Promise<NotificationPreference>;
}

export type NotificationsServices = Readonly<{
  feed: ReturnType<typeof createPostgresWebNotificationFeed>;
  notificationOutbox: ReturnType<typeof createPostgresNotificationOutbox>;
  preferences: NotificationPreferenceStore;
}>;

export function createNotificationsServices(db: PgQueryable): NotificationsServices {
  return {
    feed: createPostgresWebNotificationFeed({ db }),
    notificationOutbox: createPostgresNotificationOutbox({ db }),
    preferences: createPostgresNotificationPreferenceStore(db),
  };
}

function createPostgresNotificationPreferenceStore(
  db: PgQueryable,
): NotificationPreferenceStore {
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
      const saved = new Map(
        result.rows.map((row) => [row.preference_key, Boolean(row.enabled)]),
      );

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
        [
          input.accountId,
          input.key,
          input.enabled,
          new Date().toISOString(),
        ],
      );

      return {
        key: input.key,
        enabled: input.enabled,
      };
    },
  };
}
