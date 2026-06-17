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
import { createPromotionAliasReader } from "../../../features/source-observations/api/provider-promotion-alias-reader";
import {
  writePromotionAliases,
  type PromotionAliasServices,
} from "../../../features/source-observations/api/provider-promotion-alias-writer";
import type { PromotionAliasCandidate } from "../../../features/source-observations/api/provider-promotion-alias-planner";

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

  it("assembles the admin alias review read model with coverage and auto-accept eligibility (#1908)", async () => {
    // A pending same-id English official equivalent (held for review).
    const officialCandidate = itemAliasCandidate({
      target: { kind: "catalog-item", targetId: "cat_charizard", targetKey: "name" },
      aliasText: "Sprigatito",
      aliasLanguageCode: "en",
      aliasType: "official-equivalent",
      reviewStatus: "pending",
      provenance: {
        providerKey: "tcgdex",
        observationId: "obs_1",
        sourceCategory: "provider-same-id-localized-endpoint",
        sourceProfileKey: "pokemon-tcg",
        sourceProfileVersion: "2026.06.03",
        mappingFingerprint: "fp-1",
      },
      evidence: { providerId: "sv1a-001", evidenceKind: "card-id", nativeName: "ニャオハ" },
    });
    // A curated-operator-mapping candidate the policy would auto-accept.
    const curatedCandidate = buildCatalogAliasCandidate({
      target: { kind: "catalog-item", targetId: "cat_pikachu", targetKey: "name" },
      aliasText: "Pikachu",
      aliasLanguageCode: "en",
      aliasType: "official-equivalent",
      confidence: "manual",
      reviewStatus: "pending",
      provenance: {
        providerKey: "tcgdex",
        observationId: "obs_2",
        sourceCategory: "curated-operator-mapping",
        sourceProfileKey: "pokemon-tcg",
        sourceProfileVersion: "2026.06.03",
        mappingFingerprint: "fp-1",
      },
      evidence: {},
    });
    await services.catalogAliases.upsertSourceObservationAliasCandidates(
      [officialCandidate, curatedCandidate],
      "2026-06-16T00:00:00.000Z",
    );

    // Accept one alias so the coverage view reflects a published English alias.
    await proposeAndDrain(curatedCandidate, "system");
    await services.catalogAliases.catalogAliasCommandHandler({
      streamId: catalogAliasStreamId(curatedCandidate.aliasHash),
      command: { type: "AcceptCatalogAlias", actor: "usr_review" },
      context,
    });
    await drainCatalogProjections();

    const readModel = await services.catalogAliases.getCatalogAliasReviewReadModel({
      generatedAt: "2026-06-16T02:00:00.000Z",
      filter: { providerKey: "tcgdex" },
    });

    expect(readModel.counts.total).toBeGreaterThanOrEqual(2);
    const official = readModel.candidates.find((candidate) => candidate.aliasHash === officialCandidate.aliasHash);
    expect(official?.proposedAlias).toBe("Sprigatito");
    expect(official?.nativePrintedName).toBe("ニャオハ");
    expect(official?.reviewStatus).toBe("pending");

    const curated = readModel.candidates.find((candidate) => candidate.aliasHash === curatedCandidate.aliasHash);
    expect(curated?.autoAccept.governedReviewState).toBe("auto-accepted");

    // The accepted English alias shows up in coverage.
    expect(readModel.coverage.cardsWithAcceptedEnglishAlias).toBeGreaterThanOrEqual(1);
    expect(readModel.coverage.cardsNeedingReview).toBeGreaterThanOrEqual(1);
    expect(readModel.groups.some((group) => group.scope === "provider" && group.value === "tcgdex")).toBe(true);
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

  // -------------------------------------------------------------------------
  // Promotion writes aliases (#1909): seeds reviewed candidate rows, runs the
  // promotion alias writer with the real read-model + alias aggregate against
  // the database, and asserts the durable alias_rows that result.
  // -------------------------------------------------------------------------
  function promotionAliasServices(): PromotionAliasServices {
    return {
      ...createPromotionAliasReader(pool),
      catalogAliasCommandHandler: services.catalogAliases.catalogAliasCommandHandler,
    };
  }

  function observationItemCandidate(
    overrides: Partial<Parameters<typeof buildCatalogAliasCandidate>[0]> = {},
  ): CatalogAliasCandidate {
    return buildCatalogAliasCandidate({
      // Persisted before promotion: the Catalog Item id is unresolved.
      target: { kind: "catalog-item", targetId: null, targetKey: "card-name" },
      aliasText: "ニャオハ",
      aliasLanguageCode: "ja",
      aliasType: "provider-localized-name",
      confidence: "high",
      reviewStatus: "accepted",
      provenance: {
        providerKey: "tcgdex",
        observationId: "obs_promote_1",
        sourceCategory: "provider-localized-name",
        sourceProfileKey: "pokemon-tcg",
        sourceProfileVersion: "2026.06.03",
        mappingFingerprint: "fp-1",
      },
      evidence: { sharedId: "sv1a-001" },
      ...overrides,
    });
  }

  async function seedCandidates(candidates: readonly CatalogAliasCandidate[]) {
    await services.catalogAliases.upsertSourceObservationAliasCandidates(candidates, "2026-06-16T00:00:00.000Z");
  }

  const promoteResolution = {
    catalogItemId: "cat_promoted_charizard",
    referenceRecordIdsByTypeKey: { expansion: "ref_expansion_promoted", series: "ref_series_promoted" },
  } as const;

  it("promotes accepted item aliases into Catalog Item facts with the resolved id (#1909)", async () => {
    await seedCandidates([observationItemCandidate()]);

    const result = await writePromotionAliases({
      services: promotionAliasServices(),
      observationId: "obs_promote_1",
      resolution: promoteResolution,
      context,
    });
    await drainCatalogProjections();

    expect(result.proposed).toBe(1);
    expect(result.accepted).toBe(1);
    const aliases = await services.catalogAliases.listPublishableCatalogItemAliases("cat_promoted_charizard");
    expect(aliases).toHaveLength(1);
    expect(aliases[0]?.catalog_item_id).toBe("cat_promoted_charizard");
    expect(aliases[0]?.alias_text).toBe("ニャオハ");
    expect(aliases[0]?.observation_id).toBe("obs_promote_1");
    expect(aliases[0]?.provider_key).toBe("tcgdex");
  });

  it("promotes accepted set-equivalent aliases into Reference Record facts (#1909)", async () => {
    await seedCandidates([
      buildCatalogAliasCandidate({
        target: { kind: "reference-record", targetId: null, targetKey: "expansion" },
        aliasText: "トリプレットビート",
        aliasLanguageCode: "ja",
        aliasType: "set-equivalent",
        confidence: "exact",
        reviewStatus: "auto-accepted",
        provenance: {
          providerKey: "tcgdex",
          observationId: "obs_promote_1",
          sourceCategory: "provider-same-id-localized-endpoint",
          sourceProfileKey: "pokemon-tcg",
          sourceProfileVersion: "2026.06.03",
          mappingFingerprint: "fp-1",
        },
        evidence: {},
      }),
    ]);

    await writePromotionAliases({
      services: promotionAliasServices(),
      observationId: "obs_promote_1",
      resolution: promoteResolution,
      context,
    });
    await drainCatalogProjections();

    const aliases = await services.catalogAliases.listPublishableReferenceRecordAliases("ref_expansion_promoted");
    expect(aliases).toHaveLength(1);
    expect(aliases[0]?.reference_record_id).toBe("ref_expansion_promoted");
    expect(aliases[0]?.alias_type).toBe("set-equivalent");
  });

  it("does not promote pending or rejected candidates into publishable facts (#1909)", async () => {
    await seedCandidates([
      observationItemCandidate({ aliasText: "Pending Name", reviewStatus: "pending" }),
      observationItemCandidate({ aliasText: "Rejected Name", reviewStatus: "rejected" }),
    ]);

    await writePromotionAliases({
      services: promotionAliasServices(),
      observationId: "obs_promote_1",
      resolution: promoteResolution,
      context,
    });
    await drainCatalogProjections();

    expect(await services.catalogAliases.listPublishableCatalogItemAliases("cat_promoted_charizard")).toHaveLength(0);
  });

  it("re-promoting the same scope is idempotent and does not duplicate facts (#1909)", async () => {
    await seedCandidates([observationItemCandidate()]);

    for (let i = 0; i < 2; i += 1) {
      await writePromotionAliases({
        services: promotionAliasServices(),
        observationId: "obs_promote_1",
        resolution: promoteResolution,
        context,
      });
    }
    await drainCatalogProjections();

    const aliases = await services.catalogAliases.listCatalogItemAliases("cat_promoted_charizard");
    expect(aliases).toHaveLength(1);
    expect(aliases[0]?.review_status).toBe("accepted");
  });

  it("retracts a previously promoted alias when its candidate is rejected on re-promotion (#1909)", async () => {
    await seedCandidates([observationItemCandidate()]);
    await writePromotionAliases({
      services: promotionAliasServices(),
      observationId: "obs_promote_1",
      resolution: promoteResolution,
      context,
    });
    await drainCatalogProjections();
    expect(await services.catalogAliases.listPublishableCatalogItemAliases("cat_promoted_charizard")).toHaveLength(1);

    // The candidate is rejected in review, then promotion is re-run.
    await seedCandidates([observationItemCandidate({ reviewStatus: "rejected" })]);
    const result = await writePromotionAliases({
      services: promotionAliasServices(),
      observationId: "obs_promote_1",
      resolution: promoteResolution,
      context,
    });
    await drainCatalogProjections();

    expect(result.retracted).toBe(1);
    expect(await services.catalogAliases.listPublishableCatalogItemAliases("cat_promoted_charizard")).toHaveLength(0);
    // The row survives for audit; only the review_status flips to revoked.
    const all = await services.catalogAliases.listCatalogItemAliases("cat_promoted_charizard");
    expect(all).toHaveLength(1);
    expect(all[0]?.review_status).toBe("revoked");
  });

  it("retracts a promoted alias when its candidate is revoked, while a fresh accepted alias publishes (#1909)", async () => {
    await seedCandidates([observationItemCandidate({ aliasText: "Old Localized Name" })]);
    await writePromotionAliases({
      services: promotionAliasServices(),
      observationId: "obs_promote_1",
      resolution: promoteResolution,
      context,
    });
    await drainCatalogProjections();

    // The old candidate is revoked in review and a fresh accepted candidate is
    // recorded; re-promotion publishes the new alias and retracts the old one.
    await seedCandidates([
      observationItemCandidate({ aliasText: "Old Localized Name", reviewStatus: "revoked" }),
      observationItemCandidate({ aliasText: "New Localized Name", reviewStatus: "accepted" }),
    ]);
    await writePromotionAliases({
      services: promotionAliasServices(),
      observationId: "obs_promote_1",
      resolution: promoteResolution,
      context,
    });
    await drainCatalogProjections();

    const publishable = await services.catalogAliases.listPublishableCatalogItemAliases("cat_promoted_charizard");
    expect(publishable.map((alias) => alias.alias_text)).toEqual(["New Localized Name"]);
  });

  // -------------------------------------------------------------------------
  // Publish resolved alias facts (#1910): create a real Catalog Item /
  // Reference Record, write accepted aliases, drain the projection (which
  // enqueues recompute), process the recompute batch, and assert the resolved
  // fact persists and the aliases-resolved fact publishes only on hash change.
  // -------------------------------------------------------------------------
  function l10n(en: string) {
    return { defaultLocale: "en" as const, values: { en } };
  }

  async function createCatalogItem(itemId: string, title: string) {
    await services.items.commandHandler({
      streamId: `catalog.item-${itemId}`,
      command: { type: "CreateCatalogItem", itemId: itemId as never, title: l10n(title) as never },
      context,
    });
  }

  async function createReferenceRecord(referenceRecordId: string, typeKey: string, key: string, name: string) {
    await services.referenceData.referenceRecordCommandHandler({
      streamId: `catalog.reference-record-${referenceRecordId}`,
      command: {
        type: "CreateReferenceRecord",
        referenceRecordId: referenceRecordId as never,
        typeKey,
        key,
        name: l10n(name) as never,
      },
      context,
    });
  }

  async function processItemAliasRecompute() {
    return services.catalogAliases.processCatalogItemAliasRecomputeBatch(context, { limit: 50 });
  }

  it("publishes a resolved Catalog Item alias fact only when the resolved hash changes (#1910)", async () => {
    await createCatalogItem("cat_resolved_1", "Charizard");
    const candidate = itemAliasCandidate({
      target: { kind: "catalog-item", targetId: "cat_resolved_1", targetKey: "name" },
      reviewStatus: "auto-accepted",
      confidence: "exact",
    });
    await proposeAndDrain(candidate, "system");

    const first = await processItemAliasRecompute();
    await drainCatalogProjections();
    expect(first.changed).toBe(1);

    const facts = await pool.query(
      `SELECT alias_language_code, aliases, resolved_alias_hash, resolver_version
       FROM catalog_item_resolved_aliases WHERE catalog_item_id = $1`,
      ["cat_resolved_1"],
    );
    expect(facts.rows).toHaveLength(1);
    expect(facts.rows[0]?.alias_language_code).toBe("fr");
    expect(facts.rows[0]?.aliases).toEqual([
      expect.objectContaining({ aliasHash: candidate.aliasHash, aliasText: "Dracaufeu", broad: false }),
    ]);

    // The aliases-resolved fact was appended to the Catalog Item stream.
    const published = await pool.query(
      `SELECT event_type FROM event_store_events
       WHERE stream_id = $1 AND event_type = 'catalog.catalog-item.aliases-resolved'`,
      ["catalog.item-cat_resolved_1"],
    );
    expect(published.rows.length).toBeGreaterThanOrEqual(1);

    // Re-running recompute with no alias change publishes nothing new.
    await services.catalogAliases.enqueueAllCatalogItemAliasRecomputeWork();
    const second = await processItemAliasRecompute();
    await drainCatalogProjections();
    expect(second.changed).toBe(0);
    expect(second.unchanged).toBe(1);
  });

  it("publishes an empty resolved fact when the last accepted alias is revoked (#1910)", async () => {
    await createCatalogItem("cat_resolved_2", "Pikachu");
    const candidate = itemAliasCandidate({
      target: { kind: "catalog-item", targetId: "cat_resolved_2", targetKey: "name" },
      reviewStatus: "auto-accepted",
      confidence: "exact",
    });
    await proposeAndDrain(candidate, "system");
    await processItemAliasRecompute();
    await drainCatalogProjections();

    const beforeHash = (
      await pool.query(`SELECT resolved_alias_hash FROM catalog_item_resolved_aliases WHERE catalog_item_id = $1`, [
        "cat_resolved_2",
      ])
    ).rows[0]?.resolved_alias_hash;

    // Revoke the alias; the projection enqueues recompute, which publishes the
    // empty/retracted fact.
    await services.catalogAliases.catalogAliasCommandHandler({
      streamId: catalogAliasStreamId(candidate.aliasHash),
      command: { type: "RevokeCatalogAlias", actor: "usr_3", reason: "evidence changed" },
      context,
    });
    await drainCatalogProjections();
    const revoke = await processItemAliasRecompute();
    await drainCatalogProjections();

    expect(revoke.changed).toBe(1);
    const fact = await pool.query(
      `SELECT aliases, resolved_alias_hash FROM catalog_item_resolved_aliases WHERE catalog_item_id = $1`,
      ["cat_resolved_2"],
    );
    expect(fact.rows[0]?.aliases).toEqual([]);
    expect(fact.rows[0]?.resolved_alias_hash).not.toBe(beforeHash);
  });

  it("backfill rebuilds resolved alias facts for existing promoted Reference Records (#1910)", async () => {
    await createReferenceRecord("ref_resolved_1", "expansion", "triplet-beat", "Triplet Beat");
    const candidate = buildCatalogAliasCandidate({
      target: { kind: "reference-record", targetId: "ref_resolved_1", targetKey: "expansion" },
      aliasText: "トリプレットビート",
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

    // Backfill enqueues every Reference Record with published aliases.
    const enqueued = await services.catalogAliases.enqueueAllReferenceRecordAliasRecomputeWork();
    expect(enqueued).toBeGreaterThanOrEqual(1);
    const result = await services.catalogAliases.processReferenceRecordAliasRecomputeBatch(context, { limit: 50 });
    await drainCatalogProjections();
    expect(result.changed).toBeGreaterThanOrEqual(1);

    const fact = await pool.query(
      `SELECT aliases FROM catalog_reference_record_resolved_aliases WHERE reference_record_id = $1`,
      ["ref_resolved_1"],
    );
    expect(fact.rows).toHaveLength(1);
    expect(fact.rows[0]?.aliases).toEqual([
      expect.objectContaining({ aliasText: "トリプレットビート", aliasType: "set-equivalent" }),
    ]);
  });

  it("resolves conflicting official equivalents through #1912 source precedence (#1909)", async () => {
    const sameIdEndpoint = buildCatalogAliasCandidate({
      target: { kind: "catalog-item", targetId: null, targetKey: "card-name" },
      aliasText: "Sprigatito",
      aliasLanguageCode: "en",
      aliasType: "official-equivalent",
      confidence: "high",
      reviewStatus: "accepted",
      provenance: {
        providerKey: "tcgdex",
        observationId: "obs_promote_1",
        sourceCategory: "provider-same-id-localized-endpoint",
        sourceProfileKey: "pokemon-tcg",
        sourceProfileVersion: "2026.06.03",
        mappingFingerprint: "fp-1",
      },
      evidence: {},
    });
    const curated = buildCatalogAliasCandidate({
      target: { kind: "catalog-item", targetId: null, targetKey: "card-name" },
      aliasText: "Sprigatito",
      aliasLanguageCode: "en",
      aliasType: "official-equivalent",
      confidence: "manual",
      reviewStatus: "accepted",
      provenance: {
        providerKey: "tcgdex",
        observationId: "obs_promote_1",
        sourceCategory: "curated-operator-mapping",
        sourceProfileKey: "pokemon-tcg",
        sourceProfileVersion: "2026.06.03",
        mappingFingerprint: "fp-1",
      },
      evidence: {},
    });
    await seedCandidates([sameIdEndpoint, curated]);

    await writePromotionAliases({
      services: promotionAliasServices(),
      observationId: "obs_promote_1",
      resolution: promoteResolution,
      context,
    });
    await drainCatalogProjections();

    const publishable = await services.catalogAliases.listPublishableCatalogItemAliases("cat_promoted_charizard");
    // The curated operator mapping (precedence 2) wins over same-id endpoint (3).
    expect(publishable).toHaveLength(1);
    expect(publishable[0]?.source_category).toBe("curated-operator-mapping");
  });
});
