import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { bootstrapContextDatabase } from "@chase-sets/bounded-context-runtime";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import type { PgQueryable, PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { module as catalogModule } from "../../../../index";
import {
  CATALOG_SOURCE_OBSERVATION_EVENT_STREAM_RESET_TARGET,
  resetCatalogIntegrationPreLaunchData,
} from "./catalog-integration-data-migration-reset";

const databaseBaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseBaseUrl && process.env.CI) {
  throw new Error("TEST_DATABASE_URL is required for database-backed tests in CI.");
}
const describeDb = databaseBaseUrl ? describe : describe.skip;

const PROFILE_RELATION = "catalog_provider_integration_profile_versions";
// Relations the reset touches after its entry lock: job-table locks, surface
// deletes and the source-stream delete. A waiting reset must hold none of them.
const LATER_RESET_RELATIONS = [
  "catalog_source_observation_integration_durable_jobs",
  "catalog_source_observation_bulk_review_jobs",
  "catalog_source_observations",
  "event_store_streams",
] as const;
const LOCK_WAIT_DEADLINE_MS = 30_000;

type RelationLockRow = Readonly<{ pid: number; mode: string; granted: boolean }>;
type HeldRelationLockRow = Readonly<{ relation: string; mode: string; granted: boolean }>;

describeDb("catalog integration data migration reset db", () => {
  let pools: Readonly<Record<"catalog", PgTransactionalPool>>;

  beforeAll(async () => {
    const urls = createMultiContextTestDatabaseUrls(databaseBaseUrl!, ["catalog"], "catalog_integration_reset_lock");
    await ensureMultiContextTestDatabases(databaseBaseUrl!, urls);
    pools = createMultiContextTestPools(urls);
  });

  beforeEach(async () => {
    await resetMultiContextTestSchemas(pools);
    await bootstrapContextDatabase(catalogModule, pools.catalog);
  });

  afterAll(async () => closeMultiContextTestPools(pools));

  it.each([true, false])(
    "blocks reset entry behind a concurrent SHARE holder of the profile relation until its COMMIT (rebuildSeedProfiles %s)",
    async (rebuildSeedProfiles) => {
      const holder = await pools.catalog.connect();
      let holderCommitted = false;
      let resetSettled = false;
      let reset: Promise<unknown> | undefined;
      try {
        await holder.query("BEGIN");
        await holder.query(`LOCK TABLE ${PROFILE_RELATION} IN SHARE MODE`);
        const holderPid = await backendPid(holder);

        const resetReport = resetCatalogIntegrationPreLaunchData(pools.catalog, { rebuildSeedProfiles });
        reset = resetReport;
        void resetReport.then(
          () => {
            resetSettled = true;
          },
          () => {
            resetSettled = true;
          },
        );

        // Observed through pg_locks, never through elapsed time: the reset's
        // backend queues a ROW EXCLUSIVE request on the profile relation ...
        const waiting = await waitForRelationLockWaiter(pools.catalog, PROFILE_RELATION, "RowExclusiveLock");
        expect(waiting.granted).toBe(false);
        expect(waiting.pid).not.toBe(holderPid);
        expect(resetSettled).toBe(false);
        // ... behind the holder's granted SHARE lock ...
        expect(await relationLocks(pools.catalog, PROFILE_RELATION)).toEqual(
          expect.arrayContaining([{ pid: holderPid, mode: "ShareLock", granted: true }]),
        );
        // ... while holding nothing on any relation the reset touches later, so
        // the profile lock is the reset's first statement, not a late one.
        expect(await relationLocksHeldByPid(pools.catalog, waiting.pid, LATER_RESET_RELATIONS)).toEqual([]);

        await holder.query("COMMIT");
        holderCommitted = true;

        const report = await resetReport;
        expect(resetSettled).toBe(true);
        expect(report.mode).toBe("pre-launch-wipe-and-rebuild");
        expect(report.steps.map((step) => step.tableName)).toContain(
          CATALOG_SOURCE_OBSERVATION_EVENT_STREAM_RESET_TARGET,
        );
        expect(report.steps.at(-1)).toMatchObject(
          rebuildSeedProfiles
            ? { tableName: PROFILE_RELATION, action: "delete-and-rebuild-seed" }
            : { tableName: CATALOG_SOURCE_OBSERVATION_EVENT_STREAM_RESET_TARGET, action: "delete" },
        );
        expect(report.after.activeProviderProfiles > 0).toBe(rebuildSeedProfiles);
        expect(report.after).toMatchObject({
          sourceObservations: 0,
          sourceObservationEventStreams: 0,
          integrationDurableJobs: 0,
          bulkReviewJobs: 0,
        });
        expect(await relationLocks(pools.catalog, PROFILE_RELATION)).toEqual([]);
      } finally {
        if (!holderCommitted) {
          await holder.query("ROLLBACK").catch(() => undefined);
        }
        holder.release();
        await reset?.catch(() => undefined);
      }
    },
  );
});

async function backendPid(client: PgQueryable): Promise<number> {
  const result = await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
  return Number(result.rows[0]?.pid);
}

async function relationLocks(db: PgQueryable, relation: string): Promise<readonly RelationLockRow[]> {
  const result = await db.query<RelationLockRow>(
    `SELECT pid, mode, granted
     FROM pg_locks
     WHERE locktype = 'relation'
       AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
       AND relation = $1::regclass
     ORDER BY pid, mode`,
    [relation],
  );
  return result.rows.map((row) => ({ pid: Number(row.pid), mode: row.mode, granted: row.granted }));
}

async function relationLocksHeldByPid(
  db: PgQueryable,
  pid: number,
  relations: readonly string[],
): Promise<readonly HeldRelationLockRow[]> {
  const result = await db.query<HeldRelationLockRow>(
    `SELECT relation::regclass::text AS relation, mode, granted
     FROM pg_locks
     WHERE locktype = 'relation'
       AND pid = $1
       AND relation = ANY($2::regclass[])
     ORDER BY relation, mode`,
    [pid, relations],
  );
  return result.rows;
}

async function waitForRelationLockWaiter(db: PgQueryable, relation: string, mode: string): Promise<RelationLockRow> {
  const deadline = Date.now() + LOCK_WAIT_DEADLINE_MS;
  // Each iteration is one awaited pg_locks round trip; no timer sleeps.
  while (Date.now() < deadline) {
    const waiter = (await relationLocks(db, relation)).find((row) => row.mode === mode && !row.granted);
    if (waiter) {
      return waiter;
    }
  }
  throw new Error(`No backend queued a ${mode} request on ${relation} within ${LOCK_WAIT_DEADLINE_MS}ms.`);
}
