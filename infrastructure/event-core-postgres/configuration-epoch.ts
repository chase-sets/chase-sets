import type {
  ConfigurationClosureStatus,
  ConfigurationConsumerRegistration,
  ConfigurationEpoch,
  ConfigurationEpochGrant,
  ConfigurationEpochStore,
  ConfigurationGuardRecord,
  ConfigurationKey,
} from "@chase-sets/event-core/configuration-epoch";
import { ConfigurationEpochError } from "@chase-sets/event-core/configuration-epoch";
import type { PgQueryable, PgTransactionalPool } from "./types";
import { withPgTransaction } from "./types";

export type PostgresConfigurationEpochStoreConfig = Readonly<{
  pool: PgTransactionalPool;
  ownerTableName?: string;
  topologyTableName?: string;
  receiptTableName?: string;
  now?: () => string;
}>;

const OWNER_TABLE = "event_configuration_guard_history";
const TOPOLOGY_TABLE = "event_configuration_source_topology";
const RECEIPT_TABLE = "event_configuration_closed_through";
const LOCK_NAMESPACE = "configuration_epoch:";

function tableName(value: string | undefined, fallback: string): string {
  const name = value ?? fallback;
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`Invalid configuration epoch table name: ${name}`);
  return name;
}

function assertText(value: string, field: string): void {
  if (!value || value.length > 512) throw new ConfigurationEpochError(`${field} must be a non-empty bounded string.`);
}

function assertEpoch(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new ConfigurationEpochError(`${field} must be a non-negative safe integer.`);
}

function mapGuard(row: Record<string, unknown>): ConfigurationGuardRecord {
  return {
    key: String(row.key),
    epoch: Number(row.epoch),
    storeIncarnation: String(row.store_incarnation),
    keyCreationEpoch: Number(row.key_creation_epoch),
    state: String(row.state) as ConfigurationGuardRecord["state"],
    topologyRevision: Number(row.topology_revision),
  };
}

async function lock(client: PgQueryable, key: string, mode: "shared" | "exclusive"): Promise<void> {
  await client.query(
    `SELECT pg_advisory_xact_lock${mode === "shared" ? "_shared" : ""}(hashtextextended($1::text, 0))`,
    [`${LOCK_NAMESPACE}${key}`],
  );
}

export function createPostgresConfigurationEpochStore(
  config: PostgresConfigurationEpochStoreConfig,
): ConfigurationEpochStore {
  const ownerTable = tableName(config.ownerTableName, OWNER_TABLE);
  const topologyTable = tableName(config.topologyTableName, TOPOLOGY_TABLE);
  const receiptTable = tableName(config.receiptTableName, RECEIPT_TABLE);
  const now = config.now ?? (() => new Date().toISOString());

  async function current(
    client: PgQueryable,
    key: string,
    epoch?: number,
  ): Promise<ConfigurationGuardRecord | undefined> {
    const result = await client.query<Record<string, unknown>>(
      `SELECT key, epoch, store_incarnation, key_creation_epoch, state, topology_revision
         FROM ${ownerTable}
        WHERE key = $1 ${epoch === undefined ? "" : "AND epoch = $2"}
        ORDER BY epoch DESC LIMIT 1`,
      epoch === undefined ? [key] : [key, epoch],
    );
    return result.rows[0] ? mapGuard(result.rows[0]) : undefined;
  }

  const store: ConfigurationEpochStore = {
    async open(input: ConfigurationKey) {
      assertText(input.key, "key");
      assertText(input.storeIncarnation, "storeIncarnation");
      const epoch = input.keyCreationEpoch ?? 0;
      assertEpoch(epoch, "keyCreationEpoch");
      return withPgTransaction(config.pool, async (client) => {
        await lock(client, input.key, "exclusive");
        await client.query(
          `INSERT INTO ${ownerTable} (key, epoch, store_incarnation, key_creation_epoch, state, topology_revision, updated_at)
           VALUES ($1, $2, $3, $2, 'OPEN', 0, $4)
           ON CONFLICT (key, epoch, store_incarnation) DO NOTHING`,
          [input.key, epoch, input.storeIncarnation, now()],
        );
        const guard = await current(client, input.key, epoch);
        if (!guard) throw new ConfigurationEpochError("Configuration guard history is unknown.");
        return guard;
      });
    },
    async registerConsumer(key, registration: ConfigurationConsumerRegistration) {
      assertText(key, "key");
      assertText(registration.consumerStoreId, "consumerStoreId");
      assertText(registration.storeIncarnation, "storeIncarnation");
      return withPgTransaction(config.pool, async (client) => {
        await lock(client, key, "exclusive");
        const guard = await current(client, key);
        if (guard?.state === "CLOSING" && registration.initializedClosedThroughEpoch === undefined) {
          throw new ConfigurationEpochError("Cannot register a consumer while configuration closure is CLOSING.");
        }
        const revision = (guard?.topologyRevision ?? 0) + 1;
        await client.query(
          `INSERT INTO ${topologyTable} (key, topology_revision, consumer_store_id, store_incarnation, state, initialized_closed_through_epoch, updated_at)
           VALUES ($1, $2, $3, $4, 'REGISTERED', $5, $6)
           ON CONFLICT (key, consumer_store_id) DO UPDATE SET
             topology_revision = EXCLUDED.topology_revision,
             store_incarnation = EXCLUDED.store_incarnation,
             state = 'REGISTERED',
             initialized_closed_through_epoch = EXCLUDED.initialized_closed_through_epoch,
             updated_at = EXCLUDED.updated_at`,
          [
            key,
            revision,
            registration.consumerStoreId,
            registration.storeIncarnation,
            registration.initializedClosedThroughEpoch ?? null,
            now(),
          ],
        );
        if (guard?.state === "CLOSING" && registration.initializedClosedThroughEpoch !== undefined) {
          await client.query(
            `INSERT INTO ${receiptTable} (key, epoch, topology_revision, consumer_store_id, store_incarnation, acknowledged_at)
             VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT DO NOTHING`,
            [
              key,
              registration.initializedClosedThroughEpoch,
              guard.topologyRevision,
              registration.consumerStoreId,
              registration.storeIncarnation,
              now(),
            ],
          );
        }
        if (guard && guard.state !== "CLOSING")
          await client.query(
            `UPDATE ${ownerTable} SET topology_revision = $2, updated_at = $3 WHERE key = $1 AND epoch = $4`,
            [key, revision, now(), guard.epoch],
          );
        return { topologyRevision: revision };
      });
    },
    async retireConsumer(key, consumerStoreId, storeIncarnation) {
      assertText(key, "key");
      assertText(consumerStoreId, "consumerStoreId");
      assertText(storeIncarnation, "storeIncarnation");
      await withPgTransaction(config.pool, async (client) => {
        await lock(client, key, "exclusive");
        const guard = await current(client, key);
        if (guard?.state === "CLOSING")
          throw new ConfigurationEpochError("Cannot retire a consumer while configuration closure is CLOSING.");
        await client.query(
          `UPDATE ${topologyTable} SET state = 'RETIRED', updated_at = $4 WHERE key = $1 AND consumer_store_id = $2 AND store_incarnation = $3`,
          [key, consumerStoreId, storeIncarnation, now()],
        );
      });
    },
    async beginClosure(key, epoch) {
      assertText(key, "key");
      assertEpoch(epoch, "epoch");
      return withPgTransaction(config.pool, async (client) => {
        await lock(client, key, "exclusive");
        const guard = await current(client, key, epoch);
        if (!guard) throw new ConfigurationEpochError("Configuration guard history is unknown.");
        if (guard.state !== "OPEN" && guard.state !== "CLOSING")
          throw new ConfigurationEpochError("Only OPEN configuration guards may close.");
        await client.query(
          `UPDATE ${ownerTable} SET state = 'CLOSING', updated_at = $4 WHERE key = $1 AND epoch = $2 AND store_incarnation = $3`,
          [key, epoch, guard.storeIncarnation, now()],
        );
        const pending = await client.query<{ consumer_store_id: string }>(
          `SELECT consumer_store_id FROM ${topologyTable} WHERE key = $1 AND topology_revision = $2 AND state = 'REGISTERED' ORDER BY consumer_store_id`,
          [key, guard.topologyRevision],
        );
        return {
          key,
          epoch,
          topologyRevision: guard.topologyRevision,
          status: "PENDING",
          pendingConsumerStoreIds: pending.rows.map((row) => row.consumer_store_id),
        } satisfies ConfigurationClosureStatus;
      });
    },
    async acknowledgeClosedThrough(input) {
      assertText(input.key, "key");
      await withPgTransaction(config.pool, async (client) => {
        await lock(client, input.key, "exclusive");
        const guard = await current(client, input.key, input.epoch);
        if (!guard || guard.state !== "CLOSING" || guard.topologyRevision !== input.topologyRevision)
          throw new ConfigurationEpochError("Configuration closure is unknown or topology is stale.");
        const registration = await client.query<{ store_incarnation: string }>(
          `SELECT store_incarnation FROM ${topologyTable} WHERE key = $1 AND topology_revision = $2 AND consumer_store_id = $3 AND state = 'REGISTERED'`,
          [input.key, input.topologyRevision, input.consumerStoreId],
        );
        if (registration.rows[0]?.store_incarnation !== input.storeIncarnation)
          throw new ConfigurationEpochError("Consumer store incarnation is unknown.");
        await client.query(
          `INSERT INTO ${receiptTable} (key, epoch, topology_revision, consumer_store_id, store_incarnation, acknowledged_at) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT DO NOTHING`,
          [input.key, input.epoch, input.topologyRevision, input.consumerStoreId, input.storeIncarnation, now()],
        );
      });
    },
    async installClosure(key, epoch, topologyRevision) {
      assertText(key, "key");
      return withPgTransaction(config.pool, async (client) => {
        await lock(client, key, "exclusive");
        const guard = await current(client, key, epoch);
        if (!guard || guard.state !== "CLOSING")
          throw new ConfigurationEpochError("Configuration closure is not CLOSING.");
        const missing = await client.query<{ consumer_store_id: string }>(
          `SELECT t.consumer_store_id
             FROM ${topologyTable} t
            WHERE t.key = $1 AND t.topology_revision = $2 AND t.state = 'REGISTERED'
              AND NOT EXISTS (
                SELECT 1 FROM ${receiptTable} r
                 WHERE r.key = t.key AND r.epoch = $3 AND r.topology_revision = $2
                   AND r.consumer_store_id = t.consumer_store_id AND r.store_incarnation = t.store_incarnation
              )
            ORDER BY t.consumer_store_id`,
          [key, topologyRevision, epoch],
        );
        if (missing.rows.length)
          throw new ConfigurationEpochError("Configuration closure is pending CLOSED-THROUGH receipts.", {
            missingConsumerStoreIds: missing.rows.map((row) => row.consumer_store_id),
          });
        await client.query(
          `UPDATE ${ownerTable} SET state = 'APPLIED', updated_at = $4 WHERE key = $1 AND epoch = $2 AND store_incarnation = $3`,
          [key, epoch, guard.storeIncarnation, now()],
        );
        await client.query(
          `INSERT INTO ${ownerTable} (key, epoch, store_incarnation, key_creation_epoch, state, topology_revision, updated_at) VALUES ($1, $2, $3, $4, 'OPEN', $5, $6) ON CONFLICT DO NOTHING`,
          [key, epoch + 1, guard.storeIncarnation, epoch + 1, topologyRevision, now()],
        );
        return { ...guard, state: "APPLIED" as const, topologyRevision };
      });
    },
    async recover(key, epoch) {
      return withPgTransaction(config.pool, async (client) => {
        const guard = await current(client, key, epoch);
        if (!guard) throw new ConfigurationEpochError("Configuration guard history is unknown.");
        const pending = await client.query<{ consumer_store_id: string }>(
          `SELECT t.consumer_store_id FROM ${topologyTable} t WHERE t.key = $1 AND t.topology_revision = $2 AND t.state = 'REGISTERED' AND NOT EXISTS (SELECT 1 FROM ${receiptTable} r WHERE r.key = t.key AND r.epoch = $3 AND r.topology_revision = $2 AND r.consumer_store_id = t.consumer_store_id AND r.store_incarnation = t.store_incarnation)`,
          [key, guard.topologyRevision, epoch],
        );
        return {
          key,
          epoch,
          topologyRevision: guard.topologyRevision,
          status: guard.state === "APPLIED" ? "APPLIED" : pending.rows.length ? "PENDING" : "BLOCKED",
          pendingConsumerStoreIds: pending.rows.map((row) => row.consumer_store_id),
        } satisfies ConfigurationClosureStatus;
      });
    },
    async captureGrant(input) {
      assertText(input.key, "key");
      return withPgTransaction(config.pool, async (client) => {
        await lock(client, input.key, "shared");
        const guard = await current(client, input.key);
        if (!guard || guard.state !== "OPEN")
          throw new ConfigurationEpochError("Configuration guard is not OPEN; new grants are refused.");
        const nowValue = input.now ?? now();
        if (input.validUntil !== undefined && Date.parse(input.validUntil) <= Date.parse(nowValue))
          throw new ConfigurationEpochError("Configuration epoch grant is past its scheduled validity bound.");
        return {
          key: input.key,
          epoch: guard.epoch,
          storeIncarnation: guard.storeIncarnation,
          validUntil: input.validUntil,
        };
      });
    },
    validateGrantVector: () => {
      throw new ConfigurationEpochError("Postgres grant validation requires a transaction-scoped adapter.");
    },
  };
  return store;
}

/** Checks a grant vector after taking every key's shared advisory lock. */
export async function validateConfigurationGrantVectorInTransaction(
  client: PgQueryable,
  grants: readonly ConfigurationEpochGrant[],
  now = new Date().toISOString(),
  ownerTableName = OWNER_TABLE,
): Promise<void> {
  const ownerTable = tableName(ownerTableName, OWNER_TABLE);
  const seen = new Set<string>();
  const ordered = [...grants].sort((left, right) =>
    `${left.key}\u0000${left.epoch}\u0000${left.storeIncarnation}`.localeCompare(
      `${right.key}\u0000${right.epoch}\u0000${right.storeIncarnation}`,
    ),
  );
  for (const grant of ordered) {
    const identity = `${grant.key}\u0000${grant.epoch}\u0000${grant.storeIncarnation}`;
    if (seen.has(identity)) throw new ConfigurationEpochError("Configuration grant vector contains a duplicate key.");
    seen.add(identity);
    await lock(client, grant.key, "shared");
    const result = await client.query<{ state: string }>(
      `SELECT state FROM ${ownerTable} WHERE key = $1 AND epoch = $2 AND store_incarnation = $3`,
      [grant.key, grant.epoch, grant.storeIncarnation],
    );
    if (result.rows.length !== 1 || result.rows[0].state !== "OPEN")
      throw new ConfigurationEpochError("Configuration grant is not acknowledged at its installed epoch.");
    if (grant.validUntil !== undefined && Date.parse(grant.validUntil) <= Date.parse(now))
      throw new ConfigurationEpochError("Configuration epoch grant is past its scheduled validity bound.");
  }
}

export const configurationEpochSchemaSql = `
CREATE TABLE IF NOT EXISTS ${OWNER_TABLE} (
  key text NOT NULL,
  epoch bigint NOT NULL CHECK (epoch >= 0),
  store_incarnation text NOT NULL,
  key_creation_epoch bigint NOT NULL CHECK (key_creation_epoch >= 0),
  state text NOT NULL CHECK (state IN ('OPEN', 'CLOSING', 'APPLIED')),
  topology_revision bigint NOT NULL CHECK (topology_revision >= 0),
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (key, epoch, store_incarnation)
);
CREATE TABLE IF NOT EXISTS ${TOPOLOGY_TABLE} (
  key text NOT NULL,
  topology_revision bigint NOT NULL CHECK (topology_revision >= 0),
  consumer_store_id text NOT NULL,
  store_incarnation text NOT NULL,
  state text NOT NULL CHECK (state IN ('REGISTERED', 'RETIRED')),
  initialized_closed_through_epoch bigint NULL CHECK (initialized_closed_through_epoch IS NULL OR initialized_closed_through_epoch >= 0),
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (key, consumer_store_id)
);
CREATE TABLE IF NOT EXISTS ${RECEIPT_TABLE} (
  key text NOT NULL,
  epoch bigint NOT NULL CHECK (epoch >= 0),
  topology_revision bigint NOT NULL CHECK (topology_revision >= 0),
  consumer_store_id text NOT NULL,
  store_incarnation text NOT NULL,
  acknowledged_at timestamptz NOT NULL,
  PRIMARY KEY (key, epoch, topology_revision, consumer_store_id, store_incarnation)
);
CREATE INDEX IF NOT EXISTS ${RECEIPT_TABLE}_lookup_idx ON ${RECEIPT_TABLE} (key, epoch, topology_revision);
`;
