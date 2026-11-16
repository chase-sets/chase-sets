import { randomUUID } from "node:crypto";
import type { ConfigurationConsumer } from "@chase-sets/event-core/configuration-epoch";
import { withConfigurationEpochTransaction, type PgTransactionalPool } from "@chase-sets/event-core-postgres";

export function createMarketplaceListingConsumer(pool: PgTransactionalPool) {
  const topology: { identity: ConfigurationConsumer; pool: PgTransactionalPool }[] = [];
  let pending: Promise<ConfigurationConsumer> | undefined;
  async function initialize(): Promise<ConfigurationConsumer> {
    if (pending) return pending;
    pending = withConfigurationEpochTransaction(pool, async (db) => {
      await db.query(
        "INSERT INTO event_configuration_store_identity (singleton, store_id, incarnation) VALUES (true, 'marketplace', $1) ON CONFLICT DO NOTHING",
        [randomUUID()],
      );
      const result = await db.query<{ store_id: string; incarnation: string }>(
        "SELECT store_id, incarnation FROM event_configuration_store_identity WHERE singleton = true",
      );
      if (result.rows.length !== 1 || !result.rows[0].store_id || !result.rows[0].incarnation)
        throw new Error("Marketplace consumer identity is unavailable.");
      return { storeId: result.rows[0].store_id, incarnation: result.rows[0].incarnation };
    })
      .then((identity) => {
        topology.splice(0, topology.length, { identity, pool });
        return identity;
      })
      .catch((error) => {
        pending = undefined;
        throw error;
      });
    return pending;
  }
  return { topology, initialize };
}
