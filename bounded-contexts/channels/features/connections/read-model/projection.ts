import type { ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { channelConnectionEventCodec } from "../domain/codec";

export function buildChannelConnectionProjectionHandlers(db: PgQueryable): ProjectorHandlerMap {
  return {
    "channels.connection.connected": async (transport) => {
      const event = decode(transport);
      if (event.type !== "channels.connection.connected") return;
      await db.query(
        `INSERT INTO channel_connections (
           connection_id, account_id, provider_key, environment, status,
           created_at, created_at_instant, credential_reference, bindings,
           projection_updated_at, last_stream_version
         )
         VALUES ($1, $2, $3, $4, 'pending-setup', $5::text, ($5::text)::timestamptz, NULL, '[]'::jsonb, $6, $7)
         ON CONFLICT (connection_id) DO UPDATE
         SET account_id = EXCLUDED.account_id,
             provider_key = EXCLUDED.provider_key,
             environment = EXCLUDED.environment,
             status = EXCLUDED.status,
             created_at = EXCLUDED.created_at,
             created_at_instant = EXCLUDED.created_at_instant,
             credential_reference = NULL,
             bindings = '[]'::jsonb,
             projection_updated_at = EXCLUDED.projection_updated_at,
             last_stream_version = EXCLUDED.last_stream_version
         WHERE channel_connections.last_stream_version < EXCLUDED.last_stream_version`,
        [
          event.data.connectionId,
          event.data.accountId,
          event.data.providerKey,
          event.data.environment,
          event.data.createdAt,
          transport.timing.recordedAt,
          transport.streamVersion,
        ],
      );
    },
    "channels.connection.activated": async (transport) => {
      const event = decode(transport);
      if (event.type !== "channels.connection.activated") return;
      await db.query(
        `UPDATE channel_connections
         SET status = 'active',
             credential_reference = $2,
             bindings = $3::jsonb,
             projection_updated_at = $4,
             last_stream_version = $5
         WHERE connection_id = $1
           AND last_stream_version < $5`,
        [
          event.data.connectionId,
          event.data.credentialReference,
          JSON.stringify(event.data.bindings),
          transport.timing.recordedAt,
          transport.streamVersion,
        ],
      );
    },
    "channels.connection.paused": async (transport) => {
      const event = decode(transport);
      if (event.type !== "channels.connection.paused") return;
      await updateStatus(db, event.data.connectionId, "paused", transport.timing.recordedAt, transport.streamVersion);
    },
    "channels.connection.resumed": async (transport) => {
      const event = decode(transport);
      if (event.type !== "channels.connection.resumed") return;
      await updateStatus(db, event.data.connectionId, "active", transport.timing.recordedAt, transport.streamVersion);
    },
    "channels.connection.disconnected": async (transport) => {
      const event = decode(transport);
      if (event.type !== "channels.connection.disconnected") return;
      await db.query(
        `UPDATE channel_connections
         SET status = 'disconnected',
             credential_reference = NULL,
             bindings = '[]'::jsonb,
             projection_updated_at = $2,
             last_stream_version = $3
         WHERE connection_id = $1
           AND last_stream_version < $3`,
        [event.data.connectionId, transport.timing.recordedAt, transport.streamVersion],
      );
    },
  };
}

function decode(transport: Parameters<ProjectorHandlerMap[string]>[0]) {
  return channelConnectionEventCodec.decode({ eventType: transport.type, payload: transport.data });
}

async function updateStatus(
  db: PgQueryable,
  connectionId: string,
  status: "active" | "paused",
  recordedAt: string,
  streamVersion: number,
) {
  await db.query(
    `UPDATE channel_connections
     SET status = $2,
         projection_updated_at = $3,
         last_stream_version = $4
     WHERE connection_id = $1
       AND last_stream_version < $4`,
    [connectionId, status, recordedAt, streamVersion],
  );
}
