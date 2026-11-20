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
import { createScopeSyncBatchPlanner, resolveScopeSyncCountMembership } from "./planner";
import { listProviderScopeMappingsByScopeRecord } from "../../provider-scope-mapping/read-model/queries";
import { assertScopeSyncBatchPreviewCurrent, ScopeSyncBatchStalePreviewError } from "../domain/batch";
import { countCaptureUnitKeys } from "../domain/count-capture-plan";
import { createCapturePlannerFixture, captureContext } from "../tests/count-capture-planner-fixture";

const databaseBaseUrl = process.env.TEST_DATABASE_URL;
const describeDb = databaseBaseUrl ? describe : describe.skip;

describeDb("scope-sync batch language edition selection", () => {
  let pools: Readonly<{ catalog: PgTransactionalPool }>;
  let pool: PgTransactionalPool;

  beforeAll(async () => {
    const urls = createMultiContextTestDatabaseUrls(databaseBaseUrl!, ["catalog"], "scope_sync_language_10060");
    await ensureMultiContextTestDatabases(databaseBaseUrl!, urls);
    pools = createMultiContextTestPools(urls);
    pool = pools.catalog;
  });

  beforeEach(async () => {
    await resetMultiContextTestSchemas({ catalog: pool });
    await pool.query(catalogModule.schemaSql);
    await pool.query(
      `INSERT INTO catalog_scope_records
        (scope_record_id, product_domain, scope_kind, reference_type_key, reference_record_id, reference_record_key, name, lifecycle_status, language_editions)
       VALUES
        ('scope-pokemon-en', 'pokemon', 'expansion', 'expansion', 'ref-pokemon-en', 'pokemon-en', 'Pokemon EN', 'active', '["en"]'),
        ('scope-pokemon-ja', 'pokemon', 'expansion', 'expansion', 'ref-pokemon-ja', 'pokemon-ja', 'Pokemon JA', 'active', '["ja"]'),
        ('scope-pokemon-unstamped', 'pokemon', 'expansion', 'expansion', 'ref-pokemon-unstamped', 'pokemon-unstamped', 'Pokemon Unstamped', 'active', '[]'),
        ('scope-one-piece-unstamped', 'one-piece', 'set', 'set', 'ref-one-piece-unstamped', 'one-piece-unstamped', 'One Piece Unstamped', 'active', '[]')`,
    );
  });

  afterAll(async () => {
    await closeMultiContextTestPools(pools);
  });

  it.each([
    ["en", ["scope-pokemon-en"]],
    ["ja", ["scope-pokemon-ja"]],
    [null, ["scope-pokemon-en", "scope-pokemon-ja", "scope-pokemon-unstamped"]],
  ] as const)("selects Pokemon records for language %s", async (languageCode, expectedIds) => {
    const result = await resolveScopeSyncCountMembership(pool, {
      mode: "matching-scope",
      query: { productDomain: "pokemon", scopeKind: "expansion", languageCode },
    });
    expect(result.records.map((record) => record.scope_record_id)).toEqual(expectedIds);
  });

  it("does not apply language filtering to One Piece", async () => {
    const result = await resolveScopeSyncCountMembership(pool, {
      mode: "matching-scope",
      query: { productDomain: "one-piece", scopeKind: "set", languageCode: "en" },
    });
    expect(result.records.map((record) => record.scope_record_id)).toEqual(["scope-one-piece-unstamped"]);
  });

  it.each(["2026-10-10T05:18:47.195000Z", "2026-10-10T05:18:47.195123Z"])(
    "matches Coverage and JSON at %s in a non-UTC session and fingerprints a one-microsecond mapping change",
    async (version) => {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SET LOCAL TIME ZONE 'Asia/Kolkata'");
        expect((await client.query<{ TimeZone: string }>("SHOW TIME ZONE")).rows[0]!.TimeZone).toBe("Asia/Kolkata");
        const scopeRecordId = "scope-one-piece-unstamped";
        for (const [index, unitKey] of countCaptureUnitKeys.entries())
          await client.query(
            `INSERT INTO catalog_provider_scope_mappings
              (mapping_id, scope_record_id, provider_key, unit_key, set_id, confidence, review_status, policy_version, updated_at)
             VALUES ($1, $2, 'scrydex', $3, 'OP01', 'exact', 'accepted', 'synthetic', $4)`,
            [`synthetic-version-${index}`, scopeRecordId, unitKey, version],
          );
        const planner = createScopeSyncBatchPlanner({
          db: client,
          now: () => "2026-10-13T08:04:10.000Z",
          previewCatalogSyncScope: createCapturePlannerFixture(async () => null).previewCatalogSyncScope,
        });
        const input = { selection: { mode: "ids" as const, scopeRecordIds: [scopeRecordId] }, context: captureContext };
        const coverage = await listProviderScopeMappingsByScopeRecord(client, scopeRecordId);
        const membership = await resolveScopeSyncCountMembership(client, input.selection);
        const before = await planner.resolve(input);
        const repeated = await planner.resolve(input);
        const expected = coverage.map((mapping) => ({
          mappingId: mapping.mapping_id,
          version: mapping.updated_at,
          reviewStatus: mapping.review_status,
        }));
        expect(coverage.map((mapping) => mapping.updated_at)).toEqual([version, version, version]);
        expect(membership.mappings.map((mapping) => mapping.updated_at)).toEqual([version, version, version]);
        expect(before.plans[0]!.mappingVersions).toEqual(expected);
        expect(JSON.parse(JSON.stringify(before.preview)).samples[0].mappingVersions).toEqual(expected);
        expect(repeated.preview.planFingerprint).toBe(before.preview.planFingerprint);
        await client.query(
          "UPDATE catalog_provider_scope_mappings SET updated_at = updated_at + interval '1 microsecond' WHERE mapping_id = $1",
          ["synthetic-version-0"],
        );
        const after = await planner.resolve(input);
        expect(after.preview.planFingerprint).not.toBe(before.preview.planFingerprint);
        expect(() => assertScopeSyncBatchPreviewCurrent(before.preview.planFingerprint, after.preview)).toThrow(
          ScopeSyncBatchStalePreviewError,
        );
      } finally {
        await client.query("ROLLBACK");
        client.release();
      }
    },
  );
});
