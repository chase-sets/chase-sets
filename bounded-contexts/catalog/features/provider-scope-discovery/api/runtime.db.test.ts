import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import { bootstrapContextDatabase } from "@chase-sets/bounded-context-runtime";
import { createPostgresEventStore, createPostgresProjectionStore } from "@chase-sets/event-core-postgres";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import type { JsonObject, JsonValue } from "@chase-sets/primitives/json";
import { module as catalogModule } from "../../../index";
import { createProviderScopeMappingRuntime } from "../../provider-scope-mapping/api/runtime";
import {
  catalogProviderIntegrationProfileVersions,
  catalogProviderProfileVersionIngestionUnitKey,
  type CatalogProviderIntegrationProfileVersionRecord,
} from "../../source-observations/api/provider-integration-profiles";
import type { CatalogProviderOptionQueryPage } from "../../source-observations/api/provider-option-query-cache";
import { listCatalogProviderIntegrationOptionsFromProfiles } from "../../source-observations/api/providers/provider-option-query-resolver";
import { tcgplayerAutomationResponseFixtures } from "../../source-observations/api/providers/tcgplayer-automation-response-fixtures.test-data";
import type { CatalogProviderSourceObservationMappingContract } from "../../source-observations/api/promotion/provider-source-observation-normalizer";
import { normalizeCatalogProviderSourceObservation } from "../../source-observations/api/promotion/provider-source-observation-normalizer";
import {
  catalogScopeProductDomainContracts,
  type CatalogScopeProductDomain,
  type CatalogScopeRecordKind,
} from "../../scope-registry/domain/contract";
import { listProviderScopeDiscoveryTargets, type ProviderScopeDiscoveryTarget } from "./discovery-targets";
import { createProviderScopeDiscoveryRuntime, type ProviderScopeDiscoveryPorts } from "./runtime";
import type { ProviderRefreshCadenceConfig } from "./provider-refresh-cadence";
import {
  classifyProviderScopeDiscoveryTarget,
  matchScopeObservationsToScopeRecords,
  providerScopeMappingCoordinates,
} from "./scope-observation-matcher";
import type { ProviderScopeObservationRecord } from "./refresh-schedule-store";

const databaseBaseUrl = process.env.TEST_DATABASE_URL;
const describeDb = databaseBaseUrl ? describe : describe.skip;
const contextNames = ["catalog"] as const;
const repositoryRoot = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "../../../../..");

const TEST_CONTEXT = {
  tenantId: "tnt_identity" as never,
  audit: {
    performedByUserId: "usr_identity_system" as never,
    forAccountId: "acc_identity_system" as never,
  },
};

const HOUR_MS = 60 * 60 * 1000;

const testCadence: readonly ProviderRefreshCadenceConfig[] = [
  {
    providerKey: "tcgdex",
    scheduleEnabled: true,
    manualOnly: false,
    creditAware: false,
    intervalMs: 6 * HOUR_MS,
    reason: "test",
  },
  {
    providerKey: "scrydex",
    scheduleEnabled: false,
    manualOnly: true,
    creditAware: true,
    intervalMs: 24 * HOUR_MS,
    reason: "test",
  },
];

describeDb("provider scope discovery runtime db", () => {
  let pools: Readonly<Record<(typeof contextNames)[number], PgTransactionalPool>>;

  beforeAll(async () => {
    const databaseUrls = createMultiContextTestDatabaseUrls(
      databaseBaseUrl!,
      contextNames,
      "catalog_provider_scope_discovery",
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

  function buildRuntime(input: {
    optionPagesByQueryKind: Readonly<
      Record<
        string,
        readonly { value: string; label: string; parentValue?: string | null; metadata?: Record<string, unknown> }[]
      >
    >;
    optionPagesByProviderQueryKind?: Readonly<
      Record<
        string,
        readonly { value: string; label: string; parentValue?: string | null; metadata?: Record<string, unknown> }[]
      >
    >;
    profileProviderKeys?: readonly string[];
    profileVersions?: readonly CatalogProviderIntegrationProfileVersionRecord[];
    cadenceConfig?: readonly ProviderRefreshCadenceConfig[];
    failQueryKinds?: readonly string[];
    queryIntegrationOptions?: ProviderScopeDiscoveryPorts["queryIntegrationOptions"];
  }) {
    const eventStore = createPostgresEventStore({ pool: pools.catalog });
    const checkpointStore = createPostgresProjectionStore({ db: pools.catalog });
    const deps = { eventStore, checkpointStore, db: pools.catalog } as const;
    const providerScopeMappings = createProviderScopeMappingRuntime(deps);
    const queryCalls: string[] = [];
    const queryRequests: Parameters<ProviderScopeDiscoveryPorts["queryIntegrationOptions"]>[0][] = [];

    const runtime = createProviderScopeDiscoveryRuntime(
      deps,
      {
        listProfileVersions: async () =>
          input.profileVersions ??
          catalogProviderIntegrationProfileVersions.filter((version) =>
            (input.profileProviderKeys ?? ["tcgdex"]).includes(version.providerKey),
          ),
        queryIntegrationOptions: async (query) => {
          queryCalls.push(`${query.providerKey}:${query.queryKind}`);
          queryRequests.push(query);
          if (input.failQueryKinds?.includes(query.queryKind)) {
            throw new Error(`provider transport unavailable for ${query.queryKind}`);
          }
          if (input.queryIntegrationOptions) {
            return input.queryIntegrationOptions(query);
          }
          const items =
            input.optionPagesByProviderQueryKind?.[`${query.providerKey}:${query.queryKind}`] ??
            input.optionPagesByQueryKind[query.queryKind] ??
            [];
          return optionPage(
            items.map((item) => ({
              providerKey: query.providerKey,
              queryKind: query.queryKind,
              value: item.value,
              label: item.label,
              description: null,
              parentValue: item.parentValue ?? null,
              imageUrl: null,
              aliases: [],
              metadata: (item.metadata ?? {}) as CatalogProviderOptionQueryPage["items"][number]["metadata"],
            })),
          );
        },
        providerScopeMappingCommandHandler: providerScopeMappings.commandHandler,
      },
      input.cadenceConfig ?? testCadence,
    );

    return { runtime, queryCalls, queryRequests, providerScopeMappings };
  }

  it("bootstraps over the deployed v1 observation cache before running its v2 rebuild migration", async () => {
    await pools.catalog.query(`DROP TABLE catalog_provider_scope_observations;

CREATE TABLE catalog_provider_scope_observations (
  provider_key text NOT NULL,
  query_kind text NOT NULL,
  language_code text NOT NULL,
  option_external_key text NOT NULL,
  display_name text NOT NULL,
  parent_value text NULL,
  image_url text NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  scan_id text NOT NULL,
  scanned_at timestamptz NOT NULL,
  first_observed_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider_key, query_kind, language_code, option_external_key)
);

CREATE INDEX catalog_provider_scope_observations_lookup_idx
  ON catalog_provider_scope_observations (provider_key, query_kind, parent_value);

INSERT INTO catalog_provider_scope_observations (
  provider_key, query_kind, language_code, option_external_key, display_name, scan_id, scanned_at
) VALUES ('tcgdex', 'expansions', 'en', 'sv1', 'Scarlet & Violet', 'scan-v1', now());`);

    await bootstrapContextDatabase(catalogModule, pools.catalog);

    const columns = await pools.catalog.query<{ column_name: string }>(
      `SELECT column_name
       FROM information_schema.columns
       WHERE table_schema = current_schema()
         AND table_name = 'catalog_provider_scope_observations'
       ORDER BY column_name`,
    );
    expect(columns.rows.map((row) => row.column_name)).toEqual(
      expect.arrayContaining(["unit_key", "scope_kind", "source_query_kind", "observation_hash"]),
    );
    expect(columns.rows.map((row) => row.column_name)).not.toEqual(
      expect.arrayContaining(["query_kind", "option_external_key", "display_name", "parent_value"]),
    );

    const observations = await pools.catalog.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM catalog_provider_scope_observations",
    );
    expect(observations.rows[0]?.count).toBe("0");
  });

  async function insertScopeRecord(input: {
    id: string;
    name: string;
    officialSetCode: string | null;
    productDomain?: "pokemon" | "magic" | "yugioh" | "one-piece" | "lorcana";
    scopeKind?: CatalogScopeRecordKind;
    referenceRecordKey?: string;
    releaseDate?: string | null;
  }) {
    const productDomain = input.productDomain ?? "pokemon";
    const scopeKind = input.scopeKind ?? "expansion";
    await pools.catalog.query(
      `INSERT INTO catalog_scope_records (
         scope_record_id, product_domain, scope_kind, reference_type_key,
         reference_record_id, reference_record_key, name, lifecycle_status, official_set_code, release_date
       )
       VALUES ($1, $2, $3, $3, $1, $7, $4, 'active', $5, $6::date)`,
      [
        input.id,
        productDomain,
        scopeKind,
        input.name,
        input.officialSetCode,
        input.releaseDate ?? null,
        input.referenceRecordKey ?? input.id,
      ],
    );
  }

  it("expands all nine contract-bound TCGplayer set-name cascades on identical consecutive scans without duplicate proposals", async () => {
    const versions = activeTcgplayerProfileVersions();
    const facts = await loadTcgplayerFixtureFacts(versions);
    const factsByUnit = new Map(facts.map((fact) => [fact.unitKey, fact]));

    for (const productDomain of Object.keys(catalogScopeProductDomainContracts) as CatalogScopeProductDomain[]) {
      const contract = catalogScopeProductDomainContracts[productDomain];
      await insertScopeRecord({
        id: `scope-parent-${productDomain}`,
        productDomain,
        scopeKind: "product-line",
        referenceRecordKey: contract.productLineReferenceRecordKey,
        name: `${productDomain} canonical product line`,
        officialSetCode: null,
      });
    }
    for (const [index, fact] of [
      ...new Map(facts.map((fact) => [`${fact.productDomain}:${fact.setName}`, fact])).values(),
    ].entries()) {
      await insertScopeRecord({
        id: `scope-leaf-${index}`,
        productDomain: fact.productDomain,
        scopeKind: catalogScopeProductDomainContracts[fact.productDomain].leafReferenceTypeKey,
        name: fact.setName,
        officialSetCode: null,
      });
    }

    const { runtime, queryRequests } = buildRuntime({
      optionPagesByQueryKind: {},
      profileVersions: versions,
      cadenceConfig: [cadence("tcgplayer")],
      queryIntegrationOptions: (query) => tcgplayerFixtureOptionPage(query, versions, factsByUnit),
    });

    const first = await runtime.runProviderRefreshNow({ providerKey: "tcgplayer", context: TEST_CONTEXT });

    expect(versions).toHaveLength(9);
    expect(first).toMatchObject({
      status: "succeeded",
      observationCount: 18,
      newObservationCount: 18,
      mappingsProposed: 18,
    });
    expect(queryRequests.filter((query) => query.queryKind === "set-names")).toHaveLength(9);
    for (const fact of facts) {
      expect(
        queryRequests.filter(
          (query) =>
            query.ingestionUnitKey === fact.unitKey &&
            query.queryKind === "set-names" &&
            query.parentValue === String(fact.productLineId),
        ),
      ).toHaveLength(1);
    }

    const mappingEvents = await pools.catalog.query<{
      payload: {
        unitKey: string;
        coordinates: {
          productLineId: string | null;
          seriesId: string | null;
          setId: string | null;
          setName: string | null;
          language: Record<string, string | null>;
        };
      };
    }>(`SELECT payload FROM event_store_events WHERE stream_id LIKE 'catalog.provider-scope-mapping-%'`);
    const leafMappings = mappingEvents.rows.filter((row) => row.payload.coordinates.setName !== null);
    expect(leafMappings).toHaveLength(9);
    for (const fact of facts) {
      expect(leafMappings.find((row) => row.payload.unitKey === fact.unitKey)?.payload.coordinates).toEqual({
        productLineId: String(fact.productLineId),
        seriesId: null,
        setId: null,
        setName: fact.setName,
        language: {
          languageCode: null,
          providerLanguageCode: null,
          providerLanguageId: null,
          providerLocale: null,
          providerLanguageName: null,
        },
      });
    }
    expect(await runtime.listCanonicalScopeRecordProposals()).toEqual([]);

    const second = await runtime.runProviderRefreshNow({ providerKey: "tcgplayer", context: TEST_CONTEXT });
    expect(second).toMatchObject({
      status: "succeeded",
      observationCount: 18,
      newObservationCount: 0,
      mappingsProposed: 0,
    });
    expect(queryRequests.filter((query) => query.queryKind === "set-names")).toHaveLength(18);
    const eventsAfterSecondScan = await pools.catalog.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM event_store_events WHERE stream_id LIKE 'catalog.provider-scope-mapping-%'`,
    );
    expect(eventsAfterSecondScan.rows[0]?.count).toBe("18");
    expect(await runtime.listCanonicalScopeRecordProposals()).toEqual([]);
  });

  it.each([
    { caseName: "zero", extraParent: false, omitParent: true },
    { caseName: "multiple", extraParent: true, omitParent: false },
  ])("fails the TCGplayer cascade closed for $caseName current-scan product-line parents", async (control) => {
    const version = activeTcgplayerProfileVersions().find(
      (candidate) => candidate.profileKey === "pokemon-single-card-product-sku",
    )!;
    const facts = await loadTcgplayerFixtureFacts([version]);
    const fact = facts[0]!;
    const factsByUnit = new Map([[fact.unitKey, fact]]);
    const contract = catalogScopeProductDomainContracts.pokemon;
    await insertScopeRecord({
      id: "scope-parent-pokemon",
      productDomain: "pokemon",
      scopeKind: "product-line",
      referenceRecordKey: contract.productLineReferenceRecordKey,
      name: "Pokemon Trading Card Game",
      officialSetCode: null,
    });
    await insertScopeRecord({
      id: "scope-leaf-pokemon",
      productDomain: "pokemon",
      scopeKind: "expansion",
      name: fact.setName,
      officialSetCode: null,
    });

    const baseProductLinePage = await tcgplayerFixtureOptionPage(
      queryInput(version, "product-lines", null),
      [version],
      factsByUnit,
    );
    const productLineItems = control.omitParent
      ? []
      : control.extraParent
        ? [
            ...baseProductLinePage.items,
            {
              ...baseProductLinePage.items[0]!,
              value: "synthetic-second-product-line",
              label: "Synthetic second product-line identity",
              metadata: { syntheticControl: true },
            },
          ]
        : baseProductLinePage.items;
    const { runtime, queryRequests } = buildRuntime({
      optionPagesByQueryKind: {},
      profileVersions: [version],
      cadenceConfig: [cadence("tcgplayer")],
      queryIntegrationOptions: async (query) =>
        query.queryKind === "product-lines"
          ? optionPage(productLineItems)
          : tcgplayerFixtureOptionPage(query, [version], factsByUnit),
    });

    const result = await runtime.runProviderRefreshNow({ providerKey: "tcgplayer", context: TEST_CONTEXT });

    expect(result.status).toBe("succeeded");
    expect(queryRequests.filter((query) => query.queryKind === "set-names")).toHaveLength(0);
    expect(result.mappingsProposed).toBe(0);
    expect(await runtime.listCanonicalScopeRecordProposals()).toEqual([]);
  });

  it("derives TCGplayer set-name coordinates from provider granularity and declared parent identity", async () => {
    const version = activeTcgplayerProfileVersions().find(
      (candidate) => candidate.profileKey === "pokemon-single-card-product-sku",
    )!;
    const target = listProviderScopeDiscoveryTargets([version], classifyProviderScopeDiscoveryTarget).find(
      (candidate) => candidate.queryKind === "set-names",
    )!;
    const [mappedOption] = await listCatalogProviderIntegrationOptionsFromProfiles({
      profiles: [version.profile],
      providerKey: "tcgplayer",
      queryKind: "set-names",
      languageCode: "en",
      parentValue: "3",
      defaultProviderKey: "tcgplayer",
      transports: {
        listTcgplayerSetNames: async () => tcgplayerAutomationResponseFixtures.catalogSetNames.results,
      },
    });
    const observation = observationRecord(target, mappedOption!, "coordinate-candidate");

    const candidate = providerScopeMappingCoordinates(target, observation);
    const positionalParentMutant = providerScopeMappingCoordinates({ ...target, parentScope: "series" }, observation);
    const combinedSetExpansionMutant = providerScopeMappingCoordinates(
      { ...target, providerScope: "expansion" },
      observation,
    );

    expect(candidate).toEqual({
      productLineId: "3",
      seriesId: null,
      setId: null,
      setName: "Prismatic Evolutions",
      language: null,
    });
    expect(positionalParentMutant).toEqual({
      productLineId: null,
      seriesId: "3",
      setId: null,
      setName: "Prismatic Evolutions",
      language: null,
    });
    expect(combinedSetExpansionMutant).toEqual({
      productLineId: "3",
      seriesId: null,
      setId: "Prismatic Evolutions",
      setName: null,
      language: null,
    });
    expect(positionalParentMutant).not.toEqual(candidate);
    expect(combinedSetExpansionMutant).not.toEqual(candidate);
  });

  it("derives TCGdex expansion coordinates without localized set name or discovery language", async () => {
    const version = catalogProviderIntegrationProfileVersions.find(
      (candidate) => candidate.providerKey === "tcgdex" && candidate.active,
    )!;
    const contract = version.executableMappingContract;
    if (!contract?.sourceObservation) {
      throw new Error("Missing executable TCGdex source-observation contract.");
    }
    const payload = JSON.parse(
      await readFile(path.resolve(repositoryRoot, contract.fixtures.fixtureRoot, "normal.json"), "utf8"),
    ) as JsonObject;
    const mapped = normalizeCatalogProviderSourceObservation({
      contract: contract as CatalogProviderSourceObservationMappingContract,
      payload,
      observedAt: "2026-08-27T00:00:00.000Z",
    });
    expect(mapped.diagnostics).toEqual([]);
    expect(mapped.observation).not.toBeNull();
    const fixtureSet = payload.set as JsonObject;
    const [mappedOption] = await listCatalogProviderIntegrationOptionsFromProfiles({
      profiles: [version.profile],
      providerKey: "tcgdex",
      queryKind: "expansions",
      languageCode: "en",
      parentValue: payload.seriesId as string,
      defaultProviderKey: "tcgdex",
      transports: {
        listTcgdexExpansions: async () => [
          {
            expansionId: fixtureSet.id,
            name: fixtureSet.name,
            seriesId: payload.seriesId,
          },
        ],
      },
    });
    const target = listProviderScopeDiscoveryTargets([version], classifyProviderScopeDiscoveryTarget).find(
      (candidate) => candidate.queryKind === "expansions",
    )!;
    const observation = observationRecord(target, mappedOption!, "tcgdex-coordinate-candidate");

    expect(providerScopeMappingCoordinates(target, observation)).toEqual({
      productLineId: null,
      seriesId: "sv",
      setId: "sv01",
      setName: null,
      language: null,
    });
  });

  it("classifies Pokemon set-name observations by the domain leaf kind and exposes the provider-vocabulary mutant", async () => {
    const version = activeTcgplayerProfileVersions().find(
      (candidate) => candidate.profileKey === "pokemon-single-card-product-sku",
    )!;
    const fact = (await loadTcgplayerFixtureFacts([version]))[0]!;
    const target = listProviderScopeDiscoveryTargets([version], classifyProviderScopeDiscoveryTarget).find(
      (candidate) => candidate.queryKind === "set-names",
    )!;
    const page = await tcgplayerFixtureOptionPage(
      queryInput(version, "set-names", String(fact.productLineId)),
      [version],
      new Map([[fact.unitKey, fact]]),
    );
    await insertScopeRecord({
      id: "scope-prismatic-evolutions",
      productDomain: "pokemon",
      scopeKind: "expansion",
      name: fact.setName,
      officialSetCode: null,
    });
    const observation = observationRecord(target, page.items[0]!, "domain-leaf-candidate");

    const candidate = await matchScopeObservationsToScopeRecords(pools.catalog, {
      target,
      observations: [observation],
      scanId: "scan-domain-leaf-candidate",
    });
    const providerVocabularyMutant = await matchScopeObservationsToScopeRecords(pools.catalog, {
      target: { ...target, scopeKind: "set" },
      observations: [{ ...observation, scopeKind: "set", observationHash: "provider-vocabulary-set-mutant" }],
      scanId: "scan-provider-vocabulary-set-mutant",
    });

    expect(target.scopeKind).toBe("expansion");
    expect(candidate).toEqual([
      expect.objectContaining({
        matchedBy: "normalized-name",
        candidate: expect.objectContaining({
          scopeRecordId: "scope-prismatic-evolutions",
          reviewStatus: "auto-accepted",
        }),
      }),
    ]);
    expect(providerVocabularyMutant).toEqual([
      expect.objectContaining({
        matchedBy: "new-canonical-scope",
        candidate: expect.objectContaining({ reviewStatus: "proposed" }),
      }),
    ]);
    expect(
      await pools.catalog.query<{ scope_kind: string }>(`SELECT scope_kind FROM catalog_scope_record_proposals`),
    ).toMatchObject({
      rows: [{ scope_kind: "set" }],
    });
  });

  it("isolates a TCGplayer cascade failure while another due provider succeeds", async () => {
    const tcgplayer = activeTcgplayerProfileVersions().find(
      (candidate) => candidate.profileKey === "pokemon-single-card-product-sku",
    )!;
    const tcgdex = catalogProviderIntegrationProfileVersions.find(
      (candidate) => candidate.providerKey === "tcgdex" && candidate.active,
    )!;
    const fact = (await loadTcgplayerFixtureFacts([tcgplayer]))[0]!;
    await insertScopeRecord({
      id: "scope-parent-pokemon",
      productDomain: "pokemon",
      scopeKind: "product-line",
      referenceRecordKey: catalogScopeProductDomainContracts.pokemon.productLineReferenceRecordKey,
      name: "Pokemon Trading Card Game",
      officialSetCode: null,
    });
    const { runtime } = buildRuntime({
      optionPagesByQueryKind: {},
      profileVersions: [tcgplayer, tcgdex],
      cadenceConfig: [cadence("tcgplayer"), cadence("tcgdex")],
      failQueryKinds: ["set-names"],
      queryIntegrationOptions: (query) =>
        query.providerKey === "tcgplayer"
          ? tcgplayerFixtureOptionPage(query, [tcgplayer], new Map([[fact.unitKey, fact]]))
          : Promise.resolve(optionPage([])),
    });

    const summary = await runtime.processScheduledRefresh({ context: TEST_CONTEXT });

    expect(summary.providersDue).toBe(2);
    expect(summary.failures).toBe(1);
    expect(summary.providers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ providerKey: "tcgplayer", status: "failed" }),
        expect.objectContaining({ providerKey: "tcgdex", status: "succeeded" }),
      ]),
    );
  });

  it("records observations and auto-accepts an exact set-code match without any manual pull", async () => {
    await insertScopeRecord({ id: "scope-paldean-fates", name: "Paldean Fates", officialSetCode: "PAF" });

    const { runtime } = buildRuntime({
      optionPagesByQueryKind: {
        expansions: [
          {
            value: "sv04.5",
            label: "Paldean Fates",
            parentValue: "sv",
            metadata: { abbreviation: "PAF" },
          },
        ],
      },
    });

    const summary = await runtime.processScheduledRefresh({ context: TEST_CONTEXT });

    expect(summary.providersDue).toBe(1);
    expect(summary.failures).toBe(0);
    expect(summary.observationsRecorded).toBeGreaterThan(0);
    expect(summary.mappingsProposed).toBe(1);

    const observations = await runtime.listScopeObservations({ providerKey: "tcgdex", scopeKind: "expansion" });
    expect(observations).toHaveLength(1);
    expect(observations[0]).toMatchObject({
      providerKey: "tcgdex",
      scopeKind: "expansion",
      sourceQueryKind: "expansions",
      externalId: "sv04.5",
      label: "Paldean Fates",
      parents: ["sv"],
      languageCode: "en",
    });
    expect(observations[0]!.unitKey).not.toBe("");
    expect(observations[0]!.observationHash).toMatch(/^[a-f0-9]{64}$/);

    const mappingEvents = await pools.catalog.query<{ event_type: string; payload: { reviewStatus: string } }>(
      `SELECT event_type, payload FROM event_store_events WHERE stream_id LIKE 'catalog.provider-scope-mapping-%'`,
    );
    expect(mappingEvents.rows).toHaveLength(1);
    expect(mappingEvents.rows[0]!.event_type).toBe("catalog.provider-scope-mapping.proposed");
    expect(mappingEvents.rows[0]!.payload.reviewStatus).toBe("auto-accepted");

    const refreshed = buildRuntime({
      optionPagesByQueryKind: {
        expansions: [
          {
            value: "sv04.5",
            label: "Paldean Fates",
            parentValue: "sv",
            metadata: { abbreviation: "PAF", providerRevision: 2 },
          },
        ],
      },
    });
    const refreshedResult = await refreshed.runtime.runProviderRefreshNow({
      providerKey: "tcgdex",
      context: TEST_CONTEXT,
    });
    expect(refreshedResult.mappingsProposed).toBe(0);

    const acceptedEventsAfterRefresh = await pools.catalog.query<{ event_type: string }>(
      `SELECT event_type FROM event_store_events WHERE stream_id LIKE 'catalog.provider-scope-mapping-%'`,
    );
    expect(acceptedEventsAfterRefresh.rows).toHaveLength(1);

    // A second sweep inside the cadence window claims nothing: the provider
    // is not due again and nothing is re-proposed.
    const secondSweep = await runtime.processScheduledRefresh({ context: TEST_CONTEXT });
    expect(secondSweep.providersDue).toBe(0);
    expect(secondSweep.mappingsProposed).toBe(0);
  });

  it("auto-accepts a unique normalized-name or accepted set-equivalent alias match", async () => {
    await insertScopeRecord({ id: "scope-name-match", name: "Journey Together", officialSetCode: null });
    await insertScopeRecord({ id: "scope-alias-match", name: "Scarlet & Violet—151", officialSetCode: null });
    await pools.catalog.query(
      `INSERT INTO catalog_reference_record_aliases (
         alias_hash, reference_record_id, type_key, alias_text, normalized_alias_text,
         alias_language_code, source_language_code, alias_type, confidence, review_status,
         provider_key, observation_id, source_category, source_profile_key, source_profile_version,
         mapping_fingerprint, evidence, last_actor, last_reason, policy_version
       ) VALUES (
         'alias-pokemon-151', 'scope-alias-match', 'expansion', 'Pokemon 151', 'pokemon 151',
         'en', NULL, 'set-equivalent', 'high', 'accepted',
         'tcgdex', NULL, 'provider-observation', 'pokemon-tcg', 'test',
         'fp-alias-151', '{}'::jsonb, 'user:test', 'verified', 'test-policy'
       )`,
    );

    const { runtime } = buildRuntime({
      optionPagesByQueryKind: {
        expansions: [
          { value: "journey-together", label: "Journey Together" },
          { value: "sv03.5", label: "Pokémon 151" },
        ],
      },
    });
    const result = await runtime.runProviderRefreshNow({ providerKey: "tcgdex", context: TEST_CONTEXT });

    expect(result.mappingsProposed).toBe(2);
    const events = await pools.catalog.query<{ payload: { reviewStatus: string; evidence: { matchedBy: string } } }>(
      `SELECT payload FROM event_store_events
       WHERE stream_id LIKE 'catalog.provider-scope-mapping-%'
       ORDER BY payload->'evidence'->>'matchedBy' ASC`,
    );
    expect(events.rows.map((row) => row.payload.reviewStatus)).toEqual(["auto-accepted", "auto-accepted"]);
    expect(events.rows.map((row) => row.payload.evidence.matchedBy).sort()).toEqual([
      "accepted-alias",
      "normalized-name",
    ]);
  });

  it("uses release-date proximity only to propose a tiebreaker for ambiguous exact names", async () => {
    await insertScopeRecord({
      id: "scope-legacy-base-set",
      name: "Base Set",
      officialSetCode: null,
      releaseDate: "1999-01-09",
    });
    await insertScopeRecord({
      id: "scope-modern-base-set",
      name: "Base Set",
      officialSetCode: null,
      releaseDate: "2025-01-01",
    });

    const { runtime } = buildRuntime({
      optionPagesByQueryKind: {
        expansions: [{ value: "base", label: "Base Set", metadata: { releaseDate: "1999-01-10" } }],
      },
    });
    const result = await runtime.runProviderRefreshNow({ providerKey: "tcgdex", context: TEST_CONTEXT });

    expect(result.mappingsProposed).toBe(1);
    const event = await pools.catalog.query<{
      payload: { scopeRecordId: string; reviewStatus: string; evidence: { matchedBy: string } };
    }>(`SELECT payload FROM event_store_events WHERE stream_id LIKE 'catalog.provider-scope-mapping-%'`);
    expect(event.rows[0]!.payload).toMatchObject({
      scopeRecordId: "scope-legacy-base-set",
      reviewStatus: "proposed",
      evidence: { matchedBy: "release-date-proximity" },
    });
  });

  it("proposes one new canonical set and mappings from every provider unit that offers it", async () => {
    const cadenceConfig: readonly ProviderRefreshCadenceConfig[] = [
      {
        providerKey: "lorcanajson",
        scheduleEnabled: false,
        manualOnly: true,
        creditAware: false,
        intervalMs: 24 * HOUR_MS,
        reason: "test",
      },
      {
        providerKey: "lorcast",
        scheduleEnabled: false,
        manualOnly: true,
        creditAware: false,
        intervalMs: 24 * HOUR_MS,
        reason: "test",
      },
    ];
    const { runtime } = buildRuntime({
      optionPagesByQueryKind: {},
      optionPagesByProviderQueryKind: {
        "lorcanajson:sets": [
          { value: "FBL", label: "Fabled", metadata: { setCode: "FBL", releaseDate: "2026-08-01" } },
        ],
        "lorcast:sets": [{ value: "fabled", label: "Fabled", metadata: { setCode: "FBL", releaseDate: "2026-08-01" } }],
      },
      profileProviderKeys: ["lorcanajson", "lorcast"],
      cadenceConfig,
    });

    await runtime.runProviderRefreshNow({ providerKey: "lorcanajson", context: TEST_CONTEXT });
    await runtime.runProviderRefreshNow({ providerKey: "lorcast", context: TEST_CONTEXT });

    const proposals = await runtime.listCanonicalScopeRecordProposals({ productDomain: "lorcana" });
    expect(proposals).toHaveLength(1);
    expect(proposals[0]).toMatchObject({
      name: "Fabled",
      officialSetCode: "FBL",
      reviewStatus: "proposed",
      scopeKind: "set",
    });

    const mappingEvents = await pools.catalog.query<{
      payload: { providerKey: string; unitKey: string; reviewStatus: string; scopeRecordId: string };
    }>(`SELECT payload FROM event_store_events WHERE stream_id LIKE 'catalog.provider-scope-mapping-%'`);
    expect(new Set(mappingEvents.rows.map((row) => row.payload.providerKey))).toEqual(
      new Set(["lorcanajson", "lorcast"]),
    );
    expect(mappingEvents.rows.every((row) => row.payload.unitKey.length > 0)).toBe(true);
    expect(mappingEvents.rows.every((row) => row.payload.reviewStatus === "proposed")).toBe(true);
    expect(mappingEvents.rows.every((row) => row.payload.scopeRecordId === proposals[0]!.scopeRecordId)).toBe(true);
  });

  it("does not resurrect a rejected proposal when changed evidence is observed again", async () => {
    const first = buildRuntime({
      optionPagesByQueryKind: {
        expansions: [{ value: "new-set", label: "A New Set", metadata: { providerRevision: 1 } }],
      },
    });
    await first.runtime.runProviderRefreshNow({ providerKey: "tcgdex", context: TEST_CONTEXT });

    const proposed = await pools.catalog.query<{ stream_id: string }>(
      `SELECT stream_id FROM event_store_events WHERE stream_id LIKE 'catalog.provider-scope-mapping-%'`,
    );
    const streamId = proposed.rows[0]!.stream_id;
    await first.providerScopeMappings.commandHandler({
      streamId,
      command: { type: "RejectProviderScopeMapping", actor: "user:test", reason: "wrong provider set" },
      context: TEST_CONTEXT,
    });

    const second = buildRuntime({
      optionPagesByQueryKind: {
        expansions: [{ value: "new-set", label: "A New Set", metadata: { providerRevision: 2 } }],
      },
    });
    const rerun = await second.runtime.runProviderRefreshNow({ providerKey: "tcgdex", context: TEST_CONTEXT });
    expect(rerun.mappingsProposed).toBe(0);

    const events = await pools.catalog.query<{ event_type: string }>(
      `SELECT event_type FROM event_store_events WHERE stream_id = $1 ORDER BY stream_version ASC`,
      [streamId],
    );
    expect(events.rows.map((row) => row.event_type)).toEqual([
      "catalog.provider-scope-mapping.proposed",
      "catalog.provider-scope-mapping.rejected",
    ]);
    expect(await second.runtime.listCanonicalScopeRecordProposals()).toHaveLength(1);
  });

  it("never claims manual-only credit-consuming providers and honors operator pause", async () => {
    const { runtime, queryCalls } = buildRuntime({ optionPagesByQueryKind: {} });

    const schedules = await runtime.listRefreshSchedules();
    expect(schedules.map((schedule) => schedule.providerKey).sort()).toEqual(["scrydex", "tcgdex"]);

    await runtime.setRefreshPaused({ providerKey: "tcgdex", paused: true, actor: "user:test", reason: "hold" });
    const summary = await runtime.processScheduledRefresh({ context: TEST_CONTEXT });

    expect(summary.providersDue).toBe(0);
    expect(queryCalls).toHaveLength(0);

    const paused = (await runtime.listRefreshSchedules()).find((schedule) => schedule.providerKey === "tcgdex");
    expect(paused?.paused).toBe(true);
    expect(paused?.pausedBy).toBe("user:test");

    // Resuming makes the provider claimable again; scrydex stays excluded.
    await runtime.setRefreshPaused({ providerKey: "tcgdex", paused: false, actor: "user:test" });
    const resumed = await runtime.processScheduledRefresh({ context: TEST_CONTEXT });
    expect(resumed.providers.map((provider) => provider.providerKey)).toEqual(["tcgdex"]);
    expect(queryCalls.every((call) => call.startsWith("tcgdex:"))).toBe(true);
  });

  it("records a failed run on the schedule so the scheduled-alerting watch can see it", async () => {
    const { runtime } = buildRuntime({
      optionPagesByQueryKind: {},
      failQueryKinds: ["languages", "series", "expansions"],
    });

    const summary = await runtime.processScheduledRefresh({ context: TEST_CONTEXT });

    expect(summary.failures).toBe(1);
    expect(summary.providers[0]).toMatchObject({ providerKey: "tcgdex", status: "failed" });

    const schedule = (await runtime.listRefreshSchedules()).find((entry) => entry.providerKey === "tcgdex");
    expect(schedule?.lastRunStatus).toBe("failed");
    expect(schedule?.lastRunError).toContain("provider transport unavailable");
  });

  it("supports an explicit manual run for manual-only providers", async () => {
    const { runtime } = buildRuntime({ optionPagesByQueryKind: {} });

    // Scrydex has no targets in this fixture (profiles are filtered to
    // tcgdex), so a manual run reports skipped-no-targets rather than
    // silently doing nothing.
    const result = await runtime.runProviderRefreshNow({ providerKey: "scrydex", context: TEST_CONTEXT });

    expect(result.status).toBe("skipped-no-targets");
    const schedule = (await runtime.listRefreshSchedules()).find((entry) => entry.providerKey === "scrydex");
    expect(schedule?.lastRunStatus).toBe("skipped-no-targets");
    expect(schedule?.lastRunTriggeredBy).toBe("manual");
  });
});

function optionPage(items: CatalogProviderOptionQueryPage["items"]): CatalogProviderOptionQueryPage {
  return {
    items,
    total: items.length,
    count: items.length,
    page: { cursor: null, nextCursor: null, limit: items.length, hasMore: false },
    cache: {
      status: "bypass",
      source: "live",
      cacheKey: "test",
      fetchedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      staleUntil: new Date(Date.now() + 120_000).toISOString(),
      cacheOnly: false,
      forceRefresh: true,
      degraded: false,
      diagnostics: [],
    } as CatalogProviderOptionQueryPage["cache"],
  };
}

type TcgplayerFixtureFact = Readonly<{
  unitKey: string;
  productDomain: CatalogScopeProductDomain;
  productLineId: number;
  productLineName: string;
  setName: string;
}>;

function activeTcgplayerProfileVersions(): readonly CatalogProviderIntegrationProfileVersionRecord[] {
  return catalogProviderIntegrationProfileVersions.filter(
    (version) => version.providerKey === "tcgplayer" && version.active && version.lifecycle === "active",
  );
}

async function loadTcgplayerFixtureFacts(
  versions: readonly CatalogProviderIntegrationProfileVersionRecord[],
): Promise<readonly TcgplayerFixtureFact[]> {
  return Promise.all(
    versions.map(async (version) => {
      const contract = version.executableMappingContract;
      if (!contract?.sourceObservation) {
        throw new Error(`Missing executable TCGplayer source-observation contract for ${version.profileKey}.`);
      }
      const payload = JSON.parse(
        await readFile(path.resolve(repositoryRoot, contract.fixtures.fixtureRoot, "normal.json"), "utf8"),
      ) as JsonObject;
      const mapped = normalizeCatalogProviderSourceObservation({
        contract: contract as CatalogProviderSourceObservationMappingContract,
        payload: payload as JsonValue,
        observedAt: "2026-08-27T00:00:00.000Z",
      });
      if (!mapped.observation || mapped.diagnostics.length > 0) {
        throw new Error(`Executable TCGplayer fixture mapper rejected ${version.profileKey}.`);
      }
      const target = listProviderScopeDiscoveryTargets([version], classifyProviderScopeDiscoveryTarget).find(
        (candidate) => candidate.queryKind === "set-names",
      );
      const normalized = mapped.observation.normalized as unknown as Record<string, unknown>;
      const productLineId = payload.productLineId;
      const productLineName = normalized.productLineName;
      const setName = normalized.setName;
      if (
        !target?.productDomain ||
        (typeof productLineId !== "number" && typeof productLineId !== "string") ||
        !Number.isInteger(Number(productLineId)) ||
        typeof productLineName !== "string" ||
        typeof setName !== "string"
      ) {
        throw new Error(`Checked TCGplayer fixture lacks cascade facts for ${version.profileKey}.`);
      }
      return {
        unitKey: catalogProviderProfileVersionIngestionUnitKey(version),
        productDomain: target.productDomain,
        productLineId: Number(productLineId),
        productLineName,
        setName,
      };
    }),
  );
}

async function tcgplayerFixtureOptionPage(
  query: Parameters<ProviderScopeDiscoveryPorts["queryIntegrationOptions"]>[0],
  versions: readonly CatalogProviderIntegrationProfileVersionRecord[],
  factsByUnit: ReadonlyMap<string, TcgplayerFixtureFact>,
): Promise<CatalogProviderOptionQueryPage> {
  const unitKey = query.ingestionUnitKey ?? "";
  const version = versions.find((candidate) => catalogProviderProfileVersionIngestionUnitKey(candidate) === unitKey);
  const fact = factsByUnit.get(unitKey);
  if (!version || !fact) {
    throw new Error(`No checked TCGplayer fixture facts for '${unitKey}'.`);
  }
  const items = await listCatalogProviderIntegrationOptionsFromProfiles({
    profiles: [version.profile],
    providerKey: "tcgplayer",
    queryKind: query.queryKind,
    languageCode: query.languageCode,
    parentValue: query.parentValue,
    defaultProviderKey: "tcgplayer",
    transports: {
      listTcgplayerProductLines: async () => [
        {
          productLineId: fact.productLineId,
          productLineName: fact.productLineName,
          productLineUrlName: null,
          isDirect: true,
        },
      ],
      listTcgplayerSetNames: async () => [
        {
          name: fact.setName,
          cleanSetName: fact.setName,
          categoryId: fact.productLineId,
          active: true,
        },
      ],
    },
  });
  return optionPage(items);
}

function queryInput(
  version: CatalogProviderIntegrationProfileVersionRecord,
  queryKind: string,
  parentValue: string | null,
): Parameters<ProviderScopeDiscoveryPorts["queryIntegrationOptions"]>[0] {
  return {
    providerKey: version.providerKey,
    profileKey: version.profileKey,
    ingestionUnitKey: catalogProviderProfileVersionIngestionUnitKey(version),
    queryKind,
    languageCode: "en",
    parentValue,
  };
}

function observationRecord(
  target: ProviderScopeDiscoveryTarget,
  item: CatalogProviderOptionQueryPage["items"][number],
  observationHash: string,
): ProviderScopeObservationRecord {
  return {
    providerKey: target.providerKey,
    unitKey: target.ingestionUnitKey,
    scopeKind: target.scopeKind,
    sourceQueryKind: target.queryKind,
    languageCode: target.languageCode,
    externalId: item.value,
    label: item.label,
    parents: item.parentValue ? [item.parentValue] : [],
    imageUrl: item.imageUrl,
    metadata: item.metadata,
    scanId: `scan-${observationHash}`,
    scannedAt: "2026-08-27T00:00:00.000Z",
    firstObservedAt: "2026-08-27T00:00:00.000Z",
    observationHash,
    newlyObserved: true,
    changed: true,
  };
}

function cadence(providerKey: string): ProviderRefreshCadenceConfig {
  return {
    providerKey,
    scheduleEnabled: true,
    manualOnly: false,
    creditAware: false,
    intervalMs: 6 * HOUR_MS,
    reason: "test",
  };
}
