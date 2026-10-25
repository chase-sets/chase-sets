import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import type { BcSchemaMigration } from "@chase-sets/bounded-context-module";
import { bootstrapContextDatabase } from "@chase-sets/bounded-context-runtime";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import { module as catalogModule } from "../../index";
import { catalogAuthoringSchemaMigrations } from "../../support/authoring-support/schema";

const databaseBaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseBaseUrl && process.env.CI) throw new Error("TEST_DATABASE_URL is required in CI.");
const describeDb = databaseBaseUrl ? describe : describe.skip;

describeDb("TCGplayer custody retirement migration", () => {
  let pool: PgTransactionalPool;

  beforeAll(async () => {
    const urls = createMultiContextTestDatabaseUrls(databaseBaseUrl!, ["catalog"], "catalog_custody_retirement");
    await ensureMultiContextTestDatabases(databaseBaseUrl!, urls);
    pool = createMultiContextTestPools(urls).catalog;
  });

  beforeEach(async () => {
    await resetMultiContextTestSchemas({ catalog: pool });
    await pool.query(catalogModule.schemaSql);
    await pool.query(
      `CREATE TABLE catalog_tcgplayer_operator_sessions (
         provider_key text PRIMARY KEY,
         version text NOT NULL,
         state text NOT NULL,
         revision bigint NOT NULL,
         key_id text NOT NULL,
         ciphertext bytea NULL,
         iv bytea NULL,
         tag bytea NULL,
         stored_at timestamptz NULL,
         observed_at timestamptz NULL,
         browser_expires_at timestamptz NULL
       );
       CREATE TABLE catalog_tcgplayer_operator_session_outcomes (
         provider_key text PRIMARY KEY,
         source text NOT NULL,
         revision bigint NOT NULL,
         custody_revision bigint NOT NULL,
         state text NOT NULL,
         state_since timestamptz NOT NULL,
         last_rejection_at timestamptz NULL,
         last_rejection_status integer NULL,
         rate_budget_context text NOT NULL,
         ever_succeeded boolean NOT NULL,
         updated_at timestamptz NOT NULL
       );`,
    );
    await pool.query(
      `INSERT INTO catalog_operator_session_grants
         (id, token_hash, creator_user_id, creator_membership_id, created_at, last_used_at, idle_expires_at)
       VALUES
         ('00000000-0000-0000-0000-000000000001', decode(repeat('00', 32), 'hex'), '00000000-0000-0000-0000-000000000101', '00000000-0000-0000-0000-000000000201', now(), now(), now() + interval '1 day'),
         ('00000000-0000-0000-0000-000000000002', decode(repeat('11', 32), 'hex'), '00000000-0000-0000-0000-000000000102', '00000000-0000-0000-0000-000000000202', now(), now(), now() + interval '1 day')`,
    );
    await pool.query(
      `UPDATE catalog_operator_session_grants
       SET revoked_at = now(), revoke_reason = 'disconnect'
       WHERE id = '00000000-0000-0000-0000-000000000002';
       INSERT INTO catalog_tcgplayer_operator_sessions
         (provider_key, version, state, revision, key_id, ciphertext, iv, tag, stored_at, observed_at, browser_expires_at)
       VALUES
         ('tcgplayer', 'CatalogOperatorSession/v1', 'stored', 1, 'synthetic-key', decode('00', 'hex'), decode(repeat('00', 12), 'hex'), decode(repeat('00', 16), 'hex'), now(), now(), now() + interval '1 day'),
         ('cleared', 'CatalogOperatorSession/v1', 'cleared', 2, 'synthetic-key', NULL, NULL, NULL, NULL, NULL, NULL);
       INSERT INTO catalog_tcgplayer_operator_session_outcomes
         (provider_key, source, revision, custody_revision, state, state_since, rate_budget_context, ever_succeeded, updated_at)
       VALUES
         ('tcgplayer', 'operator-session', 1, 1, 'healthy', now(), 'retained', true, now()),
         ('cleared', 'environment', 0, 0, 'untested', now(), 'unknown', false, now());`,
    );
  });

  afterAll(async () => closeMultiContextTestPools({ catalog: pool }));

  it("deletes seeded custody rows, clears grants, drops tables, and is idempotent", async () => {
    const migration: BcSchemaMigration | undefined = catalogAuthoringSchemaMigrations.find(
      ({ migrationId }) => migrationId === "20261018_catalog_remove_tcgplayer_server_custody",
    );
    expect(migration?.dataStep).toBeTypeOf("function");

    await bootstrapContextDatabase(catalogModule, pool);
    await bootstrapContextDatabase(catalogModule, pool);

    await expect(pool.query("SELECT 1 FROM catalog_operator_session_grants")).resolves.toMatchObject({ rows: [] });
    await expect(pool.query("SELECT 1 FROM catalog_tcgplayer_operator_sessions")).rejects.toThrow();
    await expect(pool.query("SELECT 1 FROM catalog_tcgplayer_operator_session_outcomes")).rejects.toThrow();

    await pool.query("DELETE FROM bounded_context_schema_migrations WHERE migration_id = $1", [
      "20261018_catalog_remove_tcgplayer_server_custody",
    ]);
    await bootstrapContextDatabase(catalogModule, pool);
    await expect(pool.query("SELECT 1 FROM catalog_operator_session_grants")).resolves.toMatchObject({ rows: [] });
    await expect(pool.query("SELECT 1 FROM catalog_tcgplayer_operator_sessions")).rejects.toThrow();
    await expect(pool.query("SELECT 1 FROM catalog_tcgplayer_operator_session_outcomes")).rejects.toThrow();
  });
});
