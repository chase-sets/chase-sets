import {
  withPgTransaction,
  type PgQueryable,
  type PgTransactionalPool,
  type PostgresEventStore,
} from "@chase-sets/event-core-postgres";
import type { ConnectionHealthServices } from "../../connection-health/domain/contracts";
import { decodeChannelAttentionResolve } from "../domain/codecs";
import { ChannelAttentionError, type ConnectionAttentionServices } from "../domain/contracts";
import { readConnectionAttention } from "../read-model/query";
import { publishAttentionFact, recordAttentionHealthTransition } from "./lifecycle";

export function createConnectionAttentionRuntime(
  deps: Readonly<{
    db: PgTransactionalPool;
    eventStore: PostgresEventStore;
    connectionHealth: ConnectionHealthServices;
  }>,
): ConnectionAttentionServices {
  return {
    listOpenAttention: (input) => readConnectionAttention(deps.db, input),
    async resolveAttention(input, context) {
      const command = decodeChannelAttentionResolve(input);
      const { connection, reasonCode, generation, resolutionReason } = command;
      if (connection.accountId !== context.audit.forAccountId) throw new ChannelAttentionError("connection-not-found");
      // Automatic recovery is producer-owned, not a seller assertion of success.
      if (resolutionReason === "recovered-automatically") throw new ChannelAttentionError("invalid-attention-contract");
      const reasons = await deps.connectionHealth.listOpenReasonGenerations(connection);
      const reason = reasons.find((item) => item.reasonCode === reasonCode && item.generation === generation);
      if (!reason) return { outcome: "stale" };
      return withPgTransaction(deps.db, async (db: PgQueryable) => {
        await db.query("SELECT stream_id FROM event_store_streams WHERE stream_id=$1 FOR UPDATE", [
          `channels.connection-${connection.connectionId}`,
        ]);
        const current = await db.query(
          `SELECT 1 FROM channel_connection_health WHERE connection_id=$1 AND account_id=$2 AND reasons @> $3::jsonb FOR UPDATE`,
          [connection.connectionId, connection.accountId, JSON.stringify([reason])],
        );
        if (current.rows.length === 0) return { outcome: "stale" };
        await recordAttentionHealthTransition(db, deps.eventStore, connection, reason, context);
        const at = new Date().toISOString();
        const result = await db.query(
          `UPDATE channel_connection_attention SET resolved_at=$6,resolution_reason=$7
          WHERE connection_id=$1 AND account_id=$2 AND reason_code=$3 AND reason_generation=$4 AND fingerprint=$5
            AND resolved_at IS NULL AND resolution_reason IS NULL
            AND EXISTS (SELECT 1 FROM channel_connection_health AS health WHERE health.connection_id=$1 AND health.account_id=$2 AND health.reasons @> $8::jsonb)
          RETURNING connection_id`,
          [
            connection.connectionId,
            connection.accountId,
            reasonCode,
            generation,
            reason.fingerprint,
            at,
            resolutionReason,
            JSON.stringify([reason]),
          ],
        );
        if (!result.rows.length) return { outcome: "inert" };
        await publishAttentionFact(db, deps.eventStore, connection, reason, context, resolutionReason, at);
        return { outcome: "resolved" };
      });
    },
  };
}
