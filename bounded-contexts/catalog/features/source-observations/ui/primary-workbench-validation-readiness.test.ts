import {
  buildCatalogPrimaryWorkbenchReadModel,
  buildCatalogPrimaryWorkbenchSourceObservationReviewQuery,
  catalogProviderProfileEditableSectionKeys,
  cleanVerificationReport,
  controlPlaneOverview,
  describe,
  expect,
  integrationJobSummary,
  it,
  jsonClone,
  lifecycleImpact,
  profileAuthoringModel,
  profileReview,
  sourceObservationListItem,
  sourceObservationScope,
  tcgdexPokemonCardSourceObservationMappingContract,
  tcgdexPokemonTcgProviderProfile,
  tcgplayerAutomationClientProviderProfile,
  validateCatalogPrimaryWorkbenchReadModelContract,
  type CatalogProviderIntegrationProfile,
} from "./primary-workbench-read-model-test-support";

describe("Catalog primary workbench read model - validation readiness", () => {
  it("builds validation cockpit evidence from fixture, dry-run, compare, and readiness contracts", () => {
    const profile = profileReview({
      active: true,
      lifecycle: "active",
      executableMappingContract: tcgdexPokemonCardSourceObservationMappingContract,
      profile: {
        providerKey: "tcgdex",
        supportedScopes: ["pokemon/card"],
        selectedOptionMapping: {
          dimensions: [
            {
              dimensionKey: "foil-treatment",
              sourcePath: "card.variant.displayName",
            },
          ],
        },
      },
      fixtures: {
        fixtureRoot: "bounded-contexts/catalog/features/source-observations/api/__fixtures__/tcgdex",
        coveredFlows: [
          "normal",
          "partial",
          "stale",
          "changed",
          "ambiguous",
          "replay",
          "sealed-product",
          "unknown-option",
        ],
        liveProviderCallsAllowed: false,
      },
    });
    const overview = controlPlaneOverview();
    const readModel = buildCatalogPrimaryWorkbenchReadModel({
      requestUrl:
        "https://admin.example/catalog/integrations?providerKey=tcgdex&unitKey=tcgdex:pokemon:card:import&profileVersion=2026.06.04&section=readiness",
      scopes: { items: [sourceObservationScope()], total: 1, count: 1 },
      profileReviews: { items: [profile], total: 1, count: 1 },
      profileAuthoringModel: profileAuthoringModel({ review: profile }),
      controlPlaneOverview: {
        ...overview,
        readiness: {
          ...overview.readiness,
          units: [
            {
              ...overview.readiness.units[0],
              dryRunEvidence: [
                {
                  externalKey: "en:sv01-001",
                  sourceUrl: "fixture://tcgdex/normal.json",
                  sourceHash: "sha256:tcgdex-normal",
                  normalizedFacts: {
                    name: "Sprigatito",
                    cardNumber: "001",
                    cardVariantKey: "standard",
                  },
                },
              ],
            },
          ],
        },
      },
      canManageCatalog: true,
    });

    expect(readModel.validationReadiness.status).toBe("degraded");
    expect(readModel.validationReadiness.fixtureFlows.every((flow) => flow.status === "ready")).toBe(true);
    expect(readModel.validationReadiness.dryRunEvidence[0]).toMatchObject({
      externalKey: "en:sv01-001",
      normalizedFacts: expect.arrayContaining([{ key: "name", value: "Sprigatito" }]),
    });
    expect(readModel.validationReadiness.dryRunEvidence[0]?.duplicateCandidates.length).toBeGreaterThan(0);
    expect(readModel.validationReadiness.dryRunEvidence[0]?.selectedOptions).toEqual(
      expect.arrayContaining([expect.objectContaining({ label: "Option dimension: foil-treatment" })]),
    );
    expect(
      readModel.validationReadiness.dryRunEvidence[0]?.promotionCommandPreview.map((command) => command.commandName),
    ).toEqual(expect.arrayContaining(["CreateCatalogItem", "LinkExternalCatalogItemReference"]));
    expect(readModel.validationReadiness.semanticCompare.mappingFingerprint).toMatchObject({
      candidate: "sha256:candidate-mapping",
      active: "sha256:active-mapping",
      changed: true,
    });
    expect(readModel.validationReadiness.semanticCompare.unchangedSections).toEqual(
      expect.arrayContaining([expect.objectContaining({ domainConcept: "Promotion Plan" })]),
    );
    expect(readModel.validationReadiness.activationDecision).toMatchObject({
      status: "blocked",
      actionState: "blocked",
      blockers: expect.arrayContaining(["migration-evidence-missing", "reference-impact-review-required"]),
      migrationEvidence: { state: "required" },
      affectedReferences: {
        referenceCount: 2,
        requiresMigrationEvidence: true,
      },
    });
    expect(readModel.actions.find((action) => action.key === "provider-profile.activate")).toMatchObject({
      state: "blocked",
      blockers: expect.arrayContaining(["migration-evidence-missing", "reference-impact-review-required"]),
    });
    expect(JSON.stringify(readModel.validationReadiness)).not.toMatch(/raw\s+json/i);
  });

  it("models ready activation when migration evidence is recorded", () => {
    const profile = profileReview({
      executableMappingContract: tcgdexPokemonCardSourceObservationMappingContract,
      migrationEvidence: {
        evidenceText: "Validated fixture run and reviewed changed mapping fingerprint.",
        fixtureRunId: "fixture_run_123",
        mappingFingerprintBefore: "sha256:active-mapping",
        mappingFingerprintAfter: "sha256:candidate-mapping",
        recordedAt: "2026-06-09T02:00:00.000Z",
        recordedByUserId: "operator_123",
      },
    });
    const overview = controlPlaneOverview();
    const readModel = buildCatalogPrimaryWorkbenchReadModel({
      requestUrl:
        "https://admin.example/catalog/integrations?providerKey=tcgdex&unitKey=tcgdex:pokemon:card:import&profileVersion=2026.06.04&section=readiness",
      scopes: { items: [sourceObservationScope()], total: 1, count: 1 },
      profileReviews: { items: [profile], total: 1, count: 1 },
      profileAuthoringModel: profileAuthoringModel({ review: profile }),
      controlPlaneOverview: {
        ...overview,
        unitActivity: {
          ...overview.unitActivity,
          units: overview.unitActivity.units.map((unit) => ({ ...unit, recentJobs: [] })),
        },
      },
      canManageCatalog: true,
    });

    expect(readModel.validationReadiness.activationDecision).toMatchObject({
      status: "ready",
      actionState: "available",
      blockers: [],
      activationCommandKey: "provider-profile.activate",
      evidenceCommandKey: "provider-profile.edit-section",
      migrationEvidence: {
        state: "recorded",
        fixtureRunId: "fixture_run_123",
        recordedByUserId: "operator_123",
      },
      affectedReferences: {
        referenceCount: 2,
        requiresMigrationEvidence: true,
      },
    });
    expect(readModel.validationReadiness.activationDecision.affectedReferences.replayImplications).toEqual(
      expect.arrayContaining([expect.stringMatching(/2 existing references/)]),
    );
  });

  it("denies activation and migration evidence writes for view-only operators", () => {
    const profile = profileReview({
      executableMappingContract: tcgdexPokemonCardSourceObservationMappingContract,
      migrationEvidence: {
        evidenceText: "Validated fixture run and reviewed changed mapping fingerprint.",
        recordedAt: "2026-06-09T02:00:00.000Z",
      },
    });
    const readModel = buildCatalogPrimaryWorkbenchReadModel({
      requestUrl:
        "https://admin.example/catalog/integrations?providerKey=tcgdex&unitKey=tcgdex:pokemon:card:import&profileVersion=2026.06.04&section=readiness",
      scopes: { items: [sourceObservationScope()], total: 1, count: 1 },
      profileReviews: { items: [profile], total: 1, count: 1 },
      profileAuthoringModel: profileAuthoringModel({ review: profile }),
      controlPlaneOverview: controlPlaneOverview(),
      canManageCatalog: false,
    });

    expect(readModel.validationReadiness.activationDecision).toMatchObject({
      status: "blocked",
      actionState: "denied",
      saveEvidenceState: "denied",
      blockers: expect.arrayContaining(["permission-denied"]),
      saveEvidenceBlockers: expect.arrayContaining(["permission-denied"]),
    });
  });

  it("groups blocked validation readiness with exact remediation and long diagnostic paths", () => {
    const longPath =
      "executableMappingContract.normalizedObservation.fields.variants.providerSpecific.parallelFoilTreatment.sourceSelector.path";
    const profile = profileReview({
      active: true,
      lifecycle: "active",
      executableMappingContract: tcgdexPokemonCardSourceObservationMappingContract,
      validation: {
        status: "invalid",
        diagnostics: [
          {
            code: "missing-required-path",
            path: longPath,
            diagnosticText: "Variant foil treatment selector is missing.",
            severity: "error",
          },
        ],
      },
      fixtures: {
        fixtureRoot: "bounded-contexts/catalog/features/source-observations/api/__fixtures__/tcgdex",
        coveredFlows: ["normal"],
        liveProviderCallsAllowed: false,
      },
    });
    const overview = controlPlaneOverview();
    const readModel = buildCatalogPrimaryWorkbenchReadModel({
      requestUrl:
        "https://admin.example/catalog/integrations?providerKey=tcgdex&unitKey=tcgdex:pokemon:card:import&profileVersion=2026.06.04&section=readiness",
      scopes: { items: [sourceObservationScope()], total: 1, count: 1 },
      profileReviews: { items: [profile], total: 1, count: 1 },
      profileAuthoringModel: profileAuthoringModel({
        review: profile,
        activationReadiness: {
          status: "blocked",
          checks: [
            {
              checkKey: "normalized-observation:variant-foil",
              code: "missing-required-path",
              sectionKey: "normalized-observation",
              domainConcept: "Normalized Observation",
              status: "blocked",
              path: longPath,
              diagnosticText: "Variant foil treatment selector is missing.",
              severity: "error",
              remediation: "Map the provider foil treatment before activation.",
              blockingBehavior: "fail-closed",
            },
          ],
          groups: [
            {
              domainConcept: "Normalized Observation",
              status: "blocked",
              checks: [
                {
                  checkKey: "normalized-observation:variant-foil",
                  code: "missing-required-path",
                  sectionKey: "normalized-observation",
                  domainConcept: "Normalized Observation",
                  status: "blocked",
                  path: longPath,
                  diagnosticText: "Variant foil treatment selector is missing.",
                  severity: "error",
                  remediation: "Map the provider foil treatment before activation.",
                  blockingBehavior: "fail-closed",
                },
              ],
            },
          ],
          requiresMigrationEvidence: true,
          referenceCount: 2,
        },
      }),
      controlPlaneOverview: {
        ...overview,
        readiness: {
          ...overview.readiness,
          units: [
            {
              ...overview.readiness.units[0],
              fixtureValidationStatus: "blocked",
              dryRunStatus: "blocked",
              diagnosticCounts: { info: 0, warning: 0, error: 1 },
              diagnostics: [
                {
                  code: "fixture-harness-failure",
                  severity: "error",
                  message: "Fixture dry-run blocked by normalized observation mapping.",
                  unitKey: "tcgdex:pokemon:card:import",
                  retryAfterSeconds: null,
                  source: "catalog",
                },
              ],
              latestDiagnosticText: "Fixture dry-run blocked by normalized observation mapping.",
              dryRunEvidence: [],
            },
          ],
        },
      },
      canManageCatalog: true,
    });

    expect(readModel.validationReadiness.status).toBe("blocked");
    expect(readModel.validationReadiness.summary.blockedFixtureFlows).toBeGreaterThan(0);
    expect(readModel.validationReadiness.activationReadiness.groups).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          domainConcept: "Normalized Observation",
          checks: [
            expect.objectContaining({
              path: longPath,
              remediation: "Map the provider foil treatment before activation.",
            }),
          ],
        }),
      ]),
    );
    expect(readModel.validationReadiness.dryRunEvidence[0]?.diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: longPath })]),
    );
  });
});
