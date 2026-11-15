import { randomUUID } from "node:crypto";
import { ConfigurationEpochError, type ConfigurationConsumer } from "@chase-sets/event-core/configuration-epoch";
import { createEventStoreError, type EventStore } from "@chase-sets/event-core/event-store";
import type { AppendToStreamInput } from "@chase-sets/event-core/storage";
import {
  createPostgresConfigurationEpochStore,
  withConfigurationEpochTransaction,
  type PgQueryable,
  type PgTransactionalPool,
  type PostgresEventStore,
} from "@chase-sets/event-core-postgres";
import type { SessionEvent } from "../domain/domain";

export type AuthSessionTopology = readonly Readonly<{ identity: ConfigurationConsumer; pool: PgTransactionalPool }>[];
export const sessionAuthorityEventClassification = {
  "auth.session.started": "consumed",
  "auth.session.account-switched": "consumed",
  "auth.session.revoked": "consumed",
  "auth.session.expired": "consumed",
} satisfies Record<SessionEvent["type"], "consumed">;

export function sessionOwnerKey(streamId: string): string | undefined {
  const prefix = "auth.session-";
  return streamId.startsWith(prefix) && streamId.length > prefix.length
    ? `session/${streamId.slice(prefix.length)}`
    : undefined;
}

class SessionClosureRequired extends Error {
  constructor(readonly keys: readonly string[]) {
    super("Auth Session closure required");
  }
}

export function createAuthSessionEpochs(pool: PgTransactionalPool, consumers: AuthSessionTopology = []) {
  async function source(db?: PgQueryable) {
    async function readSource(client: PgQueryable) {
      await client.query(
        "INSERT INTO event_configuration_store_identity (singleton, store_id, incarnation) VALUES (true, 'auth', $1) ON CONFLICT DO NOTHING",
        [randomUUID()],
      );
      const rows = await client.query<{ store_id: string; incarnation: string }>(
        "SELECT store_id, incarnation FROM event_configuration_store_identity WHERE singleton = true",
      );
      const identity = rows.rows[0];
      if (rows.rows.length !== 1 || identity?.store_id !== "auth")
        throw new ConfigurationEpochError("Auth source incarnation unavailable");
      const sourceIncarnation = identity.incarnation;
      return createPostgresConfigurationEpochStore({
        pool,
        sourceIncarnation,
        consumers,
        async readCanonicalCreation(db, key) {
          if (!key.startsWith("session/") || key.length === 8)
            throw new ConfigurationEpochError("unknown Auth owner key");
          const rows = await db.query<{ event_type: string; stream_version: number }>(
            "SELECT event_type, stream_version FROM event_store_events WHERE stream_id = $1 ORDER BY stream_version LIMIT 1",
            [`auth.session-${key.slice(8)}`],
          );
          if (rows.rows[0]?.event_type !== "auth.session.started" || Number(rows.rows[0]?.stream_version) !== 1)
            throw new ConfigurationEpochError("Auth canonical Session creation unavailable");
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
        `auth.session-${key.slice(8)}`,
      ]);
      // Creation has no prior grant. Pre-enrollment Sessions are OPEN at creation epoch zero.
      if (!existing.rows.length) continue;
      const status = await epochs.beginClosureInTransaction(db, key);
      if (status.pendingConsumers.length) pending.push(key);
      else await epochs.installClosureInTransaction(db, key);
    }
    if (pending.length) throw new SessionClosureRequired(pending);
  }

  async function transaction<T>(keys: readonly string[], work: (db: PgQueryable) => Promise<T>): Promise<T> {
    async function attempt() {
      return withConfigurationEpochTransaction(pool, async (db) => {
        await db.query("SAVEPOINT auth_session_work");
        try {
          await enroll(db, keys);
          return { kind: "applied" as const, value: await work(db) };
        } catch (error) {
          if (!(error instanceof SessionClosureRequired)) throw error;
          await db.query("ROLLBACK TO SAVEPOINT auth_session_work");
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
        throw new ConfigurationEpochError(`Auth Session writer ${status.status}: ${key}; retry after closure`);
    }
    const retry = await attempt();
    if (retry.kind !== "applied") throw new ConfigurationEpochError("Auth Session writer PENDING during retry");
    return retry.value;
  }
  return { source, transaction };
}

export type AuthSessionEpochs = ReturnType<typeof createAuthSessionEpochs>;

/** All production and seed Session appends, including retained retries, enter here. */
export function createAuthSessionPersistence(store: PostgresEventStore, epochs: AuthSessionEpochs): EventStore {
  async function append(inputs: readonly AppendToStreamInput[]) {
    const keys = inputs
      .filter((input) => input.events.length)
      .flatMap((input) => {
        const key = sessionOwnerKey(input.streamId);
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
