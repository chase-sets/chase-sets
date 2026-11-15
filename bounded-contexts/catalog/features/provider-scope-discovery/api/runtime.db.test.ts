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
import { bootstrapContextDatabase, drainLocalProjectionHandlerSets } from "@chase-sets/bounded-context-runtime";
import { createPostgresEventStore, createPostgresProjectionStore } from "@chase-sets/event-core-postgres";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import type { JsonObject } from "@chase-sets/primitives/json";
import { module as catalogModule } from "../../../index";
import type { ReferenceRecordId } from "../../../ids";
import { createCatalogServices } from "../../../support/authoring-support/services";
import { localizedTextMapFromEnglish } from "../../../support/runtime-support/common";
import { createProviderScopeMappingRuntime } from "../../provider-scope-mapping/api/runtime";
import { providerScopeMappingStreamId } from "../../provider-scope-mapping/domain/domain";
import { createReferenceDataRuntime } from "../../reference-data/api/runtime";
import { ProviderAdapterRegistry } from "../../source-observations/api/provider-adapters/registry";
import { queryProviderIntegrationOptions } from "../../source-observations/api/providers/provider-option-queries";
import { createTcgdexProviderAdapter } from "../../source-observations/api/providers/tcgdex/adapter";
import { createYgojsonProviderAdapter } from "../../source-observations/api/providers/ygojson/adapter";
import { createYgoprodeckProviderAdapter } from "../../source-observations/api/providers/ygoprodeck/adapter";
import {
  catalogProviderIntegrationProfileVersions,
  catalogProviderProfileVersionIngestionUnitKey,
  type CatalogProviderIntegrationProfileVersionRecord,
} from "../../source-observations/api/provider-integration-profiles";
import type { CatalogProviderOptionQueryPage } from "../../source-observations/api/provider-option-query-cache";
import { listCatalogProviderIntegrationOptionsFromProfiles } from "../../source-observations/api/providers/provider-option-query-resolver";
import type { CatalogProviderSourceObservationMappingContract } from "../../source-observations/api/promotion/provider-source-observation-normalizer";
import { normalizeCatalogProviderSourceObservation } from "../../source-observations/api/promotion/provider-source-observation-normalizer";
import {
  catalogScopeProductDomainContracts,
  type CatalogScopeProductDomain,
  type CatalogScopeRecordKind,
} from "../../scope-registry/domain/contract";
import { listProviderScopeDiscoveryTargets, type ProviderScopeDiscoveryTarget } from "./discovery-targets";
import { acceptedReferenceRecordIdForProposal } from "./proposal-acceptance";
import { createProviderScopeDiscoveryRuntime, type ProviderScopeDiscoveryPorts } from "./runtime";
import type { ProviderRefreshCadenceConfig } from "./provider-refresh-cadence";
import {
  classifyProviderScopeDiscoveryTarget,
  matchScopeObservationsToScopeRecords,
  providerScopeMappingCoordinates,
} from "./scope-observation-matcher";
import type { ProviderScopeObservationRecord } from "./refresh-schedule-store";
import { getCanonicalScopeRecordProposal } from "./scope-record-proposal-store";

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
    optionPagesByLanguageQueryKind?: Readonly<
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
          // Unkeyed scripted pages are the provider's English options; another
          // discovery language lists only what is scripted for it.
          const items =
            query.languageCode !== "en"
              ? (input.optionPagesByLanguageQueryKind?.[`${query.languageCode}:${query.queryKind}`] ?? [])
              : (input.optionPagesByProviderQueryKind?.[`${query.providerKey}:${query.queryKind}`] ??
                input.optionPagesByQueryKind[query.queryKind] ??
                []);
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
        referenceRecordCommandHandler: createReferenceDataRuntime(deps).referenceRecordCommandHandler,
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
    languageEditions?: readonly string[];
  }) {
    const productDomain = input.productDomain ?? "pokemon";
    const scopeKind = input.scopeKind ?? "expansion";
    await pools.catalog.query(
      `INSERT INTO catalog_scope_records (
         scope_record_id, product_domain, scope_kind, reference_type_key,
         reference_record_id, reference_record_key, name, lifecycle_status, official_set_code, release_date,
         language_editions
       )
       VALUES ($1, $2, $3, $3, $1, $7, $4, 'active', $5, $6::date, $8::jsonb)`,
      [
        input.id,
        productDomain,
        scopeKind,
        input.name,
        input.officialSetCode,
        input.releaseDate ?? null,
        input.referenceRecordKey ?? input.id,
        JSON.stringify(input.languageEditions ?? []),
      ],
    );
  }

  it("derives TCGdex expansion coordinates with the discovery language and without a localized set name", async () => {
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
      language: { languageCode: "en" },
    });
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

  describe("Japanese TCGdex discovery", () => {
    async function recordedJapaneseSets(ids: readonly string[]): Promise<readonly JsonObject[]> {
      const sets = (await fixture("tcgdex/ja-sets.json")) as unknown as readonly JsonObject[];
      return ids.map((id) => sets.find((set) => set.id === id)!);
    }

    // The real TCGdex profile and adapter, serving the recorded /v2/ja/sets
    // entries; English lists nothing and localized options have no English mirror.
    function tcgdexRuntime(japaneseSets: readonly JsonObject[]) {
      const tcgdex = catalogProviderIntegrationProfileVersions.find(
        (version) => version.providerKey === "tcgdex" && version.active && version.lifecycle === "active",
      )!;
      const fetch = (async (url: RequestInfo | URL) => {
        const { pathname } = new URL(String(url));
        if (pathname === "/v2/ja/sets") {
          return new Response(JSON.stringify(japaneseSets));
        }
        if (/^\/v2\/(en|ja)\/(sets|series)$/.test(pathname)) {
          return new Response("[]");
        }
        if (/^\/v2\/en\/(sets|series)\/[^/]+$/.test(pathname)) {
          return new Response("Not Found", { status: 404 });
        }
        throw new Error(`Unexpected provider request in test: ${pathname}`);
      }) as typeof globalThis.fetch;
      const registry = new ProviderAdapterRegistry([
        createTcgdexProviderAdapter({ loadActiveProfileVersion: async () => tcgdex, fetch }),
      ]);
      return buildRuntime({
        optionPagesByQueryKind: {},
        queryIntegrationOptions: (query) =>
          queryProviderIntegrationOptions(query, pools.catalog, null, undefined, registry),
      }).runtime;
    }

    async function mappingProposals() {
      const result = await pools.catalog.query<{ payload: JsonObject }>(
        `SELECT payload FROM event_store_events
         WHERE event_type = 'catalog.provider-scope-mapping.proposed'
         ORDER BY payload->>'scopeRecordId' ASC`,
      );
      return result.rows.map((row) => row.payload);
    }

    it("proposes a Japanese expansion as its own edition instead of matching the English record of its id", async () => {
      await insertScopeRecord({
        id: "scope-flashfire",
        name: "Flashfire",
        officialSetCode: "FLF",
        referenceRecordKey: "xy2",
        languageEditions: ["en"],
      });
      const runtime = tcgdexRuntime(await recordedJapaneseSets(["XY2"]));

      expect((await runtime.runProviderRefreshNow({ providerKey: "tcgdex", context: TEST_CONTEXT })).status).toBe(
        "succeeded",
      );

      expect(await runtime.listScopeObservations({ providerKey: "tcgdex", scopeKind: "expansion" })).toEqual([
        expect.objectContaining({ languageCode: "ja", externalId: "XY2", label: "ワイルドブレイズ" }),
      ]);
      const proposals = await runtime.listCanonicalScopeRecordProposals({ productDomain: "pokemon" });
      expect(proposals).toEqual([
        expect.objectContaining({
          name: "ワイルドブレイズ",
          officialSetCode: "XY2",
          languageEditions: ["ja"],
          reviewStatus: "proposed",
        }),
      ]);
      expect(await mappingProposals()).toEqual([
        expect.objectContaining({
          scopeRecordId: proposals[0]!.scopeRecordId,
          reviewStatus: "proposed",
          coordinates: expect.objectContaining({
            setId: "XY2",
            language: expect.objectContaining({ languageCode: "ja" }),
          }),
        }),
      ]);
    });

    it("auto-accepts a Japanese expansion onto the Japanese record of its code and never by its name", async () => {
      const [wildBlaze, supercharged] = await recordedJapaneseSets(["XY2", "SV8"]);
      await insertScopeRecord({
        id: "scope-sv8-ja",
        name: String(supercharged!.name),
        officialSetCode: "SV8",
        referenceRecordKey: "sv8-ja",
        languageEditions: ["ja"],
      });
      const runtime = tcgdexRuntime([wildBlaze!, supercharged!]);

      expect((await runtime.runProviderRefreshNow({ providerKey: "tcgdex", context: TEST_CONTEXT })).status).toBe(
        "succeeded",
      );

      const proposals = await runtime.listCanonicalScopeRecordProposals({ productDomain: "pokemon" });
      expect(proposals).toEqual([
        expect.objectContaining({ name: "ワイルドブレイズ", officialSetCode: "XY2", languageEditions: ["ja"] }),
      ]);
      const mappings = await mappingProposals();
      expect(mappings).toEqual([
        expect.objectContaining({ scopeRecordId: proposals[0]!.scopeRecordId, reviewStatus: "proposed" }),
        expect.objectContaining({ scopeRecordId: "scope-sv8-ja", reviewStatus: "auto-accepted" }),
      ]);
      expect(mappings[1]).toMatchObject({
        coordinates: {
          productLineId: null,
          seriesId: null,
          setId: "SV8",
          setName: null,
          language: { languageCode: "ja" },
        },
        evidence: { externalId: "SV8", languageCode: "ja", matchedBy: "exact-id-or-code" },
      });
    });

    it("keeps the English mapping ids, review statuses and match methods beside Japanese discovery", async () => {
      await insertScopeRecord({ id: "scope-paldean-fates", name: "Paldean Fates", officialSetCode: "PAF" });
      await insertScopeRecord({
        id: "scope-name-match",
        name: "Journey Together",
        officialSetCode: null,
        languageEditions: ["en"],
      });
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
      const [wildBlaze] = await recordedJapaneseSets(["XY2"]);
      const { runtime } = buildRuntime({
        optionPagesByQueryKind: {
          expansions: [
            { value: "sv04.5", label: "Paldean Fates", parentValue: "sv", metadata: { abbreviation: "PAF" } },
            { value: "journey-together", label: "Journey Together" },
            { value: "sv03.5", label: "Pokémon 151" },
          ],
        },
        optionPagesByLanguageQueryKind: {
          "ja:expansions": [{ value: String(wildBlaze!.id), label: String(wildBlaze!.name) }],
        },
      });

      await runtime.runProviderRefreshNow({ providerKey: "tcgdex", context: TEST_CONTEXT });

      const english = (await mappingProposals()).filter((payload) =>
        String(payload.scopeRecordId).startsWith("scope-"),
      );
      expect(
        english.map((payload) => [
          payload.mappingId,
          payload.scopeRecordId,
          payload.reviewStatus,
          (payload.evidence as JsonObject).matchedBy,
        ]),
      ).toEqual([
        [
          "ee971478a95ed88007ea4b8fea117743b6c12503ab8072a19decd8cc290068a3",
          "scope-alias-match",
          "auto-accepted",
          "accepted-alias",
        ],
        [
          "4aab3037210f88775be127fa05f605fcc9d0e174ab60ffc8035749a43b969f15",
          "scope-name-match",
          "auto-accepted",
          "normalized-name",
        ],
        [
          "12cfb43bf88a5673f7a4c7e7cdddb20be109e8dfc230f34fca1f93888b08bc72",
          "scope-paldean-fates",
          "auto-accepted",
          "exact-id-or-code",
        ],
      ]);
      expect(await runtime.listCanonicalScopeRecordProposals({ productDomain: "pokemon" })).toEqual([
        expect.objectContaining({ officialSetCode: "XY2", languageEditions: ["ja"] }),
      ]);
    });
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

  it("adds the accepted Scope Record column over a deployed proposal table and keeps its proposals unaccepted", async () => {
    await pools.catalog.query(`ALTER TABLE catalog_scope_record_proposals DROP COLUMN accepted_scope_record_id;

INSERT INTO catalog_scope_record_proposals (
  proposal_id, scope_record_id, product_domain, scope_kind, name, normalized_name
) VALUES ('deployed-proposal', 'proposed-scope-deployed-proposal', 'yugioh', 'set', 'Starter Deck: Yugi', 'starter deck yugi');`);

    await bootstrapContextDatabase(catalogModule, pools.catalog);

    expect(await getCanonicalScopeRecordProposal(pools.catalog, "deployed-proposal")).toMatchObject({
      scopeRecordId: "proposed-scope-deployed-proposal",
      reviewStatus: "proposed",
      acceptedScopeRecordId: null,
    });
  });

  describe("accepted canonical proposals", () => {
    const YGOPRODECK_UNIT = "ygoprodeck:yugioh:single-card:reference-data";
    const YGOJSON_UNIT = "ygojson:yugioh:set:reference-data";
    const PRODUCT_LINE_ID = "ref_test_yugioh_product_line";
    const LOB_YGOPRODECK_ROW = {
      set_name: "Legend of Blue Eyes White Dragon",
      set_code: "LOB",
      num_of_cards: 126,
      tcg_date: "2002-03-08",
    };
    const createRequest = {
      mode: "create",
      parentScopeRecordId: null,
      releaseDate: null,
      officialSetCode: null,
    } as const;

    beforeEach(async () => {
      await bootstrapContextDatabase(catalogModule, pools.catalog);
    });

    async function yugiohHarness() {
      const services = createCatalogServices(pools.catalog);
      const deps = {
        eventStore: createPostgresEventStore({ pool: pools.catalog }),
        checkpointStore: createPostgresProjectionStore({ db: pools.catalog }),
        db: pools.catalog,
      } as const;
      const sets: Record<"ygoprodeck" | "ygojson", readonly unknown[]> = { ygoprodeck: [], ygojson: [] };
      const fetch = (async (url: RequestInfo | URL) => {
        const href = String(url);
        if (href.endsWith("/cardsets.php")) {
          return new Response(JSON.stringify(sets.ygoprodeck));
        }
        if (href.endsWith("/aggregate/sets.json")) {
          return new Response(JSON.stringify(sets.ygojson));
        }
        throw new Error(`Unexpected provider request in test: ${href}`);
      }) as typeof globalThis.fetch;
      const registry = new ProviderAdapterRegistry([
        createYgoprodeckProviderAdapter({ fetch }),
        createYgojsonProviderAdapter({ fetch }),
      ]);
      const crashes: string[] = [];
      const runtime = createProviderScopeDiscoveryRuntime(
        deps,
        {
          listProfileVersions: async () =>
            catalogProviderIntegrationProfileVersions.filter((version) =>
              ["ygoprodeck", "ygojson"].includes(version.providerKey),
            ),
          queryIntegrationOptions: (query) =>
            queryProviderIntegrationOptions(query, pools.catalog, null, undefined, registry),
          providerScopeMappingCommandHandler: async (input) => {
            const crash = crashes.indexOf(input.command.type);
            if (crash >= 0) {
              crashes.splice(crash, 1);
              throw new Error(`Injected crash before ${input.command.type}.`);
            }
            return services.providerScopeMappings.commandHandler(input);
          },
          referenceRecordCommandHandler: services.referenceData.referenceRecordCommandHandler,
        },
        [cadence("ygoprodeck"), cadence("ygojson")],
      );
      const drain = () => drainLocalProjectionHandlerSets("catalog", pools.catalog, services.projectors);

      const streamId = `catalog.reference-record-${PRODUCT_LINE_ID}`;
      await services.referenceData.referenceRecordCommandHandler({
        streamId,
        command: {
          type: "CreateReferenceRecord",
          referenceRecordId: PRODUCT_LINE_ID as ReferenceRecordId,
          typeKey: "product-line",
          key: "yu-gi-oh-official-card-game",
          name: localizedTextMapFromEnglish("Yu-Gi-Oh! Official Card Game"),
        },
        context: TEST_CONTEXT,
      });
      await services.referenceData.referenceRecordCommandHandler({
        streamId,
        command: { type: "PublishReferenceRecord" },
        context: TEST_CONTEXT,
      });
      await drain();

      return {
        services,
        runtime,
        drain,
        crashes,
        async refresh(providerKey: "ygoprodeck" | "ygojson", next: readonly unknown[]) {
          sets[providerKey] = next;
          const result = await runtime.runProviderRefreshNow({ providerKey, context: TEST_CONTEXT });
          expect(result.status).toBe("succeeded");
        },
        accept(proposalId: string) {
          return runtime.acceptCanonicalScopeRecordProposal({
            proposalId,
            request: createRequest,
            actor: "user:operator",
            context: TEST_CONTEXT,
          });
        },
        review(streamId: string, type: "AcceptProviderScopeMapping" | "RejectProviderScopeMapping") {
          return services.providerScopeMappings.commandHandler({
            streamId,
            command:
              type === "AcceptProviderScopeMapping"
                ? { type, actor: "user:operator" }
                : { type, actor: "user:operator", reason: "Wrong provider set." },
            context: TEST_CONTEXT,
          });
        },
      };
    }

    function mappingStream(scopeRecordId: string, providerKey: string, unitKey: string): string {
      return providerScopeMappingStreamId({ scopeRecordId, providerKey, unitKey });
    }

    async function mappingEvents(streamId: string) {
      const result = await pools.catalog.query<{ event_type: string; payload: JsonObject }>(
        "SELECT event_type, payload FROM event_store_events WHERE stream_id = $1 ORDER BY stream_version ASC",
        [streamId],
      );
      return result.rows;
    }

    async function proposedScopeMappingProposals(): Promise<number> {
      const result = await pools.catalog.query<{ count: string }>(
        `SELECT count(*)::text AS count
         FROM event_store_events
         WHERE event_type = 'catalog.provider-scope-mapping.proposed'
           AND payload->>'scopeRecordId' LIKE 'proposed-scope-%'`,
      );
      return Number(result.rows[0]!.count);
    }

    it("re-points the proposal's mappings onto the accepted Scope Record and maps a changed observation there", async () => {
      const harness = await yugiohHarness();
      const sdy = (await fixture("ygoprodeck-yugioh-set-reference/normal.json")).set;
      await harness.refresh("ygoprodeck", [sdy, LOB_YGOPRODECK_ROW]);
      await harness.refresh("ygojson", [(await fixture("ygojson-yugioh-set-reference-data/normal.json")).set]);
      const proposals = await harness.runtime.listCanonicalScopeRecordProposals({ productDomain: "yugioh" });
      expect(proposals).toHaveLength(2);
      const sdyProposal = proposals.find((proposal) => proposal.officialSetCode === "SDY")!;
      const lobProposal = proposals.find((proposal) => proposal.officialSetCode === "LOB")!;
      const sdySource = mappingStream(sdyProposal.scopeRecordId, "ygoprodeck", YGOPRODECK_UNIT);
      const lobSource = mappingStream(lobProposal.scopeRecordId, "ygoprodeck", YGOPRODECK_UNIT);
      const lobRejected = mappingStream(lobProposal.scopeRecordId, "ygojson", YGOJSON_UNIT);
      expect(await mappingEvents(lobRejected)).toHaveLength(1);
      await harness.review(sdySource, "AcceptProviderScopeMapping");
      await harness.review(lobRejected, "RejectProviderScopeMapping");
      // The YGOJSON mapping reached the LOB proposal by a name match, not in the
      // proposal's evidence, so the re-point finds it through the mapping read model.
      await harness.drain();
      const sdyProposed = (await mappingEvents(sdySource))[0]!.payload;
      const lobProposed = (await mappingEvents(lobSource))[0]!.payload;

      const sdyAccepted = await harness.accept(sdyProposal.proposalId);
      const lobAccepted = await harness.accept(lobProposal.proposalId);

      const sdyId = acceptedReferenceRecordIdForProposal(sdyProposal.proposalId);
      const lobId = acceptedReferenceRecordIdForProposal(lobProposal.proposalId);
      expect(sdyAccepted).toMatchObject({
        ok: true,
        acceptance: { mappings: { repointed: [{ providerKey: "ygoprodeck", retiredAs: "revoked" }], conflicts: [] } },
      });
      expect(lobAccepted).toMatchObject({
        ok: true,
        acceptance: {
          mappings: {
            repointed: [{ providerKey: "ygoprodeck", retiredAs: "rejected", targetAlreadyPresent: false }],
            conflicts: [],
            retained: [{ providerKey: "ygojson", unitKey: YGOJSON_UNIT, reviewStatus: "rejected" }],
          },
        },
      });
      for (const [target, proposed] of [
        [mappingStream(sdyId, "ygoprodeck", YGOPRODECK_UNIT), sdyProposed],
        [mappingStream(lobId, "ygoprodeck", YGOPRODECK_UNIT), lobProposed],
      ] as const) {
        const repointed = await mappingEvents(target);
        expect(repointed).toHaveLength(1);
        expect(repointed[0]!.payload).toMatchObject({
          reviewStatus: "proposed",
          coordinates: proposed.coordinates as JsonObject,
          provenance: proposed.provenance as JsonObject,
        });
      }
      const sdyRetired = await mappingEvents(sdySource);
      expect(sdyRetired.map((event) => event.event_type)).toEqual([
        "catalog.provider-scope-mapping.proposed",
        "catalog.provider-scope-mapping.accepted",
        "catalog.provider-scope-mapping.revoked",
      ]);
      expect(sdyRetired[2]!.payload.reason).toContain(sdyId);
      const lobRetired = await mappingEvents(lobSource);
      expect(lobRetired.map((event) => event.event_type)).toEqual([
        "catalog.provider-scope-mapping.proposed",
        "catalog.provider-scope-mapping.rejected",
      ]);
      expect(lobRetired[1]!.payload.reason).toContain(lobId);
      expect(await mappingEvents(lobRejected)).toEqual([
        expect.objectContaining({ event_type: "catalog.provider-scope-mapping.proposed" }),
        expect.objectContaining({
          event_type: "catalog.provider-scope-mapping.rejected",
          payload: expect.objectContaining({ reason: "Wrong provider set." }),
        }),
      ]);
      expect(await mappingEvents(mappingStream(lobId, "ygojson", YGOJSON_UNIT))).toEqual([]);

      await harness.drain();
      const proposalProposals = await proposedScopeMappingProposals();
      await harness.refresh("ygoprodeck", [
        (await fixture("ygoprodeck-yugioh-set-reference/changed.json")).set,
        LOB_YGOPRODECK_ROW,
      ]);

      const remapped = await mappingEvents(mappingStream(sdyId, "ygoprodeck", YGOPRODECK_UNIT));
      expect(remapped).toHaveLength(2);
      expect(remapped[1]!.payload).toMatchObject({ scopeRecordId: sdyId, reviewStatus: "auto-accepted" });
      expect(await proposedScopeMappingProposals()).toBe(proposalProposals);
      expect(await mappingEvents(sdySource)).toHaveLength(3);
    });

    it("finishes a re-point interrupted after the target mapping was proposed", async () => {
      const harness = await yugiohHarness();
      await harness.refresh("ygoprodeck", [(await fixture("ygoprodeck-yugioh-set-reference/normal.json")).set]);
      const [proposal] = await harness.runtime.listCanonicalScopeRecordProposals({ productDomain: "yugioh" });
      const acceptedId = acceptedReferenceRecordIdForProposal(proposal!.proposalId);
      const source = mappingStream(proposal!.scopeRecordId, "ygoprodeck", YGOPRODECK_UNIT);
      const target = mappingStream(acceptedId, "ygoprodeck", YGOPRODECK_UNIT);
      harness.crashes.push("RejectProviderScopeMapping");

      await expect(harness.accept(proposal!.proposalId)).rejects.toThrow("Injected crash");
      expect(await getCanonicalScopeRecordProposal(pools.catalog, proposal!.proposalId)).toMatchObject({
        reviewStatus: "accepted",
        acceptedScopeRecordId: acceptedId,
      });
      expect(await mappingEvents(target)).toHaveLength(1);
      expect((await mappingEvents(source)).map((event) => event.event_type)).toEqual([
        "catalog.provider-scope-mapping.proposed",
      ]);

      const retried = await harness.accept(proposal!.proposalId);

      expect(retried).toMatchObject({
        ok: true,
        acceptance: {
          scopeRecordId: acceptedId,
          referenceRecord: { created: false, published: false },
          mappings: { repointed: [{ retiredAs: "rejected", targetAlreadyPresent: true }], conflicts: [] },
        },
      });
      expect(await mappingEvents(target)).toHaveLength(1);
      expect((await mappingEvents(source)).map((event) => event.event_type)).toEqual([
        "catalog.provider-scope-mapping.proposed",
        "catalog.provider-scope-mapping.rejected",
      ]);
    });
  });
});

async function fixture(relativePath: string): Promise<JsonObject> {
  const file = path.join(
    repositoryRoot,
    "bounded-contexts/catalog/features/source-observations/api/__fixtures__",
    relativePath,
  );
  return JSON.parse(await readFile(file, "utf8")) as JsonObject;
}

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
