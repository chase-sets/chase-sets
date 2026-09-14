import type { PgQueryable, PostgresEventStore } from "@chase-sets/event-core-postgres";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { ChannelHealthQuery, ChannelHealthReasonGeneration } from "../../connection-health/domain/contracts";
import { decodeChannelAttentionFact } from "../domain/codecs";
import type { ChannelAttentionResolution } from "../domain/contracts";

export async function publishAttentionFact(
  db: PgQueryable,
  eventStore: PostgresEventStore,
  connection: ChannelHealthQuery,
  reason: ChannelHealthReasonGeneration,
  context: EventStoreContext,
  resolutionReason: ChannelAttentionResolution | null,
  resolvedAt: string | null,
) {
  const payload = decodeChannelAttentionFact({
    schemaVersion: resolutionReason === null ? "ChannelAttentionOpened/v1" : "ChannelAttentionResolved/v1",
    connection,
    reasonCode: reason.reasonCode,
    generation: reason.generation,
    resolutionReason,
    openedAt: reason.opening.occurredAt,
    resolvedAt,
  });
  await eventStore.appendToStreamInTransaction(db, {
    streamId: `channels.connection-attention-${connection.connectionId}`,
    wakeSourceContextName: "channels",
    expectedVersion: "any",
    events: [
      {
        eventType:
          resolutionReason === null ? "channels.connection.attention-opened" : "channels.connection.attention-resolved",
        payload,
      },
    ],
    context,
  });
}

export async function recordAttentionHealthTransition(
  db: PgQueryable,
  eventStore: PostgresEventStore,
  connection: ChannelHealthQuery,
  reason: ChannelHealthReasonGeneration,
  context: EventStoreContext,
) {
  if (reason.state !== "closed") {
    const inserted = await db.query(
      `INSERT INTO channel_connection_attention
      (connection_id,account_id,reason_code,reason_generation,fingerprint,opened_at)
      SELECT $1,$2,$3,$4,$5,$6 WHERE EXISTS (SELECT 1 FROM channel_connection_health AS health
        WHERE health.connection_id=$1 AND health.account_id=$2 AND health.reasons @> $7::jsonb)
      ON CONFLICT (connection_id,reason_code,reason_generation) DO NOTHING RETURNING connection_id`,
      [
        connection.connectionId,
        connection.accountId,
        reason.reasonCode,
        reason.generation,
        reason.fingerprint,
        reason.opening.occurredAt,
        JSON.stringify([reason]),
      ],
    );
    if (inserted.rows.length) await publishAttentionFact(db, eventStore, connection, reason, context, null, null);
    return;
  }
  const resolved = await db.query(
    `UPDATE channel_connection_attention SET resolved_at=$6,resolution_reason='recovered-automatically'
    WHERE connection_id=$1 AND account_id=$2 AND reason_code=$3 AND reason_generation=$4 AND fingerprint=$5
      AND resolved_at IS NULL AND resolution_reason IS NULL
      AND EXISTS (SELECT 1 FROM channel_connection_health AS health WHERE health.connection_id=$1 AND health.account_id=$2
        AND health.reasons @> $7::jsonb) RETURNING connection_id`,
    [
      connection.connectionId,
      connection.accountId,
      reason.reasonCode,
      reason.generation,
      reason.fingerprint,
      reason.lastOccurredAt,
      JSON.stringify([reason]),
    ],
  );
  if (resolved.rows.length)
    await publishAttentionFact(
      db,
      eventStore,
      connection,
      reason,
      context,
      "recovered-automatically",
      reason.lastOccurredAt,
    );
}
