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
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
  seedTestPoolOptions,
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

describeDb("seed test pool idle retention", () => {
  let databaseUrls: Readonly<Record<(typeof platformApiContextNames)[number], string>>;
  let admin: PgTransactionalPool;

  beforeAll(async () => {
    databaseUrls = createMultiContextTestDatabaseUrls(
      adminDatabaseUrl!,
      platformApiContextNames,
      "seed_pool_retention",
    );
    await ensureMultiContextTestDatabases(adminDatabaseUrl!, databaseUrls);
    admin = createPgPool(adminDatabaseUrl!);
  });

  afterAll(async () => {
    if (admin) await closeMultiContextTestPools({ admin });
  });

  it.each(["commit", "rollback", "cancel"] as const)(
    "expires only idle clients and closes every unique pool after %s",
    async (outcome) => {
      const baseline = createMultiContextTestPools(databaseUrls);
      const repaired = createMultiContextTestPools(databaseUrls, seedTestPoolOptions);
      const cohorts = { baseline, repaired };
      const held: { client: PgPoolClient; pid: number; pool: PgTransactionalPool }[] = [];
      const diagnostics = (pools: Readonly<Record<string, PgTransactionalPool>>) =>
        [...new Set(Object.values(pools))].map((pool) => {
          const observed = pool as PgTransactionalPool & PoolDiagnostics;
          return { total: observed.totalCount, idle: observed.idleCount, waiting: observed.waitingCount };
        });
      const idleCount = (pools: Readonly<Record<string, PgTransactionalPool>>) =>
        diagnostics(pools).reduce((sum, pool) => sum + pool.idle, 0);

      try {
        for (const pools of Object.values(cohorts)) {
          const aliases = { ...pools, control: pools.auth, workSignal: pools.auth };
          expect(Object.keys(aliases)).toHaveLength(platformApiContextNames.length + 2);
          expect(new Set(Object.values(aliases)).size).toBe(platformApiContextNames.length);
          await resetMultiContextTestSchemas(aliases);
          const client = await pools.auth.connect();
          const entry = { client, pid: 0, pool: pools.auth };
          held.push(entry);
          await client.query("BEGIN");
          const result = await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
          entry.pid = result.rows[0]!.pid;
          await client.query("SELECT pg_advisory_xact_lock($1)", [entry.pid]);
          const peer = await pools.auth.query<{ pid: number; acquired: boolean }>(
            "SELECT pg_backend_pid() AS pid, pg_try_advisory_xact_lock($1) AS acquired",
            [entry.pid],
          );
          expect(peer.rows[0]).toEqual({ pid: expect.any(Number), acquired: false });
          expect(peer.rows[0]!.pid).not.toBe(entry.pid);
        }

        await expect.poll(() => idleCount(repaired), { timeout: 5_000 }).toBe(0);
        expect(idleCount(baseline)).toBeGreaterThanOrEqual(platformApiContextNames.length);
        expect(diagnostics(repaired).reduce((sum, pool) => sum + pool.total, 0)).toBe(1);
        expect(diagnostics(repaired).every((pool) => pool.waiting === 0)).toBe(true);
        const activity = await admin.query<{ state: string; count: number }>(
          "SELECT state, count(*)::int AS count FROM pg_stat_activity WHERE datname = ANY($1::text[]) GROUP BY state ORDER BY state",
          [Object.values(databaseUrls).map((url) => new URL(url).pathname.slice(1))],
        );
        console.info(
          `[seed-pool-retention] ${JSON.stringify({ outcome, baseline: diagnostics(baseline), repaired: diagnostics(repaired), activity: activity.rows })}`,
        );

        for (const { client, pid, pool } of held) {
          expect((await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!.pid).toBe(pid);
          const peer = await pool.query<{ acquired: boolean }>("SELECT pg_try_advisory_xact_lock($1) AS acquired", [
            pid,
          ]);
          expect(peer.rows[0]!.acquired).toBe(false);

          if (outcome === "rollback") {
            await expect(client.query("SELECT 1 / 0")).rejects.toMatchObject({ code: "22012" });
          } else if (outcome === "cancel") {
            const pending = client.query("SELECT pg_sleep(30)").catch((error: unknown) => error);
            await expect
              .poll(async () => {
                const result = await admin.query<{ wait_event: string }>(
                  "SELECT wait_event FROM pg_stat_activity WHERE pid = $1",
                  [pid],
                );
                return result.rows[0]?.wait_event;
              })
              .toBe("PgSleep");
            await admin.query("SELECT pg_cancel_backend($1)", [pid]);
            expect(await pending).toMatchObject({ code: "57014" });
          }
          await client.query(outcome === "commit" ? "COMMIT" : "ROLLBACK");
          const unlocked = await pool.query<{ acquired: boolean }>("SELECT pg_try_advisory_xact_lock($1) AS acquired", [
            pid,
          ]);
          expect(unlocked.rows[0]!.acquired).toBe(true);
        }
      } finally {
        const cleanupErrors: unknown[] = [];
        await Promise.all(
          held.map(async ({ client }) => {
            let releaseError: unknown;
            try {
              await client.query("ROLLBACK");
            } catch (error) {
              releaseError = error;
              cleanupErrors.push(error);
            } finally {
              client.release(releaseError);
            }
          }),
        );
        await Promise.all(Object.values(cohorts).map(closeMultiContextTestPools));
        for (const pools of Object.values(cohorts)) {
          expect(diagnostics(pools)).toEqual(platformApiContextNames.map(() => ({ total: 0, idle: 0, waiting: 0 })));
        }
        await expect
          .poll(async () => {
            const remaining = await admin.query<{ count: number }>(
              "SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname = ANY($1::text[])",
              [Object.values(databaseUrls).map((url) => new URL(url).pathname.slice(1))],
            );
            return remaining.rows[0]!.count;
          })
          .toBe(0);
        expect(cleanupErrors).toEqual([]);
      }
    },
  );
});

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
