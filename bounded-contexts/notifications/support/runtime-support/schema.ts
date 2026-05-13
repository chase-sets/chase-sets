import { notificationOutboxSchemaSql } from "@chase-sets/notification-outbox";
import { webNotificationsSchemaSql } from "@chase-sets/web-notifications";

export const notificationsSchemaSql = `
${notificationOutboxSchemaSql}

${webNotificationsSchemaSql}

CREATE TABLE IF NOT EXISTS notification_preferences (
  account_id text NOT NULL,
  preference_key text NOT NULL,
  enabled boolean NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (account_id, preference_key)
);`;
