import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { module as catalogModule } from "../../../index";
import { catalogSourceObservationSchemaMigrations } from "./schema";

const databaseBaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseBaseUrl && process.env.CI) {
  throw new Error("TEST_DATABASE_URL is required for Catalog Merge Candidate identity migration tests in CI.");
}
const describeDb = databaseBaseUrl ? describe : describe.skip;
const contextNames = ["catalog"] as const;

describeDb("Catalog Merge Candidate canonical scope identity migration", () => {
  let pools: Readonly<Record<(typeof contextNames)[number], PgTransactionalPool>>;

  beforeAll(async () => {
    const databaseUrls = createMultiContextTestDatabaseUrls(
      databaseBaseUrl!,
      contextNames,
      "catalog_merge_candidate_scope_identity",
    );
    await ensureMultiContextTestDatabases(databaseBaseUrl!, databaseUrls);
    pools = createMultiContextTestPools(databaseUrls);
  });

  beforeEach(async () => {
    await resetMultiContextTestSchemas(pools);
  });

  afterAll(async () => {
    await closeMultiContextTestPools(pools);
  });

  it("creates canonical scope identity on a fresh schema", async () => {
    await pools.catalog.query(catalogModule.schemaSql);
    await applyIdentityMigration(pools.catalog);

    await expect(candidateScopeColumn(pools.catalog)).resolves.toMatchObject({ is_nullable: "NO" });
    await expect(candidateScopeConstraints(pools.catalog)).resolves.toEqual(
      expect.arrayContaining([
        "catalog_merge_candidates_scope_record_fk",
        "catalog_merge_candidates_scope_record_required",
      ]),
    );
    await expect(candidateScopeIndexes(pools.catalog)).resolves.toContain("catalog_merge_candidates_scope_record_idx");
  });

  it("wipes legacy candidate streams and projections while preserving rebuild inputs", async () => {
    await createLegacyCandidateSchema(pools.catalog);
    await seedLegacyCandidateState(pools.catalog);

    await applyIdentityMigration(pools.catalog);
    await applyIdentityMigration(pools.catalog);

    await expect(count(pools.catalog, "catalog_merge_candidates")).resolves.toBe(0);
    await expect(count(pools.catalog, "catalog_merge_candidate_observations")).resolves.toBe(0);
    await expect(count(pools.catalog, "event_store_streams")).resolves.toBe(1);
    await expect(count(pools.catalog, "event_store_events")).resolves.toBe(1);
    await expect(count(pools.catalog, "catalog_scope_records")).resolves.toBe(1);
    await expect(count(pools.catalog, "catalog_provider_scope_mappings")).resolves.toBe(1);
    await expect(count(pools.catalog, "catalog_source_observations")).resolves.toBe(1);
    await expect(candidateScopeColumn(pools.catalog)).resolves.toMatchObject({ is_nullable: "NO" });
  });
});

async function applyIdentityMigration(db: PgTransactionalPool): Promise<void> {
  const migration = catalogSourceObservationSchemaMigrations.find(
    (candidate) => candidate.migrationId === "20260713_catalog_merge_candidate_scope_identity_v2",
  );
  if (!migration) {
    throw new Error("Catalog Merge Candidate canonical scope identity migration is missing.");
  }
  for (const statement of migration.statements) {
    await db.query(statement);
  }
}

async function createLegacyCandidateSchema(db: PgTransactionalPool): Promise<void> {
  await db.query(`CREATE TABLE event_store_streams (
    stream_id text PRIMARY KEY,
    current_version bigint NOT NULL,
    updated_at timestamptz NOT NULL
  );
  CREATE TABLE event_store_events (
    event_id text PRIMARY KEY,
    stream_id text NOT NULL REFERENCES event_store_streams (stream_id) ON DELETE CASCADE
  );
  CREATE TABLE catalog_scope_records (scope_record_id text PRIMARY KEY);
  CREATE TABLE catalog_provider_scope_mappings (mapping_id text PRIMARY KEY, review_status text NOT NULL);
  CREATE TABLE catalog_source_observations (observation_id text PRIMARY KEY);
  CREATE TABLE catalog_merge_candidates (
    candidate_id text PRIMARY KEY,
    identity_fingerprint text NOT NULL,
    status text NOT NULL,
    updated_at timestamptz NOT NULL
  );
  CREATE TABLE catalog_merge_candidate_observations (
    candidate_id text NOT NULL REFERENCES catalog_merge_candidates (candidate_id) ON DELETE CASCADE,
    observation_id text NOT NULL,
    PRIMARY KEY (candidate_id, observation_id)
  );`);
}

async function seedLegacyCandidateState(db: PgTransactionalPool): Promise<void> {
  await db.query(`INSERT INTO catalog_scope_records VALUES ('scope_base_set');
  INSERT INTO catalog_provider_scope_mappings VALUES ('map_accepted', 'accepted');
  INSERT INTO catalog_source_observations VALUES ('obs_1');
  INSERT INTO catalog_merge_candidates VALUES ('cand_v1', 'sha256:v1', 'ready', now());
  INSERT INTO catalog_merge_candidate_observations VALUES ('cand_v1', 'obs_1');
  INSERT INTO event_store_streams VALUES ('catalog.merge-candidate-cand_v1', 1, now());
  INSERT INTO event_store_streams VALUES ('catalog.item-item_preserved', 1, now());
  INSERT INTO event_store_events VALUES ('evt_v1', 'catalog.merge-candidate-cand_v1');
  INSERT INTO event_store_events VALUES ('evt_preserved', 'catalog.item-item_preserved');`);
}

async function candidateScopeColumn(db: PgTransactionalPool) {
  const result = await db.query<{ is_nullable: string }>(
    `SELECT is_nullable
     FROM information_schema.columns
     WHERE table_schema = current_schema()
       AND table_name = 'catalog_merge_candidates'
       AND column_name = 'scope_record_id'`,
  );
  return result.rows[0];
}

async function candidateScopeConstraints(db: PgTransactionalPool): Promise<readonly string[]> {
  const result = await db.query<{ conname: string }>(
    `SELECT conname
     FROM pg_constraint
     WHERE conrelid = 'catalog_merge_candidates'::regclass
     ORDER BY conname`,
  );
  return result.rows.map((row) => row.conname);
}

async function candidateScopeIndexes(db: PgTransactionalPool): Promise<readonly string[]> {
  const result = await db.query<{ indexname: string }>(
    `SELECT indexname
     FROM pg_indexes
     WHERE schemaname = current_schema()
       AND tablename = 'catalog_merge_candidates'
     ORDER BY indexname`,
  );
  return result.rows.map((row) => row.indexname);
}

async function count(db: PgTransactionalPool, table: string): Promise<number> {
  const result = await db.query<{ count: string }>(`SELECT COUNT(*) AS count FROM ${table}`);
  return Number(result.rows[0]?.count ?? 0);
}
