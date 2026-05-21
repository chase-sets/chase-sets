import type { PgQueryable } from "@chase-sets/event-core-postgres";

export type ProviderWebhookInboxEntry = Readonly<{
  tableName: string;
  providerEventId: string;
  providerName: string;
  eventKind: string;
  providerObjectReference?: string | null;
  receivedAt?: string;
}>;

function assertSafeTableName(tableName: string) {
  if (!/^[a-z][a-z0-9_]*$/.test(tableName)) {
    throw new Error("Provider webhook inbox table name is invalid.");
  }
}

export async function recordProviderWebhookEvent(db: PgQueryable, entry: ProviderWebhookInboxEntry) {
  assertSafeTableName(entry.tableName);
  const result = await db.query<{ provider_event_id: string }>(
    `INSERT INTO ${entry.tableName} (
       provider_event_id,
       provider_name,
       event_kind,
       provider_object_reference,
       received_at
     ) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (provider_event_id) DO NOTHING
     RETURNING provider_event_id`,
    [
      entry.providerEventId,
      entry.providerName,
      entry.eventKind,
      entry.providerObjectReference ?? null,
      entry.receivedAt ?? new Date().toISOString(),
    ],
  );

  return (result.rowCount ?? result.rows.length) > 0;
}
