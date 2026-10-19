import { createConnection, createServer, type Socket } from "node:net";
import { createPgPool, type PgQueryResult, type PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  closeMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "./test-support";
import { createOwnedDatabaseUrl } from "./provisioning";

const adminDatabaseUrl = process.env.TEST_DATABASE_URL;
if (!adminDatabaseUrl && process.env.CI) {
  throw new Error("TEST_DATABASE_URL is required for database-backed tests in CI.");
}
const describeDb = adminDatabaseUrl ? describe : describe.skip;

const platformApiContextNames = [
  "auth",
  "authenticity",
  "catalog",
  "channels",
  "checkout",
  "collections",
  "commercial-terms",
  "customer-feedback",
  "discovery",
  "fulfillment",
  "identity",
  "inventory",
  "marketplace",
  "notifications",
  "ordering",
  "payments",
  "platform-operations",
  "pricing",
  "public-presence",
  "settlement",
] as const;

const resetSql = "DROP OWNED BY CURRENT_USER CASCADE; GRANT ALL PRIVILEGES ON SCHEMA public TO CURRENT_USER;";
const coldAcquisitionConcurrency = 4;
const platformApiConnectionTimeoutMs = 5_000;

type PoolDiagnostics = Readonly<{
  totalCount: number;
  idleCount: number;
  waitingCount: number;
}>;

type CloseableObservedPool = PgTransactionalPool &
  PoolDiagnostics &
  Readonly<{
    end: () => Promise<void>;
    resetQueries: readonly string[];
    successfulResetQueries: readonly string[];
  }>;

type ColdAcquisitionProxy = Readonly<{
  peakSimultaneousAcquisitions: () => number;
  proxyUrl: (databaseUrl: string) => string;
  close: () => Promise<void>;
}>;

describeDb("multi-context schema reset cold acquisition concurrency", () => {
  let coldProxy: ColdAcquisitionProxy;
  let pools: Readonly<Record<(typeof platformApiContextNames)[number], CloseableObservedPool>>;

  beforeAll(async () => {
    const databaseUrls = Object.fromEntries(
      platformApiContextNames.map((contextName) => {
        const databaseName = `schema_reset_cold_${contextName.replaceAll("-", "_")}`;
        return [contextName, createOwnedDatabaseUrl(adminDatabaseUrl!, databaseName, databaseName)];
      }),
    ) as Readonly<Record<(typeof platformApiContextNames)[number], string>>;
    await ensureMultiContextTestDatabases(adminDatabaseUrl!, databaseUrls);
    const provisioningPool = createPgPool(adminDatabaseUrl!) as PgTransactionalPool &
      Readonly<{ end: () => Promise<void> }>;
    try {
      await provisioningPool.query("CHECKPOINT");
    } finally {
      await provisioningPool.end();
    }
    coldProxy = await createColdAcquisitionProxy(adminDatabaseUrl!, coldAcquisitionConcurrency);
    pools = Object.fromEntries(
      platformApiContextNames.map((contextName) => {
        const pool = createPgPool(coldProxy.proxyUrl(databaseUrls[contextName]), {
          connectionTimeoutMillis: platformApiConnectionTimeoutMs,
        }) as PgTransactionalPool & PoolDiagnostics & Readonly<{ end: () => Promise<void> }>;
        return [contextName, observeResetQueries(pool)];
      }),
    ) as Readonly<Record<(typeof platformApiContextNames)[number], CloseableObservedPool>>;
  });

  afterAll(async () => {
    try {
      if (pools) {
        await closeMultiContextTestPools(pools);
        const closure = Object.fromEntries(
          Object.entries(pools).map(([contextName, pool]) => [
            contextName,
            { total: pool.totalCount, idle: pool.idleCount, waiting: pool.waitingCount },
          ]),
        );
        console.info(`[schema-reset-cold-fanout] closure=${JSON.stringify(closure)}`);
        expect(Object.values(closure)).toEqual(platformApiContextNames.map(() => ({ total: 0, idle: 0, waiting: 0 })));
      }
    } finally {
      if (coldProxy) {
        await coldProxy.close();
      }
    }
  });

  it("resets all 20 genuinely cold pools within the acquisition bound and includes a 21st remainder", async () => {
    expect(platformApiContextNames).toHaveLength(20);
    expect(
      Object.values(pools).map((pool) => ({
        total: pool.totalCount,
        idle: pool.idleCount,
        waiting: pool.waitingCount,
      })),
    ).toEqual(platformApiContextNames.map(() => ({ total: 0, idle: 0, waiting: 0 })));

    const twentiethResetQueries: string[] = [];
    const twentiethPool = {
      async query<Row = Record<string, unknown>>(sql: string): Promise<PgQueryResult<Row>> {
        twentiethResetQueries.push(sql);
        return { rows: [] };
      },
    };

    const firstPool = pools[platformApiContextNames[0]];
    try {
      await resetMultiContextTestSchemas({
        ...pools,
        twentieth: twentiethPool,
        duplicateOfFirst: firstPool,
      });
    } catch (error) {
      console.info(
        `[schema-reset-cold-fanout] failure=${JSON.stringify({
          message: error instanceof Error ? error.message : String(error),
          peakSimultaneousAcquisitions: coldProxy.peakSimultaneousAcquisitions(),
          attemptedRealResets: Object.values(pools).filter((pool) => pool.resetQueries.length === 1).length,
          successfulRealResets: Object.values(pools).filter((pool) => pool.successfulResetQueries.length === 1).length,
          twentiethResets: twentiethResetQueries.length,
        })}`,
      );
      throw error;
    }

    const resetCounts = Object.fromEntries(
      Object.entries(pools).map(([contextName, pool]) => [contextName, pool.resetQueries.length]),
    );
    console.info(
      `[schema-reset-cold-fanout] success=${JSON.stringify({
        peakSimultaneousAcquisitions: coldProxy.peakSimultaneousAcquisitions(),
        resetCounts,
        twentiethResets: twentiethResetQueries.length,
      })}`,
    );

    expect(coldProxy.peakSimultaneousAcquisitions()).toBeGreaterThan(1);
    expect(coldProxy.peakSimultaneousAcquisitions()).toBeLessThanOrEqual(coldAcquisitionConcurrency);
    expect(Object.values(resetCounts)).toEqual(platformApiContextNames.map(() => 1));
    expect(Object.values(pools).flatMap((pool) => pool.successfulResetQueries)).toEqual(
      platformApiContextNames.map(() => resetSql),
    );
    expect(twentiethResetQueries).toEqual([resetSql]);
  });
});

describeDb("DDL-reset arm B relfilenode discriminator", () => {
  it("keeps heap, index, sequence and TOAST relfilenodes across the data-reset primitive", async () => {
    const pool = createPgPool(adminDatabaseUrl!) as PgTransactionalPool & Readonly<{ end: () => Promise<void> }>;
    const suffix = `${process.pid}_${Date.now()}`;
    const table = `ddl_reset_probe_${suffix}`;
    const index = `${table}_payload_idx`;
    try {
      await pool.query(`CREATE TABLE ${table} (id bigint GENERATED ALWAYS AS IDENTITY, payload text NOT NULL);`);
      await pool.query(`CREATE INDEX ${index} ON ${table} (payload);`);
      await pool.query(`INSERT INTO ${table} (payload) VALUES ('seed'), (repeat('x', 4096));`);
      const before = await pool.query<{ relname: string; relfilenode: string; reltoastrelid: string }>(
        `SELECT c.relname, c.relfilenode::text, c.reltoastrelid::text FROM pg_class c
         WHERE c.relname IN ('${table}', '${index}') OR c.oid = pg_get_serial_sequence('${table}', 'id')::regclass
         ORDER BY c.relname`,
      );
      await pool.query(`DELETE FROM ${table};`);
      await pool.query(`SELECT setval(pg_get_serial_sequence('${table}', 'id'), 1, false);`);
      const after = await pool.query<{ relname: string; relfilenode: string; reltoastrelid: string }>(
        `SELECT c.relname, c.relfilenode::text, c.reltoastrelid::text FROM pg_class c
         WHERE c.relname IN ('${table}', '${index}') OR c.oid = pg_get_serial_sequence('${table}', 'id')::regclass
         ORDER BY c.relname`,
      );
      expect(after.rows).toEqual(before.rows);
    } finally {
      await pool.query(`DROP TABLE IF EXISTS ${table} CASCADE`);
      await pool.end();
    }
  });

  it("fails the relfilenode guard for the TRUNCATE RESTART IDENTITY bypass mutant", async () => {
    const pool = createPgPool(adminDatabaseUrl!) as PgTransactionalPool & Readonly<{ end: () => Promise<void> }>;
    const suffix = `${process.pid}_${Date.now()}_mutant`;
    const table = `ddl_reset_probe_${suffix}`;
    try {
      await pool.query(`CREATE TABLE ${table} (id bigint GENERATED ALWAYS AS IDENTITY, payload text NOT NULL);`);
      await pool.query(`INSERT INTO ${table} (payload) VALUES ('seed'), (repeat('x', 4096));`);
      const before = await pool.query<{ relfilenode: string; reltoastrelid: string }>(
        `SELECT relfilenode::text, reltoastrelid::text FROM pg_class WHERE relname = '${table}'`,
      );
      await pool.query(`TRUNCATE ${table} RESTART IDENTITY;`);
      const after = await pool.query<{ relfilenode: string; reltoastrelid: string }>(
        `SELECT relfilenode::text, reltoastrelid::text FROM pg_class WHERE relname = '${table}'`,
      );
      expect(after.rows).not.toEqual(before.rows);
    } finally {
      await pool.query(`DROP TABLE IF EXISTS ${table} CASCADE`);
      await pool.end();
    }
  });
});

function observeResetQueries(
  pool: PgTransactionalPool & PoolDiagnostics & Readonly<{ end: () => Promise<void> }>,
): CloseableObservedPool {
  const resetQueries: string[] = [];
  const successfulResetQueries: string[] = [];

  return {
    async query<Row = Record<string, unknown>>(sql: string, values?: readonly unknown[]): Promise<PgQueryResult<Row>> {
      resetQueries.push(sql);
      const result = await pool.query<Row>(sql, values);
      successfulResetQueries.push(sql);
      return result;
    },
    connect: () => pool.connect(),
    end: () => pool.end(),
    get totalCount() {
      return pool.totalCount;
    },
    get idleCount() {
      return pool.idleCount;
    },
    get waitingCount() {
      return pool.waitingCount;
    },
    resetQueries,
    successfulResetQueries,
  };
}

async function createColdAcquisitionProxy(
  targetDatabaseUrl: string,
  maxSimultaneousAcquisitions: number,
): Promise<ColdAcquisitionProxy> {
  const target = new URL(targetDatabaseUrl);
  const targetPort = Number(target.port || 5432);
  const sockets = new Set<Socket>();
  let establishing = 0;
  let peakEstablishing = 0;

  const server = createServer((clientSocket) => {
    clientSocket.setNoDelay(true);
    sockets.add(clientSocket);
    establishing += 1;
    peakEstablishing = Math.max(peakEstablishing, establishing);
    let establishmentSettled = false;
    let backendSocket: Socket | undefined;
    let backendMessages = Buffer.alloc(0);

    const settleEstablishment = () => {
      if (establishmentSettled) return;
      establishmentSettled = true;
      establishing -= 1;
    };

    clientSocket.on("error", () => undefined);
    clientSocket.on("close", () => {
      settleEstablishment();
      sockets.delete(clientSocket);
      backendSocket?.destroy();
    });

    if (establishing > maxSimultaneousAcquisitions) {
      // Leave an over-bound TCP connection unforwarded. The real pg-pool
      // acquisition timer owns the failure and emits its canonical signature.
      clientSocket.pause();
      return;
    }

    backendSocket = createConnection({
      host: target.hostname,
      port: targetPort,
    });
    backendSocket.setNoDelay(true);
    sockets.add(backendSocket);
    backendSocket.on("error", (error) => clientSocket.destroy(error));
    backendSocket.on("close", () => {
      settleEstablishment();
      sockets.delete(backendSocket!);
      clientSocket.destroy();
    });
    backendSocket.on("data", (chunk: Buffer) => {
      if (establishmentSettled) return;
      backendMessages = Buffer.concat([backendMessages, chunk]);

      while (backendMessages.length >= 5) {
        const messageLength = backendMessages.readUInt32BE(1);
        const packetLength = messageLength + 1;
        if (messageLength < 4 || backendMessages.length < packetLength) return;
        const messageType = backendMessages[0];
        backendMessages = backendMessages.subarray(packetLength);
        if (messageType === "Z".charCodeAt(0)) {
          settleEstablishment();
          return;
        }
      }
    });
    clientSocket.pipe(backendSocket);
    backendSocket.pipe(clientSocket);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Cold acquisition proxy did not bind a TCP port.");
  }

  return {
    peakSimultaneousAcquisitions: () => peakEstablishing,
    proxyUrl(databaseUrl: string) {
      const url = new URL(databaseUrl);
      url.hostname = "127.0.0.1";
      url.port = String(address.port);
      return url.toString();
    },
    async close() {
      for (const socket of sockets) {
        socket.destroy();
      }
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}
