import type { BcRetentionSweep } from "@chase-sets/bounded-context-module";

export const notificationsRetentionSweeps: readonly BcRetentionSweep[] = [
  providerEvents("mobile-message-provider-events", "notification_mobile_message_provider_events"),
  providerEvents("email-provider-events", "notification_email_provider_events"),
];

function providerEvents(name: string, tableName: string): BcRetentionSweep {
  return {
    name,
    tableName,
    predicateSql: "candidate.received_at < now() - interval '90 days'",
    orderBySql: "candidate.received_at ASC",
    intervalMs: 6 * 60 * 60 * 1_000,
    batchLimit: 500,
  };
}
