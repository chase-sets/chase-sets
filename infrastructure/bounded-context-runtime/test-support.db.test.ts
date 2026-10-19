import { createConnection, createServer, type Socket } from "node:net";
import { randomUUID } from "node:crypto";
import { createPgPool, type PgQueryResult, type PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  closeMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
  orderDataResetTables,
  resetMultiContextTestData,
  assertMultiContextTestDataCatalog,
  isDataResetOptOut,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
} from "./test-support";
import { createOwnedDatabaseUrl } from "./provisioning";

const adminDatabaseUrl = process.env.TEST_DATABASE_URL;
if (!adminDatabaseUrl && process.env.CI) {
  throw new Error("TEST_DATABASE_URL is required for database-backed tests in CI.");
}
const describeDb = adminDatabaseUrl ? describe : describe.skip;

describe("data reset opt-out identity", () => {
  it("matches the live Vitest name of a listed nested test", () => {
    const { testPath, currentTestName } = expect.getState();
    const file = "infrastructure/bounded-context-runtime/test-support.db.test.ts";
    expect(currentTestName).toBe("data reset opt-out identity > matches the live Vitest name of a listed nested test");
    expect(
      isDataResetOptOut(testPath, currentTestName, [
        { file, test: "data reset opt-out identity matches the live Vitest name of a listed nested test" },
      ]),
    ).toBe(true);
    expect(
      isDataResetOptOut(testPath, currentTestName, [{ file, test: "data reset opt-out identity another test" }]),
    ).toBe(false);
  });
});

describe("data reset dependency ordering", () => {
  it("deletes children before parents and leaves self references to row ordering", () => {
    expect(
      orderDataResetTables(
        ["parent", "child", "self"],
        [
          { child: "child", parent: "parent" },
          { child: "self", parent: "self" },
        ],
      ),
    ).toEqual(["child", "parent", "self"]);
  });

  it("refuses cycles and references outside the captured target", () => {
    expect(() =>
      orderDataResetTables(
        ["a", "b"],
        [
          { child: "a", parent: "b" },
          { child: "b", parent: "a" },
        ],
      ),
    ).toThrow("unsafe foreign-key cycle");
    expect(() => orderDataResetTables(["a"], [{ child: "a", parent: "missing" }])).toThrow("uncaptured table");
  });
});

describeDb("data reset primitive discriminator", () => {
  async function fixture(extra = "") {
    const urls = createMultiContextTestDatabaseUrls(adminDatabaseUrl!, ["probe"], `data_reset_${randomUUID()}`);
    await ensureMultiContextTestDatabases(adminDatabaseUrl!, urls);
    const pools = createMultiContextTestPools(urls);
    const pool = pools.probe;
    const version = await pool.query<{ version: string }>("SELECT current_setting('server_version') AS version");
    expect(Number(version.rows[0]!.version.split(".")[0])).toBe(16);
    const bootstrap = async () => {
      await pool.query(`CREATE TABLE IF NOT EXISTS reset_bootstrap (id integer PRIMARY KEY, note text NOT NULL);
        INSERT INTO reset_bootstrap VALUES (1,'actual bootstrap row') ON CONFLICT DO NOTHING;
        CREATE TABLE IF NOT EXISTS reset_heap (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, payload text);
        CREATE TABLE IF NOT EXISTS reset_child (id integer PRIMARY KEY, heap_id bigint REFERENCES reset_heap(id));
        CREATE TABLE IF NOT EXISTS reset_self (id integer PRIMARY KEY, parent_id integer REFERENCES reset_self(id) ON DELETE RESTRICT);
        ${extra}`);
    };
    return { pools, pool, bootstrap };
  }

  async function nodes(pool: PgTransactionalPool) {
    return (
      await pool.query<{ name: string; kind: string; node: number }>(`WITH tables AS (
      SELECT c.oid,c.reltoastrelid FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relkind='r' AND c.relowner=current_user::regrole
    ), relations AS (
      SELECT oid FROM tables UNION SELECT reltoastrelid FROM tables WHERE reltoastrelid<>0
      UNION SELECT i.indexrelid FROM pg_index i WHERE i.indrelid IN (SELECT oid FROM tables UNION SELECT reltoastrelid FROM tables)
      UNION SELECT c.oid FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='S'
    ) SELECT c.oid::regclass::text AS name,c.relkind AS kind,pg_relation_filenode(c.oid) AS node
      FROM pg_class c JOIN relations r ON r.oid=c.oid ORDER BY name`)
    ).rows;
  }

  it("preserves every table, index, sequence and TOAST relfilenode across the real helper", async () => {
    const f = await fixture();
    try {
      await resetMultiContextTestData(f.pools, f.bootstrap);
      await f.pool
        .query(`INSERT INTO reset_heap(payload) SELECT string_agg(md5(n::text),'') FROM generate_series(1,1000) n;
        INSERT INTO reset_child VALUES (1,1);
        INSERT INTO reset_self VALUES (1,NULL),(2,1),(3,2)`);
      const before = await nodes(f.pool);
      expect(new Set(before.map((row) => row.kind))).toEqual(new Set(["r", "i", "S", "t"]));
      expect(before.every((row) => row.node > 0)).toBe(true);
      await resetMultiContextTestData(f.pools, f.bootstrap);
      expect(await nodes(f.pool), "relfilenode stability discriminator").toEqual(before);
      expect((await f.pool.query("SELECT * FROM reset_heap")).rows).toEqual([]);
      expect((await f.pool.query("SELECT * FROM reset_child")).rows).toEqual([]);
      expect((await f.pool.query("SELECT * FROM reset_self")).rows).toEqual([]);
    } finally {
      await closeMultiContextTestPools(f.pools);
    }
  });

  it("matches fresh bootstrap rows and sequence next values after partial, poisoned and repeated histories", async () => {
    const f = await fixture();
    const fresh = await fixture();
    try {
      await resetMultiContextTestData(fresh.pools, fresh.bootstrap);
      const expectedRows = (await fresh.pool.query("SELECT * FROM reset_bootstrap ORDER BY id")).rows;
      const expectedNext = (await fresh.pool.query("SELECT nextval('reset_heap_id_seq')::text AS next")).rows;
      await resetMultiContextTestData(f.pools, f.bootstrap);
      for (let history = 0; history < 3; history += 1) {
        await f.pool.query(`DELETE FROM reset_bootstrap; INSERT INTO reset_bootstrap VALUES (9,'poison');
          INSERT INTO reset_heap(payload) VALUES ('partial'); SELECT nextval('reset_heap_id_seq')`);
        await resetMultiContextTestData(f.pools, f.bootstrap);
        expect((await f.pool.query("SELECT * FROM reset_bootstrap ORDER BY id")).rows).toEqual(expectedRows);
        expect((await f.pool.query("SELECT nextval('reset_heap_id_seq')::text AS next")).rows).toEqual(expectedNext);
        await f.bootstrap();
        expect((await f.pool.query("SELECT * FROM reset_bootstrap ORDER BY id")).rows).toEqual(expectedRows);
      }
      await assertMultiContextTestDataCatalog(f.pools);
    } finally {
      await closeMultiContextTestPools(f.pools);
      await closeMultiContextTestPools(fresh.pools);
    }
  });

  it.each([
    [
      "FK cycle",
      "CREATE TABLE reset_a(id integer PRIMARY KEY,b integer); CREATE TABLE reset_b(id integer PRIMARY KEY,a integer REFERENCES reset_a(id)); ALTER TABLE reset_a ADD FOREIGN KEY(b) REFERENCES reset_b(id)",
    ],
    ["materialized view", "CREATE MATERIALIZED VIEW reset_view AS SELECT 1 AS id"],
    [
      "rule",
      "CREATE RULE reset_rule AS ON DELETE TO reset_heap DO ALSO INSERT INTO reset_bootstrap VALUES (99,'side effect')",
    ],
    [
      "side-effect trigger",
      "CREATE FUNCTION reset_trigger() RETURNS trigger LANGUAGE plpgsql AS 'BEGIN INSERT INTO reset_bootstrap VALUES (98,''trigger''); RETURN OLD; END'; CREATE TRIGGER reset_side_effect BEFORE DELETE ON reset_heap FOR EACH ROW EXECUTE FUNCTION reset_trigger()",
    ],
  ])("refuses unsupported %s instead of guessing", async (_name, sql) => {
    const f = await fixture(sql);
    try {
      await expect(resetMultiContextTestData(f.pools, f.bootstrap)).rejects.toThrow(
        /unsafe foreign-key cycle|unsupported data reset shape/,
      );
    } finally {
      await closeMultiContextTestPools(f.pools);
    }
  });

  it("detects an injected unlisted file-end schema change", async () => {
    const f = await fixture();
    try {
      await resetMultiContextTestData(f.pools, f.bootstrap);
      await f.pool.query("CREATE TABLE reset_unlisted(id integer)");
      await expect(assertMultiContextTestDataCatalog(f.pools)).rejects.toThrow("unlisted file-end catalog drift");
      await f.pool.query("DROP TABLE reset_unlisted");
      await assertMultiContextTestDataCatalog(f.pools);
    } finally {
      await closeMultiContextTestPools(f.pools);
    }
  });

  it("captures an empty target without assuming a ledger and deduplicates aliased pools", async () => {
    const urls = createMultiContextTestDatabaseUrls(
      adminDatabaseUrl!,
      ["auth", "empty"],
      `reset_alias_${randomUUID()}`,
    );
    await ensureMultiContextTestDatabases(adminDatabaseUrl!, urls);
    const pools = createMultiContextTestPools({ ...urls, authAlias: urls.auth });
    let boots = 0;
    const bootstrap = async () => {
      boots += 1;
      await pools.auth.query(
        "CREATE TABLE IF NOT EXISTS actual_bootstrap(id integer PRIMARY KEY); INSERT INTO actual_bootstrap VALUES (7) ON CONFLICT DO NOTHING",
      );
    };
    try {
      await resetMultiContextTestData(pools, bootstrap);
      await pools.auth.query("INSERT INTO actual_bootstrap VALUES (8)");
      await resetMultiContextTestData({ authAlias: pools.authAlias, auth: pools.auth, empty: pools.empty }, bootstrap);
      expect(boots).toBe(2);
      expect((await pools.authAlias.query("SELECT * FROM actual_bootstrap ORDER BY id")).rows).toEqual([{ id: 7 }]);
      expect((await pools.empty.query("SELECT tablename FROM pg_tables WHERE schemaname='public'")).rows).toEqual([]);
      await assertMultiContextTestDataCatalog(pools);
    } finally {
      await closeMultiContextTestPools(pools);
    }
  });
});

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
