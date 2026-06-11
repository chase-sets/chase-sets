import { describe, expect, it } from "vitest";
import {
  assertCatalogPrimaryWorkbenchActionState,
  assertCatalogPrimaryWorkbenchBlockerCategory,
  catalogPrimaryWorkbenchActions,
  catalogPrimaryWorkbenchBlockers,
  catalogPrimaryWorkbenchContractVersion,
  catalogPrimaryWorkbenchDeploySkewPolicies,
  catalogPrimaryWorkbenchDownstreamContracts,
  catalogPrimaryWorkbenchInstrumentationDimensions,
  catalogPrimaryWorkbenchProviderTransportCategories,
  catalogPrimaryWorkbenchRetirementPolicy,
  catalogPrimaryWorkbenchSections,
  validateCatalogPrimaryWorkbenchReadModelContract,
  type CatalogPrimaryWorkbenchBlockerCategory,
  type CatalogPrimaryWorkbenchReadModel,
  type CatalogPrimaryWorkbenchSectionKey,
} from "./primary-workbench-admin-contracts";

describe("Catalog primary workbench admin contracts", () => {
  it("defines the Stage 2 import-to-promotion workbench sections in primary-path order", () => {
    const expectedSections: readonly CatalogPrimaryWorkbenchSectionKey[] = [
      "provider-scope-selection",
      "readiness",
      "import-jobs",
      "source-observation-review",
      "promotion-preview",
      "promotion-result",
      "supporting-evidence",
    ];

    expect(catalogPrimaryWorkbenchSections.map((section) => section.key)).toEqual(expectedSections);
    expect(catalogPrimaryWorkbenchSections.slice(0, 6).every((section) => section.defaultVisible)).toBe(true);
    expect(catalogPrimaryWorkbenchSections.at(-1)).toMatchObject({
      key: "supporting-evidence",
      defaultVisible: false,
    });
  });

  it("composes the existing generic Admin query keys needed by #1060 without provider-specific branches", () => {
    const allQueryKeys = new Set(catalogPrimaryWorkbenchSections.flatMap((section) => section.queryKeys));

    expect(allQueryKeys).toEqual(
      new Set([
        "integration-health-summary",
        "provider-transport-readiness-summary",
        "active-profile-version-summary",
        "profile-section-status-summary",
        "fixture-validation-summary",
        "activation-readiness-summary",
        "adapter-transport-diagnostics",
        "import-job-progress-summary",
        "source-observation-review-query",
        "promotion-plan-preview",
        "audit-evidence-timeline",
        "dry-run-evidence-summary",
        "semantic-version-comparison",
        "replay-reapply-impact-summary",
        "rollback-retirement-impact-summary",
      ]),
    );

    for (const section of catalogPrimaryWorkbenchSections) {
      expect(section.key).not.toMatch(/tcgdex|tcgplayer|scryfall|mtg|pokemon|integrations-page/i);
      expect(section.queryKeys.join(" ")).not.toMatch(/tcgdex|tcgplayer|scryfall|mtg|pokemon/i);
    }
  });

  it("pins explicit blocker categories instead of generic disabled booleans", () => {
    const requiredBlockers: readonly CatalogPrimaryWorkbenchBlockerCategory[] = [
      "permission-denied",
      "authorization-denied",
      "rollout-disabled",
      "kill-switch-active",
      "rbac-missing",
      "active-job-conflict",
      "concurrent-job",
      "missing-active-profile",
      "activation-readiness-blocked",
      "migration-evidence-missing",
      "reference-impact-review-required",
      "missing-fixture-coverage",
      "provider-credential-missing",
      "provider-credential-invalid",
      "provider-transport-rate-limited",
      "provider-transport-throttled",
      "provider-transport-quota-exceeded",
      "provider-transport-timeout",
      "provider-transport-pagination-failure",
      "provider-transport-partial-data",
      "provider-transport-stale-cache",
      "provider-transport-degraded",
      "source-projection-stale",
      "promotion-conflict",
      "stale-promotion-preview",
      "idempotency-replay",
      "security-privacy-blocked",
      "deploy-skew-unsupported-version",
      "raw-json-retired",
      "legacy-selector-retired",
    ];
    const categories = catalogPrimaryWorkbenchBlockers.map((blocker) => blocker.category);

    for (const blocker of requiredBlockers) {
      expect(categories).toContain(blocker);
    }
    for (const blocker of catalogPrimaryWorkbenchBlockers) {
      expect(blocker.failClosed).toBe(true);
      expect(blocker.copyKey).toMatch(/^catalog\.primary\./);
      expect(blocker.instrumentationDimension).toBe("blocker_category");
      expect(blocker.category).not.toBe("disabled");
    }
  });

  it("fails closed for unknown blocker categories, action states, and missing security fields", () => {
    expect(() => assertCatalogPrimaryWorkbenchBlockerCategory("provider-is-sad")).toThrow(
      "Unknown primary workbench blocker category 'provider-is-sad' must fail closed.",
    );
    expect(() => assertCatalogPrimaryWorkbenchActionState("maybe")).toThrow(
      "Unknown primary workbench action state 'maybe' must fail closed.",
    );
    expect(() =>
      validateCatalogPrimaryWorkbenchReadModelContract({
        schemaVersion: catalogPrimaryWorkbenchContractVersion,
        routeContext: {
          section: "legacy-god-page",
          providerKey: "tcgdex",
          unitKey: "tcgdex:pokemon:single-card:source-observation-import",
          importScope: "changed",
          profileVersion: "2026.06.04",
          sourceObservationFilters: {},
          selectedObservationIds: [],
          jobId: null,
          promotionPreviewId: null,
          returnPath: "/catalog/integrations",
        },
      }),
    ).toThrow("Primary workbench route context section must be a rebuilt workspace or primary section key.");
    expect(() =>
      validateCatalogPrimaryWorkbenchReadModelContract({
        schemaVersion: catalogPrimaryWorkbenchContractVersion,
        routeContext: {
          section: "import-to-promotion",
          providerKey: "tcgdex",
          unitKey: "tcgdex:pokemon:single-card:source-observation-import",
          importScope: "changed",
          profileVersion: "2026.06.04",
          sourceObservationFilters: {},
          selectedObservationIds: [],
          jobId: null,
          promotionPreviewId: null,
          returnPath: "/catalog/not-the-workbench",
        },
      }),
    ).toThrow("Primary workbench returnPath must be a safe rebuilt Catalog admin path.");
    expect(() =>
      validateCatalogPrimaryWorkbenchReadModelContract({
        schemaVersion: catalogPrimaryWorkbenchContractVersion,
        routeContext: {
          section: "import-to-promotion",
          providerKey: "tcgdex",
          unitKey: "tcgdex:pokemon:single-card:source-observation-import",
          importScope: "changed",
          profileVersion: "2026.06.04",
          sourceObservationFilters: {},
          selectedObservationIds: [],
          jobId: null,
          promotionPreviewId: null,
          returnPath: "/catalog/integrations",
        },
        deploySkew: catalogPrimaryWorkbenchDeploySkewPolicies[0],
        instrumentation: {
          dimensions: catalogPrimaryWorkbenchInstrumentationDimensions,
          redactionSafe: true,
        },
      }),
    ).toThrow("Primary workbench security/privacy fields are required and must fail closed when missing.");
    expect(() =>
      validateCatalogPrimaryWorkbenchReadModelContract({
        schemaVersion: catalogPrimaryWorkbenchContractVersion,
        routeContext: {
          section: "import-to-promotion",
          providerKey: "tcgdex",
          unitKey: "tcgdex:pokemon:single-card:source-observation-import",
          importScope: "changed",
          profileVersion: "2026.06.04",
          sourceObservationFilters: {},
          selectedObservationIds: [],
          jobId: null,
          promotionPreviewId: null,
          returnPath: "/catalog/integrations",
        },
        readiness: {
          freshness: "fresh",
          blockers: ["provider-is-sad" as never],
          providerTransport: [],
          rolloutEnabled: true,
          rbacAllowed: true,
          auditEvidenceUrl: null,
        },
        healthTriage: healthTriageFixture(),
        deploySkew: catalogPrimaryWorkbenchDeploySkewPolicies[0],
        securityPrivacy: {
          redactionApplied: true,
          governedDataClasses: [],
          unsafeEvidenceBlocked: false,
          missingSecurityFieldsBlocker: "security-privacy-blocked",
        },
        instrumentation: {
          dimensions: catalogPrimaryWorkbenchInstrumentationDimensions,
          redactionSafe: true,
        },
      }),
    ).toThrow("Unknown primary workbench blocker category 'provider-is-sad' must fail closed.");
    expect(() =>
      validateCatalogPrimaryWorkbenchReadModelContract({
        schemaVersion: catalogPrimaryWorkbenchContractVersion,
        routeContext: {
          section: "import-to-promotion",
          providerKey: "tcgdex",
          unitKey: "tcgdex:pokemon:single-card:source-observation-import",
          importScope: "changed",
          profileVersion: "2026.06.04",
          sourceObservationFilters: {},
          selectedObservationIds: [],
          jobId: null,
          promotionPreviewId: null,
          returnPath: "/catalog/integrations",
        },
        deploySkew: catalogPrimaryWorkbenchDeploySkewPolicies[1],
        securityPrivacy: {
          redactionApplied: true,
          governedDataClasses: [],
          unsafeEvidenceBlocked: false,
          missingSecurityFieldsBlocker: "security-privacy-blocked",
        },
        instrumentation: {
          dimensions: catalogPrimaryWorkbenchInstrumentationDimensions,
          redactionSafe: true,
        },
      }),
    ).toThrow("Primary workbench deploy-skew policy is unsupported and must fail closed.");
  });

  it("defines fail-closed deploy-skew policy without legacy fallbacks", () => {
    expect(catalogPrimaryWorkbenchDeploySkewPolicies).toEqual([
      expect.objectContaining({ mode: "current", supported: true }),
      expect.objectContaining({
        mode: "old-ui-new-api",
        supported: false,
        failClosedBlocker: "deploy-skew-unsupported-version",
      }),
      expect.objectContaining({
        mode: "new-ui-old-api",
        supported: false,
        failClosedBlocker: "deploy-skew-unsupported-version",
      }),
    ]);
    expect(catalogPrimaryWorkbenchDeploySkewPolicies.flatMap((policy) => policy.forbiddenFallbacks)).toEqual(
      expect.arrayContaining([
        "legacy provider selector",
        "retired admin module coupling",
        "raw JSON broad patch",
        "silent active-profile fallback",
        "support-only legacy route",
        "compatibility redirect",
      ]),
    );
  });

  it("defines retirement as complete removal across code, documentation, evidence, and operator surfaces", () => {
    expect(catalogPrimaryWorkbenchRetirementPolicy).toMatchObject({
      term: "retire",
      requiredDisposition: "complete-removal",
    });
    expect(catalogPrimaryWorkbenchRetirementPolicy.surfaces).toEqual(
      expect.arrayContaining([
        "runtime code",
        "API routes",
        "UI modules",
        "product patterns",
        "read-model contracts",
        "clients",
        "route aliases",
        "feature flags",
        "hidden flags",
        "fallback branches",
        "redirects",
        "compatibility aliases",
        "compatibility shims",
        "migration shims",
        "tests",
        "fixtures",
        "seeds",
        "screenshots",
        "documentation",
        "runbooks",
        "release notes",
        "operator instructions",
      ]),
    );
    expect(catalogPrimaryWorkbenchRetirementPolicy.forbiddenOutcomes).toEqual(
      expect.arrayContaining([
        "soft deprecation",
        "compatibility shim",
        "legacy support path",
        "migration of retired admin structure",
        "raw JSON escape hatch",
        "support-only preserved route",
        "documentation-only deprecation",
        "hidden flag fallback",
      ]),
    );
  });

  it("exports canonical provider transport categories for downstream proof budgets", () => {
    expect(catalogPrimaryWorkbenchProviderTransportCategories).toEqual([
      "rate-limit",
      "throttle",
      "quota",
      "timeout",
      "pagination-failure",
      "partial-data",
      "stale-cache",
      "degraded-provider",
    ]);
  });

  it("pins command contracts with permission, idempotency, and confirmation semantics", () => {
    const actionsByKey = new Map(catalogPrimaryWorkbenchActions.map((action) => [action.key, action]));

    expect(actionsByKey.get("start-provider-import")).toMatchObject({
      method: "POST",
      requiredPermission: "catalog.manage",
      idempotencyRequired: true,
    });
    expect(actionsByKey.get("execute-promotion")).toMatchObject({
      requiredPermission: "catalog.manage",
      confirmationRequired: true,
      idempotencyRequired: true,
      blockerCategories: expect.arrayContaining([
        "stale-promotion-preview",
        "active-job-conflict",
        "concurrent-job",
        "security-privacy-blocked",
      ]),
    });
    expect(actionsByKey.get("clone-provider-profile")).toMatchObject({
      method: "POST",
      routePattern: "/api/catalog/source-observations/admin/provider-profiles/:providerKey/:profileVersion/clone",
      requiredPermission: "catalog.manage",
      idempotencyRequired: true,
      blockerCategories: expect.arrayContaining(["permission-denied", "profile-version-missing", "raw-json-retired"]),
    });
    expect(actionsByKey.get("update-provider-profile-section")).toMatchObject({
      method: "PATCH",
      routePattern:
        "/api/catalog/source-observations/admin/provider-profiles/:providerKey/:profileVersion/sections/:section",
      requiredPermission: "catalog.manage",
      idempotencyRequired: true,
      blockerCategories: expect.arrayContaining([
        "permission-denied",
        "profile-section-read-only",
        "profile-section-stale",
        "raw-json-retired",
      ]),
    });
    expect(actionsByKey.get("select-provider-scope")).toMatchObject({
      method: "GET",
      requiredPermission: "catalog.view",
    });

    for (const action of catalogPrimaryWorkbenchActions) {
      expect(action.routePattern).toMatch(/^\/api\/catalog\/source-observations\/admin\//);
      expect(action.routePattern).not.toContain("/catalog/integrations");
      expect(action.routePattern).not.toContain("/admin/catalog/source-observations");
      expect(action.routePattern).not.toMatch(/raw-json|legacy|compat/i);
    }
  });

  it("maps every downstream Stage 2 and hardening issue to owned sections and fields", () => {
    const downstreamIssues = catalogPrimaryWorkbenchDownstreamContracts.map((entry) => entry.issue);

    expect(downstreamIssues).toEqual([
      "#1033",
      "#1034",
      "#1035",
      "#1036",
      "#1037",
      "#1056",
      "#1038",
      "#1039",
      "#1040",
      "#1057",
      "#1058",
      "#1059",
      "#1062",
      "#1063",
      "#1064",
      "#1065",
    ]);

    for (const downstream of catalogPrimaryWorkbenchDownstreamContracts) {
      expect(downstream.consumes.length, downstream.issue).toBeGreaterThan(0);
      expect(downstream.requiredFields.length, downstream.issue).toBeGreaterThan(0);
    }
  });

  it("accepts a redaction-safe representative primary workbench read model", () => {
    const profileSnapshot = {
      schemaVersion: "catalog-provider-profile-version-v1",
      compatibilityPolicy: "provider-profile-version",
      providerKey: "tcgdex",
      profileKey: "tcgdex-pokemon-card",
      profileVersion: "2026.06.04",
      lifecycle: "active",
      active: true,
      connectorKind: "tcgdex-json",
      connectorSourceVersion: null,
      sourceMappingFingerprint: "sha256:mapping",
    } as const;
    const readModel = {
      schemaVersion: catalogPrimaryWorkbenchContractVersion,
      generatedAt: "2026-06-09T00:00:00.000Z",
      routeContext: {
        section: "import-to-promotion",
        providerKey: "tcgdex",
        unitKey: "tcgdex:pokemon:single-card:source-observation-import",
        importScope: "changed",
        profileVersion: "2026.06.04",
        sourceObservationFilters: { status: "changed" },
        selectedObservationIds: ["obs_001"],
        jobId: "job_001",
        promotionPreviewId: "preview_001",
        returnPath: "/catalog/integrations?providerKey=tcgdex&section=workbench",
      },
      providerScope: {
        providers: [
          {
            providerKey: "tcgdex",
            displayName: "TCGdex",
            units: [
              {
                unitKey: "tcgdex:pokemon:single-card:source-observation-import",
                productDomain: "pokemon",
                productForm: "single-card",
                importScopes: ["changed", "set"],
                activeProfile: null,
              },
            ],
          },
        ],
      },
      readiness: {
        freshness: "partial",
        blockers: ["provider-transport-rate-limited"],
        providerTransport: ["rate-limit", "partial-data"],
        rolloutEnabled: true,
        rbacAllowed: true,
        auditEvidenceUrl: "/catalog/integrations?providerKey=tcgdex&section=evidence",
      },
      healthTriage: {
        status: "degraded",
        freshness: "fresh",
        generatedAt: "2026-06-09T00:00:00.000Z",
        selectedProviderKey: "tcgdex",
        selectedUnitKey: "tcgdex:pokemon:single-card:source-observation-import",
        returnToPrimaryHref:
          "/catalog/integrations?providerKey=tcgdex&unitKey=tcgdex%3Apokemon%3Asingle-card%3Asource-observation-import&importScope=changed&section=workbench",
        summary: {
          readyUnits: 0,
          totalUnits: 1,
          blockedUnits: 0,
          degradedProviders: 1,
          activeJobs: 1,
          rolloutStops: 0,
          auditEntries: 1,
        },
        readModels: [
          {
            queryKey: "integration-health-summary",
            freshness: "fresh",
            generatedAt: "2026-06-09T00:00:00.000Z",
            statusMessage: "Catalog semantic readiness is fresh.",
            ownerMetricKey: "catalog.integration.health.generated_at",
          },
          {
            queryKey: "provider-transport-readiness-summary",
            freshness: "fresh",
            generatedAt: "2026-06-09T00:00:00.000Z",
            statusMessage: "Provider transport readiness is degraded.",
            ownerMetricKey: "catalog.integration.provider_transport.generated_at",
          },
        ],
        units: [
          {
            unitKey: "tcgdex:pokemon:single-card:source-observation-import",
            providerKey: "tcgdex",
            displayName: "TCGdex",
            productDomain: "pokemon",
            productForm: "single-card",
            ingestionPurpose: "source-observation-import",
            profileVersion: "2026.06.04",
            status: "degraded",
            semanticReadiness: "ready",
            credentialReadiness: "ready",
            credentialReadinessState: "configured",
            transportReadiness: "ready",
            fixtureValidationStatus: "ready",
            dryRunStatus: "completed",
            observationFacts: 2,
            diagnosticCounts: { info: 0, warning: 1, error: 0 },
            diagnosticCodes: ["provider-rate-limit"],
            latestDiagnosticText: "Provider rate limit warning.",
            affectedPrimaryAction: "pull-provider-data",
            ownerMetricKey: "catalog.integration.provider_transport.blocked",
            nextAction: "Wait for the provider rate-limit window before retrying.",
          },
        ],
        providers: [
          {
            providerKey: "tcgdex",
            adapterKey: "tcgdex",
            status: "degraded",
            readiness: "degraded",
            credentialReadiness: "ready",
            credentialReadinessState: "configured",
            unitKeys: ["tcgdex:pokemon:single-card:source-observation-import"],
            apiReachability: "ready",
            optionQueryHealth: "ready",
            rateLimitStatus: "degraded",
            payloadAcquisition: "ready",
            diagnosticCodes: ["provider-rate-limit"],
            latestDiagnosticText: "Provider rate limit warning.",
            ownerMetricKey: "catalog.integration.provider_rate_limit.status",
            nextAction: "Reduce provider pull scope before retrying.",
          },
        ],
        rolloutControls: [],
        recentJobs: [
          {
            jobId: "job_001",
            providerKey: "tcgdex",
            unitKey: "tcgdex:pokemon:single-card:source-observation-import",
            operatorStatus: "running",
            phase: "running",
            progressLabel: "1/2 work units, 50% complete",
            summary: "import job job_001 is running",
            ownerMetricKey: "catalog.integration.job.active",
            nextAction: "Let the active job finish before starting another pull.",
          },
        ],
        auditPreview: {
          generatedAt: "2026-06-09T00:00:00.000Z",
          projectionStatus: "partial",
          statusMessage: "Audit lifecycle projection is partial.",
          entries: [
            {
              eventId: "aud_001",
              occurredAt: "2026-06-09T00:00:00.000Z",
              eventName: "import-job-started",
              category: "import-job",
              providerKey: "tcgdex",
              unitKey: "tcgdex:pokemon:single-card:source-observation-import",
              summary: "Provider import started.",
            },
          ],
        },
      },
      profileAuthoring: {
        status: "ready",
        generatedAt: "2026-06-09T00:00:00.000Z",
        selectedProfile: {
          providerKey: "tcgdex",
          profileKey: "tcgdex-pokemon-card",
          profileVersion: "2026.06.04",
          displayName: "TCGdex Pokemon cards",
          lifecycle: "active",
          active: true,
          status: "planned",
          connectorKind: "tcgdex-json",
          capabilities: ["source-observation-import", "promotion-command-plan"],
          supportedScopes: ["pokemon/card"],
          languageOptions: ["en"],
          mappingOutputKind: "provider-product",
          hasExecutableMappingContract: true,
          mappingFingerprint: "sha256:mapping",
          referenceCount: 2,
          sourceContract: {
            owner: "chase-sets/catalog",
            repository: "chase-sets/chase-sets",
            commit: null,
            documentPath: "bounded-contexts/catalog/docs/provider-integration-profiles.md",
            fixtureSetVersion: "tcgdex-proof-v1",
          },
          fixtures: {
            fixtureRoot: "bounded-contexts/catalog/features/source-observations/api/__fixtures__/tcgdex",
            coveredFlows: ["normal", "changed", "replay"],
            liveProviderCallsAllowed: false,
          },
          validation: {
            status: "valid",
            diagnosticCount: 0,
            latestDiagnosticText: null,
          },
          migrationEvidence: {
            state: "recorded",
            recordedAt: "2026-06-09T00:00:00.000Z",
            fixtureRunId: "fixture_run_001",
            mappingFingerprintBefore: "sha256:old",
            mappingFingerprintAfter: "sha256:mapping",
          },
          authoringAudit: {
            createdAt: "2026-06-08T00:00:00.000Z",
            createdByUserId: "user_admin",
            createdForAccountId: null,
            updatedAt: "2026-06-09T00:00:00.000Z",
            updatedByUserId: "user_editor",
            updatedForAccountId: null,
          },
          immutableIdentityFacts: [
            {
              key: "provider-key",
              label: "Provider key",
              value: "tcgdex",
            },
            {
              key: "profile-key",
              label: "Profile key",
              value: "tcgdex-pokemon-card",
            },
          ],
        },
        activeProfile: {
          providerKey: "tcgdex",
          profileKey: "tcgdex-pokemon-card",
          profileVersion: "2026.06.04",
          displayName: "TCGdex Pokemon cards",
          lifecycle: "active",
          active: true,
          status: "planned",
          href: "/catalog/integrations?providerKey=tcgdex&profileVersion=2026.06.04&section=profile-work",
        },
        availableProfiles: [
          {
            providerKey: "tcgdex",
            profileKey: "tcgdex-pokemon-card",
            profileVersion: "2026.06.04",
            displayName: "TCGdex Pokemon cards",
            lifecycle: "active",
            active: true,
            status: "planned",
            href: "/catalog/integrations?providerKey=tcgdex&profileVersion=2026.06.04&section=profile-work",
          },
        ],
        returnToPrimaryHref:
          "/catalog/integrations?providerKey=tcgdex&unitKey=tcgdex%3Apokemon%3Asingle-card%3Asource-observation-import&importScope=changed&profileVersion=2026.06.04&selectedObservationIds=obs_001&jobId=job_001&promotionPreviewId=preview_001&section=workbench&filter.status=changed",
        sectionGroups: [
          {
            key: "profile-foundation",
            label: "Profile foundation",
            sections: ["basics"],
          },
        ],
        sectionWorkspaces: [
          {
            sectionKey: "basics",
            displayName: "Basics",
            group: "profile-foundation",
            groupLabel: "Profile foundation",
            description: "Profile identity controls.",
            domainConcept: "profile identity",
            status: "valid",
            editable: false,
            actionState: "blocked",
            blockers: ["profile-section-read-only"],
            dirtyState: "clean",
            staleState: "fresh",
            saveOutcome: "not-submitted",
            submitHref: "/catalog/integrations?providerKey=tcgdex&profileVersion=2026.06.04&section=profile-work",
            commandKey: "update-provider-profile-section",
            fields: [
              {
                key: "displayName",
                label: "Display name",
                value: "TCGdex Pokemon cards",
                control: "text",
                required: true,
                disabled: true,
                helpText: null,
                options: [],
              },
            ],
            optionQueries: [],
            importScopeControls: [],
            mappingRows: [],
            diagnostics: [],
            semanticChangeCount: 0,
            readinessCheckCount: 0,
            anchorId: "profile-section-basics",
          },
        ],
        cloneDraft: {
          commandKey: "clone-provider-profile",
          sourceProviderKey: "tcgdex",
          sourceProfileVersion: "2026.06.04",
          targetProfileVersion: "2026.06.04-draft",
          targetLifecycle: "draft",
          state: "available",
          blockers: [],
          submitHref:
            "/catalog/integrations?providerKey=tcgdex&unitKey=tcgdex%3Apokemon%3Asingle-card%3Asource-observation-import&importScope=changed&profileVersion=2026.06.04&selectedObservationIds=obs_001&jobId=job_001&promotionPreviewId=preview_001&section=profile-work&returnPath=%2Fcatalog%2Fintegrations%3FproviderKey%3Dtcgdex%26unitKey%3Dtcgdex%253Apokemon%253Asingle-card%253Asource-observation-import%26importScope%3Dchanged%26profileVersion%3D2026.06.04%26selectedObservationIds%3Dobs_001%26jobId%3Djob_001%26promotionPreviewId%3Dpreview_001%26section%3Dworkbench%26filter.status%3Dchanged&filter.status=changed",
          lifecycleRestrictions: [
            {
              code: "active-clone-required",
              label: "Draft required for active profiles",
              description: "Active profiles are cloned before edits.",
              severity: "warning",
            },
          ],
          immutableIdentityFacts: [
            {
              key: "provider-key",
              label: "Provider key",
              value: "tcgdex",
            },
            {
              key: "profile-key",
              label: "Profile key",
              value: "tcgdex-pokemon-card",
            },
          ],
        },
      },
      validationReadiness: validationReadinessFixture(),
      importJobs: {
        freshness: "fresh",
        activeJobCount: 1,
        failedJobCount: 0,
        selectedScope: {
          providerKey: "tcgdex",
          unitKey: "tcgdex:pokemon:single-card:source-observation-import",
          importScope: "changed",
          profileVersion: "2026.06.04",
          profileSnapshot,
          expectedObservationVolume: 2,
          observedCount: 2,
          changedCount: 1,
          promotedCount: 0,
          rejectedCount: 0,
          readiness: {
            adapterReadiness: "degraded",
            credentialReadiness: "ready",
            rolloutEnabled: true,
            providerTransport: ["rate-limit", "partial-data"],
            blockers: ["provider-transport-rate-limited", "provider-transport-partial-data"],
          },
        },
        jobs: [
          {
            jobId: "job_001",
            action: "start-provider-import",
            state: "running",
            operatorStatus: "running",
            summary: "import job job_001 is running",
            completed: 1,
            total: 2,
            progressPercent: 50,
            unitKey: "tcgdex:pokemon:single-card:source-observation-import",
            providerKey: "tcgdex",
            importScope: "changed",
            profileVersion: "2026.06.04",
            profileSnapshot,
            scopeMatchesRoute: true,
            createdAt: "2026-06-09T00:00:00.000Z",
            startedAt: "2026-06-09T00:01:00.000Z",
            consistency: {
              schemaVersion: "catalog-integration-durable-job-v1",
              compatibilityPolicy: "integration-durable-job",
              duplicateSubmissionPolicy: "reuse-active-job",
              profileSnapshotPolicy: "snapshotted-at-enqueue",
              retryResumePolicy: "skip-completed-outcomes",
              partialFailurePolicy: "mixed-outcomes",
              workUnitClaimPolicy: "leased-work-units",
            },
            failureGroups: [],
            retryAvailable: false,
            resumeAvailable: false,
            cancelAvailable: true,
            sourceObservationReviewHref:
              "/catalog/integrations?providerKey=tcgdex&jobId=job_001&section=source-observation-review",
            auditEvidenceUrl:
              "/catalog/integrations?section=evidence&providerKey=tcgdex&jobId=job_001&returnPath=%2Fcatalog%2Fintegrations%3FproviderKey%3Dtcgdex%26jobId%3Djob_001%26section%3Dworkbench",
            observationLinks: ["obs_001"],
            blockers: [],
          },
        ],
      },
      sourceObservationReview: {
        freshness: "fresh",
        counts: {
          observed: 2,
          changed: 1,
          promoted: 0,
          rejected: 0,
          blocked: 0,
          eligible: 1,
        },
        cursor: "observedAt:obs_001",
        selectedObservationIds: ["obs_001"],
        evidenceSummariesRedacted: true,
        duplicateConflictCount: 0,
        promotionReadyCount: 1,
        filters: [
          { key: "providerKey", label: "Provider", value: "tcgdex", serverApplied: true },
          { key: "status", label: "Status", value: "changed", serverApplied: true },
        ],
        savedFilters: [
          {
            key: "ready-for-promotion",
            label: "Ready for promotion preview",
            filters: { providerKey: "tcgdex", status: "changed" },
            count: 1,
          },
        ],
        pagination: {
          mode: "offset",
          limit: 25,
          offset: 0,
          total: 1,
          nextCursor: null,
          previousCursor: null,
        },
        bulkSelection: {
          selectedCount: 1,
          eligibleSelectedCount: 1,
          actions: ["preview-promotion", "reject-source-observations", "defer-source-observations"],
        },
        rows: [
          {
            observationId: "obs_001",
            providerKey: "tcgdex",
            externalKey: "base1-4",
            displayName: "Charizard",
            status: "changed",
            statusReason: null,
            languageCode: "en",
            sourceUrl: "https://api.tcgdex.example/cards/base1-4",
            sourceRecordHash: "sha256:source-record",
            sourceUpdatedAt: "2026-06-09T00:30:00.000Z",
            observedAt: "2026-06-09T00:00:00.000Z",
            changedAt: "2026-06-09T00:30:00.000Z",
            sourceProfileVersion: "2026.06.04",
            promotionProfileVersion: null,
            normalizedFactSummaries: ["pokemon-card", "Charizard", "Base Set", "4"],
            payloadSummary: "pokemon-card; 1 image URL(s); 1 external reference(s) summarized.",
            redactionSummary: "Provider payload withheld; normalized facts and provenance are redaction-safe.",
            duplicateEvidence: ["pokemon / Pokemon / Base Set / Charizard / 4 / en"],
            conflictEvidence: ["Changed normalized facts require promotion preview before Catalog writes."],
            promotionReadiness: {
              state: "eligible",
              blockers: [],
            },
            commandPreview: {
              promotionPlanHash: null,
              disposition: "eligible",
              confirmationRequired: true,
            },
            auditTrail: ["Observed 2026-06-09T00:00:00.000Z"],
            detailHref:
              "/catalog/integrations?providerKey=tcgdex&selectedObservationIds=obs_001&section=source-observation-review",
            actions: [
              {
                key: "view-source-observation",
                state: "available",
                blockers: [],
                href: "/catalog/integrations?providerKey=tcgdex&selectedObservationIds=obs_001&section=source-observation-review",
              },
              {
                key: "preview-promotion",
                state: "available",
                blockers: [],
                href: "/catalog/integrations?providerKey=tcgdex&selectedObservationIds=obs_001&section=source-observation-review",
              },
            ],
          },
        ],
      },
      promotionPreview: {
        previewId: "preview_001",
        freshness: "fresh",
        scope: {
          kind: "explicit-rows",
          label: "Explicit selected observations",
          requestedCount: 1,
          eligibleCount: 1,
          selectedObservationIds: ["obs_001"],
          filterSummary: ["Provider: tcgdex", "Status: changed"],
          partialFailureMode: "per-observation",
        },
        dispositions: {
          eligible: 1,
          skipped: 0,
          blocked: 0,
          conflicting: 0,
          destructive: 0,
          "stale-preview": 0,
          "confirmation-required": 1,
        },
        outcomeCounts: {
          eligible: 1,
          blocked: 0,
          skipped: 0,
          conflicting: 0,
          failed: 0,
        },
        commandPlanHash: "sha256:preview",
        confirmationRequired: true,
        destructiveCount: 0,
        executionSafeguards: {
          previewRequired: true,
          previewFresh: true,
          stalePreviewRejected: false,
          idempotencyRequired: true,
          doubleSubmitProtection: true,
          rejectsWhenChanged: ["observations", "profile-version", "rollout-state", "permissions", "command-inputs"],
          staleReasons: [],
          overlappingActionBlockers: [],
        },
        reviewDecisions: {
          reject: {
            reasonRequired: true,
            partialFailureMode: "failed-observations-remain-in-scope",
            auditEvidenceRequired: true,
          },
          defer: {
            stateChange: "keeps-observation-in-review",
            returnsToReviewWhen: "next-provider-import-or-filter-reset",
            auditEvidenceRequired: true,
          },
        },
        profileWorkflows: {
          reapply: {
            profileSemantics: "current-active-profile",
            target: "promoted-observations",
            profileVersion: "2026.06.04",
          },
          replay: {
            profileSemantics: "original-source-profile-version",
            target: "source-observation-evidence",
            profileVersion: "2026.06.04",
          },
        },
        blockers: [],
      },
      promotionResult: {
        resultId: "promotion_001",
        promotedCatalogItemIds: ["cat_001"],
        promotedReferenceIds: ["ref_001"],
        skippedObservationIds: [],
        auditEvidenceIds: ["aud_001"],
      },
      actions: [
        {
          key: "execute-promotion",
          state: "available",
          blockers: [],
          copyKey: null,
        },
      ],
      deploySkew: catalogPrimaryWorkbenchDeploySkewPolicies[0],
      securityPrivacy: {
        redactionApplied: true,
        governedDataClasses: ["audit-evidence", "dry-run-output-evidence"],
        unsafeEvidenceBlocked: false,
        missingSecurityFieldsBlocker: "security-privacy-blocked",
      },
      instrumentation: {
        dimensions: catalogPrimaryWorkbenchInstrumentationDimensions,
        redactionSafe: true,
      },
    } satisfies CatalogPrimaryWorkbenchReadModel;

    validateCatalogPrimaryWorkbenchReadModelContract(readModel);

    expect(readModel.readiness.providerTransport).toEqual(["rate-limit", "partial-data"]);
    expect(readModel.promotionPreview.dispositions["confirmation-required"]).toBe(1);
    expect(readModel.instrumentation.dimensions).toContain("route_context_preserved");
  });
});

function validationReadinessFixture(): CatalogPrimaryWorkbenchReadModel["validationReadiness"] {
  return {
    status: "ready",
    freshness: "fresh",
    generatedAt: "2026-06-09T00:00:00.000Z",
    selectedProviderKey: "tcgdex",
    selectedUnitKey: "tcgdex:pokemon:single-card:source-observation-import",
    selectedProfileVersion: "2026.06.04",
    selectedFixtureFlow: "normal",
    returnToPrimaryHref: "/catalog/integrations?providerKey=tcgdex&section=workbench",
    summary: {
      readyFixtureFlows: 1,
      totalFixtureFlows: 1,
      blockedFixtureFlows: 0,
      dryRunEvidenceCount: 1,
      semanticChangeCount: 0,
      unchangedSectionCount: 1,
      blockingReadinessChecks: 0,
      auditEvidenceCount: 1,
    },
    fixtureFlows: [
      {
        flow: "normal",
        label: "Normal",
        status: "ready",
        payloadFile: "normal.json",
        payloadPath: "bounded-contexts/catalog/features/source-observations/api/__fixtures__/tcgdex/normal.json",
        expectedStatus: "completed",
        expectedDiagnosticPaths: [],
        expectedHashEvidencePaths: ["normalizedObservation.hashMaterial.0"],
        expectedMergeEvidencePaths: ["duplicatePrevention.mergeCandidateEvidence.0"],
        expectedPromotionCommands: ["CreateCatalogItem"],
        samplePayloadAvailable: true,
        diagnostics: [],
        actionState: "available",
        blockers: [],
      },
    ],
    dryRunEvidence: [
      {
        externalKey: "en:sv01-001",
        sourceUrl: "fixture://tcgdex/normal.json",
        sourceHash: "sha256:source",
        status: "completed",
        normalizedFacts: [{ key: "name", value: "Sprigatito" }],
        redactionSummary: [
          { label: "Payload body", value: "not retained" },
          { label: "Normalized facts", value: "1 redacted summary" },
        ],
        duplicateCandidates: [
          {
            key: "duplicate-prevention.mergeCandidateEvidence.0",
            label: "Merge identity",
            path: "executableMappingContract.duplicatePrevention.mergeCandidateEvidence.0",
            summary: "merge identity selector",
            owner: "catalog",
            uses: ["merge-identity"],
            diagnostics: [],
          },
        ],
        selectedOptions: [],
        promotionCommandPreview: [
          {
            commandName: "CreateCatalogItem",
            inputs: [
              {
                key: "promotion-command.0.title",
                label: "title",
                path: "executableMappingContract.promotionCommandPlan.commands.0.inputs.title",
                summary: "card.name selector",
                owner: "catalog-truth",
                uses: ["promotion-command"],
                diagnostics: [],
              },
            ],
          },
        ],
        diagnostics: [],
        auditEvidence: ["fixture-run:fixture_run_001"],
      },
    ],
    semanticCompare: {
      mappingFingerprint: {
        candidate: "sha256:mapping",
        active: "sha256:mapping",
        changed: false,
      },
      activationImpact: [],
      fixtureCoverage: [{ flow: "normal", status: "ready" }],
      sections: [
        {
          sectionKey: "normalized-observation",
          domainConcept: "Normalized Observation",
          status: "valid",
          changeCount: 0,
          changes: [],
        },
      ],
      unchangedSections: [{ sectionKey: "normalized-observation", domainConcept: "Normalized Observation" }],
    },
    activationReadiness: {
      status: "ready",
      requiresMigrationEvidence: false,
      referenceCount: 2,
      groups: [
        {
          domainConcept: "Activation",
          status: "ready",
          checks: [
            {
              checkKey: "activation:ready",
              code: "activation-ready",
              sectionKey: "readiness",
              status: "passed",
              path: "activationReadiness",
              diagnosticText: "Activation readiness has no blocking checks.",
              severity: "warning",
              remediation: "No remediation required.",
              blockingBehavior: "allow",
              flow: null,
            },
          ],
        },
      ],
    },
    activationDecision: {
      status: "ready",
      actionState: "available",
      blockers: [],
      saveEvidenceState: "available",
      saveEvidenceBlockers: [],
      activationCommandKey: "activate-provider-profile",
      evidenceCommandKey: "update-provider-profile-section",
      workspaceHref: "/catalog/integrations?providerKey=tcgdex&profileVersion=2026.06.04&section=readiness",
      providerKey: "tcgdex",
      profileVersion: "2026.06.04",
      lifecycle: "test",
      importEligibility: "eligible",
      affectedReferences: {
        referenceCount: 2,
        requiresMigrationEvidence: false,
        replayImplications: ["No mapping fingerprint change detected for replay or reapply decisions."],
      },
      migrationEvidence: {
        state: "not-required",
        evidenceText: "",
        fixtureRunId: null,
        mappingFingerprintBefore: "sha256:mapping",
        mappingFingerprintAfter: "sha256:mapping",
        recordedAt: null,
        recordedByUserId: null,
      },
      auditConsequences: {
        auditEvidenceUrl: "/catalog/integrations?providerKey=tcgdex&profileVersion=2026.06.04&section=audit-evidence",
        eventNames: ["activation-readiness-evaluated", "profile-activated"],
        summary: "Activation records readiness evaluation and profile activation audit evidence.",
      },
    },
  };
}

function healthTriageFixture(): CatalogPrimaryWorkbenchReadModel["healthTriage"] {
  return {
    status: "ready",
    freshness: "fresh",
    generatedAt: "2026-06-09T00:00:00.000Z",
    selectedProviderKey: "tcgdex",
    selectedUnitKey: "tcgdex:pokemon:single-card:source-observation-import",
    returnToPrimaryHref: "/catalog/integrations?providerKey=tcgdex&section=workbench",
    summary: {
      readyUnits: 1,
      totalUnits: 1,
      blockedUnits: 0,
      degradedProviders: 0,
      activeJobs: 0,
      rolloutStops: 0,
      auditEntries: 0,
    },
    readModels: [
      {
        queryKey: "integration-health-summary",
        freshness: "fresh",
        generatedAt: "2026-06-09T00:00:00.000Z",
        statusMessage: "Catalog semantic readiness is fresh.",
        ownerMetricKey: "catalog.integration.health.generated_at",
      },
    ],
    units: [
      {
        unitKey: "tcgdex:pokemon:single-card:source-observation-import",
        providerKey: "tcgdex",
        displayName: "TCGdex",
        productDomain: "pokemon",
        productForm: "single-card",
        ingestionPurpose: "source-observation-import",
        profileVersion: "2026.06.04",
        status: "ready",
        semanticReadiness: "ready",
        credentialReadiness: "ready",
        credentialReadinessState: "configured",
        transportReadiness: "ready",
        fixtureValidationStatus: "ready",
        dryRunStatus: "completed",
        observationFacts: 2,
        diagnosticCounts: { info: 0, warning: 0, error: 0 },
        diagnosticCodes: [],
        latestDiagnosticText: null,
        affectedPrimaryAction: "pull-provider-data",
        ownerMetricKey: "catalog.integration.unit.ready",
        nextAction: "Continue with provider pull.",
      },
    ],
    providers: [
      {
        providerKey: "tcgdex",
        adapterKey: "tcgdex",
        status: "ready",
        readiness: "ready",
        credentialReadiness: "ready",
        credentialReadinessState: "configured",
        unitKeys: ["tcgdex:pokemon:single-card:source-observation-import"],
        apiReachability: "ready",
        optionQueryHealth: "ready",
        rateLimitStatus: "ready",
        payloadAcquisition: "ready",
        diagnosticCodes: [],
        latestDiagnosticText: null,
        ownerMetricKey: "catalog.integration.provider.ready",
        nextAction: "Continue with provider pull.",
      },
    ],
    rolloutControls: [],
    recentJobs: [],
    auditPreview: {
      generatedAt: "2026-06-09T00:00:00.000Z",
      projectionStatus: "partial",
      statusMessage: "Audit lifecycle projection is partial.",
      entries: [],
    },
  };
}
