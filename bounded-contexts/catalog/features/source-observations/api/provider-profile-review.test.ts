import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { JsonValue } from "@chase-sets/primitives/json";
import {
  catalogProviderIntegrationProfileVersions,
  type CatalogProviderIntegrationProfileVersionRecord,
} from "./provider-integration-profiles";
import type { CatalogProviderProfileFixtureCase } from "./provider-profile-contract-harness";
import { catalogProviderProfileFixtureCases } from "./provider-profile-fixture-cases";
import type { CatalogProviderIntegrationProfileVersionStore } from "./provider-integration-profile-store";
import {
  activateCatalogProviderProfileVersionForReview,
  cloneCatalogProviderProfileVersionForReview,
  getCatalogProviderProfileAuthoringModel,
  updateCatalogProviderProfileVersionForReview,
  updateCatalogProviderProfileSectionForReview,
  dryRunCatalogProviderProfileVersion,
  listCatalogProviderProfileVersionReviews,
  retireCatalogProviderProfileVersionForReview,
} from "./provider-profile-review";

describe("Catalog provider profile review", () => {
  it("lists profile versions with validation status and review metadata", async () => {
    const reviews = await listCatalogProviderProfileVersionReviews(profileStore());

    expect(reviews.map((review) => [review.providerKey, review.profileVersion, review.validation.status])).toEqual([
      ["mtgjson", "2026.06.19", "valid"],
      ["mtgjson", "2026.06.19", "valid"],
      ["lorcanajson", "2026.06.23", "valid"],
      ["lorcanajson", "2026.06.23", "valid"],
      ["lorcast", "2026.06.23", "valid"],
      ["lorcast", "2026.06.23", "valid"],
      ["scryfall", "2026.06.19", "valid"],
      ["scryfall", "2026.06.19", "valid"],
      ["scrydex", "2026.06.22", "valid"],
      ["scrydex", "2026.06.22", "valid"],
      ["scrydex", "2026.06.22", "valid"],
      ["scrydex", "2026.06.23", "valid"],
      ["scrydex", "2026.06.23", "valid"],
      ["scrydex", "2026.06.23", "valid"],
      ["ygoprodeck", "2026.06.21", "valid"],
      ["ygoprodeck", "2026.06.21", "valid"],
      ["ygojson", "2026.06.21", "valid"],
      ["ygojson", "2026.07.14", "valid"],
      ["tcgdex", "2026.06.03", "valid"],
      ["tcgplayer", "2026.06.19", "valid"],
      ["tcgplayer", "2026.06.19", "valid"],
      ["tcgplayer", "2026.06.20", "valid"],
      ["tcgplayer", "2026.06.22", "valid"],
      ["tcgplayer", "2026.06.23", "valid"],
      ["tcgplayer", "2026.06.23", "valid"],
      ["tcgplayer", "2026.06.23", "valid"],
      ["tcgplayer", "2026.06.05", "valid"],
      ["tcgplayer", "2026.07.13", "valid"],
    ]);
    expect(reviews.find((review) => review.profileKey === "mtg-card-print-reference-data")).toMatchObject({
      connectorKind: "scryfall-json",
      sourceContract: {
        fixtureSetVersion: "scryfall-mtg-card-print-production-v1",
      },
      fixtures: {
        liveProviderCallsAllowed: false,
      },
      hasExecutableMappingContract: true,
    });
    expect(reviews.find((review) => review.profileKey === "mtg-card-reference-data")).toMatchObject({
      connectorKind: "mtgjson-json",
      ingestionUnitKey: "mtgjson:mtg:single-card:reference-data",
      sourceContract: {
        fixtureSetVersion: "mtgjson-mtg-card-reference-production-v1",
      },
      fixtures: {
        liveProviderCallsAllowed: false,
      },
      hasExecutableMappingContract: true,
    });
    expect(reviews.find((review) => review.profileKey === "mtg-sealed-product-sku")).toMatchObject({
      ingestionUnitKey: "tcgplayer:mtg:sealed-product:source-observation-import",
    });
    expect(reviews.find((review) => review.providerKey === "tcgdex")?.sourceOptionKinds).toEqual([
      expect.objectContaining({
        queryKind: "languages",
        scope: "language",
        parentScope: null,
      }),
      expect.objectContaining({
        queryKind: "series",
        scope: "series",
        parentScope: "language",
      }),
      expect.objectContaining({
        queryKind: "expansions",
        scope: "expansion",
        parentScope: "series",
      }),
    ]);
  });

  it("dry-runs executable profiles with redacted payload and mapping evidence", async () => {
    const result = await dryRunCatalogProviderProfileVersion({
      store: profileStore(),
      providerKey: "scryfall",
      profileKey: "mtg-card-print-reference-data",
      profileVersion: "2026.06.19",
      payload: scryfallPayload(),
      observedAt: "2026-06-03T00:00:00.000Z",
    });

    expect(result.status).toBe("completed");
    expect(result.observation).toMatchObject({
      providerKey: "scryfall",
      externalKey: "card:0000579f-7b35-4ed3-b44c-db2a538066fe",
      normalized: {
        kind: "magic-card-print",
        externalCatalogItemReferences: [{ providerKey: "tcgplayer", externalKey: "product:14240" }],
      },
    });
    expect(result.redactedPayload).toMatchObject({
      card: {
        prices: "[redacted]",
        auth: "[redacted]",
      },
    });
    expect(result.hashMaterial).toHaveLength(1);
    expect(result.mergeCandidateEvidence.map((evidence) => evidence.value)).toEqual([14240, "157", "Time Spiral"]);
    expect(result.duplicatePreventionPolicy).toEqual({
      ambiguousCandidatePolicy: "block-promotion",
      replayPolicy: "same-profile-version",
      exactExternalCatalogItemReferencesFirst: true,
    });
    expect(result.duplicatePreventionRules).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ruleKey: "exact-external-catalog-item-reference",
          candidatePolicy: "reuse",
        }),
      ]),
    );
    expect(result.duplicatePreventionCandidatePreview).toBeNull();
    expect(result.promotionCommandPlan.commands.map((command) => command.commandName)).toEqual([
      "CreateCatalogItem",
      "SetCatalogItemFieldValue",
      "LinkExternalCatalogItemReference",
    ]);
  });

  it("clones an existing profile version into an editable draft", async () => {
    const store = mutableProfileStore();

    const review = await cloneCatalogProviderProfileVersionForReview({
      store,
      providerKey: "tcgdex",
      profileVersion: "2026.06.03",
      targetProfileVersion: "2026.06.04",
      audit: {
        createdAt: "2026-06-03T00:00:00.000Z",
        createdByUserId: "usr_test",
        createdForAccountId: "acc_test",
        updatedAt: "2026-06-03T00:00:00.000Z",
        updatedByUserId: "usr_test",
        updatedForAccountId: "acc_test",
      },
    });

    expect(review).toMatchObject({
      providerKey: "tcgdex",
      profileVersion: "2026.06.04",
      lifecycle: "draft",
      active: false,
      authoringAudit: {
        createdByUserId: "usr_test",
      },
    });
    await expect(store.getProfileVersion("tcgdex", "2026.06.04")).resolves.toMatchObject({
      executableMappingContract: {
        profileVersion: "2026.06.04",
        lifecycle: "draft",
      },
    });
  });

  it("updates draft profile versions with migration evidence for later activation", async () => {
    const store = mutableProfileStore([tcgdexVersion("2026.06.04", "draft", false)]);

    const review = await updateCatalogProviderProfileVersionForReview({
      store,
      providerKey: "tcgdex",
      profileVersion: "2026.06.04",
      patch: {
        lifecycle: "test",
        migrationEvidence: {
          evidenceText: "Fixture harness and replay diff passed.",
          mappingFingerprintBefore: "before",
          mappingFingerprintAfter: "after",
          recordedAt: "2026-06-03T00:00:00.000Z",
        },
      },
      audit: {
        updatedAt: "2026-06-03T00:01:00.000Z",
        updatedByUserId: "usr_test",
        updatedForAccountId: "acc_test",
      },
    });

    expect(review).toMatchObject({
      lifecycle: "test",
      migrationEvidence: {
        evidenceText: "Fixture harness and replay diff passed.",
      },
      authoringAudit: {
        updatedByUserId: "usr_test",
      },
    });
    await expect(
      activateCatalogProviderProfileVersionForReview({
        store,
        providerKey: "tcgdex",
        profileVersion: "2026.06.04",
        fixtureCases: fixtureCasesForProfileVersion("tcgdex", "2026.06.04"),
        repositoryRoot: repositoryRoot(),
      }),
    ).resolves.toMatchObject({
      active: true,
      lifecycle: "active",
    });
  });

  it("blocks activation while same-provider integration work is active", async () => {
    const store = mutableProfileStore([
      ...catalogProviderIntegrationProfileVersions,
      tcgdexVersion("2026.06.04", "test", false),
    ]);

    await expect(
      activateCatalogProviderProfileVersionForReview({
        store,
        providerKey: "tcgdex",
        profileVersion: "2026.06.04",
        activeJobs: [
          {
            jobId: "job_import_tcgdex",
            jobKind: "integration",
            action: "import",
            status: "running",
            providerKey: "tcgdex",
            profileVersion: "2026.06.03",
          },
        ],
        fixtureCases: fixtureCasesForProfileVersion("tcgdex", "2026.06.04"),
        repositoryRoot: repositoryRoot(),
      }),
    ).rejects.toMatchObject({
      code: "profile_lifecycle_job_conflict",
      blockingJobs: [
        expect.objectContaining({
          jobId: "job_import_tcgdex",
          action: "import",
          profileVersion: "2026.06.03",
        }),
      ],
    });
  });

  it("blocks draft profile edits while provider-scoped promote work is active", async () => {
    const store = mutableProfileStore([tcgdexVersion("2026.06.04", "draft", false)]);

    await expect(
      updateCatalogProviderProfileVersionForReview({
        store,
        providerKey: "tcgdex",
        profileVersion: "2026.06.04",
        patch: { lifecycle: "test" },
        activeJobs: [
          {
            jobId: "job_promote_tcgdex",
            jobKind: "bulk-review",
            action: "promote",
            status: "queued",
            providerKey: "tcgdex",
            profileVersion: null,
          },
        ],
      }),
    ).rejects.toMatchObject({
      code: "profile_lifecycle_job_conflict",
      blockingJobs: [expect.objectContaining({ jobId: "job_promote_tcgdex", action: "promote" })],
    });
  });

  it("builds a UI authoring model with fixture templates, semantic diff, and activation readiness", async () => {
    const store = mutableProfileStore([
      ...catalogProviderIntegrationProfileVersions,
      tcgdexVersion("2026.06.04", "draft", false),
    ]);

    const model = await getCatalogProviderProfileAuthoringModel({
      store,
      providerKey: "tcgdex",
      profileVersion: "2026.06.04",
      repositoryRoot: repositoryRoot(),
    });

    expect(model.review).toMatchObject({
      providerKey: "tcgdex",
      profileVersion: "2026.06.04",
    });
    expect(model.editableSections.map((section) => section.section)).toEqual(
      expect.arrayContaining(["basics", "provider-options", "promotion-plan", "migration-evidence"]),
    );
    expect(model.fixtureCases.map((fixtureCase) => fixtureCase.flow)).toEqual(
      expect.arrayContaining(["normal", "ambiguous", "unknown-option"]),
    );
    expect(model.dryRunInputTemplate).toMatchObject({
      defaultFlow: "normal",
      payload: expect.objectContaining({ observationId: "tcgdex_en_sv01_001_standard" }),
    });
    expect(model.semanticDiff).toMatchObject({
      activeProfileVersion: "2026.06.03",
      mappingFingerprint: { changed: true },
    });
    expect(model.semanticDiff.changes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "executableMappingContract.normalizedObservation.hashMaterial",
          label: "Hash Material",
          severity: "error",
          activationImpact: expect.stringContaining("migration evidence"),
        }),
        expect.objectContaining({
          path: "executableMappingContract.duplicatePrevention",
          label: "Duplicate Prevention",
          severity: "error",
        }),
        expect.objectContaining({
          path: "profile.optionQueries",
          label: "Provider Option Queries",
          severity: "warning",
        }),
        expect.objectContaining({
          path: "migrationEvidence",
          label: "Migration Evidence",
          activationImpact: expect.stringContaining("fingerprint-changing activation"),
        }),
      ]),
    );
    expect(model.semanticDiff.changes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "executableMappingContract.duplicatePrevention",
          sectionKey: "duplicate-prevention",
          domainConcept: "Duplicate Prevention",
        }),
      ]),
    );
    expect(model.semanticDiff.sections).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sectionKey: "normalized-observation",
          domainConcept: "Normalized Observation",
          status: "error",
          changes: expect.arrayContaining([
            expect.objectContaining({
              path: "executableMappingContract.normalizedObservation.hashMaterial",
            }),
          ]),
        }),
      ]),
    );
    expect(model.activationReadiness).toMatchObject({
      status: "blocked",
      requiresMigrationEvidence: true,
      checks: expect.arrayContaining([
        expect.objectContaining({
          checkKey: "migration-evidence",
          code: "activation-migration-evidence",
          sectionKey: "migration-evidence",
          domainConcept: "Migration Evidence",
          status: "blocked",
          remediation: "Record migration evidence for mapping fingerprint changes.",
          blockingBehavior: "activation-blocking",
        }),
      ]),
      groups: expect.arrayContaining([
        expect.objectContaining({
          domainConcept: "Migration Evidence",
          status: "blocked",
        }),
      ]),
    });
    expect(model.sectionSummaries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sectionKey: "migration-evidence",
          domainConcept: "Migration Evidence",
          status: "blocked",
          readinessChecks: expect.arrayContaining([
            expect.objectContaining({
              checkKey: "migration-evidence",
            }),
          ]),
        }),
        expect.objectContaining({
          sectionKey: "normalized-observation",
          domainConcept: "Normalized Observation",
          status: "warning",
          semanticChanges: expect.arrayContaining([
            expect.objectContaining({
              path: "executableMappingContract.normalizedObservation.hashMaterial",
            }),
          ]),
        }),
      ]),
    );
    expect(model.selectedOptionSchema).toBeNull();
    expect(model.promotionTargetSchema).toBeNull();
  });

  it("links dry-run diagnostics back to semantic profile sections and fixture flows", async () => {
    const result = await dryRunCatalogProviderProfileVersion({
      store: profileStore(),
      providerKey: "scryfall",
      profileKey: "mtg-card-print-reference-data",
      profileVersion: "2026.06.19",
      payload: {},
      observedAt: "2026-06-03T00:00:00.000Z",
      fixtureFlow: "normal",
    });

    expect(result.status).toBe("blocked");
    expect(result.diagnosticLinks.length).toBeGreaterThan(0);
    expect(result.diagnosticLinks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sectionKey: "normalized-observation",
          domainConcept: "Normalized Observation",
          fixtureFlow: "normal",
        }),
      ]),
    );
  });

  it("includes selected option authoring schema when supplied by the admin runtime", async () => {
    const model = await getCatalogProviderProfileAuthoringModel({
      store: mutableProfileStore([tcgdexVersion("2026.06.04", "draft", false)]),
      providerKey: "tcgdex",
      profileVersion: "2026.06.04",
      repositoryRoot: repositoryRoot(),
      selectedOptionSchema: {
        dimensions: [
          {
            dimensionId: "dim_condition",
            dimensionKey: "condition",
            dimensionName: "Condition",
            status: "active",
            options: [
              {
                optionId: "opt_near_mint",
                optionKey: "near-mint",
                optionLabel: "Near Mint",
                status: "active",
              },
            ],
          },
        ],
      },
    });

    expect(model.selectedOptionSchema).toEqual({
      dimensions: [
        expect.objectContaining({
          dimensionKey: "condition",
          options: [expect.objectContaining({ optionKey: "near-mint" })],
        }),
      ],
    });
  });

  it("includes promotion target authoring schema when supplied by the admin runtime", async () => {
    const model = await getCatalogProviderProfileAuthoringModel({
      store: mutableProfileStore([tcgdexVersion("2026.06.04", "draft", false)]),
      providerKey: "tcgdex",
      profileVersion: "2026.06.04",
      repositoryRoot: repositoryRoot(),
      promotionTargetSchema: {
        blueprints: [{ id: "bp_pokemon", key: "pokemon-card-single", name: "Pokemon Card", status: "active" }],
        categories: [{ id: "cat_singles", key: "trading-card-singles", name: "Singles", status: "active" }],
        fields: [{ id: "fld_name", key: "card-name", name: "Card Name", status: "active" }],
      },
    });

    expect(model.promotionTargetSchema).toEqual({
      blueprints: [expect.objectContaining({ key: "pokemon-card-single" })],
      categories: [expect.objectContaining({ key: "trading-card-singles" })],
      fields: [expect.objectContaining({ key: "card-name" })],
    });
  });

  it("updates profile basics through typed section commands", async () => {
    const store = mutableProfileStore([tcgdexVersion("2026.06.04", "draft", false)]);

    const review = await updateCatalogProviderProfileSectionForReview({
      store,
      providerKey: "tcgdex",
      profileVersion: "2026.06.04",
      command: {
        section: "basics",
        lifecycle: "test",
        displayName: "TCGdex Authoring Candidate",
        status: "planned",
        capabilities: ["provider-option-query"],
        supportedScopes: ["language", "expansion"],
        languageOptions: ["en", "fr"],
      },
    });

    expect(review).toMatchObject({
      displayName: "TCGdex Authoring Candidate",
      lifecycle: "test",
      status: "planned",
      capabilities: ["provider-option-query"],
      supportedScopes: ["language", "expansion"],
      languageOptions: ["en", "fr"],
      executableMappingContract: {
        displayName: "TCGdex Authoring Candidate",
        lifecycle: "test",
      },
    });
  });

  it("updates provider option queries through typed section commands", async () => {
    const store = mutableProfileStore([tcgdexVersion("2026.06.04", "draft", false)]);
    const base = await store.getProfileVersion("tcgdex", "2026.06.04");
    if (!base) {
      throw new Error("Expected draft TCGdex profile version.");
    }

    const review = await updateCatalogProviderProfileSectionForReview({
      store,
      providerKey: "tcgdex",
      profileVersion: "2026.06.04",
      command: {
        section: "provider-options",
        optionQueries: [
          ...base.profile.optionQueries,
          {
            ...base.profile.optionQueries[0],
            queryKind: "language-audit",
            displayName: "Language Audit",
          },
        ],
      },
    });

    expect(review.profile.optionQueries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          queryKind: "language-audit",
          displayName: "Language Audit",
        }),
      ]),
    );
  });

  it("updates executable promotion plans while preserving profile identity", async () => {
    const store = mutableProfileStore([tcgdexVersion("2026.06.04", "draft", false)]);
    const base = await store.getProfileVersion("tcgdex", "2026.06.04");
    if (!base?.executableMappingContract) {
      throw new Error("Expected draft TCGdex executable mapping contract.");
    }

    const review = await updateCatalogProviderProfileSectionForReview({
      store,
      providerKey: "tcgdex",
      profileVersion: "2026.06.04",
      command: {
        section: "promotion-plan",
        promotionCommandPlan: {
          ...base.executableMappingContract.promotionCommandPlan,
          commands: [],
        },
      },
    });

    expect(review.executableMappingContract).toMatchObject({
      providerKey: "tcgdex",
      profileKey: "pokemon-tcg",
      profileVersion: "2026.06.04",
      lifecycle: "draft",
      promotionCommandPlan: {
        commands: [],
      },
    });
  });

  it("rejects fixture section commands that allow live provider calls", async () => {
    await expect(
      updateCatalogProviderProfileSectionForReview({
        store: mutableProfileStore([tcgdexVersion("2026.06.04", "draft", false)]),
        providerKey: "tcgdex",
        profileVersion: "2026.06.04",
        command: {
          section: "fixtures",
          fixtures: {
            fixtureRoot: "bounded-contexts/catalog/fixtures/source-observations/tcgdex",
            coveredFlows: ["normal"],
            liveProviderCallsAllowed: true,
          },
        },
      }),
    ).rejects.toThrow("fixtures.liveProviderCallsAllowed must remain false.");
  });

  it("blocks activation when fixture harness validation fails", async () => {
    await expect(
      activateCatalogProviderProfileVersionForReview({
        store: mutableProfileStore([tcgdexVersion("2026.06.04", "test", false)]),
        providerKey: "tcgdex",
        profileVersion: "2026.06.04",
        fixtureCases: fixtureCasesForProfileVersion("tcgdex", "2026.06.04").filter(
          (fixtureCase) => fixtureCase.flow !== "normal",
        ),
        repositoryRoot: repositoryRoot(),
      }),
    ).rejects.toThrow("failed fixture harness validation");
  });

  it("blocks activation when the profile is not eligible for imports", async () => {
    const version = tcgdexVersion("2026.06.04", "test", false);
    const importIneligibleVersion = {
      ...version,
      profile: {
        ...version.profile,
        capabilities: version.profile.capabilities.filter((capability) => capability !== "source-observation-import"),
      },
    };
    const store = mutableProfileStore([importIneligibleVersion]);

    const model = await getCatalogProviderProfileAuthoringModel({
      store,
      providerKey: "tcgdex",
      profileVersion: "2026.06.04",
      repositoryRoot: repositoryRoot(),
    });

    expect(model.activationReadiness).toMatchObject({
      status: "blocked",
      checks: expect.arrayContaining([
        expect.objectContaining({
          checkKey: "import-eligibility",
          status: "blocked",
          path: "profile.capabilities",
        }),
      ]),
    });
    await expect(
      activateCatalogProviderProfileVersionForReview({
        store,
        providerKey: "tcgdex",
        profileVersion: "2026.06.04",
        fixtureCases: fixtureCasesForProfileVersion("tcgdex", "2026.06.04"),
        repositoryRoot: repositoryRoot(),
      }),
    ).rejects.toThrow("requires the source-observation-import capability");
  });

  it("rejects edits to immutable active profile versions", async () => {
    await expect(
      updateCatalogProviderProfileVersionForReview({
        store: mutableProfileStore(),
        providerKey: "tcgdex",
        profileVersion: "2026.06.03",
        patch: { lifecycle: "test" },
      }),
    ).rejects.toThrow("Only draft or test Catalog provider profile versions can be edited; 'active' is immutable.");
  });

  it("blocks retirement while Source Observations still reference the profile version", async () => {
    await expect(
      retireCatalogProviderProfileVersionForReview({
        store: mutableProfileStore([tcgdexVersion("2026.06.04", "deprecated", false)], 3),
        providerKey: "tcgdex",
        profileVersion: "2026.06.04",
      }),
    ).rejects.toThrow("tcgdex@2026.06.04 is referenced by 3 Source Observations and cannot be retired");
  });
});

function profileStore(
  versions: readonly CatalogProviderIntegrationProfileVersionRecord[] = catalogProviderIntegrationProfileVersions,
): CatalogProviderIntegrationProfileVersionStore {
  return {
    seedProfileVersions: async () => versions,
    upsertProfileVersion: async (version) => version,
    listProfileVersions: async (providerKey) =>
      versions.filter((version) => !providerKey || version.providerKey === providerKey),
    getProfileVersion: async (providerKey, profileVersion, selector) =>
      versions.find(
        (version) =>
          version.providerKey === providerKey &&
          version.profileVersion === profileVersion &&
          selectorMatchesVersion(selector, version),
      ) ?? null,
    getActiveProfileVersion: async (providerKey, selector) =>
      versions.find(
        (version) => version.providerKey === providerKey && version.active && selectorMatchesVersion(selector, version),
      ) ?? null,
    activateProfileVersion: async (providerKey, profileVersion) => {
      const version = versions.find(
        (candidate) => candidate.providerKey === providerKey && candidate.profileVersion === profileVersion,
      );
      if (!version) {
        throw new Error("Profile version not found.");
      }
      return { ...version, lifecycle: "active", active: true };
    },
    deprecateProfileVersion: async (providerKey, profileVersion) => {
      const version = versions.find(
        (candidate) => candidate.providerKey === providerKey && candidate.profileVersion === profileVersion,
      );
      if (!version) {
        throw new Error("Profile version not found.");
      }
      return { ...version, lifecycle: "deprecated", active: false };
    },
    rollbackProfileVersion: async (providerKey, profileVersion) => {
      const version = versions.find(
        (candidate) => candidate.providerKey === providerKey && candidate.profileVersion === profileVersion,
      );
      if (!version) {
        throw new Error("Profile version not found.");
      }
      return { ...version, lifecycle: "active", active: true };
    },
    countProfileVersionReferences: async () => 0,
  };
}

function mutableProfileStore(
  versions: readonly CatalogProviderIntegrationProfileVersionRecord[] = catalogProviderIntegrationProfileVersions,
  referenceCount = 0,
): CatalogProviderIntegrationProfileVersionStore {
  let records = [...versions];
  return {
    seedProfileVersions: async () => records,
    upsertProfileVersion: async (version) => {
      records = records.filter(
        (candidate) =>
          !(
            candidate.providerKey === version.providerKey &&
            candidate.profileKey === version.profileKey &&
            candidate.profileVersion === version.profileVersion
          ),
      );
      if (version.active && version.lifecycle === "active") {
        records = records.map((candidate) =>
          candidate.providerKey === version.providerKey
            ? {
                ...candidate,
                active: false,
                lifecycle: "deprecated",
                executableMappingContract: candidate.executableMappingContract
                  ? { ...candidate.executableMappingContract, lifecycle: "deprecated" }
                  : undefined,
              }
            : candidate,
        );
      }
      records = [...records, version];
      return version;
    },
    listProfileVersions: async (providerKey) =>
      records.filter((version) => !providerKey || version.providerKey === providerKey),
    getProfileVersion: async (providerKey, profileVersion, selector) =>
      records.find(
        (version) =>
          version.providerKey === providerKey &&
          version.profileVersion === profileVersion &&
          selectorMatchesVersion(selector, version),
      ) ?? null,
    getActiveProfileVersion: async (providerKey, selector) =>
      records.find(
        (version) => version.providerKey === providerKey && version.active && selectorMatchesVersion(selector, version),
      ) ?? null,
    activateProfileVersion: async (providerKey, profileVersion) => {
      const version = records.find(
        (candidate) => candidate.providerKey === providerKey && candidate.profileVersion === profileVersion,
      );
      if (!version) {
        throw new Error("Profile version not found.");
      }
      const active = {
        ...version,
        lifecycle: "active" as const,
        active: true,
        executableMappingContract: version.executableMappingContract
          ? { ...version.executableMappingContract, lifecycle: "active" as const }
          : undefined,
      };
      records = records.map((candidate) =>
        candidate.providerKey === providerKey
          ? candidate.profileVersion === profileVersion
            ? active
            : {
                ...candidate,
                lifecycle: "deprecated" as const,
                active: false,
                executableMappingContract: candidate.executableMappingContract
                  ? { ...candidate.executableMappingContract, lifecycle: "deprecated" as const }
                  : undefined,
              }
          : candidate,
      );
      return active;
    },
    deprecateProfileVersion: async (providerKey, profileVersion) => {
      const version = records.find(
        (candidate) => candidate.providerKey === providerKey && candidate.profileVersion === profileVersion,
      );
      if (!version) {
        throw new Error("Profile version not found.");
      }
      const deprecated = { ...version, lifecycle: "deprecated" as const, active: false };
      records = records.map((candidate) => (candidate === version ? deprecated : candidate));
      return deprecated;
    },
    rollbackProfileVersion: async (providerKey, profileVersion) => {
      const version = records.find(
        (candidate) => candidate.providerKey === providerKey && candidate.profileVersion === profileVersion,
      );
      if (!version) {
        throw new Error("Profile version not found.");
      }
      const active = { ...version, lifecycle: "active" as const, active: true };
      records = records.map((candidate) =>
        candidate.providerKey === providerKey
          ? candidate.profileVersion === profileVersion
            ? active
            : { ...candidate, lifecycle: "deprecated" as const, active: false }
          : candidate,
      );
      return active;
    },
    countProfileVersionReferences: async () => referenceCount,
  };
}

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

function fixtureCasesForProfileVersion(
  providerKey: string,
  profileVersion: string,
): readonly CatalogProviderProfileFixtureCase[] {
  return catalogProviderProfileFixtureCases()
    .filter((fixtureCase) => fixtureCase.providerKey === providerKey)
    .map((fixtureCase) => ({
      ...fixtureCase,
      profileVersion,
    }));
}

function selectorMatchesVersion(
  selector: Readonly<{ profileKey?: string | null; ingestionUnitKey?: string | null }> | null | undefined,
  version: CatalogProviderIntegrationProfileVersionRecord,
): boolean {
  const profileKey = selector?.profileKey?.trim().toLowerCase();
  const ingestionUnitKey = selector?.ingestionUnitKey?.trim().toLowerCase();
  return (
    (!profileKey || version.profileKey.trim().toLowerCase() === profileKey) &&
    (!ingestionUnitKey ||
      (
        version.ingestionUnitIdentity?.unitKey ??
        version.executableMappingContract?.ingestionUnitIdentity?.unitKey ??
        ""
      )
        .trim()
        .toLowerCase() === ingestionUnitKey)
  );
}

function repositoryRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../..");
}

function scryfallPayload(): JsonValue {
  return {
    kind: "single-card",
    card: {
      object: "card",
      id: "0000579f-7b35-4ed3-b44c-db2a538066fe",
      name: "Fury Sliver",
      lang: "en",
      released_at: "2006-10-06",
      uri: "https://api.scryfall.com/cards/0000579f-7b35-4ed3-b44c-db2a538066fe",
      scryfall_uri: "https://scryfall.com/card/tsp/157/fury-sliver",
      set: "tsp",
      set_name: "Time Spiral",
      collector_number: "157",
      image_uris: {
        normal: "https://cards.scryfall.io/normal/front/0/0/0000579f-7b35-4ed3-b44c-db2a538066fe.jpg",
      },
      tcgplayer_id: 14240,
      prices: {
        usd: "0.42",
      },
      auth: {
        cookie: "TCGAuthTicket_Production=secret",
      },
    },
  };
}
