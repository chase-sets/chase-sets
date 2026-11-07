import { describe, expect, it } from "vitest";
import {
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
} from "@chase-sets/bounded-context-runtime/test-support";
import {
  createPgPool,
  type PgPoolClient,
  type PgQueryable,
  type PgTransactionalPool,
} from "@chase-sets/event-core-postgres";
import { createCatalogServices, type CatalogServices } from "../../../support/authoring-support/services";
import { seedContext as context } from "../../../support/seed-support/context";
import {
  sourceObservationPromotionPreviewToken,
  type SourceObservationPromotionConfirmation,
} from "../api/promotion/promotion-preview-token";
import { usePromotionTargetExclusionFixture } from "./promotion-target-exclusion-fixture";

const databaseBaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseBaseUrl && process.env.CI) throw new Error("TEST_DATABASE_URL is required for bulk promotion admission DB proof.");
const describeDb = databaseBaseUrl ? describe : describe.skip;

const confirmation: SourceObservationPromotionConfirmation = {
  unitKey: null,
  importScope: null,
  profileVersion: null,
  scope: {},
};

type Writes = Readonly<{ jobs: number; jobEvents: number; units: number; bindings: number; events: number }>;

async function writes(db: PgQueryable): Promise<Writes> {
  const count = async (table: string) =>
    Number((await db.query<{ count: string }>(`SELECT COUNT(*)::text AS count FROM ${table}`)).rows[0]?.count ?? 0);
  return {
    jobs: await count("catalog_source_observation_bulk_review_jobs"),
    jobEvents: await count("catalog_source_observation_bulk_review_job_events"),
    units: await count("catalog_source_observation_bulk_review_work_units"),
    bindings: await count("catalog_provider_send_job_bindings"),
    events: await count("event_store_events"),
  };
}

async function unitIds(db: PgQueryable, jobId: string): Promise<readonly string[]> {
  const result = await db.query<{ unit_id: string }>(
    "SELECT unit_id FROM catalog_source_observation_bulk_review_work_units WHERE job_id = $1 ORDER BY unit_id",
    [jobId],
  );
  return result.rows.map((row) => row.unit_id);
}

/** One job, its unit and its send binding committed; the job's own events record its admission. */
async function expectOneAdmittedJob(db: PgQueryable, before: Writes, jobId: string): Promise<void> {
  const after = await writes(db);
  expect({ jobs: after.jobs, units: after.units, bindings: after.bindings, events: after.events }).toEqual({
    jobs: before.jobs + 1,
    units: before.units + 1,
    bindings: before.bindings + 1,
    events: before.events,
  });
  const jobEvents = await db.query<{ count: string }>(
    "SELECT COUNT(*)::text AS count FROM catalog_source_observation_bulk_review_job_events WHERE job_id = $1",
    [jobId],
  );
  expect(Number(jobEvents.rows[0]?.count)).toBeGreaterThan(0);
  expect(after.jobEvents - before.jobEvents).toBe(Number(jobEvents.rows[0]?.count));
}

async function lockWaiters(db: PgQueryable): Promise<number> {
  const result = await db.query<{ count: string }>(
    "SELECT COUNT(*)::text AS count FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'",
  );
  return Number(result.rows[0]?.count ?? 0);
}

async function waitFor(check: () => Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Condition was not reached within five seconds.");
}

/** A pool whose transaction clients pause after the admission's row lock until `release` resolves. */
function pausingAfterRowLock(pool: PgTransactionalPool, locked: () => void, release: Promise<void>): PgTransactionalPool {
  return {
    query: pool.query.bind(pool),
    connect: async () => {
      const client = (await pool.connect()) as PgPoolClient;
      const query = (async (text: string, values?: readonly unknown[]) => {
        const result = await client.query(text, values);
        if (text.includes("FOR SHARE")) {
          locked();
          await release;
        }
        return result;
      }) as PgPoolClient["query"];
      return { query, release: client.release.bind(client) };
    },
  };
}

// The admission locks the selected rows, previews them again on its own
// transaction's client, compares the token and enqueues, all in one
// repeatable-read transaction. These run the real Catalog services on PostgreSQL.
describeDb("bulk promotion admission through real Catalog services", () => {
  let pool: PgTransactionalPool;
  let services: CatalogServices;
  let catalogUrl: string;
  const { retainedPlan } = usePromotionTargetExclusionFixture(
    async () => {
      const urls = createMultiContextTestDatabaseUrls(databaseBaseUrl!, ["catalog"], "bulk_promotion_admission");
      await ensureMultiContextTestDatabases(databaseBaseUrl!, urls);
      catalogUrl = urls.catalog;
      return createMultiContextTestPools(urls).catalog;
    },
    (fresh) => {
      ({ pool, services } = fresh);
    },
  );

  async function confirmedPreview(observationId: string) {
    const preview = await services.sourceObservations.previewPromoteObservations({
      observationIds: [observationId],
      promoteAsDraft: false,
    });
    expect(preview).toMatchObject({ matched: 1, eligible: 1 });
    expect(preview.validation.diagnostics.filter((diagnostic) => diagnostic.blocking)).toEqual([]);
    return sourceObservationPromotionPreviewToken({ observationIds: [observationId] }, preview, confirmation);
  }

  function admit(on: CatalogServices, observationId: string, previewToken: string) {
    return on.sourceObservations.admitBulkPromotionJob({
      observationIds: [observationId],
      promoteAsDraft: false,
      previewToken,
      confirmation,
      context,
    });
  }

  it("admits a real preview token on a one-connection pool without a second checkout", async () => {
    await retainedPlan("admit-one-client");
    const previewToken = await confirmedPreview("admit-one-client");
    const before = await writes(pool);
    const oneConnection = createPgPool(catalogUrl, { max: 1, connectionTimeoutMillis: 500 });
    try {
      const job = await admit(createCatalogServices(oneConnection), "admit-one-client", previewToken);

      expect(job).not.toBeNull();
      expect(await unitIds(pool, job!.jobId)).toEqual(["admit-one-client"]);
      await expectOneAdmittedJob(pool, before, job!.jobId);
    } finally {
      await (oneConnection as unknown as { end: () => Promise<void> }).end();
    }
  });

  it("refuses with no writes when a selected row changes before the admission locks it", async () => {
    await retainedPlan("admit-changed-first");
    const previewToken = await confirmedPreview("admit-changed-first");
    const before = await writes(pool);
    const writer = (await pool.connect()) as PgPoolClient;
    try {
      await writer.query("BEGIN");
      await writer.query(
        "UPDATE catalog_source_observations SET source_record_hash = 'changed-' || source_record_hash WHERE observation_id = $1",
        ["admit-changed-first"],
      );
      const admission = admit(services, "admit-changed-first", previewToken);
      // The admission's row lock waits behind the writer; the writer then commits a change its snapshot cannot see.
      await waitFor(async () => (await lockWaiters(pool)) === 1);
      await writer.query("COMMIT");

      await expect(admission).resolves.toBeNull();
    } finally {
      writer.release();
    }
    expect(await writes(pool)).toEqual(before);
  });

  it("admits exactly the checked snapshot when a writer waits on the admission's row lock", async () => {
    await retainedPlan("admit-locked-first");
    const previewToken = await confirmedPreview("admit-locked-first");
    const before = await writes(pool);
    let locked!: () => void;
    const rowLocked = new Promise<void>((resolve) => {
      locked = resolve;
    });
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const admitting = createCatalogServices(pausingAfterRowLock(pool, locked, released));
    const admission = admit(admitting, "admit-locked-first", previewToken);
    await rowLocked;
    const change = pool.query(
      "UPDATE catalog_source_observations SET source_record_hash = 'changed-' || source_record_hash WHERE observation_id = $1",
      ["admit-locked-first"],
    );
    await waitFor(async () => (await lockWaiters(pool)) === 1);
    release();

    const job = await admission;
    await change;
    expect(job).not.toBeNull();
    expect(await unitIds(pool, job!.jobId)).toEqual(["admit-locked-first"]);
    await expectOneAdmittedJob(pool, before, job!.jobId);
    const hash = await pool.query<{ source_record_hash: string }>(
      "SELECT source_record_hash FROM catalog_source_observations WHERE observation_id = $1",
      ["admit-locked-first"],
    );
    expect(hash.rows[0]?.source_record_hash).toMatch(/^changed-/);
  });

  it("rolls back the job, its event, binding and units when a write after the job insert fails", async () => {
    await retainedPlan("admit-rollback");
    const previewToken = await confirmedPreview("admit-rollback");
    const before = await writes(pool);
    await pool.query(
      `CREATE FUNCTION fail_bulk_review_units() RETURNS trigger LANGUAGE plpgsql AS $$
       BEGIN RAISE EXCEPTION 'synthetic work unit failure'; END $$`,
    );
    await pool.query(
      `CREATE TRIGGER fail_bulk_review_units BEFORE INSERT ON catalog_source_observation_bulk_review_work_units
       FOR EACH ROW EXECUTE FUNCTION fail_bulk_review_units()`,
    );
    try {
      await expect(admit(services, "admit-rollback", previewToken)).rejects.toThrow(/synthetic work unit failure/);
    } finally {
      await pool.query("DROP TRIGGER fail_bulk_review_units ON catalog_source_observation_bulk_review_work_units");
      await pool.query("DROP FUNCTION fail_bulk_review_units()");
    }
    expect(await writes(pool)).toEqual(before);
  });
});
