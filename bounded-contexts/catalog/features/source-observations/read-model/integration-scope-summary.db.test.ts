import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { bootstrapContextDatabase } from "@chase-sets/bounded-context-runtime";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { module as catalogModule } from "../../../index";
import { selectedImportScopeFor } from "../ui/primary-workbench-import-jobs";
import { listSourceObservationIntegrationScopes } from "./queries";
import { buildSourceObservationProjectionHandlers } from "./projection";
import { catalogSourceObservationSchemaMigrations } from "./schema";

const databaseBaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseBaseUrl && process.env.CI) {
  throw new Error("TEST_DATABASE_URL is required for Source Observation integration-scope summary tests in CI.");
}
const describeDb = databaseBaseUrl ? describe : describe.skip;
const setId = "000f0093-1847-4db7-a315-5bd07f055c7a";

describeDb("Source Observation integration scope summaries", () => {
  let pool: PgTransactionalPool;

  beforeAll(async () => {
    const urls = createMultiContextTestDatabaseUrls(databaseBaseUrl!, ["catalog"], "catalog_scope_key_repair");
    await ensureMultiContextTestDatabases(databaseBaseUrl!, urls);
    pool = createMultiContextTestPools(urls).catalog;
  });

  beforeEach(async () => {
    await resetMultiContextTestSchemas({ catalog: pool });
    await bootstrapContextDatabase(catalogModule, pool);
  });

  afterAll(async () => closeMultiContextTestPools({ catalog: pool }));

  it("keys a YGOJSON set summary by normalized setId so importScope en:<uuid> resolves expected observations", async () => {
    const handlers = buildSourceObservationProjectionHandlers(pool);
    const handler = handlers["catalog.source-observation.recorded"];
    await handler({
      streamId: "catalog.source-observation-ygojson-beginners-edition-2",
      type: "catalog.source-observation.recorded",
      data: {
        observationId: "ygojson-beginners-edition-2",
        providerKey: "ygojson",
        externalKey: `set:${setId}`,
        sourceUrl: "https://example.test/ygojson/beginners-edition-2.json",
        languageCode: "en",
        sourceRecordHash: "hash:ygojson-beginners-edition-2",
        sourceUpdatedAt: null,
        observedAt: "2026-10-25T00:00:00.000Z",
        sourceProfileKey: "yugioh-set-reference-data",
        sourceProfileVersion: "2026.10.25",
        sourceMappingFingerprint: "fingerprint:ygojson:2026.10.25",
        normalized: {
          kind: "yugioh-set-reference",
          tcg: "yugioh",
          languageCode: "en",
          name: "Beginner's Edition 2",
          setId,
          setName: "Beginner's Edition 2",
          releaseDate: "2006-09-28",
          cardCount: null,
          productLineName: "Yu-Gi-Oh!",
        },
        sourcePayload: { productLineId: "yugioh", productLineName: "Yu-Gi-Oh!" },
      },
      timing: { recordedAt: "2026-10-25T00:00:01.000Z" },
    } as never);

    const rows = await listSourceObservationIntegrationScopes(pool, {
      provider: "ygojson",
      language: "en",
      setId,
    });
    const selected = selectedImportScopeFor({
      activeProfile: null,
      activeJobCount: 0,
      blockers: [],
      input: { providerKey: "ygojson", importScope: `en:${setId}`, scopes: { items: rows } },
      importScope: `en:${setId}`,
      providerKey: "ygojson",
      providerTransport: [],
      routeContext: {} as never,
      rolloutEnabled: true,
      unitKey: "ygojson:yugioh:set:reference-data",
    });
    expect(rows).toHaveLength(1);
    expect(selected?.expectedObservationVolume).toBeGreaterThan(0);
  });

  it("repairs a legacy row, removes the stale name summary, and is idempotent", async () => {
    await pool.query(
      `INSERT INTO catalog_source_observations (
         observation_id, provider_key, external_key, source_url, language_code,
         source_record_hash, observed_at, source_profile_key, source_profile_version,
         source_mapping_fingerprint, normalized, source_payload
       ) VALUES ($1, 'ygojson', $2, 'https://example.test', 'en', 'hash:legacy', now(),
         'yugioh-set-reference-data', '2026.10.18', 'fingerprint:legacy', $3::jsonb, $4::jsonb)`,
      [
        "legacy-ygojson-set",
        "set:${setId}",
        JSON.stringify({
          kind: "yugioh-set-reference",
          tcg: "yugioh",
          languageCode: "en",
          name: "Beginner's Edition 2",
          setName: "Beginner's Edition 2",
          ygojsonId: setId,
        }),
        JSON.stringify({ productLineId: "yugioh", productLineName: "Yu-Gi-Oh!" }),
      ],
    );
    await pool.query(
      `INSERT INTO catalog_source_observation_integration_scope_summaries (
         provider_key, language_code, product_line_id, series_id, expansion_id,
         first_observed_at, latest_observed_at
       ) VALUES ('ygojson', 'en', 'yugioh', '', 'Beginner''s Edition 2', now(), now())`,
    );
    const migration = catalogSourceObservationSchemaMigrations.find(
      (candidate) => candidate.migrationId === "20261025_catalog_repair_ygojson_set_scope_keys",
    );
    expect(migration?.dataStep).toBeTypeOf("function");
    await migration!.dataStep!(pool);
    await migration!.dataStep!(pool);

    const row = await pool.query<{ normalized: Record<string, unknown> }>(
      "SELECT normalized FROM catalog_source_observations WHERE observation_id = $1",
      ["legacy-ygojson-set"],
    );
    expect(row.rows[0]?.normalized).toMatchObject({ setId });
    const summaries = await pool.query<{ expansion_id: string }>(
      "SELECT expansion_id FROM catalog_source_observation_integration_scope_summaries WHERE provider_key = 'ygojson'",
    );
    expect(summaries.rows.map((summary) => summary.expansion_id)).toContain(setId);
    expect(summaries.rows.map((summary) => summary.expansion_id)).not.toContain("Beginner's Edition 2");
  });
});
