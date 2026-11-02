import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { bootstrapContextDatabase } from "@chase-sets/bounded-context-runtime";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import type { JsonValue } from "@chase-sets/primitives/json";
import { module as catalogModule } from "../../../index";
import { decideSourceObservation, initialSourceObservationState } from "../domain/domain";
import { ygojsonYugiohSetReferenceSourceObservationMappingContract } from "../api/providers/ygojson/executable-mapping-contract";
import { requireCatalogProviderSourceObservation } from "../api/promotion/provider-source-observation-normalizer";
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
      input: {
        requestUrl: `https://admin.example/catalog/integrations?providerKey=ygojson&importScope=en:${setId}`,
        scopes: { items: rows, total: rows.length, count: rows.length },
        profileReviews: { items: [], total: 0, count: 0 },
        controlPlaneOverview: null,
        canManageCatalog: true,
      },
      importScope: `en:${setId}`,
      providerKey: "ygojson",
      providerTransport: [],
      routeContext: {
        section: "import-jobs",
        providerKey: "ygojson",
        unitKey: "ygojson:yugioh:set:reference-data",
        importScope: `en:${setId}`,
        profileVersion: null,
        sourceObservationFilters: { status: "" },
        selectedObservationIds: [],
        reviewOffset: null,
        reviewLimit: null,
        jobId: null,
        promotionPreviewId: null,
        returnPath: null,
      },
      rolloutEnabled: true,
      unitKey: "ygojson:yugioh:set:reference-data",
    });
    expect(rows).toHaveLength(1);
    expect(selected?.expectedObservationVolume).toBeGreaterThan(0);
  });

  it("replays the real chunked YGOJSON fixture through both evidence assemblies", async () => {
    const fixture = JSON.parse(
      readFileSync(
        fileURLToPath(
          new URL("../api/__fixtures__/ygojson-yugioh-set-reference-data/beginners-edition-2.json", import.meta.url),
        ),
        "utf8",
      ),
    ) as JsonValue;
    const observation = requireCatalogProviderSourceObservation({
      contract: ygojsonYugiohSetReferenceSourceObservationMappingContract,
      payload: fixture,
      observedAt: "2026-10-25T00:00:00.000Z",
    });
    const events = decideSourceObservation(initialSourceObservationState, {
      type: "RecordSourceObservation",
      ...observation,
    });
    expect(events.some((event) => event.type === "catalog.source-observation.normalized-evidence-chunk-recorded")).toBe(
      true,
    );
    expect(events.some((event) => event.type === "catalog.source-observation.source-payload-chunk-recorded")).toBe(
      true,
    );

    const handlers = buildSourceObservationProjectionHandlers(pool);
    for (const event of events) {
      await handlers[event.type]?.({
        streamId: `catalog.source-observation-${observation.observationId}`,
        type: event.type,
        data: event.data,
        timing: { recordedAt: "2026-10-25T00:00:01.000Z" },
      } as never);
    }

    const row = await pool.query<{ normalized: Record<string, unknown>; source_payload: Record<string, unknown> }>(
      "SELECT normalized, source_payload FROM catalog_source_observations WHERE observation_id = $1",
      [observation.observationId],
    );
    expect(row.rows[0]?.normalized).toMatchObject({
      kind: "yugioh-set-reference",
      setId,
    });
    expect(row.rows[0]?.source_payload).toMatchObject({ kind: "set-reference" });
    const summaries = await listSourceObservationIntegrationScopes(pool, {
      provider: "ygojson",
      language: "en",
      setId,
    });
    expect(summaries).toHaveLength(1);
    expect(summaries[0]?.total_observations).toBe(1);
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
      `INSERT INTO catalog_source_observations (
         observation_id, provider_key, external_key, source_url, language_code,
         source_record_hash, observed_at, source_profile_key, source_profile_version,
         source_mapping_fingerprint, normalized, source_payload
       ) VALUES
       ('ygojson-sealed-control', 'ygojson', 'sealed-product:control', 'https://example.test/sealed', 'en',
        'hash:sealed-control', '2026-10-24T00:00:00.000Z', 'yugioh-sealed-product-reference-data', '2026.10.18',
        'fingerprint:sealed-control', '{"kind":"yugioh-sealed-product","name":"Control product","setId":"sealed-control"}'::jsonb,
        '{"productLineId":"yugioh","productLineName":"Yu-Gi-Oh!"}'::jsonb),
       ('other-provider-control', 'tcgdex', 'base1', 'https://example.test/other', 'en',
        'hash:other-control', '2026-10-23T00:00:00.000Z', 'pokemon-tcg', '2026.10.18',
        'fingerprint:other-control', '{"kind":"pokemon-sealed-product","name":"Other control","setId":"base1"}'::jsonb,
        '{"productLineId":"pokemon","productLineName":"Pokemon"}'::jsonb)`,
    );
    await pool.query(
      `INSERT INTO catalog_source_observation_integration_scope_summaries (
         provider_key, language_code, product_line_id, series_id, expansion_id,
         first_observed_at, latest_observed_at
       ) VALUES ('ygojson', 'en', 'yugioh', '', 'Beginner''s Edition 2', now(), now())`,
    );
    await pool.query(
      `INSERT INTO catalog_source_observation_integration_scope_summaries (
         provider_key, language_code, product_line_id, series_id, expansion_id,
         first_observed_at, latest_observed_at
       ) VALUES
       ('ygojson', 'en', 'yugioh', '', 'sealed-control', '2026-10-24T00:00:00.000Z', '2026-10-24T00:00:00.000Z'),
       ('tcgdex', 'en', 'pokemon', '', 'base1', '2026-10-23T00:00:00.000Z', '2026-10-23T00:00:00.000Z')`,
    );
    const controlsBefore = await pool.query(
      `SELECT observation_id, normalized::text AS normalized, source_payload::text AS source_payload
         FROM catalog_source_observations
        WHERE observation_id IN ('ygojson-sealed-control', 'other-provider-control')
        ORDER BY observation_id`,
    );
    const summariesBefore = await pool.query(
      `SELECT provider_key, language_code, product_line_id, series_id, expansion_id,
              total_observations, observed_observations, changed_observations,
              promoted_observations, rejected_observations, first_observed_at,
              latest_observed_at, latest_source_updated_at
         FROM catalog_source_observation_integration_scope_summaries
        WHERE (provider_key, expansion_id) IN (('ygojson', 'sealed-control'), ('tcgdex', 'base1'))
        ORDER BY provider_key, expansion_id`,
    );
    const migration = catalogSourceObservationSchemaMigrations.find(
      (candidate) => candidate.migrationId === "20261025_catalog_repair_ygojson_set_scope_keys",
    );
    expect(migration?.dataStep).toBeTypeOf("function");
    await migration!.dataStep!(pool);
    await migration!.dataStep!(pool);

    const controlsAfter = await pool.query(
      `SELECT observation_id, normalized::text AS normalized, source_payload::text AS source_payload
         FROM catalog_source_observations
        WHERE observation_id IN ('ygojson-sealed-control', 'other-provider-control')
        ORDER BY observation_id`,
    );
    const summariesAfter = await pool.query(
      `SELECT provider_key, language_code, product_line_id, series_id, expansion_id,
              total_observations, observed_observations, changed_observations,
              promoted_observations, rejected_observations, first_observed_at,
              latest_observed_at, latest_source_updated_at
         FROM catalog_source_observation_integration_scope_summaries
        WHERE (provider_key, expansion_id) IN (('ygojson', 'sealed-control'), ('tcgdex', 'base1'))
        ORDER BY provider_key, expansion_id`,
    );
    expect(controlsAfter.rows).toEqual(controlsBefore.rows);
    expect(summariesAfter.rows).toEqual(summariesBefore.rows);

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
