import { describe, expect, it } from "vitest";
import {
  assertCatalogAliasEquivalenceE2eProofConnects,
  catalogAliasEquivalenceE2eProofSchemaVersion,
  runCatalogAliasEquivalenceE2eProof,
  TCGDEX_ALIAS_E2E_PROOF_SCOPE,
  type CatalogAliasEquivalenceE2eProofPacket,
} from "./catalog-integration-alias-equivalence-e2e-proof";

describe("Catalog Alias Equivalence end-to-end milestone proof (#1913)", () => {
  it("walks the whole catalog pipeline deterministically with no live provider calls", () => {
    const packet = runCatalogAliasEquivalenceE2eProof();

    expect(packet.schemaVersion).toBe(catalogAliasEquivalenceE2eProofSchemaVersion);
    expect(packet.liveProviderCallsMade).toBe(false);
    expect(packet.provider).toMatchObject({
      providerKey: "tcgdex",
      sourceProfileKey: "pokemon-tcg",
      sourceProfileVersion: "2026.06.03",
      scope: TCGDEX_ALIAS_E2E_PROOF_SCOPE,
    });
    expect(TCGDEX_ALIAS_E2E_PROOF_SCOPE).toEqual({ languageCode: "ja", seriesId: "sv", setId: "sv1a" });
  });

  it("records the expected count at every pipeline stage", () => {
    const { stages } = runCatalogAliasEquivalenceE2eProof();

    // Stage 1: bounded source-option selection with the chosen Japanese scope.
    expect(stages.sourceOptions).toMatchObject({
      languageOptionSelected: true,
      seriesOptionSelected: true,
      expansionOptionSelected: true,
    });

    // Stage 2: five scenario cards imported, each producing one observation.
    expect(stages.import).toEqual({ queued: 5, running: 0, completed: 5, observations: 5 });

    // Stage 3: 26 candidates created across the five cards. Every card produces a
    // native localized name (5), plus a native set-equivalent + series-equivalent;
    // the three cards with an English mirror add an English set/series-equivalent
    // (so 8 of each), an English official equivalent (3), and a species alias for
    // the two Pokemon with both a dex id and a mirror (2).
    expect(stages.candidates.created).toBe(26);
    expect(stages.candidates.byAliasType).toEqual({
      "provider-localized-name": 5,
      "set-equivalent": 8,
      "series-equivalent": 8,
      "official-equivalent": 3,
      "species-name": 2,
    });
    expect(stages.candidates.englishCandidates).toBeGreaterThan(0);
    expect(stages.candidates.nativeCandidates).toBeGreaterThan(0);
    // Two cards have no English equivalent at all: the missing-mirror promo and
    // the Energy card (no dex id and no `/en/` mirror).
    expect(stages.candidates.cardsWithoutEnglishEquivalent).toBe(2);

    // Stage 4 (review): species-helps + revoked official equivalents are accepted;
    // trainer/energy/missing-mirror official equivalents stay pending and block
    // high-confidence English search until reviewed.
    expect(stages.review.accepted).toBe(2);
    expect(stages.review.blockingHighConfidenceSearch).toBe(1);
    expect(stages.review.pending).toBeGreaterThan(0);

    // Stage 5 (promotion): at least the accepted item aliases publish.
    expect(stages.promotion.proposed).toBeGreaterThan(0);
    expect(stages.promotion.publishable).toBeGreaterThanOrEqual(2);
    expect(stages.promotion.evidenceOnly).toBeGreaterThan(0);

    // Stage 6 (publish): two cards carry a published English alias fact.
    expect(stages.publish.catalogItemsWithPublishedAliases).toBe(2);
    expect(stages.publish.publishedAliasFacts).toBe(2);

    // Stage 7 (search): both accepted cards are English-reachable.
    expect(stages.search.englishReachableCatalogItems).toBe(2);
    expect(stages.search.englishQueryFindsJapaneseCard).toBe(true);

    // Stage 8 (display): the species-helps card resolves to the English name.
    expect(stages.display.englishDisplayResolved).toBe(2);
    expect(stages.display.sampleEnglishDisplay).toBe("Cacnea (サボネア)");
  });

  it("covers every #1913 scenario: species help, no-dex trainer/energy, missing mirror, revoked", () => {
    const { scenarios } = runCatalogAliasEquivalenceE2eProof();
    const byKey = new Map(scenarios.map((scenario) => [scenario.key, scenario]));

    const species = byKey.get("species-helps");
    expect(species).toMatchObject({
      nativeName: "サボネア",
      cardCategory: "Pokemon",
      englishMirrorPresent: true,
      speciesAliasProduced: true,
      officialEnglishEquivalentProduced: true,
      englishReachable: true,
      englishDisplayName: "Cacnea (サボネア)",
    });

    // Trainer: no dexId -> no species alias, so dexId cannot give an English equiv.
    const trainer = byKey.get("trainer-no-dex");
    expect(trainer?.hasDexId).toBe(false);
    expect(trainer?.speciesAliasProduced).toBe(false);

    // Energy: same no-dex constraint, and never produces an official equivalent.
    const energy = byKey.get("energy-no-dex");
    expect(energy?.hasDexId).toBe(false);
    expect(energy?.speciesAliasProduced).toBe(false);

    // Missing /en/ mirror: no English equivalent produced; native display kept.
    const missing = byKey.get("missing-en-mirror");
    expect(missing?.englishMirrorPresent).toBe(false);
    expect(missing?.officialEnglishEquivalentProduced).toBe(false);
    expect(missing?.englishReachable).toBe(false);
    expect(missing?.englishDisplayName).toBe("ピカチュウ");

    // Revoked card is reachable + has an English display BEFORE the revoke stage.
    const revoked = byKey.get("revoked");
    expect(revoked?.englishReachable).toBe(true);
    expect(revoked?.englishDisplayName).toBe("Sprigatito (ニャオハ)");
  });

  it("proves a revoked alias is removed from search and reverts display to the native name", () => {
    const { revocation } = runCatalogAliasEquivalenceE2eProof();

    expect(revocation.catalogItemId).toBe("cat_sprigatito_ja");
    expect(revocation.englishAliasBeforeRevoke).toBe("Sprigatito");
    expect(revocation.publishedBeforeRevoke).toBe(true);
    expect(revocation.publishedAfterRevoke).toBe(false);
    expect(revocation.searchReachableBeforeRevoke).toBe(true);
    expect(revocation.searchReachableAfterRevoke).toBe(false);
    expect(revocation.displayBeforeRevoke).toBe("Sprigatito (ニャオハ)");
    expect(revocation.displayAfterRevoke).toBe("ニャオハ");
    expect(revocation.retractionFactPublished).toBe(true);
  });

  it("references only diagnostics that exist in the integration diagnostic taxonomy", () => {
    const packet = runCatalogAliasEquivalenceE2eProof();
    expect(packet.diagnosticCodes).toEqual([
      "alias-provider-endpoint-missing",
      "alias-coverage-incomplete",
      "alias-pending-candidates-block-high-confidence-search",
      "alias-resolved-projection-lag",
      "alias-stale-resolved-hash",
      "alias-search-rollout-disabled",
      "alias-native-script-tokenization-gap",
    ]);
    // The connect-assertion already runs inside the builder; re-run it explicitly.
    expect(() => assertCatalogAliasEquivalenceE2eProofConnects(packet)).not.toThrow();
  });

  it("fails closed when a stage does not connect to the next", () => {
    const packet = runCatalogAliasEquivalenceE2eProof();

    const noSearch: CatalogAliasEquivalenceE2eProofPacket = {
      ...packet,
      stages: {
        ...packet.stages,
        search: { ...packet.stages.search, englishQueryFindsJapaneseCard: false },
      },
    };
    expect(() => assertCatalogAliasEquivalenceE2eProofConnects(noSearch)).toThrow(
      "English search reaches the Japanese サボネア card",
    );

    const revokeKept: CatalogAliasEquivalenceE2eProofPacket = {
      ...packet,
      revocation: { ...packet.revocation, searchReachableAfterRevoke: true },
    };
    expect(() => assertCatalogAliasEquivalenceE2eProofConnects(revokeKept)).toThrow(
      "remove the alias from English search",
    );
  });
});
