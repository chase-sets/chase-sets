import { createHash } from "node:crypto";
import {
  ConfigurationEpochError,
  assertConfigurationText,
  assertConfigurationEpoch,
  assertConfigurationGrantCurrent,
  assertConfigurationGrantVector,
  captureConfigurationGrant,
  configurationClosureStatus,
  replayConfigurationEpoch,
  sameConfigurationConsumer,
  type ConfigurationConsumer,
  type ConfigurationConsumerGuard,
  type ConfigurationEpochGrant,
  type ConfigurationEpochRecord,
  type ConfigurationEpochHistory,
} from "@chase-sets/event-core/configuration-epoch";
import {
  withPgTransaction as pgTransaction,
  type PgQueryable,
  type PgTransactionalPool,
  type PgPoolClient,
} from "./types";

export async function withConfigurationEpochTransaction<T>(
  pool: PgTransactionalPool,
  work: (client: PgPoolClient) => Promise<T>,
  options: Readonly<{ afterCommit?: (client: PgPoolClient, result: T) => Promise<void> }> = {},
): Promise<T> {
  const bounded: PgTransactionalPool = {
    query: pool.query.bind(pool),
    async connect() {
      const failure = new ConfigurationEpochError("participation connection timed out; closure remains pending");
      let expired = false;
      const client = await new Promise<PgPoolClient>((resolve, reject) => {
        const timer = setTimeout(() => {
          expired = true;
          reject(failure);
        }, CONFIGURATION_EPOCH_STEP_TIMEOUT_MS);
        pool.connect().then(
          (connected) => {
            clearTimeout(timer);
            if (expired) connected.release(failure);
            else resolve(connected);
          },
          (error: unknown) => {
            clearTimeout(timer);
            reject(error);
          },
        );
      });
      let released = false;
      const release = (error?: unknown) => {
        if (!released) {
          released = true;
          client.release(error);
        }
      };
      return {
        release,
        async query<Row = Record<string, unknown>>(text: string, values?: readonly unknown[]) {
          return new Promise<Awaited<ReturnType<typeof client.query<Row>>>>((resolve, reject) => {
            const timer = setTimeout(() => {
              const error = new ConfigurationEpochError("participation query timed out; closure remains pending");
              release(error);
              reject(error);
            }, CONFIGURATION_EPOCH_STEP_TIMEOUT_MS);
            client.query<Row>(text, values).then(
              (result) => {
                clearTimeout(timer);
                resolve(result);
              },
              (error: unknown) => {
                clearTimeout(timer);
                reject(error);
              },
            );
          });
        },
      };
    },
  };
  return pgTransaction(bounded, work, { ...options, isolationLevel: "read committed" });
}
const withPgTransaction = withConfigurationEpochTransaction;

export const CONFIGURATION_EPOCH_STEP_TIMEOUT_MS = 5000;
export const CONFIGURATION_EPOCH_LOCK_SQL =
  "SELECT pg_advisory_xact_lock_shared(hashtextextended('configuration_epoch:' || $1::text, 0))";
const EXCLUSIVE_LOCK_SQL = "SELECT pg_advisory_xact_lock(hashtextextended('configuration_epoch:' || $1::text, 0))";
type ConsumerRecord = Readonly<{ kind: "CLOSED_THROUGH"; guard: ConfigurationConsumerGuard }>;
type JournalRecord = ConfigurationEpochRecord | ConsumerRecord;
type Journal = Readonly<{ records: readonly JournalRecord[]; digest: string }>;
type ConsumerTarget = Readonly<{ identity: ConfigurationConsumer; pool: PgTransactionalPool }>;

/** SQL timeouts never settle a closure. The pending journal remains authoritative. */
async function boundStep(client: PgQueryable): Promise<void> {
  await client.query("SET LOCAL statement_timeout = '5s'");
  await client.query("SET LOCAL lock_timeout = '5s'");
}
function digest(previous: string, record: JournalRecord): string {
  return createHash("sha256").update(previous).update(JSON.stringify(record)).digest("hex");
}
const EMPTY_DIGEST = "0".repeat(64);

/** Both a canonical head and its full journal must agree, including the tail. */
async function readJournal(
  client: PgQueryable,
  role: "source" | "consumer",
  key: string,
): Promise<Journal | undefined> {
  const heads = await client.query<{ sequence: string; digest: string }>(
    "SELECT sequence::text, digest FROM event_configuration_journal_heads WHERE role = $1 AND key = $2",
    [role, key],
  );
  const rows = await client.query<{ sequence: string; record: JournalRecord; digest: string }>(
    "SELECT sequence::text, record, digest FROM event_configuration_guard_history WHERE role = $1 AND key = $2 ORDER BY sequence",
    [role, key],
  );
  if (!heads.rows.length && !rows.rows.length) return undefined;
  const head = heads.rows[0];
  if (heads.rows.length !== 1 || !head || Number(head.sequence) !== rows.rows.length || !rows.rows.length)
    throw new ConfigurationEpochError("partial journal history");
  let previous = EMPTY_DIGEST;
  for (const [index, row] of rows.rows.entries()) {
    if (Number(row.sequence) !== index + 1 || !row.record || typeof row.record !== "object")
      throw new ConfigurationEpochError("corrupt journal sequence");
    const next = digest(previous, row.record);
    if (row.digest !== next) throw new ConfigurationEpochError("corrupt journal record");
    previous = next;
  }
  if (previous !== head.digest) throw new ConfigurationEpochError("corrupt journal tail");
  return { records: rows.rows.map((r) => r.record), digest: previous };
}
async function appendJournal(
  client: PgQueryable,
  role: "source" | "consumer",
  key: string,
  prior: Journal | undefined,
  record: JournalRecord,
): Promise<void> {
  const sequence = (prior?.records.length ?? 0) + 1;
  const hash = digest(prior?.digest ?? EMPTY_DIGEST, record);
  // json (not jsonb) preserves record serialization for the linked digest.
  await client.query(
    "INSERT INTO event_configuration_guard_history (role, key, sequence, record, digest) VALUES ($1, $2, $3, $4::json, $5)",
    [role, key, sequence, JSON.stringify(record), hash],
  );
  await client.query(
    "INSERT INTO event_configuration_journal_heads (role, key, sequence, digest) VALUES ($1, $2, $3, $4) ON CONFLICT (role, key) DO UPDATE SET sequence = EXCLUDED.sequence, digest = EXCLUDED.digest",
    [role, key, sequence, hash],
  );
}
function sourceState(journal: Journal | undefined): ConfigurationEpochHistory {
  const records: ConfigurationEpochRecord[] = [];
  for (const record of journal?.records ?? []) {
    if (record.kind === "CLOSED_THROUGH") throw new ConfigurationEpochError("consumer record in source journal");
    records.push(record);
  }
  return replayConfigurationEpoch(records);
}
function consumerState(journal: Journal | undefined): ConfigurationConsumerGuard | undefined {
  let previous: ConfigurationConsumerGuard | undefined;
  for (const record of journal?.records ?? []) {
    if (record.kind !== "CLOSED_THROUGH" || !record.guard)
      throw new ConfigurationEpochError("corrupt consumer guard history");
    const guard = record.guard;
    assertConfigurationText(guard.sourceIncarnation);
    assertConfigurationEpoch(guard.keyCreationEpoch);
    assertConfigurationEpoch(guard.closedThroughEpoch);
    assertConfigurationEpoch(guard.topologyRevision);
    if (
      guard.closedThroughEpoch < guard.keyCreationEpoch ||
      (previous &&
        (guard.sourceIncarnation !== previous.sourceIncarnation ||
          guard.keyCreationEpoch !== previous.keyCreationEpoch ||
          guard.closedThroughEpoch <= previous.closedThroughEpoch ||
          guard.topologyRevision < previous.topologyRevision))
    )
      throw new ConfigurationEpochError("partial or non-monotonic consumer history");
    previous = guard;
  }
  return previous;
}
async function readIdentity(client: PgQueryable, expected: ConfigurationConsumer): Promise<void> {
  const result = await client.query<{ store_id: string; incarnation: string }>(
    "SELECT store_id, incarnation FROM event_configuration_store_identity WHERE singleton = true",
  );
  const actual = result.rows[0];
  if (
    result.rows.length !== 1 ||
    !actual ||
    actual.store_id !== expected.storeId ||
    actual.incarnation !== expected.incarnation
  )
    throw new ConfigurationEpochError("unknown or old consumer store incarnation");
}
export async function initializeConfigurationConsumer(
  pool: PgTransactionalPool,
  identity: ConfigurationConsumer,
): Promise<void> {
  assertConfigurationText(identity.storeId);
  assertConfigurationText(identity.incarnation);
  await withPgTransaction(pool, async (client) => {
    await boundStep(client);
    await client.query(EXCLUSIVE_LOCK_SQL, ["store-identity"]);
    await client.query(
      "INSERT INTO event_configuration_store_identity (singleton, store_id, incarnation) VALUES (true, $1, $2) ON CONFLICT DO NOTHING",
      [identity.storeId, identity.incarnation],
    );
    await readIdentity(client, identity);
  });
}

async function closeConsumer(target: ConsumerTarget, key: string, guard: ConfigurationConsumerGuard): Promise<void> {
  await withPgTransaction(target.pool, async (client) => {
    await boundStep(client);
    await client.query(EXCLUSIVE_LOCK_SQL, [key]);
    await readIdentity(client, target.identity);
    const journal = await readJournal(client, "consumer", key);
    const previous = consumerState(journal);
    if (
      previous?.closedThroughEpoch === guard.closedThroughEpoch &&
      previous.sourceIncarnation === guard.sourceIncarnation &&
      previous.keyCreationEpoch === guard.keyCreationEpoch &&
      previous.topologyRevision === guard.topologyRevision
    )
      return;
    const record: ConsumerRecord = { kind: "CLOSED_THROUGH", guard };
    consumerState({ records: [...(journal?.records ?? []), record], digest: "" });
    await appendJournal(client, "consumer", key, journal, record);
  });
}

export type PostgresConfigurationEpochStoreConfig = Readonly<{
  pool: PgTransactionalPool;
  sourceIncarnation: string;
  /** Transport routing only. Required membership always comes from the journal. */
  consumers: readonly ConsumerTarget[];
}>;

export function createPostgresConfigurationEpochStore(config: PostgresConfigurationEpochStoreConfig) {
  assertConfigurationText(config.sourceIncarnation);
  const identities = config.consumers.map((c) => c.identity.storeId);
  if (new Set(identities).size !== identities.length) throw new ConfigurationEpochError("duplicate consumer routes");
  async function load(client: PgQueryable, key: string) {
    const journal = await readJournal(client, "source", key);
    const state = sourceState(journal);
    if (state.sourceIncarnation !== config.sourceIncarnation)
      throw new ConfigurationEpochError("old source incarnation");
    return { journal, state };
  }
  async function append(client: PgQueryable, key: string, record: ConfigurationEpochRecord) {
    const { journal } = await load(client, key);
    sourceState({ records: [...(journal?.records ?? []), record], digest: "" });
    await appendJournal(client, "source", key, journal, record);
  }
  async function beginClosureInTransaction(client: PgQueryable, key: string) {
    assertConfigurationText(key);
    await boundStep(client);
    await client.query(EXCLUSIVE_LOCK_SQL, [key]);
    const { state } = await load(client, key);
    if (state.state === "OPEN")
      await append(client, key, { kind: "CLOSING", epoch: state.epoch, topologyRevision: state.topologyRevision });
    return configurationClosureStatus(key, (await load(client, key)).state);
  }
  async function installClosureInTransaction(client: PgQueryable, key: string) {
    await boundStep(client);
    await client.query(EXCLUSIVE_LOCK_SQL, [key]);
    const { state } = await load(client, key);
    await append(client, key, { kind: "APPLIED", epoch: state.epoch, topologyRevision: state.topologyRevision });
    return configurationClosureStatus(key, (await load(client, key)).state);
  }
  return {
    /** Must be called in the business writer's transaction, before its first INSERT. */
    beginClosureInTransaction,
    /** Atomically install the owner change in this same caller-owned transaction. */
    installClosureInTransaction,
    async open(key: string, keyCreationEpoch = 0): Promise<void> {
      assertConfigurationText(key);
      assertConfigurationEpoch(keyCreationEpoch);
      await withPgTransaction(config.pool, async (client) => {
        await boundStep(client);
        await client.query(EXCLUSIVE_LOCK_SQL, [key]);
        const prior = await readJournal(client, "source", key);
        if (prior) throw new ConfigurationEpochError("key already created");
        await appendJournal(client, "source", key, undefined, {
          kind: "CREATED",
          sourceIncarnation: config.sourceIncarnation,
          keyCreationEpoch,
        });
      });
    },
    async registerConsumer(key: string, consumer: ConfigurationConsumer): Promise<void> {
      await withPgTransaction(config.pool, async (client) => {
        await boundStep(client);
        await client.query(EXCLUSIVE_LOCK_SQL, [key]);
        const { state } = await load(client, key);
        if (state.state !== "OPEN") throw new ConfigurationEpochError("registration waits while CLOSING");
        const target = config.consumers.find((c) => sameConfigurationConsumer(c.identity, consumer));
        if (!target) throw new ConfigurationEpochError("consumer route unavailable");
        if (state.epoch > state.keyCreationEpoch)
          await closeConsumer(target, key, {
            sourceIncarnation: state.sourceIncarnation,
            keyCreationEpoch: state.keyCreationEpoch,
            closedThroughEpoch: state.epoch - 1,
            topologyRevision: state.topologyRevision + 1,
          });
        await append(client, key, { kind: "REGISTERED", consumer });
      });
    },
    async retireConsumer(key: string, consumer: ConfigurationConsumer): Promise<void> {
      await withPgTransaction(config.pool, async (client) => {
        await boundStep(client);
        await client.query(EXCLUSIVE_LOCK_SQL, [key]);
        const { state } = await load(client, key);
        if (state.state !== "OPEN") throw new ConfigurationEpochError("retirement waits while CLOSING");
        const target = config.consumers.find((c) => sameConfigurationConsumer(c.identity, consumer));
        if (!target) throw new ConfigurationEpochError("consumer route unavailable");
        await closeConsumer(target, key, {
          sourceIncarnation: state.sourceIncarnation,
          keyCreationEpoch: state.keyCreationEpoch,
          closedThroughEpoch: state.epoch,
          topologyRevision: state.topologyRevision,
        });
        await append(client, key, { kind: "RETIRED", consumer });
      });
    },
    beginClosure(key: string) {
      return withPgTransaction(config.pool, (client) => beginClosureInTransaction(client, key));
    },
    installClosure(key: string) {
      return withPgTransaction(config.pool, (client) => installClosureInTransaction(client, key));
    },
    async captureGrant(
      key: string,
      consumer: ConfigurationConsumer,
      validUntil?: string,
    ): Promise<ConfigurationEpochGrant> {
      return withPgTransaction(config.pool, async (client) => {
        await boundStep(client);
        await client.query(CONFIGURATION_EPOCH_LOCK_SQL, [key]);
        return captureConfigurationGrant(key, (await load(client, key)).state, consumer, validUntil);
      });
    },
    async status(key: string) {
      return withPgTransaction(config.pool, async (client) => {
        await boundStep(client);
        await client.query(CONFIGURATION_EPOCH_LOCK_SQL, [key]);
        return configurationClosureStatus(key, (await load(client, key)).state);
      });
    },
    /** Lost replies are retried against durable consumer journals; time never releases a key. */
    async driveClosure(key: string) {
      const closing = await withPgTransaction(config.pool, async (client) => {
        await boundStep(client);
        await client.query(CONFIGURATION_EPOCH_LOCK_SQL, [key]);
        return (await load(client, key)).state;
      });
      if (closing.state !== "CLOSING") throw new ConfigurationEpochError("not CLOSING");
      for (const consumer of closing.consumers) {
        if (closing.receipts.some((c) => sameConfigurationConsumer(c, consumer))) continue;
        try {
          const target = config.consumers.find((c) => sameConfigurationConsumer(c.identity, consumer));
          if (!target) throw new ConfigurationEpochError(`unavailable store ${consumer.storeId}`);
          await closeConsumer(target, key, {
            sourceIncarnation: closing.sourceIncarnation,
            keyCreationEpoch: closing.keyCreationEpoch,
            closedThroughEpoch: closing.epoch,
            topologyRevision: closing.topologyRevision,
          });
          await withPgTransaction(config.pool, async (client) => {
            await boundStep(client);
            await client.query(EXCLUSIVE_LOCK_SQL, [key]);
            const { state } = await load(client, key);
            if (state.epoch !== closing.epoch || state.topologyRevision !== closing.topologyRevision)
              throw new ConfigurationEpochError("stale closure driver");
            if (!state.receipts.some((c) => sameConfigurationConsumer(c, consumer)))
              await append(client, key, {
                kind: "RECEIPT",
                epoch: closing.epoch,
                topologyRevision: closing.topologyRevision,
                consumer,
              });
          });
        } catch (error) {
          await withPgTransaction(config.pool, async (client) => {
            await boundStep(client);
            await client.query(EXCLUSIVE_LOCK_SQL, [key]);
            const { state } = await load(client, key);
            if (state.state === "CLOSING" && state.epoch === closing.epoch)
              await append(client, key, {
                kind: "BLOCKED",
                reason: `consumer ${consumer.storeId} closure unavailable`,
              });
          });
          return {
            ...(await this.status(key)),
            reason: error instanceof Error ? error.message : "unknown closure error",
          };
        }
      }
      return this.status(key);
    },
  };
}

/** Consumer-local only, after the complete ordered SHARED lock footprint was acquired. */
export async function validateConfigurationGrantVectorInTransaction(
  client: PgQueryable,
  grants: readonly ConfigurationEpochGrant[],
): Promise<void> {
  const isolation = await client.query<{ isolation: string }>(
    "SELECT current_setting('transaction_isolation') AS isolation",
  );
  if (isolation.rows[0]?.isolation !== "read committed")
    throw new ConfigurationEpochError("READ COMMITTED is required");
  for (const grant of assertConfigurationGrantVector(grants)) {
    const held = await client.query<{ held: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM pg_locks
        WHERE locktype = 'advisory' AND pid = pg_backend_pid() AND granted AND mode IN ('ShareLock', 'ExclusiveLock')
          AND classid::bigint = ((hashtextextended('configuration_epoch:' || $1::text, 0) >> 32) & 4294967295)
          AND objid::bigint = (hashtextextended('configuration_epoch:' || $1::text, 0) & 4294967295)
          AND objsubid = 1) AS held`,
      [grant.key],
    );
    if (held.rows[0]?.held !== true) throw new ConfigurationEpochError("class-C key has no held guard lock");
    await readIdentity(client, grant.consumer);
    const guard = consumerState(await readJournal(client, "consumer", grant.key));
    const clock = await client.query<{ now: string }>("SELECT clock_timestamp()::text AS now");
    assertConfigurationGrantCurrent(grant, grant.consumer, guard, clock.rows[0]?.now ?? "invalid");
  }
}
export async function lockConfigurationGrantVectorInTransaction(
  client: PgQueryable,
  grants: readonly ConfigurationEpochGrant[],
): Promise<void> {
  await boundStep(client);
  for (const grant of assertConfigurationGrantVector(grants))
    await client.query(CONFIGURATION_EPOCH_LOCK_SQL, [grant.key]);
}
