import { createConnection, createServer, type Socket } from "node:net";
import {
  createPgPool,
  type PgPoolClient,
  type PgQueryResult,
  type PgTransactionalPool,
} from "@chase-sets/event-core-postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
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
    const remainderClient = {
      async query<Row = Record<string, unknown>>(sql: string): Promise<PgQueryResult<Row>> {
        if (sql === resetSql) twentiethResetQueries.push(sql);
        return { rows: [] };
      },
      release() {},
    };
    const twentiethPool: PgTransactionalPool = {
      query: remainderClient.query,
      connect: async () => remainderClient,
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
  beforeReset?: (client: PgPoolClient) => Promise<void>,
): CloseableObservedPool {
  const resetQueries: string[] = [];
  const successfulResetQueries: string[] = [];

  return {
    query: pool.query.bind(pool),
    async connect() {
      const client = await pool.connect();
      return {
        async query<Row = Record<string, unknown>>(
          sql: string,
          values?: readonly unknown[],
        ): Promise<PgQueryResult<Row>> {
          if (sql === resetSql) {
            resetQueries.push(sql);
            await beforeReset?.(client);
          }
          const result = await client.query<Row>(sql, values);
          if (sql === resetSql) successfulResetQueries.push(sql);
          return result;
        },
        release: (error?: unknown) => client.release(error),
      };
    },
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

describeDb("multi-context schema reset coordination", () => {
  let databaseUrls: Readonly<Record<"primary" | "other" | "otherRole", string>>;
  const openPools: CloseableObservedPool[] = [];

  beforeAll(async () => {
    databaseUrls = createMultiContextTestDatabaseUrls(
      adminDatabaseUrl!,
      ["primary", "other", "otherRole"],
      "reset_lock",
    );
    await ensureMultiContextTestDatabases(adminDatabaseUrl!, databaseUrls);
    const admin = openPool(adminDatabaseUrl!);
    const ownerName = new URL(databaseUrls.primary).username;
    const roleName = new URL(databaseUrls.otherRole).username;
    // Inherited database ownership survives DROP OWNED, unlike a schema grant.
    await admin.query(`GRANT "${ownerName}" TO "${roleName}"`);
  });

  afterAll(async () => {
    await closeMultiContextTestPools(Object.fromEntries(openPools.map((pool, index) => [index, pool])));
    expect(openPools.map((pool) => [pool.totalCount, pool.idleCount, pool.waitingCount])).toEqual(
      openPools.map(() => [0, 0, 0]),
    );
  });

  function openPool(url: string, beforeReset?: (client: PgPoolClient) => Promise<void>): CloseableObservedPool {
    const pool = createPgPool(url) as PgTransactionalPool & PoolDiagnostics & Readonly<{ end: () => Promise<void> }>;
    const observed = observeResetQueries(pool, beforeReset);
    openPools.push(observed);
    return observed;
  }

  function checkpoint(url: string, fail = false) {
    const reached = createCheckpoint<PgPoolClient>();
    const resume = createCheckpoint<void>();
    const pool = openPool(url, async (client) => {
      reached.resolve(client);
      await resume.promise;
      if (fail) await client.query("SELECT 1 / 0");
    });
    return { pool, reached: reached.promise, resume: () => resume.resolve() };
  }

  it("blocks an overlapping independent same-target reset while different database and role resets progress", async () => {
    const holder = checkpoint(databaseUrls.primary);
    const contender = checkpoint(databaseUrls.primary);
    const observer = openPool(databaseUrls.primary);
    const otherRoleUrl = new URL(databaseUrls.otherRole);
    otherRoleUrl.pathname = new URL(databaseUrls.primary).pathname;
    const differentDatabase = openPool(databaseUrls.other);
    const differentRole = openPool(otherRoleUrl.toString());
    const started: Promise<unknown>[] = [];

    try {
      await observer.query("CREATE TABLE reset_primary_owned (id integer)");
      await differentDatabase.query("CREATE TABLE reset_other_database_owned (id integer)");
      await differentRole.query("CREATE TABLE reset_other_role_owned (id integer)");
      const holderAttempt = trackResetAttempt(started, resetMultiContextTestSchemas({ holder: holder.pool }));
      const holderClient = await reachResetCheckpoint(holder.reached, holderAttempt);
      const { rows } = await holderClient.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
      const holderPid = rows[0]!.pid;
      const contenderAttempt = trackResetAttempt(started, resetMultiContextTestSchemas({ contender: contender.pool }));

      expect(await waitForResetContention(observer, holderPid, contender.reached)).toBe("advisory-wait");
      expect(contender.pool.resetQueries).toEqual([]);
      const independentReset = trackResetAttempt(
        started,
        resetMultiContextTestSchemas({ differentDatabase, differentRole }),
      );
      await independentReset;
      expect(differentDatabase.successfulResetQueries).toEqual([resetSql]);
      expect(differentRole.successfulResetQueries).toEqual([resetSql]);
      expect(contender.pool.resetQueries).toEqual([]);
      console.info(
        "[schema-reset-coordination] same-target=advisory-wait different-database=completed different-role=completed",
      );

      holder.resume();
      await holderAttempt;
      await reachResetCheckpoint(contender.reached, contenderAttempt);
      contender.resume();
      await contenderAttempt;
      expect(holder.pool.successfulResetQueries).toEqual([resetSql]);
      expect(contender.pool.successfulResetQueries).toEqual([resetSql]);
      const remaining = await observer.query<{ primary: string | null; other_role: string | null }>(
        "SELECT to_regclass('reset_primary_owned')::text AS primary, to_regclass('reset_other_role_owned')::text AS other_role",
      );
      expect(remaining.rows).toEqual([{ primary: null, other_role: null }]);
      const otherRemaining = await differentDatabase.query<{ owned: string | null }>(
        "SELECT to_regclass('reset_other_database_owned')::text AS owned",
      );
      expect(otherRemaining.rows).toEqual([{ owned: null }]);
    } finally {
      holder.resume();
      contender.resume();
      await Promise.allSettled(started);
    }
  });

  it("detects unsafe overlap in a control using the previous uncoordinated reset boundary", async () => {
    const holder = checkpoint(databaseUrls.primary);
    const contender = checkpoint(databaseUrls.primary);
    const observer = openPool(databaseUrls.primary);
    const started: Promise<unknown>[] = [];
    const uncoordinatedReset = async (pool: PgTransactionalPool) => {
      const client = await pool.connect();
      try {
        await client.query(resetSql);
      } finally {
        client.release();
      }
    };

    try {
      const holderAttempt = trackResetAttempt(started, uncoordinatedReset(holder.pool));
      const holderClient = await reachResetCheckpoint(holder.reached, holderAttempt);
      const { rows } = await holderClient.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
      const contenderAttempt = trackResetAttempt(started, uncoordinatedReset(contender.pool));
      expect(await waitForResetContention(observer, rows[0]!.pid, contender.reached)).toBe("unsafe-overlap");
      expect(contender.pool.resetQueries).toEqual([resetSql]);
      console.info("[schema-reset-coordination] uncoordinated-control=unsafe-overlap");
      // The checkpoint proves the unsafe entry without intentionally deadlocking
      // cleanup: execute the destructive control statements one at a time.
      holder.resume();
      await holderAttempt;
      contender.resume();
      await contenderAttempt;
    } finally {
      holder.resume();
      contender.resume();
      await Promise.allSettled(started);
    }
  });

  it.each(["statement-error", "connection-close"] as const)(
    "releases a waiting same-target reset after %s before pool cleanup",
    async (failureMode) => {
      const holder = checkpoint(databaseUrls.primary, failureMode === "statement-error");
      const contender = checkpoint(databaseUrls.primary);
      const observer = openPool(databaseUrls.primary);
      const started: Promise<unknown>[] = [];

      try {
        const holderResult = resetMultiContextTestSchemas({ holder: holder.pool }).then(
          () => ({ status: "fulfilled" as const }),
          (error: unknown) => ({ status: "rejected" as const, error }),
        );
        trackResetAttempt(started, holderResult);
        const holderClient = await reachResetCheckpoint(holder.reached, holderResult);
        const { rows } = await holderClient.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
        const holderPid = rows[0]!.pid;
        const contenderAttempt = trackResetAttempt(
          started,
          resetMultiContextTestSchemas({ contender: contender.pool }),
        );
        expect(await waitForResetContention(observer, holderPid, contender.reached)).toBe("advisory-wait");

        if (failureMode === "connection-close") {
          const adminUrl = new URL(adminDatabaseUrl!);
          adminUrl.pathname = new URL(databaseUrls.primary).pathname;
          const admin = openPool(adminUrl.toString());
          const terminated = await admin.query<{ terminated: boolean }>(
            "SELECT pg_terminate_backend($1) AS terminated",
            [holderPid],
          );
          expect(terminated.rows[0]?.terminated).toBe(true);
        }
        holder.resume();
        const result = await holderResult;
        expect(result.status).toBe("rejected");
        if (result.status === "rejected" && failureMode === "statement-error") {
          expect(result.error).toMatchObject({ code: "22012" });
        }
        await reachResetCheckpoint(contender.reached, contenderAttempt);
        contender.resume();
        await contenderAttempt;
        expect(holder.pool.successfulResetQueries).toEqual([]);
        expect(contender.pool.successfulResetQueries).toEqual([resetSql]);
        expect(observer.totalCount).toBeGreaterThan(0);
        console.info(`[schema-reset-coordination] failure=${failureMode} contender=completed before-pool-cleanup=true`);
      } finally {
        holder.resume();
        contender.resume();
        await Promise.allSettled(started);
      }
    },
  );
});

function trackResetAttempt<T>(started: Promise<unknown>[], attempt: Promise<T>): Promise<T> {
  started.push(attempt);
  // Attach a handler immediately; checkpoint assertions may fail before await.
  void attempt.catch(() => undefined);
  return attempt;
}

async function reachResetCheckpoint(
  checkpoint: Promise<PgPoolClient>,
  attempt: Promise<unknown>,
): Promise<PgPoolClient> {
  return Promise.race([
    checkpoint,
    attempt.then(() => {
      throw new Error("Reset completed without reaching its destructive-statement checkpoint.");
    }),
  ]);
}

function createCheckpoint<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

async function waitForResetContention(
  observer: PgTransactionalPool,
  holderPid: number,
  destructiveStatementReached: Promise<PgPoolClient>,
): Promise<"advisory-wait" | "unsafe-overlap"> {
  let unsafeOverlap = false;
  void destructiveStatementReached.then(() => {
    unsafeOverlap = true;
  });
  const deadline = Date.now() + platformApiConnectionTimeoutMs;
  while (Date.now() < deadline) {
    if (unsafeOverlap) return "unsafe-overlap";
    const { rows } = await observer.query<{ waiting: boolean }>(
      `SELECT EXISTS (
        SELECT 1 FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event = 'advisory'
          AND $1 = ANY(pg_blocking_pids(pid))
      ) AS waiting`,
      [holderPid],
    );
    if (rows[0]?.waiting) return "advisory-wait";
  }
  throw new Error(`Reset contender neither waited on backend ${holderPid} nor reached the destructive statement.`);
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
