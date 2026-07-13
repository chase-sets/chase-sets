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
import {
  catalogProviderIntegrationProfileVersions,
  catalogProviderProfileVersionIngestionUnitKey,
  type CatalogProviderIntegrationProfileVersionRecord,
} from "./provider-integration-profiles";
import { createCatalogProviderIntegrationProfileVersionStore } from "./provider-integration-profile-store";

const databaseBaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseBaseUrl && process.env.CI) {
  throw new Error("TEST_DATABASE_URL is required for database-backed tests in CI.");
}
const describeDb = databaseBaseUrl ? describe : describe.skip;
const contextNames = ["catalog"] as const;

describeDb("catalog provider integration profile version store db", () => {
  let pools: Readonly<Record<(typeof contextNames)[number], PgTransactionalPool>>;

  beforeAll(async () => {
    const databaseUrls = createMultiContextTestDatabaseUrls(
      databaseBaseUrl!,
      contextNames,
      "catalog_provider_profile_activation",
    );
    await ensureMultiContextTestDatabases(databaseBaseUrl!, databaseUrls);
    pools = createMultiContextTestPools(databaseUrls);
  });

  beforeEach(async () => {
    await resetMultiContextTestSchemas(pools);
    await pools.catalog.query(catalogModule.schemaSql);
  });

  afterAll(async () => {
    await closeMultiContextTestPools(pools);
  });

  it("keeps exactly one active provider profile when activation races seed reconciliation", async () => {
    const store = createCatalogProviderIntegrationProfileVersionStore(pools.catalog);
    const seededVersion = tcgdexVersion("2026.06.03", "active", true);
    const candidateVersion = tcgdexVersion("2026.06.04", "test", false);
    const ingestionUnitKey = catalogProviderProfileVersionIngestionUnitKey(seededVersion);

    await store.seedProfileVersions([seededVersion, candidateVersion]);

    await expect(
      Promise.all([
        store.activateProfileVersion("tcgdex", candidateVersion.profileVersion),
        store.seedProfileVersions([seededVersion]),
      ]),
    ).resolves.toHaveLength(2);

    const activeRows = await pools.catalog.query<{ profile_version: string }>(
      `SELECT profile_version
       FROM catalog_provider_integration_profile_versions
       WHERE provider_key = $1
         AND ingestion_unit_key = $2
         AND active = true
         AND lifecycle = 'active'
       ORDER BY profile_version ASC`,
      [seededVersion.providerKey, ingestionUnitKey],
    );

    expect(activeRows.rows).toHaveLength(1);
    expect(activeRows.rows[0]?.profile_version).toMatch(/^2026\.06\.0[34]$/);
  });
});

function tcgdexVersion(
  profileVersion: string,
  lifecycle: CatalogProviderIntegrationProfileVersionRecord["lifecycle"],
  active: boolean,
): CatalogProviderIntegrationProfileVersionRecord {
  const base = catalogProviderIntegrationProfileVersions.find((candidate) => candidate.providerKey === "tcgdex");
  if (!base) {
    throw new Error("Expected seeded TCGdex profile version.");
  }

  return {
    ...base,
    profileVersion,
    lifecycle,
    active,
    executableMappingContract: base.executableMappingContract
      ? {
          ...base.executableMappingContract,
          profileVersion,
          lifecycle,
        }
      : undefined,
  };
}
