import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import {
  bootstrapContextDatabase,
  drainContextProcesses,
  resolveModuleSubscriptions,
} from "@chase-sets/bounded-context-runtime";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { module as catalogModule } from "../../../index";
import { createCatalogServices, type CatalogServices } from "../../../support/authoring-support/index";
import {
  buildCatalogAliasCandidate,
  catalogAliasStreamId,
  type CatalogAliasCandidate,
} from "../../../features/alias-equivalence/domain/domain";
import {
  ingestTcgdexAliasCandidates,
  type TcgdexEnglishMirrorLoader,
} from "../../../features/source-observations/api/tcgdex-alias-intake";
import type { CatalogProviderIntegrationProfile } from "../../../features/source-observations/api/provider-integration-profiles";

const databaseBaseUrl = process.env.TEST_DATABASE_URL;
const catalogContextNames = ["catalog"] as const;

function requireDatabaseBaseUrl(): string {
  if (!databaseBaseUrl) {
    throw new Error("TEST_DATABASE_URL is required for database-backed catalog alias persistence tests.");
  }
  return databaseBaseUrl;
}

const context: EventStoreContext = {
  tenantId: "tnt_test" as never,
  audit: {
    performedByUserId: "usr_test" as never,
    forAccountId: "acc_test" as never,
  },
};

let pool: PgTransactionalPool;
let services: CatalogServices;
let subscriptionRunners: ReturnType<typeof resolveModuleSubscriptions>;

async function drainCatalogProjections() {
  await drainContextProcesses({ subscriptionRunners });
}

function itemAliasCandidate(overrides: Partial<Parameters<typeof buildCatalogAliasCandidate>[0]> = {}) {
  return buildCatalogAliasCandidate({
    target: { kind: "catalog-item", targetId: "cat_charizard", targetKey: "name" },
    aliasText: "Dracaufeu",
    aliasLanguageCode: "fr",
    aliasType: "official-equivalent",
    confidence: "high",
    reviewStatus: "pending",
    provenance: {
      providerKey: "tcgdex",
      observationId: "obs_1",
      sourceCategory: "provider-same-id-localized-endpoint",
      sourceProfileKey: "pokemon-tcg",
      sourceProfileVersion: "2026.06.03",
      mappingFingerprint: "fp-1",
    },
    evidence: { sharedId: "base1-4" },
    ...overrides,
  });
}

async function proposeAndDrain(candidate: CatalogAliasCandidate, actor = "usr_1") {
  await services.catalogAliases.catalogAliasCommandHandler({
    streamId: catalogAliasStreamId(candidate.aliasHash),
    command: { type: "ProposeCatalogAlias", candidate, actor },
    context,
  });
  await drainCatalogProjections();
}

describe("Catalog Alias persistence (DB-backed)", () => {
  beforeAll(async () => {
    const databaseUrls = createMultiContextTestDatabaseUrls(
      requireDatabaseBaseUrl(),
      catalogContextNames,
      "catalog_alias_persistence",
    );
    await ensureMultiContextTestDatabases(requireDatabaseBaseUrl(), databaseUrls);
    const pools = createMultiContextTestPools(databaseUrls);
    pool = pools.catalog;
  });

  beforeEach(async () => {
    await resetMultiContextTestSchemas({ catalog: pool });
    await bootstrapContextDatabase(catalogModule, pool);
    services = createCatalogServices(pool);
    subscriptionRunners = resolveModuleSubscriptions([
      {
        contextName: "catalog",
        module: catalogModule,
        services,
        pool,
        projectionHandlerSets: catalogModule.projectionHandlerSets?.(services) ?? [],
      },
    ]);
  });

  afterAll(async () => {
    await closeMultiContextTestPools({ catalog: pool });
  });

  it("persists source-observation alias candidates idempotently by hash", async () => {
    const candidate = itemAliasCandidate();
    await services.catalogAliases.upsertSourceObservationAliasCandidates([candidate], "2026-06-16T00:00:00.000Z");
    // Re-import the same evidence: must not duplicate.
    await services.catalogAliases.upsertSourceObservationAliasCandidates(
      [itemAliasCandidate({ evidence: { sharedId: "base1-4", refreshed: true } })],
      "2026-06-16T01:00:00.000Z",
    );

    const candidates = await services.catalogAliases.listSourceObservationAliasCandidates({
      targetId: "cat_charizard",
    });
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.alias_hash).toBe(candidate.aliasHash);
    expect(candidates[0]?.normalized_alias_text).toBe("dracaufeu");
    // Fresh evidence overwrote stale evidence; first_observed_at is preserved
    // at the first import time rather than advancing to the second import.
    expect(candidates[0]?.evidence).toEqual({ sharedId: "base1-4", refreshed: true });
    expect(new Date(candidates[0]?.first_observed_at as unknown as string).toISOString()).toBe(
      "2026-06-16T00:00:00.000Z",
    );
  });

  it("projects accepted aliases queryable by Catalog Item and gates publishable state", async () => {
    const candidate = itemAliasCandidate();
    await proposeAndDrain(candidate);

    let aliases = await services.catalogAliases.listCatalogItemAliases("cat_charizard");
    expect(aliases).toHaveLength(1);
    expect(aliases[0]?.review_status).toBe("pending");
    // Pending must not be publishable.
    expect(await services.catalogAliases.listPublishableCatalogItemAliases("cat_charizard")).toHaveLength(0);

    await services.catalogAliases.catalogAliasCommandHandler({
      streamId: catalogAliasStreamId(candidate.aliasHash),
      command: { type: "AcceptCatalogAlias", actor: "usr_2", reason: "verified" },
      context,
    });
    await drainCatalogProjections();

    aliases = await services.catalogAliases.listPublishableCatalogItemAliases("cat_charizard");
    expect(aliases).toHaveLength(1);
    expect(aliases[0]?.review_status).toBe("accepted");
    expect(aliases[0]?.last_actor).toBe("usr_2");
    expect(aliases[0]?.reviewed_at).not.toBeNull();
  });

  it("models cardinality: one species alias text maps to many Catalog Items", async () => {
    const speciesProvenance = {
      providerKey: "tcgdex",
      observationId: "obs_species",
      sourceCategory: "species-reference" as const,
      sourceProfileKey: "pokemon-tcg",
      sourceProfileVersion: "2026.06.03",
      mappingFingerprint: "fp-1",
    };
    for (const targetId of ["cat_pikachu_a", "cat_pikachu_b", "cat_pikachu_c"]) {
      const candidate = buildCatalogAliasCandidate({
        target: { kind: "catalog-item", targetId, targetKey: "name" },
        aliasText: "Pikachu",
        aliasLanguageCode: "en",
        aliasType: "species-name",
        confidence: "candidate",
        reviewStatus: "pending",
        provenance: speciesProvenance,
        evidence: {},
      });
      await proposeAndDrain(candidate, "usr_1");
      await services.catalogAliases.catalogAliasCommandHandler({
        streamId: catalogAliasStreamId(candidate.aliasHash),
        command: { type: "AcceptCatalogAlias", actor: "usr_2" },
        context,
      });
    }
    await drainCatalogProjections();

    const fanOut = await services.catalogAliases.countCatalogItemsForAliasText("pikachu", "en");
    expect(fanOut).toBe(3);
  });

  it("revokes an accepted alias idempotently without deleting provenance", async () => {
    const candidate = itemAliasCandidate({ reviewStatus: "auto-accepted", confidence: "exact" });
    await proposeAndDrain(candidate, "system");

    expect(await services.catalogAliases.listPublishableCatalogItemAliases("cat_charizard")).toHaveLength(1);

    for (let i = 0; i < 2; i += 1) {
      await services.catalogAliases.catalogAliasCommandHandler({
        streamId: catalogAliasStreamId(candidate.aliasHash),
        command: { type: "RevokeCatalogAlias", actor: "usr_3", reason: "evidence changed" },
        context,
      });
    }
    await drainCatalogProjections();

    // No longer publishable, but the row (and provenance) survives for audit.
    expect(await services.catalogAliases.listPublishableCatalogItemAliases("cat_charizard")).toHaveLength(0);
    const row = await services.catalogAliases.getCatalogItemAlias(candidate.aliasHash);
    expect(row?.review_status).toBe("revoked");
    expect(row?.provider_key).toBe("tcgdex");
    expect(row?.observation_id).toBe("obs_1");
    expect(row?.last_reason).toBe("evidence changed");
  });

  it("intake persists TCGdex alias candidates for a Japanese card with an English mirror", async () => {
    const englishMirror: TcgdexEnglishMirrorLoader = async ({ entity, id }) => {
      if (entity === "card" && id === "sv1a-001") {
        return { id: "sv1a-001", name: "Sprigatito" };
      }
      if (entity === "set" && id === "sv1a") {
        return { id: "sv1a", name: "Triplet Beat" };
      }
      if (entity === "series" && id === "sv") {
        return { id: "sv", name: "Scarlet & Violet" };
      }
      return null;
    };

    await ingestTcgdexAliasCandidates({
      profile: {} as CatalogProviderIntegrationProfile,
      observations: [
        {
          observationId: "tcgdex_ja_sv1a_001",
          sourceProfileKey: "pokemon-tcg",
          sourceProfileVersion: "2026.06.03",
          mappingFingerprint: "fp-1",
          payload: {
            languageCode: "ja",
            card: { id: "sv1a-001", name: "ニャオハ", category: "Pokemon", dexId: [906] },
            set: { id: "sv1a", name: "トリプレットビート" },
            seriesId: "sv",
            seriesName: "スカーレット&バイオレット",
          },
        },
      ],
      persist: services.catalogAliases.upsertSourceObservationAliasCandidates,
      observedAt: "2026-06-16T00:00:00.000Z",
      loadEnglishMirrorEntity: englishMirror,
    });

    const candidates = await services.catalogAliases.listSourceObservationAliasCandidates({
      providerKey: "tcgdex",
    });
    const byType = (type: string) => candidates.filter((c) => c.alias_type === type);

    // Native Japanese card name preserved as Indonesian-safe provider-localized-name.
    expect(byType("provider-localized-name").map((c) => c.alias_text)).toEqual(["ニャオハ"]);
    // Same-id English official equivalent, held for review.
    const official = byType("official-equivalent");
    expect(official).toHaveLength(1);
    expect(official[0]?.alias_text).toBe("Sprigatito");
    expect(official[0]?.alias_language_code).toBe("en");
    expect(official[0]?.source_language_code).toBe("ja");
    expect(official[0]?.review_status).toBe("pending");
    expect(official[0]?.source_category).toBe("provider-same-id-localized-endpoint");
    // Species alias from dex evidence.
    expect(byType("species-name").map((c) => c.alias_text)).toEqual(["Sprigatito"]);
    // Reference-record equivalences for both native and English names.
    expect(
      byType("set-equivalent")
        .map((c) => c.alias_text)
        .sort(),
    ).toEqual(["Triplet Beat", "トリプレットビート"].sort());
  });

  it("intake never persists an English alias sourced from the Indonesian id text", async () => {
    await ingestTcgdexAliasCandidates({
      profile: {} as CatalogProviderIntegrationProfile,
      observations: [
        {
          observationId: "tcgdex_id_sv1a_001",
          sourceProfileKey: "pokemon-tcg",
          sourceProfileVersion: "2026.06.03",
          mappingFingerprint: "fp-1",
          payload: {
            languageCode: "id",
            // Indonesian species name reads like English.
            card: { id: "sv1a-001", name: "Sprigatito", category: "Pokemon", dexId: [906] },
            set: { id: "sv1a", name: "Triplet Beat" },
            seriesId: "sv",
            seriesName: "Scarlet & Violet",
          },
        },
      ],
      persist: services.catalogAliases.upsertSourceObservationAliasCandidates,
      observedAt: "2026-06-16T00:00:00.000Z",
      // Japanese-only / Indonesian set: no English mirror exists.
      loadEnglishMirrorEntity: async () => null,
    });

    const candidates = await services.catalogAliases.listSourceObservationAliasCandidates({
      providerKey: "tcgdex",
    });

    // No persisted alias is both English-language and a provider-localized-name:
    // the Indonesian `id` text is never emitted as an English alias.
    const englishLocalized = candidates.filter(
      (c) => c.alias_language_code === "en" && c.source_category === "provider-localized-name",
    );
    expect(englishLocalized).toHaveLength(0);
    // The Indonesian name is stored under the Indonesian language code.
    const localized = candidates.filter((c) => c.source_category === "provider-localized-name");
    expect(localized).toHaveLength(1);
    expect(localized[0]?.alias_language_code).toBe("id");
    expect(localized[0]?.alias_text).toBe("Sprigatito");
    // No English official equivalent without an English endpoint match.
    expect(candidates.filter((c) => c.alias_type === "official-equivalent")).toHaveLength(0);
  });

  it("persists reference-record set-equivalent aliases queryable by Reference Record", async () => {
    const candidate = buildCatalogAliasCandidate({
      target: { kind: "reference-record", targetId: "ref_expansion_1", targetKey: "expansion" },
      aliasText: "リザードン",
      aliasLanguageCode: "ja",
      aliasType: "set-equivalent",
      confidence: "exact",
      reviewStatus: "auto-accepted",
      provenance: {
        providerKey: "tcgdex",
        observationId: "obs_set",
        sourceCategory: "provider-same-id-localized-endpoint",
        sourceProfileKey: "pokemon-tcg",
        sourceProfileVersion: "2026.06.03",
        mappingFingerprint: "fp-1",
      },
      evidence: {},
    });
    await proposeAndDrain(candidate, "system");

    const aliases = await services.catalogAliases.listPublishableReferenceRecordAliases("ref_expansion_1");
    expect(aliases).toHaveLength(1);
    expect(aliases[0]?.type_key).toBe("expansion");
    expect(aliases[0]?.alias_type).toBe("set-equivalent");
  });
});
