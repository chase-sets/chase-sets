import { randomUUID } from "node:crypto";
import {
  assertConfigurationText,
  ConfigurationEpochError,
  type ConfigurationConsumer,
} from "@chase-sets/event-core/configuration-epoch";
import { createEventStoreError, type EventStore } from "@chase-sets/event-core/event-store";
import type { AppendToStreamInput } from "@chase-sets/event-core/storage";
import {
  createPostgresConfigurationEpochStore,
  withConfigurationEpochTransaction,
  type PgQueryable,
  type PgTransactionalPool,
  type PostgresEventStore,
} from "@chase-sets/event-core-postgres";
import { ChannelConnectionError, type ChannelConnectionEvent } from "../domain/contracts";

export type ConnectionConsumerTopology = readonly Readonly<{
  identity: ConfigurationConsumer;
  pool: PgTransactionalPool;
}>[];

export const connectionAuthorityEventClassification = {
  "channels.connection.connected": "consumed",
  "channels.connection.activated": "consumed",
  "channels.connection.paused": "consumed",
  "channels.connection.resumed": "consumed",
  "channels.connection.disconnected": "consumed",
} satisfies Record<ChannelConnectionEvent["type"], "consumed">;

export function connectionOwnerKey(streamId: string): string | undefined {
  const prefix = "channels.connection-";
  return streamId.startsWith(prefix) && streamId.length > prefix.length
    ? `connection/${streamId.slice(prefix.length)}`
    : undefined;
}

class ConnectionClosureRequired extends Error {
  constructor(readonly keys: readonly string[]) {
    super("Channels Connection closure required");
  }
}

// CLOSING commits separately from business effects when receipts are outstanding.
export function createConnectionEpochs(pool: PgTransactionalPool, consumers: ConnectionConsumerTopology = []) {
  async function source(db?: PgQueryable) {
    async function readSource(client: PgQueryable) {
      await client.query(
        "INSERT INTO event_configuration_store_identity (singleton, store_id, incarnation) VALUES (true, 'channels', $1) ON CONFLICT DO NOTHING",
        [randomUUID()],
      );
      const rows = await client.query<{ store_id: string; incarnation: string }>(
        "SELECT store_id, incarnation FROM event_configuration_store_identity WHERE singleton = true",
      );
      const identity = rows.rows[0];
      if (rows.rows.length !== 1 || !identity)
        throw new ConfigurationEpochError("Channels source incarnation unavailable");
      assertConfigurationText(identity.store_id);
      assertConfigurationText(identity.incarnation);
      const sourceIncarnation = identity.incarnation;
      return createPostgresConfigurationEpochStore({
        pool,
        sourceIncarnation,
        consumers,
        async readCanonicalCreation(db, key) {
          if (!key.startsWith("connection/") || key.length === 11)
            throw new ConfigurationEpochError("unknown Channels owner key");
          const rows = await db.query<{ event_type: string; stream_version: number }>(
            "SELECT event_type, stream_version FROM event_store_events WHERE stream_id = $1 ORDER BY stream_version LIMIT 1",
            [`channels.connection-${key.slice(11)}`],
          );
          if (
            rows.rows[0]?.event_type !== "channels.connection.connected" ||
            Number(rows.rows[0]?.stream_version) !== 1
          )
            throw new ConfigurationEpochError("Channels canonical Connection creation unavailable");
          return { kind: "CREATED", sourceIncarnation, keyCreationEpoch: 0 };
        },
      });
    }
    return db ? readSource(db) : withConfigurationEpochTransaction(pool, readSource);
  }

  async function enroll(db: PgQueryable, keys: readonly string[]) {
    const epochs = await source(db);
    const pending: string[] = [];
    for (const key of [...new Set(keys)].sort()) {
      await db.query("SELECT pg_advisory_xact_lock(hashtextextended('configuration_epoch:' || $1::text, 0))", [key]);
      const existing = await db.query("SELECT stream_id FROM event_store_streams WHERE stream_id = $1", [
        `channels.connection-${key.slice(11)}`,
      ]);
      if (!existing.rows.length) continue;
      const status = await epochs.beginClosureInTransaction(db, key);
      if (status.pendingConsumers.length) pending.push(key);
      else await epochs.installClosureInTransaction(db, key);
    }
    if (pending.length) throw new ConnectionClosureRequired(pending);
  }

  async function transaction<T>(keys: readonly string[], work: (db: PgQueryable) => Promise<T>): Promise<T> {
    async function attempt() {
      return withConfigurationEpochTransaction(pool, async (db) => {
        await db.query("SAVEPOINT channels_connection_work");
        try {
          await enroll(db, keys);
          return { kind: "applied" as const, value: await work(db) };
        } catch (error) {
          if (!(error instanceof ConnectionClosureRequired)) throw error;
          await db.query("ROLLBACK TO SAVEPOINT channels_connection_work");
          const epochs = await source(db);
          for (const key of error.keys) await epochs.beginClosureInTransaction(db, key);
          return { kind: "closing" as const, keys: error.keys };
        }
      });
    }
    const first = await attempt();
    if (first.kind === "applied") return first.value;
    const epochs = await source();
    for (const key of first.keys) {
      const status = await epochs.driveClosure(key);
      if (status.pendingConsumers.length)
        throw new ChannelConnectionError(
          "connection-change-pending",
          `Channels Connection writer ${status.status}; retry after closure`,
        );
    }
    const retry = await attempt();
    if (retry.kind !== "applied") throw new ChannelConnectionError("connection-change-pending");
    return retry.value;
  }
  return { source, transaction };
}

export type ConnectionEpochs = ReturnType<typeof createConnectionEpochs>;

/** Handler, seed and retained replay appends share the physical Connection fence. */
export function createConnectionPersistence(store: PostgresEventStore, epochs: ConnectionEpochs): EventStore {
  async function append(inputs: readonly AppendToStreamInput[]) {
    const keys = inputs
      .filter((input) => input.events.length)
      .flatMap((input) => {
        const key = connectionOwnerKey(input.streamId);
        return key ? [key] : [];
      });
    if (!keys.length) return store.appendToStreams!(inputs);
    return epochs.transaction(keys, (db) => store.appendToStreamsInTransaction(db, inputs));
  }
  return {
    readStream: (input) => store.readStream(input),
    readAll: (input) => store.readAll(input),
    appendToStreams: append,
    appendToStream: async (input) => {
      if (input.requestTerminal)
        throw createEventStoreError("concurrency_conflict", "Request terminals require appendToStreams.");
      if (input.configurationGrants?.length)
        throw createEventStoreError("concurrency_conflict", "Class-C grants require appendToStreams.");
      if (!input.events.length) return [];
      return (await append([input]))[0].storedEvents;
    },
  };
}
