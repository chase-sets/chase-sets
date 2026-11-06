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
import { integrationScopeToObservationScope } from "../api/source-observation-job-serialization";
import { listSourceObservationIdsForReapply } from "./queries";
import { buildSourceObservationProjectionHandlers } from "./projection";

const databaseBaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseBaseUrl && process.env.CI) {
  throw new Error("TEST_DATABASE_URL is required for Source Observation reapply selection tests in CI.");
}
const describeDb = databaseBaseUrl ? describe : describe.skip;

// Two units of one provider share a coordinate: Scrydex's One Piece single cards and sealed
// products, promoted from the same synthetic set. All IDs are synthetic.
const coordinate = { provider: "scrydex", language: "en", setId: "synthetic-op-set" } as const;
const observations = [
  { observationId: "obs-synthetic-card", kind: "one-piece-card-print", name: "Synthetic Card" },
  { observationId: "obs-synthetic-sealed", kind: "one-piece-sealed-product", name: "Synthetic Booster Box" },
] as const;

describeDb("A unit's reapply selects only its own kind of Source Observation", () => {
  let pool: PgTransactionalPool;

  beforeAll(async () => {
    const urls = createMultiContextTestDatabaseUrls(databaseBaseUrl!, ["catalog"], "catalog_reapply_unit_selection");
    await ensureMultiContextTestDatabases(databaseBaseUrl!, urls);
    pool = createMultiContextTestPools(urls).catalog;
  });

  beforeEach(async () => {
    await resetMultiContextTestSchemas({ catalog: pool });
    await bootstrapContextDatabase(catalogModule, pool);
    const recorded = buildSourceObservationProjectionHandlers(pool)["catalog.source-observation.recorded"];
    for (const observation of observations) {
      await recorded({
        streamId: `catalog.source-observation-${observation.observationId}`,
        type: "catalog.source-observation.recorded",
        data: {
          observationId: observation.observationId,
          providerKey: coordinate.provider,
          externalKey: observation.observationId,
          sourceUrl: `https://example.test/scrydex/${observation.observationId}.json`,
          languageCode: coordinate.language,
          sourceRecordHash: `hash:${observation.observationId}`,
          sourceUpdatedAt: null,
          observedAt: "2026-11-06T00:00:00.000Z",
          sourceProfileKey: "synthetic-older-profile",
          sourceProfileVersion: "2026.01.01",
          sourceMappingFingerprint: "fingerprint:synthetic-older-profile",
          normalized: {
            kind: observation.kind,
            tcg: "one-piece",
            languageCode: coordinate.language,
            name: observation.name,
            setId: coordinate.setId,
            setName: "Synthetic Set",
          },
          sourcePayload: {},
        },
        timing: { recordedAt: "2026-11-06T00:00:01.000Z" },
      } as never);
    }
    // Both were promoted earlier; reapply takes only promoted observations.
    await pool.query(
      `UPDATE catalog_source_observations SET status = 'promoted' WHERE observation_id = ANY($1::text[])`,
      [observations.map((observation) => observation.observationId)],
    );
  });

  afterAll(async () => closeMultiContextTestPools({ catalog: pool }));

  it.each(observations)("selects only the $kind unit's observation on the shared coordinate", async (observation) => {
    const ids = await listSourceObservationIdsForReapply(
      pool,
      integrationScopeToObservationScope(coordinate, observation.kind),
    );

    expect(ids).toEqual([observation.observationId]);
  });

  it("still selects every promoted observation on the coordinate without a unit", async () => {
    const ids = await listSourceObservationIdsForReapply(pool, integrationScopeToObservationScope(coordinate));

    expect([...ids].sort()).toEqual(observations.map((observation) => observation.observationId).sort());
  });
});
