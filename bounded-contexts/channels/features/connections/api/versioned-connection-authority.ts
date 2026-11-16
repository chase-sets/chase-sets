import {
  CONFIGURATION_EPOCH_LOCK_SQL,
  withConfigurationEpochTransaction,
  type PgQueryable,
  type PgTransactionalPool,
  type PostgresEventStore,
} from "@chase-sets/event-core-postgres";
import {
  ChannelConnectionError,
  type VersionedConnectionAuthority,
  type ConnectionAuthorityResult,
} from "../domain/contracts";
import { assertOpaqueId } from "../domain/validation";
import { loadOwned } from "./runtime";
import type { ConnectionEpochs } from "./owner-epochs";

// Canonical ownership, seal and grant are captured under the writer's epoch lock.
export function createVersionedConnectionAuthority(
  pool: PgTransactionalPool,
  store: PostgresEventStore,
  epochs: ConnectionEpochs,
): VersionedConnectionAuthority {
  return {
    async registerConsumer(input) {
      assertOpaqueId(input.connectionId, "connectionId");
      await (await epochs.source()).registerConsumer(`connection/${input.connectionId}`, input.consumer);
    },
    async capture(input) {
      try {
        assertOpaqueId(input.accountId, "accountId");
        assertOpaqueId(input.connectionId, "connectionId");
        const source = await epochs.source();
        return await withConfigurationEpochTransaction<ConnectionAuthorityResult>(pool, async (db: PgQueryable) => {
          const key = `connection/${input.connectionId}`;
          await db.query(CONFIGURATION_EPOCH_LOCK_SQL, [key]);
          const loaded = await loadOwned(
            { readStream: (request) => store.readStreamInTransaction(db, request) },
            input.accountId,
            input.connectionId,
          );
          if (loaded.state.status !== "active") return { kind: "denied", reason: "connection-not-active" };
          const heads = await db.query<{ current_version: number }>(
            "SELECT current_version FROM event_store_streams WHERE stream_id = $1",
            [`channels.connection-${input.connectionId}`],
          );
          if (Number(heads.rows[0]?.current_version) !== loaded.version)
            return { kind: "denied", reason: "connection-authority-unavailable" };
          const grant = await source.captureGrantInTransaction(db, key, input.consumer);
          return {
            kind: "granted",
            connectionId: input.connectionId,
            accountId: loaded.state.accountId!,
            providerKey: loaded.state.providerKey!,
            environment: loaded.state.environment!,
            status: "active",
            version: loaded.version,
            seal: { version: loaded.version, storeIncarnation: grant.sourceIncarnation },
            grant,
          };
        });
      } catch (error) {
        return {
          kind: "denied",
          reason:
            error instanceof ChannelConnectionError && error.code === "connection-not-found"
              ? "connection-not-found"
              : "connection-authority-unavailable",
        };
      }
    },
  };
}
