import assert from "node:assert/strict";

const { describe, it } = process.env.VITEST ? await import("vitest") : await import("node:test");
if (!process.env.VITEST) await import("tsx/esm");

const {
  assertCatalogAliasEquivalenceE2eProofConnects,
  catalogAliasEquivalenceE2eProofSchemaVersion,
  runCatalogAliasEquivalenceE2eProof,
  TCGDEX_ALIAS_E2E_PROOF_SCOPE,
} = await import("./catalog-integration-alias-equivalence-e2e-proof.ts");

describe("Catalog Alias Equivalence end-to-end milestone proof (#1913)", () => {
  it("walks the whole catalog pipeline deterministically with no live provider calls", () => {
    const packet = runCatalogAliasEquivalenceE2eProof();
    assert.equal(packet.schemaVersion, catalogAliasEquivalenceE2eProofSchemaVersion);
    assert.equal(packet.liveProviderCallsMade, false);
    assert.deepEqual(packet.provider, {
      providerKey: "tcgdex",
      sourceProfileKey: "pokemon-tcg",
      sourceProfileVersion: "2026.06.03",
      scope: TCGDEX_ALIAS_E2E_PROOF_SCOPE,
    });
    assert.deepEqual(TCGDEX_ALIAS_E2E_PROOF_SCOPE, { languageCode: "ja", seriesId: "sv", setId: "sv1a" });
  });

  it("records the expected count at every pipeline stage", () => {
    const { stages } = runCatalogAliasEquivalenceE2eProof();
    assert.equal(stages.sourceOptions.languageOptionSelected, true);
    assert.equal(stages.sourceOptions.seriesOptionSelected, true);
    assert.equal(stages.sourceOptions.expansionOptionSelected, true);
    assert.deepEqual(stages.import, { queued: 5, running: 0, completed: 5, observations: 5 });
    assert.equal(stages.candidates.created, 26);
    assert.deepEqual(stages.candidates.byAliasType, {
      "provider-localized-name": 5,
      "set-equivalent": 8,
      "series-equivalent": 8,
      "official-equivalent": 3,
      "species-name": 2,
    });
    assert.ok(stages.candidates.englishCandidates > 0);
    assert.ok(stages.candidates.nativeCandidates > 0);
    assert.equal(stages.candidates.cardsWithoutEnglishEquivalent, 2);
    assert.equal(stages.review.accepted, 2);
    assert.equal(stages.review.blockingHighConfidenceSearch, 1);
    assert.ok(stages.review.pending > 0);
    assert.ok(stages.promotion.proposed > 0);
    assert.ok(stages.promotion.publishable >= 2);
    assert.ok(stages.promotion.evidenceOnly > 0);
    assert.equal(stages.publish.catalogItemsWithPublishedAliases, 2);
    assert.equal(stages.publish.publishedAliasFacts, 2);
    assert.equal(stages.search.englishReachableCatalogItems, 2);
    assert.equal(stages.search.englishQueryFindsJapaneseCard, true);
    assert.equal(stages.display.englishDisplayResolved, 2);
    assert.equal(stages.display.sampleEnglishDisplay, "Cacnea (サボネア)");
  });

  it("covers every species, no-dex, missing-mirror, and revoked scenario", () => {
    const byKey = new Map(runCatalogAliasEquivalenceE2eProof().scenarios.map((scenario) => [scenario.key, scenario]));
    const species = byKey.get("species-helps");
    assert.equal(species.nativeName, "サボネア");
    assert.equal(species.cardCategory, "Pokemon");
    assert.equal(species.englishMirrorPresent, true);
    assert.equal(species.speciesAliasProduced, true);
    assert.equal(species.officialEnglishEquivalentProduced, true);
    assert.equal(species.englishReachable, true);
    assert.equal(species.englishDisplayName, "Cacnea (サボネア)");
    for (const key of ["trainer-no-dex", "energy-no-dex"]) {
      assert.equal(byKey.get(key).hasDexId, false);
      assert.equal(byKey.get(key).speciesAliasProduced, false);
    }
    const missing = byKey.get("missing-en-mirror");
    assert.equal(missing.englishMirrorPresent, false);
    assert.equal(missing.officialEnglishEquivalentProduced, false);
    assert.equal(missing.englishReachable, false);
    assert.equal(missing.englishDisplayName, "ピカチュウ");
    assert.equal(byKey.get("revoked").englishReachable, true);
    assert.equal(byKey.get("revoked").englishDisplayName, "Sprigatito (ニャオハ)");
  });

  it("proves a revoked alias is removed from search and display", () => {
    assert.deepEqual(runCatalogAliasEquivalenceE2eProof().revocation, {
      catalogItemId: "cat_sprigatito_ja",
      englishAliasBeforeRevoke: "Sprigatito",
      publishedBeforeRevoke: true,
      publishedAfterRevoke: false,
      searchReachableBeforeRevoke: true,
      searchReachableAfterRevoke: false,
      displayBeforeRevoke: "Sprigatito (ニャオハ)",
      displayAfterRevoke: "ニャオハ",
      retractionFactPublished: true,
    });
  });

  it("references only diagnostics in the integration taxonomy", () => {
    const packet = runCatalogAliasEquivalenceE2eProof();
    assert.deepEqual(packet.diagnosticCodes, [
      "alias-provider-endpoint-missing",
      "alias-coverage-incomplete",
      "alias-pending-candidates-block-high-confidence-search",
      "alias-resolved-projection-lag",
      "alias-stale-resolved-hash",
      "alias-search-rollout-disabled",
      "alias-native-script-tokenization-gap",
    ]);
    assert.doesNotThrow(() => assertCatalogAliasEquivalenceE2eProofConnects(packet));
  });

  it("fails closed when a stage does not connect to the next", () => {
    const packet = runCatalogAliasEquivalenceE2eProof();
    assert.throws(
      () =>
        assertCatalogAliasEquivalenceE2eProofConnects({
          ...packet,
          stages: { ...packet.stages, search: { ...packet.stages.search, englishQueryFindsJapaneseCard: false } },
        }),
      /English search reaches the Japanese サボネア card/,
    );
    assert.throws(
      () =>
        assertCatalogAliasEquivalenceE2eProofConnects({
          ...packet,
          revocation: { ...packet.revocation, searchReachableAfterRevoke: true },
        }),
      /remove the alias from English search/,
    );
  });
});
