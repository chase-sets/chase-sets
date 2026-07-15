import { notificationOutboxSchemaSql } from "@chase-sets/notification-outbox";
import { webNotificationsSchemaSql } from "@chase-sets/web-notifications";
import { eventCorePostgresSchemaSql } from "@chase-sets/event-core-postgres";

export const notificationsSchemaSql = `
${eventCorePostgresSchemaSql}

${notificationOutboxSchemaSql}

${webNotificationsSchemaSql}

CREATE TABLE IF NOT EXISTS notification_preferences (
  account_id text NOT NULL,
  preference_key text NOT NULL,
  enabled boolean NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (account_id, preference_key)
);

CREATE TABLE IF NOT EXISTS notification_mobile_message_provider_events (
  provider_event_id text PRIMARY KEY,
  provider_name text NOT NULL,
  event_kind text NOT NULL,
  provider_object_reference text NOT NULL,
  delivery_id text NULL,
  status text NULL,
  failure_code text NULL,
  failure_message text NULL,
  from_phone_number text NULL,
  to_phone_number text NULL,
  message_body text NULL,
  occurred_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL,
  payload_json text NOT NULL
);

CREATE INDEX IF NOT EXISTS notification_mobile_message_provider_events_delivery_idx
  ON notification_mobile_message_provider_events (delivery_id, occurred_at DESC)
  WHERE delivery_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS notification_mobile_message_provider_events_received_idx
  ON notification_mobile_message_provider_events (received_at DESC);

CREATE TABLE IF NOT EXISTS notification_email_provider_events (
  provider_event_id text PRIMARY KEY,
  provider_name text NOT NULL,
  event_kind text NOT NULL,
  provider_object_reference text NOT NULL,
  recipients_json text NOT NULL,
  occurred_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL,
  payload_json text NOT NULL
);

CREATE INDEX IF NOT EXISTS notification_email_provider_events_message_idx
  ON notification_email_provider_events (provider_object_reference, occurred_at DESC);

CREATE INDEX IF NOT EXISTS notification_email_provider_events_received_idx
  ON notification_email_provider_events (received_at DESC);
`;
