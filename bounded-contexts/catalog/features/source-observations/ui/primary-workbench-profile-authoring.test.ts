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

describe("Catalog primary workbench read model - profile authoring", () => {
  it("builds provider profile overview and draft creation evidence from typed review records", () => {
    const readModel = buildCatalogPrimaryWorkbenchReadModel({
      requestUrl: "https://admin.example/catalog/integrations?providerKey=tcgdex&section=profile-work",
      scopes: { items: [sourceObservationScope()], total: 1, count: 1 },
      profileReviews: {
        items: [
          profileReview({
            active: true,
            lifecycle: "active",
            referenceCount: 3,
            authoringAudit: {
              createdAt: "2026-06-08T00:00:00.000Z",
              createdByUserId: "user_admin",
              updatedAt: "2026-06-09T00:00:00.000Z",
              updatedByUserId: "user_editor",
            },
            migrationEvidence: {
              evidenceText: "Validated mapping change.",
              mappingFingerprintBefore: "sha256:old",
              mappingFingerprintAfter: "sha256:new",
              fixtureRunId: "fixture_run_001",
              recordedAt: "2026-06-09T00:10:00.000Z",
            },
          }),
        ],
        total: 1,
        count: 1,
      },
      controlPlaneOverview: null,
      canManageCatalog: true,
    });

    expect(readModel.profileAuthoring.status).toBe("ready");
    expect(readModel.profileAuthoring.selectedProfile).toMatchObject({
      providerKey: "tcgdex",
      profileKey: "tcgdex-pokemon-card",
      profileVersion: "2026.06.04",
      lifecycle: "active",
      referenceCount: 3,
      mappingFingerprint: "sha256:new",
      validation: {
        status: "valid",
        diagnosticCount: 0,
      },
      fixtures: {
        coveredFlows: ["normal", "changed", "replay"],
      },
      migrationEvidence: {
        state: "recorded",
        fixtureRunId: "fixture_run_001",
      },
    });
    expect(readModel.profileAuthoring.cloneDraft).toMatchObject({
      commandKey: "provider-profile.clone",
      sourceProviderKey: "tcgdex",
      sourceProfileVersion: "2026.06.04",
      targetProfileVersion: "2026.06.04-draft",
      targetLifecycle: "draft",
      state: "available",
      blockers: [],
    });
    expect(readModel.profileAuthoring.cloneDraft.immutableIdentityFacts.map((fact) => fact.key)).toEqual([
      "provider-key",
      "profile-key",
      "source-contract-owner",
      "source-contract-repository",
      "connector-kind",
      "supported-scopes",
    ]);
    expect(readModel.actions.find((action) => action.key === "provider-profile.clone")).toMatchObject({
      state: "available",
      blockers: [],
    });
  });

  it("projects every registered profile section into guided workspaces without raw editors", () => {
    const readModel = buildCatalogPrimaryWorkbenchReadModel({
      requestUrl:
        "https://admin.example/catalog/integrations?providerKey=tcgdex&section=profile-work&profileVersion=2026.06.04-draft",
      scopes: { items: [sourceObservationScope()], total: 1, count: 1 },
      profileReviews: {
        items: [profileReview({ active: false, lifecycle: "draft", profileVersion: "2026.06.04-draft" })],
        total: 1,
        count: 1,
      },
      controlPlaneOverview: null,
      canManageCatalog: true,
    });

    expect(readModel.profileAuthoring.sectionGroups.map((group) => group.key)).toEqual([
      "profile-foundation",
      "provider-acquisition",
      "observation-mapping",
      "catalog-promotion",
      "evidence-lifecycle",
    ]);
    expect(readModel.profileAuthoring.sectionWorkspaces.map((workspace) => workspace.sectionKey)).toEqual([
      ...catalogProviderProfileEditableSectionKeys,
    ]);
    for (const workspace of readModel.profileAuthoring.sectionWorkspaces) {
      expect(workspace.commandKey).toBe("provider-profile.edit-section");
      expect(workspace.actionState).toBe("available");
      expect(workspace.fields.length).toBeGreaterThan(0);
      expect(`${workspace.displayName} ${workspace.fields.map((field) => field.label).join(" ")}`).not.toMatch(
        /raw JSON|Profile JSON|Candidate JSON|Active JSON/i,
      );
    }
  });

  it("projects provider option queries, cache health, and import-scope controls from profile data", () => {
    const baseOverview = controlPlaneOverview();
    const readModel = buildCatalogPrimaryWorkbenchReadModel({
      requestUrl:
        "https://admin.example/catalog/integrations?providerKey=tcgdex&unitKey=tcgdex:pokemon:card:import&importScope=en:3:base:base1&section=profile-work&profileVersion=2026.06.04-draft",
      scopes: { items: [sourceObservationScope()], total: 1, count: 1 },
      profileReviews: {
        items: [
          profileReview({
            active: false,
            lifecycle: "draft",
            profileVersion: "2026.06.04-draft",
            profile: jsonClone(tcgdexPokemonTcgProviderProfile),
            capabilities: [...tcgdexPokemonTcgProviderProfile.capabilities],
            supportedScopes: [...tcgdexPokemonTcgProviderProfile.supportedScopes],
            languageOptions: [...tcgdexPokemonTcgProviderProfile.languageOptions],
          }),
        ],
        total: 1,
        count: 1,
      },
      controlPlaneOverview: controlPlaneOverview({
        providerReadiness: {
          ...baseOverview.providerReadiness,
          providers: [
            {
              ...baseOverview.providerReadiness.providers[0]!,
              optionQueryHealth: {
                status: "degraded",
                diagnosticCodes: ["provider-option-query-stale-cache-used"],
                message: "Stale provider option query cache used during adapter recovery.",
              },
            },
          ],
        },
      }),
      canManageCatalog: true,
    });

    const providerOptions = readModel.profileAuthoring.sectionWorkspaces.find(
      (workspace) => workspace.sectionKey === "provider-options",
    );
    expect(providerOptions?.optionQueries.map((query) => query.queryKind)).toEqual([
      "languages",
      "series",
      "expansions",
    ]);
    expect(providerOptions?.optionQueries[1]).toMatchObject({
      queryKeySynonyms: [],
      scope: "series",
      parentScope: "language",
      parentRequired: false,
      parentValueKind: "language-code",
      operation: "tcgdex-list-series",
    });
    expect(providerOptions?.optionQueries[2]?.outputMappings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: "Description", path: "tcgdex-expansion-card-count" }),
        expect.objectContaining({ label: "Image fallback 1", path: "symbolUrl" }),
        expect.objectContaining({ label: "Metadata: expansionId", path: "expansionId" }),
      ]),
    );
    expect(providerOptions?.optionQueries[0]?.cacheState).toMatchObject({
      status: "degraded",
      diagnosticCodes: ["provider-option-query-stale-cache-used"],
      freshTtlMinutes: 15,
      staleTtlHours: 24,
    });
    expect(providerOptions?.optionQueries[0]?.cacheState.description).toContain("Stale provider option query cache");

    const basics = readModel.profileAuthoring.sectionWorkspaces.find((workspace) => workspace.sectionKey === "basics");
    expect(basics?.importScopeControls.map((scope) => scope.scope)).toEqual([
      "language",
      "series",
      "expansion",
      "product/card",
    ]);
    expect(basics?.importScopeControls.find((scope) => scope.scope === "language")).toMatchObject({
      state: "available",
      importScope: "en",
    });
    expect(basics?.importScopeControls.find((scope) => scope.scope === "series")).toMatchObject({
      state: "available",
      importScope: "en:base",
    });
    expect(basics?.importScopeControls.find((scope) => scope.scope === "expansion")).toMatchObject({
      state: "selected",
      importScope: "en:3:base:base1",
      expectedObservationCount: 142,
      changedCount: 24,
      reason: null,
    });
    // The import-scope control links back to the daily import-to-promotion surface
    // route, which carries no ?section= (it is the surface default).
    const productCardHref = basics?.importScopeControls.find((scope) => scope.scope === "product/card")?.href ?? "";
    expect(new URL(productCardHref, "https://admin.example").pathname).toBe("/catalog/integrations");
    expect(productCardHref).not.toContain("section=");
  });

  it("explains unavailable TCGplayer import scopes while keeping option query authoring provider-neutral", () => {
    const readModel = buildCatalogPrimaryWorkbenchReadModel({
      requestUrl:
        "https://admin.example/catalog/integrations?providerKey=tcgplayer&unitKey=tcgplayer%3Aproduct-line%3Acategory%3Aimport&importScope=en%3A3&section=profile-work&profileVersion=2026.06.04-draft",
      scopes: {
        items: [
          sourceObservationScope({
            provider_key: "tcgplayer",
            language_code: "en",
            product_line_id: "3",
            product_line_name: "Pokemon",
            series_id: "",
            series_name: "",
            expansion_id: "",
            expansion_name: "",
          }),
        ],
        total: 1,
        count: 1,
      },
      profileReviews: {
        items: [
          profileReview({
            providerKey: "tcgplayer",
            profileKey: "tcgplayer-pokemon",
            active: false,
            lifecycle: "draft",
            profileVersion: "2026.06.04-draft",
            displayName: "TCGplayer Pokemon",
            connectorKind: "tcgplayer-automation-client",
            profile: jsonClone(tcgplayerAutomationClientProviderProfile),
            capabilities: [...tcgplayerAutomationClientProviderProfile.capabilities],
            supportedScopes: [...tcgplayerAutomationClientProviderProfile.supportedScopes],
            languageOptions: [...tcgplayerAutomationClientProviderProfile.languageOptions],
          }),
        ],
        total: 1,
        count: 1,
      },
      controlPlaneOverview: null,
      canManageCatalog: true,
    });

    const providerOptions = readModel.profileAuthoring.sectionWorkspaces.find(
      (workspace) => workspace.sectionKey === "provider-options",
    );
    expect(providerOptions?.optionQueries.map((query) => [query.queryKind, query.operation])).toEqual([
      ["product-lines", "tcgplayer-list-product-lines"],
      ["set-names", "tcgplayer-list-set-names"],
      ["products", "tcgplayer-list-products"],
      ["skus", "tcgplayer-list-skus"],
    ]);
    expect(providerOptions?.optionQueries.find((query) => query.queryKind === "set-names")).toMatchObject({
      queryKeySynonyms: ["set-name", "sets"],
      parentScope: "product-line/category",
      parentRequired: true,
      parentValueKind: "product-line-id",
    });

    const basics = readModel.profileAuthoring.sectionWorkspaces.find((workspace) => workspace.sectionKey === "basics");
    expect(basics?.importScopeControls.find((scope) => scope.scope === "product-line/category")).toMatchObject({
      state: "selected",
      importScope: "en:3",
    });
    expect(basics?.importScopeControls.find((scope) => scope.scope === "set-name")).toMatchObject({
      state: "unavailable",
      href: null,
      expectedObservationCount: 0,
      reason: "No current provider scope rows expose a selectable Set Name control.",
    });
    expect(basics?.importScopeControls.find((scope) => scope.scope === "sku")?.reason).toBe(
      "No current provider scope rows expose a selectable Sku control.",
    );
  });

  it("projects Scrydex-style option queries without adding provider-specific Admin branches", () => {
    const scrydexProfile = {
      ...tcgdexPokemonTcgProviderProfile,
      providerKey: "scrydex",
      displayName: "Scrydex",
      supportedScopes: ["product/card"],
      optionQueries: [
        {
          queryKind: "sets",
          queryKeySynonyms: ["expansions"],
          displayName: "Set",
          scope: "expansion",
          parentScope: null,
          operation: "scrydex-list-sets",
          output: {
            valuePath: "id",
            labelPath: "name",
            metadataPaths: { setId: "id", code: "code" },
          },
        },
      ],
    } satisfies CatalogProviderIntegrationProfile;
    const readModel = buildCatalogPrimaryWorkbenchReadModel({
      requestUrl:
        "https://admin.example/catalog/integrations?providerKey=scrydex&section=profile-work&profileVersion=2026.06.22-draft",
      scopes: {
        items: [
          sourceObservationScope({
            provider_key: "scrydex",
            product_line_id: "one-piece-card-game",
            product_line_name: "One Piece Card Game",
            series_id: "",
            series_name: "",
            expansion_id: "op01",
            expansion_name: "Romance Dawn",
          }),
        ],
        total: 1,
        count: 1,
      },
      profileReviews: {
        items: [
          profileReview({
            providerKey: "scrydex",
            profileKey: "one-piece-card-print-source-observation",
            active: false,
            lifecycle: "draft",
            profileVersion: "2026.06.22-draft",
            displayName: "Scrydex",
            connectorKind: "scrydex-json",
            profile: jsonClone(scrydexProfile),
            capabilities: [...scrydexProfile.capabilities],
            supportedScopes: [...scrydexProfile.supportedScopes],
            languageOptions: [...scrydexProfile.languageOptions],
          }),
        ],
        total: 1,
        count: 1,
      },
      controlPlaneOverview: null,
      canManageCatalog: true,
    });

    const providerOptions = readModel.profileAuthoring.sectionWorkspaces.find(
      (workspace) => workspace.sectionKey === "provider-options",
    );
    expect(providerOptions?.optionQueries).toEqual([
      expect.objectContaining({
        queryKind: "sets",
        queryKeySynonyms: ["expansions"],
        scope: "expansion",
        operation: "scrydex-list-sets",
        outputMappings: expect.arrayContaining([
          expect.objectContaining({ label: "Value", path: "id" }),
          expect.objectContaining({ label: "Metadata: code", path: "code" }),
        ]),
      }),
    ]);
  });

  it("projects executable mapping rows with preview, diagnostics, editor affordances, and long-path-safe summaries", () => {
    const longPath =
      "source.payload.card.localized.attributes.marketplace.identity.deeply.nested.collectorNumber.with.extra.context.for.operator.review";
    const executableMappingContract = {
      ...tcgdexPokemonCardSourceObservationMappingContract,
      normalizedObservation: {
        ...tcgdexPokemonCardSourceObservationMappingContract.normalizedObservation,
        fields: {
          ...tcgdexPokemonCardSourceObservationMappingContract.normalizedObservation.fields,
          longOperatorPath: {
            selector: { kind: "path", path: longPath, required: true, nullPolicy: "diagnostic" },
            owner: "catalog-truth",
            uses: ["normalized-observation", "hash-material"],
            redaction: "none",
          },
        },
      },
    };
    const readModel = buildCatalogPrimaryWorkbenchReadModel({
      requestUrl:
        "https://admin.example/catalog/integrations?providerKey=tcgdex&section=profile-work&profileVersion=2026.06.04-draft",
      scopes: { items: [sourceObservationScope()], total: 1, count: 1 },
      profileReviews: {
        items: [
          profileReview({
            active: false,
            lifecycle: "draft",
            profileVersion: "2026.06.04-draft",
            profile: jsonClone(tcgdexPokemonTcgProviderProfile),
            executableMappingContract: jsonClone(executableMappingContract),
            validation: {
              status: "invalid",
              diagnostics: [
                {
                  code: "long-path-review",
                  path: "executableMappingContract.normalizedObservation.fields.longOperatorPath",
                  diagnosticText: "Long source path needs operator review.",
                  severity: "warning",
                },
              ],
            },
          }),
        ],
        total: 1,
        count: 1,
      },
      controlPlaneOverview: null,
      canManageCatalog: true,
    });

    const sourceObservation = readModel.profileAuthoring.sectionWorkspaces.find(
      (workspace) => workspace.sectionKey === "source-observation",
    );
    expect(sourceObservation?.mappingRows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          label: "Observation id",
          path: "executableMappingContract.sourceObservation.observationId",
          owner: "catalog-merge-evidence",
          uses: ["normalized-observation"],
          previewAvailable: true,
        }),
      ]),
    );

    const normalized = readModel.profileAuthoring.sectionWorkspaces.find(
      (workspace) => workspace.sectionKey === "normalized-observation",
    );
    expect(normalized?.mappingRows.find((row) => row.key === "normalized-observation.hashMaterial.0")).toMatchObject({
      affordances: {
        duplicate: true,
        reorder: true,
        remove: true,
        inlineDiagnostics: true,
        longPathSafe: true,
      },
    });
    const longRow = normalized?.mappingRows.find((row) => row.key === "normalized-observation.field.longOperatorPath");
    expect(longRow?.summary).toContain("...");
    expect(longRow?.summary.length).toBeLessThanOrEqual(120);
    expect(longRow?.diagnostics).toEqual([
      expect.objectContaining({
        diagnosticText: "Long source path needs operator review.",
        severity: "warning",
      }),
    ]);
  });

  it("marks section save outcomes, diagnostics, and stale conflicts at section scope", () => {
    const readModel = buildCatalogPrimaryWorkbenchReadModel({
      requestUrl:
        "https://admin.example/catalog/integrations?providerKey=tcgdex&section=profile-work&profileVersion=2026.06.04-draft&commandIntent=provider-profile.edit-section&commandStatus=error&commandResult=section-conflict&commandSection=source-contract",
      scopes: { items: [sourceObservationScope()], total: 1, count: 1 },
      profileReviews: {
        items: [
          profileReview({
            active: false,
            lifecycle: "draft",
            profileVersion: "2026.06.04-draft",
            validation: {
              status: "invalid",
              diagnostics: [
                {
                  code: "source-contract-owner",
                  path: "sourceContract.owner",
                  diagnosticText: "Source contract owner is required.",
                  severity: "error",
                },
              ],
            },
          }),
        ],
        total: 1,
        count: 1,
      },
      controlPlaneOverview: null,
      canManageCatalog: true,
    });

    const sourceContract = readModel.profileAuthoring.sectionWorkspaces.find(
      (workspace) => workspace.sectionKey === "source-contract",
    );

    expect(sourceContract).toMatchObject({
      status: "error",
      staleState: "conflict",
      saveOutcome: "conflict",
      blockers: ["profile-section-stale"],
    });
    expect(sourceContract?.diagnostics[0]).toMatchObject({
      path: "sourceContract.owner",
      diagnosticText: "Source contract owner is required.",
    });
  });

  it("keeps profile evidence visible while denying draft creation for view-only operators", () => {
    const readModel = buildCatalogPrimaryWorkbenchReadModel({
      requestUrl: "https://admin.example/catalog/integrations?providerKey=tcgdex&section=profile-work",
      scopes: { items: [sourceObservationScope()], total: 1, count: 1 },
      profileReviews: { items: [profileReview({ active: true, lifecycle: "active" })], total: 1, count: 1 },
      controlPlaneOverview: null,
      canManageCatalog: false,
    });

    expect(readModel.profileAuthoring.selectedProfile?.profileVersion).toBe("2026.06.04");
    expect(readModel.profileAuthoring.cloneDraft).toMatchObject({
      state: "denied",
      blockers: ["permission-denied"],
    });
    expect(readModel.actions.find((action) => action.key === "provider-profile.clone")).toMatchObject({
      state: "denied",
      blockers: ["permission-denied"],
    });
  });

  it("fails closed when route-selected profile version is stale", () => {
    const readModel = buildCatalogPrimaryWorkbenchReadModel({
      requestUrl:
        "https://admin.example/catalog/integrations?providerKey=tcgdex&section=profile-work&profileVersion=missing-version",
      scopes: { items: [sourceObservationScope()], total: 1, count: 1 },
      profileReviews: { items: [profileReview({ active: true, lifecycle: "active" })], total: 1, count: 1 },
      controlPlaneOverview: null,
      canManageCatalog: true,
    });

    expect(readModel.profileAuthoring.status).toBe("stale-selection");
    expect(readModel.profileAuthoring.selectedProfile).toBeNull();
    expect(readModel.profileAuthoring.cloneDraft).toMatchObject({
      state: "blocked",
      blockers: ["profile-version-missing"],
      targetProfileVersion: null,
    });
  });
});
