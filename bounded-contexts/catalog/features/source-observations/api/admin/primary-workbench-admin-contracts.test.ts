import { describe, expect, it } from "vitest";
import { CATALOG_CONTROL_PLANE_ACTIONS } from "../../ui/admin-control-plane/information-architecture-v2";
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
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as outerWorkbenchFacade from "../primary-workbench-admin-contracts";
import * as workbenchFacade from "./primary-workbench-admin-contracts";
import type {
  CatalogPrimaryWorkbenchActionReadModel,
  CatalogPrimaryWorkbenchSecurityPrivacyReadModel,
  CatalogPrimaryWorkbenchInstrumentationReadModel,
  CatalogPrimaryWorkbenchActionState,
  CatalogPrimaryWorkbenchCommandKey,
  CatalogPrimaryWorkbenchCopyKey,
  CatalogPrimaryWorkbenchActionContract,
  CatalogPrimaryWorkbenchInstrumentationDimension,
  CatalogPrimaryWorkbenchSectionContract,
  CatalogPrimaryWorkbenchBlockerContract,
  CatalogPrimaryWorkbenchDeploySkewMode,
  CatalogPrimaryWorkbenchDeploySkewPolicy,
  CatalogPrimaryWorkbenchDownstreamContract,
  CatalogPrimaryWorkbenchDownstreamIssueKey,
  CatalogPrimaryWorkbenchRetirementPolicy,
  CatalogPrimaryWorkbenchContractVersion,
  CatalogPrimaryWorkbenchProviderScopeReadModel,
  CatalogPrimaryWorkbenchProviderTransportCategory,
  CatalogPrimaryWorkbenchRouteContext,
  CatalogPrimaryWorkbenchRouteContextKey,
  CatalogPrimaryWorkbenchScopeContext,
  CatalogPrimaryWorkbenchSourceOptionKindReadModel,
  CatalogPrimaryWorkbenchSourceOptionPageReadModel,
  CatalogPrimaryWorkbenchSourceOptionPageState,
  CatalogPrimaryWorkbenchSourceOptionsReadModel,
  CatalogPrimaryWorkbenchSourceOptionsStatus,
  CatalogPrimaryWorkbenchImportJobsReadModel,
  CatalogPrimaryWorkbenchCatalogSyncReadModel,
  CatalogPrimaryWorkbenchCatalogSyncStatus,
  CatalogPrimaryWorkbenchCatalogSyncUnitReadModel,
  CatalogPrimaryWorkbenchSourceScopeWorksetReadModel,
  CatalogPrimaryWorkbenchSourceScopeWorksetStatus,
  CatalogPrimaryWorkbenchSourceScopeWorksetUnitReadModel,
  CatalogPrimaryWorkbenchSourceScopeWorksetUnitState,
  CatalogPrimaryWorkbenchConflictResolutionReadModel,
  CatalogPrimaryWorkbenchConflictResolutionRow,
  CatalogPrimaryWorkbenchConflictResolutionState,
  CatalogPrimaryWorkbenchConflictResolutionStatus,
  CatalogPrimaryWorkbenchMergeCandidateActionKey,
  CatalogPrimaryWorkbenchMergeCandidateEditFieldOverride,
  CatalogPrimaryWorkbenchMergeCandidateEditFormReadModel,
  CatalogPrimaryWorkbenchMergeCandidateEditReference,
  CatalogPrimaryWorkbenchMergeCandidateReviewReadModel,
  CatalogPrimaryWorkbenchMergeCandidateReviewRow,
  CatalogPrimaryWorkbenchProductContentsEvidenceLine,
  CatalogPrimaryWorkbenchProductContentsEvidenceReview,
  CatalogPrimaryWorkbenchProductContentsEvidenceState,
  CatalogPrimaryWorkbenchPromotionDisposition,
  CatalogPrimaryWorkbenchPromotionIdentityDiagnostic,
  CatalogPrimaryWorkbenchPromotionOutcomeCountKey,
  CatalogPrimaryWorkbenchPromotionPreviewReadModel,
  CatalogPrimaryWorkbenchPromotionProfileSemantics,
  CatalogPrimaryWorkbenchPromotionResultReadModel,
  CatalogPrimaryWorkbenchPromotionScopeKind,
  CatalogPrimaryWorkbenchPromotionStaleProtectionKey,
  CatalogPrimaryWorkbenchPromotionValidationReadModel,
  CatalogPrimaryWorkbenchSourceObservationEvidenceDetail,
  CatalogPrimaryWorkbenchSourceObservationEvidenceRouteData,
  CatalogPrimaryWorkbenchSourceObservationReviewReadModel,
  CatalogPrimaryWorkbenchSourceObservationReviewRow,
  CatalogPrimaryWorkbenchSourceObservationRowActionKey,
  CatalogPrimaryWorkbenchProfileAuthoringReadModel,
  CatalogPrimaryWorkbenchProfileAuthoringStatus,
  CatalogPrimaryWorkbenchProfileCloneDraftReadModel,
  CatalogPrimaryWorkbenchProfileImmutableFact,
  CatalogPrimaryWorkbenchProfileImmutableFactKey,
  CatalogPrimaryWorkbenchProfileImportScopeControl,
  CatalogPrimaryWorkbenchProfileLifecycleRestriction,
  CatalogPrimaryWorkbenchProfileLifecycleRestrictionCode,
  CatalogPrimaryWorkbenchProfileMappingRow,
  CatalogPrimaryWorkbenchProfileOption,
  CatalogPrimaryWorkbenchProfileOptionQueryDetail,
  CatalogPrimaryWorkbenchProfileOverview,
  CatalogPrimaryWorkbenchProfileSectionField,
  CatalogPrimaryWorkbenchProfileSectionFieldControl,
  CatalogPrimaryWorkbenchProfileSectionGroupKey,
  CatalogPrimaryWorkbenchProfileSectionSaveOutcome,
  CatalogPrimaryWorkbenchProfileSectionWorkspace,
  CatalogPrimaryWorkbenchReadinessReadModel,
  CatalogPrimaryWorkbenchValidationEvidenceRow,
  CatalogPrimaryWorkbenchValidationFixtureFlowStatus,
  CatalogPrimaryWorkbenchValidationReadinessReadModel,
  CatalogPrimaryWorkbenchValidationReadinessStatus,
  CatalogPrimaryWorkbenchAuditEvidenceFilterKey,
  CatalogPrimaryWorkbenchAuditEvidenceLink,
  CatalogPrimaryWorkbenchAuditEvidenceReadModel,
  CatalogPrimaryWorkbenchAuditEvidenceStatus,
  CatalogPrimaryWorkbenchAuditEvidenceTargetType,
  CatalogPrimaryWorkbenchGovernanceControlKind,
  CatalogPrimaryWorkbenchGovernanceControlsReadModel,
  CatalogPrimaryWorkbenchGovernanceControlsStatus,
  CatalogPrimaryWorkbenchGovernanceObservabilitySignalKey,
  CatalogPrimaryWorkbenchHealthTriageAuditPreview,
  CatalogPrimaryWorkbenchHealthTriageJob,
  CatalogPrimaryWorkbenchHealthTriageProvider,
  CatalogPrimaryWorkbenchHealthTriageReadModel,
  CatalogPrimaryWorkbenchHealthTriageReadModelState,
  CatalogPrimaryWorkbenchHealthTriageRolloutControl,
  CatalogPrimaryWorkbenchHealthTriageStatus,
  CatalogPrimaryWorkbenchHealthTriageUnit,
  CatalogPrimaryWorkbenchLifecycleOperation,
  CatalogPrimaryWorkbenchLifecycleOperationReadModel,
  CatalogPrimaryWorkbenchLifecycleRecoveryReadModel,
  CatalogPrimaryWorkbenchLifecycleRecoveryStatus,
} from "./primary-workbench-admin-contracts";

describe("Catalog primary workbench admin contracts", () => {
  it("defines the Stage 2 import-to-promotion workbench sections in primary-path order", () => {
    const expectedSections: readonly CatalogPrimaryWorkbenchSectionKey[] = [
      "provider-scope-selection",
      "readiness",
      "import-jobs",
      "source-observation-review",
      "conflict-resolution",
      "promotion-preview",
      "promotion-result",
      "lifecycle-recovery",
      "governance-controls",
      "audit-evidence",
      "supporting-evidence",
    ];

    expect(catalogPrimaryWorkbenchSections.map((section) => section.key)).toEqual(expectedSections);
    expect(
      catalogPrimaryWorkbenchSections.filter((section) => section.defaultVisible).map((section) => section.key),
    ).toEqual([
      "provider-scope-selection",
      "readiness",
      "import-jobs",
      "source-observation-review",
      "promotion-preview",
      "promotion-result",
    ]);
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
        "provider-source-options",
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
      "profile-version-missing",
      "profile-lifecycle-conflict",
      "profile-retirement-references",
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
      "duplicate-conflict",
      "promotion-conflict",
      "stale-promotion-preview",
      "idempotency-replay",
      "security-privacy-blocked",
      "unsupported-command",
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
          reviewOffset: null,
          reviewLimit: null,
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
          reviewOffset: null,
          reviewLimit: null,
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
          reviewOffset: null,
          reviewLimit: null,
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
          reviewOffset: null,
          reviewLimit: null,
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
          reviewOffset: null,
          reviewLimit: null,
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

    expect(new Set(catalogPrimaryWorkbenchActions.map((action) => action.key))).toEqual(
      new Set(CATALOG_CONTROL_PLANE_ACTIONS.map((action) => action.id)),
    );
    expect(catalogPrimaryWorkbenchActions).toHaveLength(25);

    expect(actionsByKey.get("scope.import")).toMatchObject({
      method: "POST",
      requiredPermission: "catalog.manage",
      idempotencyRequired: true,
    });
    expect(actionsByKey.get("observation.promote")).toMatchObject({
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
    expect(actionsByKey.get("provider-profile.clone")).toMatchObject({
      method: "POST",
      routePattern: "/api/catalog/source-observations/admin/provider-profiles/:providerKey/:profileVersion/clone",
      requiredPermission: "catalog.manage",
      idempotencyRequired: true,
      blockerCategories: expect.arrayContaining(["permission-denied", "profile-version-missing", "raw-json-retired"]),
    });
    expect(actionsByKey.get("provider-profile.edit-section")).toMatchObject({
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
    expect(actionsByKey.get("provider-profile.rollback")).toMatchObject({
      method: "POST",
      routePattern: "/api/catalog/source-observations/admin/provider-profiles/:providerKey/:profileVersion/rollback",
      requiredPermission: "catalog.manage",
      confirmationRequired: true,
      idempotencyRequired: true,
      blockerCategories: expect.arrayContaining(["profile-lifecycle-conflict", "active-job-conflict"]),
    });
    expect(actionsByKey.get("provider-profile.deprecate")).toMatchObject({
      method: "POST",
      routePattern: "/api/catalog/source-observations/admin/provider-profiles/:providerKey/:profileVersion/deprecate",
      requiredPermission: "catalog.manage",
      confirmationRequired: true,
      idempotencyRequired: true,
      blockerCategories: expect.arrayContaining(["profile-lifecycle-conflict", "active-job-conflict"]),
    });
    expect(actionsByKey.get("provider-profile.retire")).toMatchObject({
      method: "POST",
      routePattern: "/api/catalog/source-observations/admin/provider-profiles/:providerKey/:profileVersion/retire",
      requiredPermission: "catalog.manage",
      confirmationRequired: true,
      idempotencyRequired: true,
      blockerCategories: expect.arrayContaining([
        "profile-lifecycle-conflict",
        "profile-retirement-references",
        "active-job-conflict",
      ]),
    });
    expect(actionsByKey.get("candidate.ignore")).toMatchObject({
      method: "POST",
      routePattern: "/api/catalog/source-observations/admin/merge-candidates/:candidateId/ignore",
      requiredPermission: "catalog.manage",
      confirmationRequired: true,
      idempotencyRequired: true,
    });
    expect(actionsByKey.get("candidate.ignore")?.routePattern).not.toMatch(/delete/i);

    for (const action of catalogPrimaryWorkbenchActions) {
      expect(action.routePattern).toMatch(/^\/api\/catalog\/(?:source-observations\/|alias-equivalence\/)/);
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
      "#1041",
      "#1042",
      "#1043",
      "#1044",
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
    const savedFilters: CatalogPrimaryWorkbenchReadModel["sourceObservationReview"]["savedFilters"] = [
      {
        key: "ready-for-promotion",
        label: "Eligible for promotion",
        filters: { providerKey: "tcgdex" },
        count: 1,
      },
      {
        key: "new-observations",
        label: "New observations",
        filters: { providerKey: "tcgdex", status: "observed" },
        count: 2,
      },
      {
        key: "changed-since-last-pull",
        label: "Changed observations",
        filters: { providerKey: "tcgdex", status: "changed" },
        count: 1,
      },
    ];
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
        reviewOffset: null,
        reviewLimit: null,
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
      sourceOptions: {
        status: "ready",
        freshness: "fresh",
        generatedAt: "2026-06-09T00:00:00.000Z",
        selectedProviderKey: "tcgdex",
        selectedUnitKey: "tcgdex:pokemon:single-card:source-observation-import",
        selectedProfile: profileSnapshot,
        summary: {
          declaredKinds: 1,
          loadedPages: 1,
          availableOptions: 1,
          stalePages: 0,
          degradedPages: 0,
          unavailablePages: 0,
          rolloutBlockedPages: 0,
          blockedPages: 0,
          missingParentPages: 0,
          hasMorePages: 0,
        },
        optionKinds: [
          {
            queryKind: "languages",
            queryKeySynonyms: ["language"],
            displayName: "Language",
            scope: "language",
            parentScope: null,
            parent: {
              scope: null,
              required: false,
              valueKind: null,
              diagnosticText: null,
              selectedValue: null,
              selectedLabel: null,
              missing: false,
            },
          },
        ],
        pages: [
          {
            queryKind: "languages",
            displayName: "Language",
            scope: "language",
            state: "cached",
            actionState: "available",
            blockers: [],
            degraded: false,
            request: {
              providerKey: "tcgdex",
              languageCode: "en",
              parentValue: null,
              cursor: null,
              limit: 25,
              cacheOnly: true,
            },
            page: {
              cursor: null,
              nextCursor: null,
              limit: 25,
              hasMore: false,
              total: 1,
              count: 1,
            },
            cache: {
              status: "fresh",
              source: "cache",
              cacheKey: "sha256:languages",
              fetchedAt: "2026-06-09T00:00:00.000Z",
              expiresAt: "2026-06-09T00:15:00.000Z",
              staleUntil: "2026-06-10T00:00:00.000Z",
              cacheOnly: true,
              forceRefresh: false,
              degraded: false,
              diagnostics: [],
            },
            items: [
              {
                providerKey: "tcgdex",
                queryKind: "languages",
                value: "en",
                label: "en",
                description: null,
                parentValue: null,
                imageUrl: null,
                metadata: { languageCode: "en" },
              },
            ],
            queryHref:
              "/api/catalog/source-observations/integration-options?providerKey=tcgdex&queryKind=languages&limit=25&languageCode=en&cacheOnly=true",
            refreshHref:
              "/api/catalog/source-observations/integration-options?providerKey=tcgdex&queryKind=languages&limit=25&languageCode=en&forceRefresh=true",
            nextPageHref: null,
          },
        ],
        refresh: {
          state: "available",
          blockers: [],
          refreshAllHref:
            "/api/catalog/source-observations/integration-options?providerKey=tcgdex&queryKind=languages&limit=25&languageCode=en&forceRefresh=true",
          cacheOnly: true,
          forceRefreshSupported: true,
        },
      },
      sourceScopeWorkset: {
        status: "ready",
        generatedAt: "2026-06-09T00:00:00.000Z",
        selectedScope: {
          importScope: "changed",
          label: "tcgdex / changed",
          hasConcreteScope: true,
          scope: {
            providerKey: "tcgdex",
            productId: null,
            languageCode: null,
            productLineId: null,
            productLineName: null,
            seriesId: null,
            seriesName: null,
            expansionId: null,
            expansionName: null,
            status: "changed",
          },
        },
        summary: {
          unitCount: 1,
          readyUnitCount: 1,
          blockedUnitCount: 0,
          activeImportCount: 1,
          changedObservationCount: 2,
          promotedObservationCount: 1,
        },
        units: [
          {
            providerKey: "tcgdex",
            displayName: "TCGdex",
            unitKey: "tcgdex:pokemon:single-card:source-observation-import",
            productDomain: "pokemon",
            productForm: "single-card",
            profileVersion: "2026.06.04",
            importScope: "changed",
            profileReady: true,
            optionQueryState: "ready",
            state: "changed",
            counts: {
              observed: 4,
              changed: 2,
              promoted: 1,
              rejected: 0,
              eligible: 6,
            },
            activeJobCount: 1,
            lastJobState: "running",
            currentWorkbenchHref:
              "/catalog/integrations?providerKey=tcgdex&unitKey=tcgdex%3Apokemon%3Asingle-card%3Asource-observation-import&importScope=changed&profileVersion=2026.06.04",
            commandContext: {
              providerKey: "tcgdex",
              productId: null,
              unitKey: "tcgdex:pokemon:single-card:source-observation-import",
              importScope: "changed",
              profileVersion: "2026.06.04",
              languageCode: null,
              productLineId: null,
              productLineName: null,
              seriesId: null,
              seriesName: null,
              expansionId: null,
              expansionName: null,
            },
            actions: {
              import: {
                key: "scope.import",
                state: "available",
                blockers: [],
                copyKey: null,
              },
              previewPromotion: {
                key: "observation.promote",
                state: "available",
                blockers: [],
                copyKey: null,
              },
              reapply: {
                key: "observation.reapply",
                state: "available",
                blockers: [],
                copyKey: null,
              },
            },
          },
        ],
      },
      catalogSync: {
        status: "ready",
        generatedAt: "2026-06-09T00:00:00.000Z",
        scope: {
          scopeVersion: "catalog-sync-scope-v2",
          productDomain: "pokemon",
          productForm: "single-card",
          languageCode: null,
          reference: {
            kind: null,
            scopeRecordId: null,
          },
          label: "tcgdex / changed",
          hasConcreteScope: true,
        },
        preview: {
          previewVersion: "catalog-sync-provider-participation-preview-v1",
          status: "ready",
          startAllowed: true,
          explanation: "Selected provider units can pull Source Observations for this Catalog scope.",
          estimate: {
            totalEstimatedRequestCount: null,
            estimateState: "estimate-unavailable",
            estimateReason: null,
            creditConsumingProviders: [],
          },
          blockers: [],
          units: [
            {
              providerKey: "tcgdex",
              unitKey: "tcgdex:pokemon:single-card:source-observation-import",
              displayName: "TCGdex",
              profileVersion: "2026.06.04",
              productDomain: "pokemon",
              productForm: "single-card",
              role: "primary",
              requirement: "required",
              selected: true,
              eligibility: "eligible",
              childExecutionScope: {
                provider: "tcgdex",
                ingestionUnitKey: "tcgdex:pokemon:single-card:source-observation-import",
              },
              estimate: null,
              blockers: [],
            },
          ],
        },
        action: {
          key: "scope.sync",
          state: "available",
          blockers: [],
          copyKey: null,
        },
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
            usageBudget: null,
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
            commandKey: "provider-profile.edit-section",
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
          commandKey: "provider-profile.clone",
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
      lifecycleRecovery: lifecycleRecoveryFixture(),
      governanceControls: governanceControlsFixture(),
      auditEvidence: auditEvidenceFixture(),
      importJobs: {
        freshness: "fresh",
        activeJobCount: 1,
        failedJobCount: 0,
        selectedScope: {
          providerKey: "tcgdex",
          unitKey: "tcgdex:pokemon:single-card:source-observation-import",
          scope: {
            providerKey: "tcgdex",
            productId: null,
            languageCode: null,
            productLineId: null,
            productLineName: null,
            seriesId: null,
            seriesName: null,
            expansionId: null,
            expansionName: null,
            status: "changed",
          },
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
            action: "scope.import",
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
            result: null,
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
        savedFilters,
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
          actions: ["observation.promote", "observation.reject", "observation.defer"],
        },
        rows: [
          {
            observationId: "obs_001",
            providerKey: "tcgdex",
            externalKey: "base1-4",
            displayName: "Charizard",
            status: "changed",
            statusReason: null,
            sourceUpdatedAt: "2026-06-09T00:30:00.000Z",
            changedAt: "2026-06-09T00:30:00.000Z",
            factSummaryPreview: ["pokemon-card", "Charizard", "Base Set"],
            payloadSummary: "pokemon-card; 1 image URL(s); 1 external reference(s) summarized.",
            redactionSummary: "Provider payload withheld; normalized facts and provenance are redaction-safe.",
            duplicateCount: 1,
            promotionReadiness: {
              state: "eligible",
              blockers: [],
            },
            commandPreview: {
              promotionPlanHash: null,
              disposition: "eligible",
              confirmationRequired: true,
            },
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
                key: "observation.promote",
                state: "available",
                blockers: [],
                href: "/catalog/integrations?providerKey=tcgdex&selectedObservationIds=obs_001&section=source-observation-review",
              },
            ],
          },
        ],
      },
      mergeCandidateReview: {
        freshness: "fresh",
        counts: {
          total: 1,
          ready: 1,
          conflict: 0,
          stale: 0,
          deferred: 0,
          terminal: 0,
          blocked: 0,
        },
        filters: [
          {
            key: "scope",
            label: "Catalog scope",
            value: "Pokemon / Base Set",
            serverApplied: false,
          },
        ],
        pagination: {
          mode: "offset",
          limit: 25,
          offset: 0,
          total: 1,
        },
        rows: [
          {
            candidateId: "cand_pokemon_base1_004_standard",
            identityFingerprint: "sha256:candidate-identity",
            identityLabel: "Charizard / Base Set / #4 / en / standard",
            sourceCount: 2,
            sources: [
              {
                providerKey: "tcgdex",
                observationId: "obs_001",
                externalKey: null,
                sourceProfileVersion: "2026.06.04",
              },
            ],
            status: "ready",
            statusReason: null,
            conflicts: {
              blocking: 0,
              warnings: 0,
              messages: [],
              blockingConflicts: [],
            },
            promoteReadiness: {
              state: "ready",
              blockers: [],
            },
            proposedMapping: {
              promotionIntent: "create-catalog-item",
              catalogItemId: null,
              productIds: [],
              externalCatalogItemReferences: ["tcgdex:base1-4"],
              externalProductReferences: ["tcgplayer:sku:123 -> condition:near-mint"],
            },
            sourceComparison: [
              {
                fieldPath: "name",
                value: "Charizard",
                providerKey: "tcgdex",
                observationId: "obs_001",
                confidence: "exact",
              },
            ],
            fieldProvenance: [
              {
                fieldPath: "name",
                providerKey: "tcgdex",
                sourceProfileVersion: "2026.06.04",
                confidence: "exact",
                evidenceSummary: "card.name",
              },
            ],
            proposedFacts: [{ key: "name", value: "Charizard" }],
            actions: [
              {
                key: "candidate.promote",
                state: "available",
                blockers: [],
                reasonRequired: true,
                commandPreview: null,
              },
              {
                key: "candidate.split",
                state: "blocked",
                blockers: ["unsupported-command"],
                reasonRequired: true,
                commandPreview: null,
              },
              {
                key: "candidate.edit",
                state: "blocked",
                blockers: ["unsupported-command"],
                reasonRequired: true,
                commandPreview: null,
              },
              {
                key: "candidate.ignore",
                state: "available",
                blockers: [],
                reasonRequired: true,
                commandPreview: null,
              },
              {
                key: "candidate.defer",
                state: "available",
                blockers: [],
                reasonRequired: true,
                commandPreview: null,
              },
            ],
            editForm: {
              state: "available",
              blockers: [],
              baseSnapshotJson: "{}",
              promotionIntent: "create-catalog-item",
              catalogItemId: null,
              productIds: [],
              editableFacts: [],
              externalCatalogItemReferences: [],
              externalProductReferences: [],
            },
          },
        ],
      },
      conflictResolution: conflictResolutionFixture(),
      promotionPreview: {
        previewId: "preview_001",
        validation: {
          promoteAsDraft: false,
          coverage: "complete",
          coveredCount: 1,
          continuation: null,
          identityDiagnostics: [],
          otherBlockedObservationIds: [],
        },
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
        jobId: "job_001",
        status: "completed",
        requestedCount: 1,
        promotedCount: 1,
        skippedCount: 0,
        failedCount: 0,
        promotedCatalogItemIds: ["cat_001"],
        promotedReferenceIds: ["ref_001"],
        skippedObservationIds: [],
        failedObservationIds: [],
        redactedFailureReasons: [],
        completedAt: "2026-06-09T01:05:00.000Z",
        auditEvidenceIds: ["aud_001"],
      },
      actions: [
        {
          key: "observation.promote",
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

    const unsafeObservabilityLinkModel = structuredClone(readModel) as unknown as {
      governanceControls: {
        observability: {
          signals: {
            alertLinks: { label: string; href: string }[];
          }[];
        };
      };
    };
    unsafeObservabilityLinkModel.governanceControls.observability.signals[0].alertLinks = [
      { label: "Bad alert", href: "https://evil.example/dashboard" },
    ];
    expect(() =>
      validateCatalogPrimaryWorkbenchReadModelContract(
        unsafeObservabilityLinkModel as unknown as CatalogPrimaryWorkbenchReadModel,
      ),
    ).toThrow("Primary workbench governance alert and runbook links must target approved observability.");
  });

  it("workbench exported symbol and validator ownership is complete", () => {
    const adminFiles = readdirSync(adminDirectory).filter((file) => file.startsWith("primary-workbench-"));
    expect(adminFiles.filter((file) => file.endsWith("-implementation.ts"))).toEqual([]);
    expect(adminFiles.sort()).toEqual(
      [...workbenchOwners().map(ownerFile), facadeFile, "primary-workbench-admin-contracts.test.ts"].sort(),
    );

    const functionOwners = new Map<string, WorkbenchOwner[]>();
    for (const owner of workbenchOwners()) {
      const row = workbenchOwnerCensus[owner];
      const source = readAdminSource(ownerFile(owner));
      expect(source, owner).not.toMatch(/^export\s*(?:\*|\{|type\s*\{)/m);
      expect(exportedDeclarationNames(source).sort(), owner).toEqual(
        [...row.types, ...row.values, ...row.siblingExports].sort(),
      );
      for (const name of declaredFunctionNames(source)) {
        functionOwners.set(name, [...(functionOwners.get(name) ?? []), owner]);
      }
    }
    expect(Object.fromEntries(functionOwners)).toEqual(
      Object.fromEntries(
        workbenchOwners().flatMap((owner) =>
          workbenchOwnerCensus[owner].functions.map((name): [string, WorkbenchOwner[]] => [name, [owner]]),
        ),
      ),
    );
    expect(functionOwners.size).toBe(27);

    const facadeSource = readAdminSource(facadeFile);
    expect(facadeSource).not.toMatch(/^export\s*\*/m);
    expect(declaredFunctionNames(facadeSource)).toEqual([]);
    expect(exportedDeclarationNames(facadeSource)).toEqual([]);
    expect(
      facadeSource
        .replace(facadeReexportPattern, "")
        .replace(/^\/\/.*$/gm, "")
        .trim(),
    ).toBe("");
    const reexports = facadeReexports(facadeSource);
    expect(reexports.filter((entry) => !entry.typeOnly).flatMap((entry) => entry.names)).toHaveLength(13);
    expect(reexports.filter((entry) => entry.typeOnly).flatMap((entry) => entry.names)).toHaveLength(107);
    expect(
      reexports
        .flatMap(({ typeOnly, names, from }) => names.map((name) => `${typeOnly ? "type " : ""}${name} <- ${from}`))
        .sort(),
    ).toEqual(
      workbenchOwners()
        .flatMap((owner) => [
          ...workbenchOwnerCensus[owner].types.map((name) => `type ${name} <- ./primary-workbench-${owner}`),
          ...workbenchOwnerCensus[owner].values.map((name) => `${name} <- ./primary-workbench-${owner}`),
        ])
        .sort(),
    );
  });

  it("workbench validator family parity and omission controls", () => {
    const thrownMessages: Record<string, string[]> = {};
    for (const owner of workbenchOwners()) {
      const source = readAdminSource(ownerFile(owner));
      for (const name of workbenchOwnerCensus[owner].functions) {
        thrownMessages[name] = thrownMessageLiterals(functionSource(source, name));
      }
    }
    expect(thrownMessages).toEqual(baselineThrownMessages);
    expect(Object.values(baselineThrownMessages).flat()).toHaveLength(173);
    expect(Object.values(baselineThrownMessages).filter((messages) => messages.length > 0)).toHaveLength(19);

    // The base composite omits only the optional promotion result, which the composer accepts.
    const composite = minimalWorkbenchComposite();
    expect(thrownMessage(() => validateCatalogPrimaryWorkbenchReadModelContract(composite))).toBeNull();
    for (const control of omittedFamilyControls) {
      expect(ownersOfThrownMessage(control.message), control.validator).toEqual([control.validator]);
      expect(
        thrownMessage(() => validateCatalogPrimaryWorkbenchReadModelContract(control.payload(composite))),
        control.validator,
      ).toBe(control.message);
    }

    const composerSource = functionSource(
      readAdminSource(ownerFile("contract-validators")),
      "validateCatalogPrimaryWorkbenchReadModelContract",
    );
    const composedFamilies = new Set(
      [...composerSource.matchAll(/\b((?:assert|validate)PrimaryWorkbench\w+)\(/g)]
        .map((match) => match[1])
        .filter((name) => name !== "assertPrimaryWorkbenchBlockers"),
    );
    expect([...composedFamilies].sort()).toEqual(omittedFamilyControls.map((control) => control.validator).sort());
  });

  it("workbench facade preserves real consumer types", () => {
    const runtimeKeys = workbenchOwners()
      .flatMap((owner) => workbenchOwnerCensus[owner].values)
      .sort();
    expect(runtimeKeys).toHaveLength(13);
    expect(Object.keys(workbenchFacade).sort()).toEqual(runtimeKeys);
    expect(Object.keys(outerWorkbenchFacade).sort()).toEqual(runtimeKeys);

    // This file imports every public type type-only from the facade, so typecheck fails if one stops resolving.
    expect(typeOnlyFacadeImports(readAdminSource("primary-workbench-admin-contracts.test.ts")).sort()).toEqual(
      workbenchOwners()
        .flatMap((owner) => workbenchOwnerCensus[owner].types)
        .sort(),
    );

    const valueEdges: string[] = [];
    for (const file of [...workbenchOwners().map(ownerFile), facadeFile]) {
      const from = file === facadeFile ? "admin-contracts" : workbenchOwnerOfFile(file);
      for (const { target, names } of workbenchValueImports(readAdminSource(file))) {
        expect(valueImportRank[target], `${file} -> ${target}`).toBeLessThan(valueImportRank[from]);
        if (target !== "admin-contracts") {
          const row = workbenchOwnerCensus[target];
          expect(
            names.filter((name) => ![...row.values, ...row.siblingExports].includes(name)),
            `${file} -> ${target}`,
          ).toEqual([]);
        }
        valueEdges.push(`${from} -> ${target}`);
      }
    }
    expect(valueEdges).toContain("shared-contracts -> contract-descriptors");
    expect(valueEdges.filter((edge) => edge.startsWith("contract-validators -> ")).sort()).toEqual(
      workbenchOwners()
        .filter((owner) => valueImportRank[owner] === 1 || valueImportRank[owner] === 2)
        .map((owner) => `contract-validators -> ${owner}`)
        .sort(),
    );
  });
});

function conflictResolutionFixture(): CatalogPrimaryWorkbenchReadModel["conflictResolution"] {
  return {
    status: "ready",
    freshness: "fresh",
    generatedAt: "2026-06-09T00:00:00.000Z",
    returnToPrimaryHref: "/catalog/integrations?providerKey=tcgdex&section=workbench",
    auditEvidenceUrl: "/catalog/integrations?providerKey=tcgdex&section=evidence",
    selectedObservationIds: ["obs_001"],
    summary: {
      conflictCount: 1,
      blockingCount: 0,
      autoResolvedCount: 0,
      reviewRequiredCount: 1,
      overrideAvailableCount: 0,
      auditEventCount: 1,
    },
    rows: [
      {
        observationId: "obs_001",
        displayName: "Charizard",
        providerKey: "tcgdex",
        externalKey: "base1-4",
        affectedFact: "pokemon-card",
        factKey: "merge-identity",
        resolutionState: "requires-review",
        promotionReadinessState: "eligible",
        precedenceRuleId: "duplicate-prevention.merge-identity.v1",
        candidateValues: [
          {
            source: "Catalog candidate",
            value: "pokemon-card",
            role: "winner",
            evidencePath: "sourceObservationReview.rows.normalizedFactSummaries",
          },
          {
            source: "Duplicate evidence",
            value: "pokemon / Pokemon / Base Set / Charizard / 4 / en",
            role: "loser",
            evidencePath: "sourceObservationReview.rows.duplicateEvidence",
          },
        ],
        evidencePaths: [
          "sourceObservationReview.rows.normalizedFactSummaries",
          "sourceObservationReview.rows.duplicateEvidence",
          "sourceObservationReview.rows.promotionReadiness",
        ],
        diagnostics: ["Duplicate evidence requires review before promotion continues."],
        blockers: ["duplicate-conflict"],
        auditTrail: ["Observed 2026-06-09T00:00:00.000Z"],
        detailHref:
          "/catalog/integrations?providerKey=tcgdex&selectedObservationIds=obs_001&section=source-observation-review",
        overrideAction: {
          state: "unavailable",
          blockers: ["unsupported-command"],
          auditRequired: true,
        },
      },
    ],
    precedenceRules: [
      {
        ruleId: "duplicate-prevention.merge-identity.v1",
        label: "Duplicate prevention",
        description: "Potential duplicate identity evidence requires operator review before promotion.",
        blockingBehavior: "review-required",
        sourceAuthority: "Catalog promotion policy",
        evidencePaths: ["sourceObservationReview.rows.duplicateEvidence"],
      },
    ],
    overridePolicy: {
      supported: false,
      requiredPermission: "catalog.manage",
      state: "unavailable",
      blockers: ["unsupported-command"],
      auditRequired: true,
      reason:
        "Conflict overrides need a rebuilt backend command with evidence capture; compatibility override paths are retired.",
    },
    recentAuditEvents: [
      {
        eventId: "aud_conflict_001",
        occurredAt: "2026-06-09T00:00:00.000Z",
        eventName: "profile-section-edited",
        providerKey: "tcgdex",
        unitKey: "tcgdex:pokemon:single-card:source-observation-import",
        observationId: null,
        summary: "Profile section edited before conflict review.",
      },
    ],
  };
}

function auditEvidenceFixture(): CatalogPrimaryWorkbenchReadModel["auditEvidence"] {
  const evidenceLink = auditEvidenceLinkFixture({
    key: "audit:aud_001",
    label: "source-observation-promoted",
    summary: "Promoted Charizard from redacted Source Observation evidence.",
  });

  return {
    status: "partial",
    freshness: "partial",
    generatedAt: "2026-06-09T00:00:00.000Z",
    returnToPrimaryHref: "/catalog/integrations?providerKey=tcgdex&section=workbench",
    summary: {
      timelineEvents: 1,
      redactedEvidenceLinks: 1,
      partialProjectionCount: 1,
    },
    filters: [
      auditFilterFixture("provider", "Provider", "tcgdex", ["tcgdex"]),
      auditFilterFixture("unit", "Unit", "tcgdex:pokemon:single-card:source-observation-import", [
        "tcgdex:pokemon:single-card:source-observation-import",
      ]),
      auditFilterFixture("profile-version", "Profile version", "2026.06.04", ["2026.06.04"]),
      auditFilterFixture("job", "Job", "job_001", ["job_001"]),
      auditFilterFixture("observation", "Observation", "obs_001", ["obs_001"]),
      auditFilterFixture("action-category", "Action category", null, ["promotion"]),
      auditFilterFixture("actor", "Actor", null, ["operator:user_admin"]),
      auditFilterFixture("time", "Time", null, ["2026-06-09T00:00:00.000Z"]),
    ],
    projectionState: {
      queryKey: "audit-evidence-timeline",
      freshness: "partial",
      generatedAt: "2026-06-09T00:00:00.000Z",
      statusMessage: "Audit projection is partial.",
      missingProjection: false,
      partialProjection: true,
    },
    redactionPolicy: {
      sourcePayloadAccess: "not-required",
      profileSnapshotAccess: "not-required",
      unsafeEvidenceBlocked: false,
      governedDataClasses: ["audit-evidence", "dry-run-output-evidence"],
      forbiddenEvidenceRequests: [
        "source payload body download",
        "provider profile snapshot document",
        "compatibility fallback export",
      ],
      summary:
        "Normal review uses redacted summaries and links; source payload bodies and profile snapshots are not required.",
    },
    timeline: [
      {
        eventId: "aud_001",
        occurredAt: "2026-06-09T00:00:00.000Z",
        eventName: "source-observation-promoted",
        category: "source-observation",
        actorLabel: "operator:user_admin",
        targetType: "catalog-item",
        targetId: "cat_001",
        providerKey: "tcgdex",
        unitKey: "tcgdex:pokemon:single-card:source-observation-import",
        profileVersion: "2026.06.04",
        jobId: "job_001",
        observationId: "obs_001",
        catalogItemId: "cat_001",
        summary: "Promoted Charizard from redacted Source Observation evidence.",
        diagnosticCodes: [],
        redactionState: "redacted",
        evidenceLinks: [evidenceLink],
      },
    ],
    evidenceLinks: [evidenceLink],
  };
}

function auditFilterFixture(
  key: CatalogPrimaryWorkbenchReadModel["auditEvidence"]["filters"][number]["key"],
  label: string,
  value: string | null,
  options: readonly string[],
): CatalogPrimaryWorkbenchReadModel["auditEvidence"]["filters"][number] {
  return {
    key,
    label,
    value,
    options,
    active: Boolean(value),
  };
}

function auditEvidenceLinkFixture(
  overrides: Partial<CatalogPrimaryWorkbenchReadModel["auditEvidence"]["evidenceLinks"][number]> = {},
): CatalogPrimaryWorkbenchReadModel["auditEvidence"]["evidenceLinks"][number] {
  return {
    key: "audit:evidence",
    label: "Audit evidence",
    href: "/catalog/integrations?providerKey=tcgdex&section=evidence",
    kind: "audit-event",
    summary: "Redacted audit summary.",
    redactionState: "redacted",
    sourcePayloadAccess: "not-required",
    profileSnapshotAccess: "not-required",
    ...overrides,
  };
}

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
      activationCommandKey: "provider-profile.activate",
      evidenceCommandKey: "provider-profile.edit-section",
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

function governanceControlsFixture(): CatalogPrimaryWorkbenchReadModel["governanceControls"] {
  const auditEvidenceUrl = "/catalog/integrations?providerKey=tcgdex&section=evidence";

  return {
    status: "blocked",
    freshness: "fresh",
    generatedAt: "2026-06-09T00:00:00.000Z",
    returnToPrimaryHref: "/catalog/integrations?providerKey=tcgdex&section=workbench",
    auditEvidenceUrl,
    summary: {
      activeRolloutStops: 1,
      deniedCommands: 0,
      blockedCommands: 1,
      degradedSignals: 1,
      alertCount: 6,
      deletionEvidenceCount: 3,
    },
    rolloutMode: {
      label: "Staged rollout stopped",
      state: "stopped",
      rolloutEnabled: false,
      workerState: "paused",
      providerEmergencyStopCount: 1,
      importKillSwitchActive: true,
      promotionKillSwitchActive: false,
      reapplyKillSwitchActive: false,
    },
    controls: [
      {
        controlId: "catalog-import-launch-stop",
        kind: "provider-emergency-stop",
        label: "Provider emergency stop",
        status: "blocked",
        metricKey: "catalog.integration.rollout.stop",
        evidenceUrl: auditEvidenceUrl,
        commandKeys: ["scope.import"],
        blockers: ["kill-switch-active"],
        providerKeys: ["tcgdex"],
        unitKeys: ["tcgdex:pokemon:single-card:source-observation-import"],
        message: "Catalog integration imports stopped by launch kill switch.",
      },
      {
        controlId: "catalog-import-worker-state",
        kind: "worker-pause",
        label: "Worker pause/resume state",
        status: "blocked",
        metricKey: "catalog.integration.worker.state",
        evidenceUrl: auditEvidenceUrl,
        commandKeys: ["scope.import", "observation.reapply", "observation.replay"],
        blockers: ["kill-switch-active"],
        providerKeys: [],
        unitKeys: [],
        message: "Worker claims are paused while rollout or emergency-stop controls are blocked.",
      },
      {
        controlId: "catalog-retired-compatibility-removal",
        kind: "legacy-removal",
        label: "Retired compatibility removal",
        status: "removed",
        metricKey: "catalog.integration.retired_surfaces.removed",
        evidenceUrl: auditEvidenceUrl,
        commandKeys: [],
        blockers: ["raw-json-retired", "legacy-selector-retired"],
        providerKeys: [],
        unitKeys: [],
        message: "Retired compatibility surfaces are deletion evidence only.",
      },
    ],
    rbacMatrix: catalogPrimaryWorkbenchActions
      .filter((action) => action.requiredPermission === "catalog.manage" || action.confirmationRequired)
      .map((action) => ({
        actionKey: action.key,
        requiredPermission: action.requiredPermission,
        routePattern: action.routePattern,
        state: action.key === "scope.import" ? "blocked" : "available",
        blockers: action.key === "scope.import" ? ["kill-switch-active"] : [],
        confirmationRequired: action.confirmationRequired,
        destructive: action.confirmationRequired,
        deniedCopy: `${action.requiredPermission} checked; command state is ${
          action.key === "scope.import" ? "blocked" : "available"
        }.`,
      })),
    observability: {
      status: "degraded",
      generatedAt: "2026-06-09T00:00:00.000Z",
      signals: [
        governanceSignalFixture("option-query-latency", "Option query latency", "ready", "ready"),
        governanceSignalFixture("job-failure-rate", "Job failure rate", "ready", "0/1 failed (0%)"),
        governanceSignalFixture(
          "projection-freshness",
          "Projection freshness",
          "ready",
          "integration-health-summary:fresh",
        ),
        governanceSignalFixture(
          "source-observation-quarantine",
          "Source Observation quarantine",
          "degraded",
          "1 quarantined or blocked source signal",
        ),
        governanceSignalFixture(
          "data-quarantine",
          "Data quarantine",
          "ready",
          "0 security/privacy quarantine blockers",
        ),
        governanceSignalFixture("conflict-spike", "Conflict spike", "ready", "0 conflicts, 0 blocking"),
      ],
    },
    legacyRemovalEvidence: {
      status: "removed",
      requiredDisposition: "complete-removal",
      removedSurfaces: catalogPrimaryWorkbenchRetirementPolicy.surfaces,
      forbiddenSupportPaths: catalogPrimaryWorkbenchRetirementPolicy.forbiddenOutcomes,
      evidence: [
        {
          key: "payload-escape-hatch",
          label: "Payload escape hatch",
          status: "removed",
          evidenceUrl: auditEvidenceUrl,
          detail: "The payload escape hatch is fully removed across runtime, UI, and stored behavior.",
        },
        {
          key: "broad-patch-compatibility",
          label: "Broad patch compatibility",
          status: "removed",
          evidenceUrl: auditEvidenceUrl,
          detail:
            "This compatibility behavior is fully removed; no broad patch route, client, or fallback branch preserves it.",
        },
        {
          key: "legacy-selector-pattern",
          label: "Legacy selector pattern",
          status: "removed",
          evidenceUrl: auditEvidenceUrl,
          detail: "The legacy selector pattern is fully removed, including its old UX, aliases, and redirects.",
        },
      ],
      launchBlockerIfPresent: catalogPrimaryWorkbenchRetirementPolicy.forbiddenOutcomes,
    },
  };
}

function governanceSignalFixture(
  key: CatalogPrimaryWorkbenchReadModel["governanceControls"]["observability"]["signals"][number]["key"],
  label: string,
  status: CatalogPrimaryWorkbenchReadModel["governanceControls"]["observability"]["signals"][number]["status"],
  value: string,
): CatalogPrimaryWorkbenchReadModel["governanceControls"]["observability"]["signals"][number] {
  const href = "/catalog/integrations?providerKey=tcgdex&section=evidence";
  const alertHref =
    "https://grafana.chasesets.com/d/chase-sets-catalog-control-plane/catalog-integration-control-plane";
  const runbookHref =
    "https://github.com/chase-sets/chase-sets/blob/main/docs/runbooks/catalog-integration-operations.md";

  return {
    key,
    label,
    status,
    value,
    threshold: "launch threshold",
    ownerMetricKey: `catalog.integration.${key}`,
    evidenceUrl: href,
    stale: false,
    alertLinks: [{ label: `Alert catalog.integration.${key}`, href: alertHref }],
    runbookLinks: [{ label: `Runbook ${label}`, href: runbookHref }],
  };
}

function lifecycleRecoveryFixture(): CatalogPrimaryWorkbenchReadModel["lifecycleRecovery"] {
  return {
    status: "blocked",
    freshness: "fresh",
    generatedAt: "2026-06-09T00:00:00.000Z",
    selectedProviderKey: "tcgdex",
    selectedProfileVersion: "2026.06.04",
    returnToPrimaryHref: "/catalog/integrations?providerKey=tcgdex&section=workbench",
    auditEvidenceUrl: "/catalog/integrations?providerKey=tcgdex&section=evidence",
    summary: {
      activeJobs: 1,
      affectedReferences: 2,
      downstreamProfileReferences: 1,
      impactedCatalogItems: 1,
      blockers: 3,
      recentLifecycleEvents: 1,
    },
    profiles: [
      {
        providerKey: "tcgdex",
        profileKey: "tcgdex-pokemon-card",
        profileVersion: "2026.06.04",
        displayName: "TCGdex Pokemon cards",
        lifecycle: "active",
        active: true,
        referenceCount: 2,
        href: "/catalog/integrations?providerKey=tcgdex&profileVersion=2026.06.04&section=lifecycle",
      },
    ],
    operations: [
      {
        operation: "activation",
        label: "Activation recovery",
        description: "Open validation readiness when activation evidence is needed.",
        commandKey: "provider-profile.activate",
        providerKey: "tcgdex",
        profileVersion: "2026.06.04",
        lifecycle: "active",
        active: true,
        state: "available",
        blockers: [],
        confirmationRequired: false,
        allowed: true,
        submitHref: "/catalog/integrations?providerKey=tcgdex&profileVersion=2026.06.04&section=readiness",
        supportHref: "/catalog/integrations?providerKey=tcgdex&profileVersion=2026.06.04&section=readiness",
        impact: lifecycleImpactFixture("activation", []),
        auditConsequences: {
          auditEvidenceUrl: "/catalog/integrations?providerKey=tcgdex&section=evidence",
          eventName: "profile-activated",
          summary: "Activation audit evidence is recorded from validation readiness.",
        },
        nextSteps: ["Use validation readiness to resolve activation blockers and record migration evidence."],
      },
      {
        operation: "rollback",
        label: "Rollback profile",
        description: "Restore a previous validated profile version.",
        commandKey: "provider-profile.rollback",
        providerKey: "tcgdex",
        profileVersion: "2026.06.04",
        lifecycle: "active",
        active: true,
        state: "blocked",
        blockers: ["profile-lifecycle-conflict", "active-job-conflict"],
        confirmationRequired: true,
        allowed: false,
        submitHref: "/catalog/integrations?providerKey=tcgdex&profileVersion=2026.06.04&section=lifecycle",
        supportHref: null,
        impact: lifecycleImpactFixture("rollback", ["profile-lifecycle-active-jobs"]),
        auditConsequences: {
          auditEvidenceUrl: "/catalog/integrations?providerKey=tcgdex&section=evidence",
          eventName: "profile-rolled-back",
          summary: "Rollback records the restored profile version and affected references.",
        },
        nextSteps: ["Select a previous inactive validated profile version as the rollback target."],
      },
      {
        operation: "deprecate",
        label: "Deprecate profile",
        description: "Mark the active profile out of normal use.",
        commandKey: "provider-profile.deprecate",
        providerKey: "tcgdex",
        profileVersion: "2026.06.04",
        lifecycle: "active",
        active: true,
        state: "blocked",
        blockers: ["active-job-conflict"],
        confirmationRequired: true,
        allowed: false,
        submitHref: "/catalog/integrations?providerKey=tcgdex&profileVersion=2026.06.04&section=lifecycle",
        supportHref: null,
        impact: lifecycleImpactFixture("deprecate", ["profile-lifecycle-active-jobs"]),
        auditConsequences: {
          auditEvidenceUrl: "/catalog/integrations?providerKey=tcgdex&section=evidence",
          eventName: "profile-deprecated",
          summary: "Deprecation records lifecycle intent without preserving old code paths.",
        },
        nextSteps: ["Let active jobs finish before changing profile lifecycle state."],
      },
      {
        operation: "retire",
        label: "Retire profile",
        description: "Remove the profile from supported use when references are gone.",
        commandKey: "provider-profile.retire",
        providerKey: "tcgdex",
        profileVersion: "2026.06.04",
        lifecycle: "active",
        active: true,
        state: "blocked",
        blockers: ["profile-lifecycle-conflict", "profile-retirement-references", "active-job-conflict"],
        confirmationRequired: true,
        allowed: false,
        submitHref: "/catalog/integrations?providerKey=tcgdex&profileVersion=2026.06.04&section=lifecycle",
        supportHref: null,
        impact: lifecycleImpactFixture("retire", [
          "profile-lifecycle-active-jobs",
          "profile-retirement-referenced-observations",
        ]),
        auditConsequences: {
          auditEvidenceUrl: "/catalog/integrations?providerKey=tcgdex&section=evidence",
          eventName: "profile-retired",
          summary: "Retirement records complete-removal evidence and cannot preserve compatibility support paths.",
        },
        nextSteps: [
          "Remove active Source Observation references and downstream profile references before profile retirement.",
          "Do not keep compatibility routes, shims, fallback branches, old tests, fixtures, screenshots, or documentation.",
        ],
      },
    ],
    recentAuditEvents: [
      {
        eventId: "aud_profile_001",
        occurredAt: "2026-06-09T00:00:00.000Z",
        eventName: "profile-activated",
        category: "activation",
        providerKey: "tcgdex",
        unitKey: "tcgdex:pokemon:single-card:source-observation-import",
        profileVersion: "2026.06.04",
        summary: "Profile activated after validation readiness.",
      },
    ],
    strictRetirement: {
      requiredDisposition: "complete-removal",
      forbiddenSupportPaths: [
        "compatibility shim",
        "legacy support path",
        "migration of retired admin structure",
        "hidden flag fallback",
      ],
      summary:
        "Retiring a provider profile removes its mapping and promotion behavior entirely. Lifecycle recovery cannot keep a compatibility route, alias, shim, fallback, hidden flag, or support-only path that preserves the retired behavior.",
    },
  };
}

function lifecycleImpactFixture(
  operation: "activation" | "rollback" | "deprecate" | "retire",
  blockerCodes: readonly string[],
): CatalogPrimaryWorkbenchReadModel["lifecycleRecovery"]["operations"][number]["impact"] {
  return {
    generatedAt: "2026-06-09T00:00:00.000Z",
    referencedObservationCount: operation === "retire" ? 2 : 1,
    sourceProfileReferenceCount: operation === "retire" ? 1 : 0,
    promotionProfileReferenceCount: 0,
    impactedCatalogItemCount: 1,
    impactedCatalogItemIds: ["cat_001"],
    externalReferenceCount: 1,
    sampleObservationIds: ["obs_001"],
    impactedJobCount: blockerCodes.includes("profile-lifecycle-active-jobs") ? 1 : 0,
    blockers: blockerCodes.map((code) => ({
      code,
      severity: "error",
      diagnosticText: `${operation} lifecycle blocker`,
      path: code === "profile-retirement-referenced-observations" ? "profileVersion.references" : "jobs.active",
      providerKey: "tcgdex",
      adapterKey: null,
      unitKey: "tcgdex:pokemon:single-card:source-observation-import",
      source: "catalog",
    })),
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
        usageBudget: null,
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

type WorkbenchOwnerCensusRow = Readonly<{
  types: readonly string[];
  values: readonly string[];
  functions: readonly string[];
  siblingExports: readonly string[];
}>;

type WorkbenchOwner =
  | "shared-contracts"
  | "contract-descriptors"
  | "selection-contracts"
  | "import-sync-contracts"
  | "promotion-review-contracts"
  | "profile-readiness-contracts"
  | "lifecycle-governance-contracts"
  | "contract-validators";

type WorkbenchValueImportNode = WorkbenchOwner | "admin-contracts";

// Census value-import order: descriptors, then shared, then families, then the composer, then the facade.
const valueImportRank: Readonly<Record<WorkbenchValueImportNode, number>> = {
  "contract-descriptors": 0,
  "shared-contracts": 1,
  "selection-contracts": 2,
  "import-sync-contracts": 2,
  "promotion-review-contracts": 2,
  "profile-readiness-contracts": 2,
  "lifecycle-governance-contracts": 2,
  "contract-validators": 3,
  "admin-contracts": 4,
};

const adminDirectory = fileURLToPath(new URL(".", import.meta.url));

const facadeFile = "primary-workbench-admin-contracts.ts";

const facadeReexportPattern = /^export (type )?\{([^}]*)\} from "([^"]+)";$/gm;

const thrownLiteralPattern = /throw new Error\(\s*(`(?:[^`\\]|\\.)*`|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/g;

function workbenchOwners(): WorkbenchOwner[] {
  return Object.keys(workbenchOwnerCensus).map(workbenchValueImportNode).filter(isWorkbenchOwner);
}

function isWorkbenchOwner(node: WorkbenchValueImportNode): node is WorkbenchOwner {
  return node !== "admin-contracts";
}

function workbenchValueImportNode(name: string): WorkbenchValueImportNode {
  if (!Object.hasOwn(valueImportRank, name)) {
    throw new Error(`Unknown primary workbench module '${name}'.`);
  }
  return name as WorkbenchValueImportNode;
}

function ownerFile(owner: WorkbenchOwner): string {
  return `primary-workbench-${owner}.ts`;
}

function workbenchOwnerOfFile(file: string): WorkbenchOwner {
  const owner = workbenchValueImportNode(file.replace(/^primary-workbench-/, "").replace(/\.ts$/, ""));
  if (!isWorkbenchOwner(owner)) {
    throw new Error(`${file} is not a census owner module.`);
  }
  return owner;
}

function readAdminSource(file: string): string {
  return readFileSync(fileURLToPath(new URL(`./${file}`, import.meta.url)), "utf8").replace(/\r\n/g, "\n");
}

function specifierNames(list: string): string[] {
  return list
    .split(",")
    .map((specifier) => specifier.trim())
    .filter(Boolean);
}

function exportedDeclarationNames(source: string): string[] {
  return [...source.matchAll(/^export (?:declare )?(?:type|interface|const|let|function|enum|class) ([\w$]+)/gm)].map(
    (match) => match[1],
  );
}

function declaredFunctionNames(source: string): string[] {
  return [...source.matchAll(/^(?:export )?function ([\w$]+)/gm)].map((match) => match[1]);
}

function functionSource(source: string, name: string): string {
  const start = source.search(new RegExp(`^(?:export )?function ${name}\\(`, "m"));
  if (start < 0) {
    throw new Error(`${name} is not declared in its census module.`);
  }
  const next = source.slice(start + 1).search(/^(?:export )?(?:type|interface|const|let|function) /m);
  return next < 0 ? source.slice(start) : source.slice(start, start + 1 + next);
}

function thrownMessageLiterals(source: string): string[] {
  const literals = [...source.matchAll(thrownLiteralPattern)].map((match) => match[1].slice(1, -1));
  expect(literals).toHaveLength((source.match(/\bthrow\b/g) ?? []).length);
  return literals;
}

function ownersOfThrownMessage(message: string): string[] {
  return Object.entries(baselineThrownMessages)
    .filter(([, messages]) => messages.includes(message))
    .map(([name]) => name);
}

function thrownMessage(run: () => void): string | null {
  try {
    run();
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

function facadeReexports(source: string): { typeOnly: boolean; names: string[]; from: string }[] {
  return [...source.matchAll(facadeReexportPattern)].map((match) => ({
    typeOnly: Boolean(match[1]),
    names: specifierNames(match[2]),
    from: match[3],
  }));
}

function typeOnlyFacadeImports(source: string): string[] {
  return [...source.matchAll(/^import (type )?\{([^}]*)\} from "\.\/primary-workbench-admin-contracts";$/gm)].flatMap(
    (match) =>
      specifierNames(match[2])
        .filter((specifier) => Boolean(match[1]) || specifier.startsWith("type "))
        .map((specifier) => specifier.replace(/^type /, "")),
  );
}

function workbenchValueImports(source: string): { target: WorkbenchValueImportNode; names: string[] }[] {
  return [...source.matchAll(/^(?:import|export) \{([^}]*)\} from "\.\/primary-workbench-([a-z-]+)";$/gm)].map(
    (match) => ({ target: workbenchValueImportNode(match[2]), names: specifierNames(match[1]) }),
  );
}

type OmissionControl = Readonly<{
  validator: string;
  message: string;
  payload: (composite: Partial<CatalogPrimaryWorkbenchReadModel>) => Partial<CatalogPrimaryWorkbenchReadModel>;
}>;

function omittedSlice(
  validator: string,
  slice: keyof CatalogPrimaryWorkbenchReadModel,
  message: string,
): OmissionControl {
  return {
    validator,
    message,
    payload: (composite) => {
      const payload = { ...composite };
      delete payload[slice];
      return payload;
    },
  };
}

// One control per composed family: dropping that family's composer call lets its payload through. Route context
// presence is enforced by the composer itself and the promotion result is optional, so both use a malformed slice.
const omittedFamilyControls: readonly OmissionControl[] = [
  {
    validator: "validatePrimaryWorkbenchRouteContext",
    message: "Primary workbench route context section must be a rebuilt workspace or primary section key.",
    payload: (composite) => ({
      ...composite,
      routeContext: {
        ...composite.routeContext,
        section: "legacy-god-page",
      } as unknown as CatalogPrimaryWorkbenchRouteContext,
    }),
  },
  omittedSlice(
    "assertPrimaryWorkbenchHealthTriage",
    "healthTriage",
    "Primary workbench health triage contract is required.",
  ),
  omittedSlice("assertPrimaryWorkbenchImportJobs", "importJobs", "Primary workbench import jobs contract is required."),
  omittedSlice(
    "assertPrimaryWorkbenchConflictResolution",
    "conflictResolution",
    "Primary workbench conflict resolution contract is required.",
  ),
  omittedSlice(
    "assertPrimaryWorkbenchSourceOptions",
    "sourceOptions",
    "Primary workbench source options contract is required.",
  ),
  omittedSlice(
    "assertPrimaryWorkbenchSourceScopeWorkset",
    "sourceScopeWorkset",
    "Primary workbench source-scope workset contract is required.",
  ),
  omittedSlice(
    "assertPrimaryWorkbenchMergeCandidateReview",
    "mergeCandidateReview",
    "Primary workbench merge candidate review contract is required.",
  ),
  omittedSlice(
    "assertPrimaryWorkbenchGovernanceControls",
    "governanceControls",
    "Primary workbench governance controls contract is required.",
  ),
  omittedSlice(
    "assertPrimaryWorkbenchAuditEvidence",
    "auditEvidence",
    "Primary workbench audit evidence contract is required.",
  ),
  omittedSlice(
    "assertPrimaryWorkbenchPromotionPreview",
    "promotionPreview",
    "Primary workbench promotion preview contract is required.",
  ),
  {
    validator: "assertPrimaryWorkbenchPromotionResult",
    message: "Primary workbench promotion results require durable outcome identity and timing.",
    payload: (composite) => ({
      ...composite,
      promotionResult: { resultId: "" } as unknown as CatalogPrimaryWorkbenchPromotionResultReadModel,
    }),
  },
  omittedSlice(
    "assertPrimaryWorkbenchProfileAuthoring",
    "profileAuthoring",
    "Primary workbench profile authoring contract is required.",
  ),
  omittedSlice(
    "assertPrimaryWorkbenchValidationReadiness",
    "validationReadiness",
    "Primary workbench validation readiness contract is required.",
  ),
  omittedSlice(
    "assertPrimaryWorkbenchLifecycleRecovery",
    "lifecycleRecovery",
    "Primary workbench lifecycle recovery contract is required.",
  ),
];

// The smallest composite every family validator accepts: fixtures where they exist, empty collections elsewhere.
function minimalWorkbenchComposite(): Partial<CatalogPrimaryWorkbenchReadModel> {
  const composite = {
    schemaVersion: catalogPrimaryWorkbenchContractVersion,
    routeContext: {
      section: "import-to-promotion",
      selectedObservationIds: [],
      sourceObservationFilters: {},
    },
    securityPrivacy: {
      redactionApplied: true,
      governedDataClasses: [],
      unsafeEvidenceBlocked: false,
      missingSecurityFieldsBlocker: "security-privacy-blocked",
    },
    deploySkew: catalogPrimaryWorkbenchDeploySkewPolicies[0],
    instrumentation: {
      dimensions: catalogPrimaryWorkbenchInstrumentationDimensions,
      redactionSafe: true,
    },
    healthTriage: healthTriageFixture(),
    importJobs: { jobs: [] },
    conflictResolution: conflictResolutionFixture(),
    sourceOptions: {
      status: "ready",
      freshness: "fresh",
      optionKinds: [],
      pages: [],
      summary: { declaredKinds: 0 },
      refresh: { state: "available", blockers: [] },
    },
    sourceScopeWorkset: {
      status: "ready",
      selectedScope: { label: "No source scope selected", hasConcreteScope: false },
      summary: { unitCount: 0 },
      units: [],
    },
    mergeCandidateReview: {
      freshness: "fresh",
      counts: { total: 0, ready: 0, conflict: 0, stale: 0, deferred: 0, terminal: 0, blocked: 0 },
      rows: [],
    },
    governanceControls: governanceControlsFixture(),
    auditEvidence: auditEvidenceFixture(),
    promotionPreview: {
      blockers: [],
      scope: { partialFailureMode: "per-observation" },
      validation: { coverage: "not-previewed", promoteAsDraft: false },
      outcomeCounts: { eligible: 0, blocked: 0, skipped: 0, conflicting: 0, failed: 0 },
      executionSafeguards: {
        idempotencyRequired: true,
        doubleSubmitProtection: true,
        rejectsWhenChanged: ["observations", "profile-version", "rollout-state", "permissions", "command-inputs"],
        overlappingActionBlockers: [],
      },
      reviewDecisions: {
        reject: { reasonRequired: true },
        defer: { stateChange: "keeps-observation-in-review" },
      },
      profileWorkflows: {
        reapply: { profileSemantics: "current-active-profile" },
        replay: { profileSemantics: "original-source-profile-version" },
      },
    },
    profileAuthoring: {
      status: "missing-profile",
      returnToPrimaryHref: "/catalog/integrations",
      selectedProfile: null,
      cloneDraft: {
        commandKey: "provider-profile.clone",
        submitHref: "/catalog/integrations",
        state: "disabled",
        blockers: ["missing-active-profile"],
      },
      sectionGroups: [],
      sectionWorkspaces: [],
    },
    validationReadiness: validationReadinessFixture(),
    lifecycleRecovery: lifecycleRecoveryFixture(),
  };
  return composite as unknown as Partial<CatalogPrimaryWorkbenchReadModel>;
}

// Binding #8321 owner census: public types and values per owner, its functions, and the functions it exports for siblings.
const workbenchOwnerCensus: Readonly<Record<WorkbenchOwner, WorkbenchOwnerCensusRow>> = {
  "shared-contracts": {
    types: [
      "CatalogPrimaryWorkbenchReadModel",
      "CatalogPrimaryWorkbenchActionReadModel",
      "CatalogPrimaryWorkbenchSecurityPrivacyReadModel",
      "CatalogPrimaryWorkbenchInstrumentationReadModel",
      "CatalogPrimaryWorkbenchActionState",
      "CatalogPrimaryWorkbenchBlockerCategory",
      "CatalogPrimaryWorkbenchCommandKey",
      "CatalogPrimaryWorkbenchCopyKey",
      "CatalogPrimaryWorkbenchActionContract",
      "CatalogPrimaryWorkbenchSectionKey",
      "CatalogPrimaryWorkbenchInstrumentationDimension",
    ],
    values: ["assertCatalogPrimaryWorkbenchActionState", "assertCatalogPrimaryWorkbenchBlockerCategory"],
    functions: [
      "assertCatalogPrimaryWorkbenchBlockerCategory",
      "assertCatalogPrimaryWorkbenchActionState",
      "isSafePrimaryWorkbenchReturnPath",
      "isSafePrimaryWorkbenchObservabilityLink",
      "assertPrimaryWorkbenchBlockers",
    ],
    siblingExports: [
      "isSafePrimaryWorkbenchReturnPath",
      "isSafePrimaryWorkbenchObservabilityLink",
      "assertPrimaryWorkbenchBlockers",
    ],
  },
  "contract-descriptors": {
    types: [
      "CatalogPrimaryWorkbenchSectionContract",
      "CatalogPrimaryWorkbenchBlockerContract",
      "CatalogPrimaryWorkbenchDeploySkewMode",
      "CatalogPrimaryWorkbenchDeploySkewPolicy",
      "CatalogPrimaryWorkbenchDownstreamContract",
      "CatalogPrimaryWorkbenchDownstreamIssueKey",
      "CatalogPrimaryWorkbenchRetirementPolicy",
    ],
    values: [
      "catalogPrimaryWorkbenchSections",
      "catalogPrimaryWorkbenchActions",
      "catalogPrimaryWorkbenchBlockers",
      "catalogPrimaryWorkbenchDeploySkewPolicies",
      "catalogPrimaryWorkbenchDownstreamContracts",
      "catalogPrimaryWorkbenchInstrumentationDimensions",
      "catalogPrimaryWorkbenchRetirementPolicy",
    ],
    functions: ["section", "action", "blocker", "deploySkew", "downstream"],
    siblingExports: [],
  },
  "selection-contracts": {
    types: [
      "CatalogPrimaryWorkbenchContractVersion",
      "CatalogPrimaryWorkbenchProviderScopeReadModel",
      "CatalogPrimaryWorkbenchProviderTransportCategory",
      "CatalogPrimaryWorkbenchRouteContext",
      "CatalogPrimaryWorkbenchRouteContextKey",
      "CatalogPrimaryWorkbenchScopeContext",
      "CatalogPrimaryWorkbenchSourceOptionKindReadModel",
      "CatalogPrimaryWorkbenchSourceOptionPageReadModel",
      "CatalogPrimaryWorkbenchSourceOptionPageState",
      "CatalogPrimaryWorkbenchSourceOptionsReadModel",
      "CatalogPrimaryWorkbenchSourceOptionsStatus",
    ],
    values: [
      "catalogPrimaryWorkbenchContractVersion",
      "catalogPrimaryWorkbenchRouteSections",
      "catalogPrimaryWorkbenchProviderTransportCategories",
    ],
    functions: [
      "validatePrimaryWorkbenchRouteContext",
      "validatePrimaryWorkbenchScopeContext",
      "assertPrimaryWorkbenchSourceOptions",
    ],
    siblingExports: ["validatePrimaryWorkbenchRouteContext", "assertPrimaryWorkbenchSourceOptions"],
  },
  "import-sync-contracts": {
    types: [
      "CatalogPrimaryWorkbenchImportJobsReadModel",
      "CatalogPrimaryWorkbenchCatalogSyncReadModel",
      "CatalogPrimaryWorkbenchCatalogSyncStatus",
      "CatalogPrimaryWorkbenchCatalogSyncUnitReadModel",
      "CatalogPrimaryWorkbenchSourceScopeWorksetReadModel",
      "CatalogPrimaryWorkbenchSourceScopeWorksetStatus",
      "CatalogPrimaryWorkbenchSourceScopeWorksetUnitReadModel",
      "CatalogPrimaryWorkbenchSourceScopeWorksetUnitState",
    ],
    values: [],
    functions: ["assertPrimaryWorkbenchImportJobs", "assertPrimaryWorkbenchSourceScopeWorkset"],
    siblingExports: ["assertPrimaryWorkbenchImportJobs", "assertPrimaryWorkbenchSourceScopeWorkset"],
  },
  "promotion-review-contracts": {
    types: [
      "CatalogPrimaryWorkbenchConflictResolutionReadModel",
      "CatalogPrimaryWorkbenchConflictResolutionRow",
      "CatalogPrimaryWorkbenchConflictResolutionState",
      "CatalogPrimaryWorkbenchConflictResolutionStatus",
      "CatalogPrimaryWorkbenchMergeCandidateActionKey",
      "CatalogPrimaryWorkbenchMergeCandidateEditFieldOverride",
      "CatalogPrimaryWorkbenchMergeCandidateEditFormReadModel",
      "CatalogPrimaryWorkbenchMergeCandidateEditReference",
      "CatalogPrimaryWorkbenchMergeCandidateReviewReadModel",
      "CatalogPrimaryWorkbenchMergeCandidateReviewRow",
      "CatalogPrimaryWorkbenchProductContentsEvidenceLine",
      "CatalogPrimaryWorkbenchProductContentsEvidenceReview",
      "CatalogPrimaryWorkbenchProductContentsEvidenceState",
      "CatalogPrimaryWorkbenchPromotionDisposition",
      "CatalogPrimaryWorkbenchPromotionIdentityDiagnostic",
      "CatalogPrimaryWorkbenchPromotionOutcomeCountKey",
      "CatalogPrimaryWorkbenchPromotionPreviewReadModel",
      "CatalogPrimaryWorkbenchPromotionProfileSemantics",
      "CatalogPrimaryWorkbenchPromotionResultReadModel",
      "CatalogPrimaryWorkbenchPromotionScopeKind",
      "CatalogPrimaryWorkbenchPromotionStaleProtectionKey",
      "CatalogPrimaryWorkbenchPromotionValidationReadModel",
      "CatalogPrimaryWorkbenchSourceObservationEvidenceDetail",
      "CatalogPrimaryWorkbenchSourceObservationEvidenceRouteData",
      "CatalogPrimaryWorkbenchSourceObservationReviewReadModel",
      "CatalogPrimaryWorkbenchSourceObservationReviewRow",
      "CatalogPrimaryWorkbenchSourceObservationRowActionKey",
    ],
    values: [],
    functions: [
      "assertPrimaryWorkbenchPromotionResult",
      "assertPrimaryWorkbenchConflictResolution",
      "assertPrimaryWorkbenchPromotionPreview",
      "assertPrimaryWorkbenchMergeCandidateReview",
    ],
    siblingExports: [
      "assertPrimaryWorkbenchConflictResolution",
      "assertPrimaryWorkbenchMergeCandidateReview",
      "assertPrimaryWorkbenchPromotionPreview",
      "assertPrimaryWorkbenchPromotionResult",
    ],
  },
  "profile-readiness-contracts": {
    types: [
      "CatalogPrimaryWorkbenchProfileAuthoringReadModel",
      "CatalogPrimaryWorkbenchProfileAuthoringStatus",
      "CatalogPrimaryWorkbenchProfileCloneDraftReadModel",
      "CatalogPrimaryWorkbenchProfileImmutableFact",
      "CatalogPrimaryWorkbenchProfileImmutableFactKey",
      "CatalogPrimaryWorkbenchProfileImportScopeControl",
      "CatalogPrimaryWorkbenchProfileLifecycleRestriction",
      "CatalogPrimaryWorkbenchProfileLifecycleRestrictionCode",
      "CatalogPrimaryWorkbenchProfileMappingRow",
      "CatalogPrimaryWorkbenchProfileOption",
      "CatalogPrimaryWorkbenchProfileOptionQueryDetail",
      "CatalogPrimaryWorkbenchProfileOverview",
      "CatalogPrimaryWorkbenchProfileSectionField",
      "CatalogPrimaryWorkbenchProfileSectionFieldControl",
      "CatalogPrimaryWorkbenchProfileSectionGroupKey",
      "CatalogPrimaryWorkbenchProfileSectionSaveOutcome",
      "CatalogPrimaryWorkbenchProfileSectionWorkspace",
      "CatalogPrimaryWorkbenchReadinessReadModel",
      "CatalogPrimaryWorkbenchValidationEvidenceRow",
      "CatalogPrimaryWorkbenchValidationFixtureFlowStatus",
      "CatalogPrimaryWorkbenchValidationReadinessReadModel",
      "CatalogPrimaryWorkbenchValidationReadinessStatus",
    ],
    values: [],
    functions: ["assertPrimaryWorkbenchProfileAuthoring", "assertPrimaryWorkbenchValidationReadiness"],
    siblingExports: ["assertPrimaryWorkbenchProfileAuthoring", "assertPrimaryWorkbenchValidationReadiness"],
  },
  "lifecycle-governance-contracts": {
    types: [
      "CatalogPrimaryWorkbenchAuditEvidenceFilterKey",
      "CatalogPrimaryWorkbenchAuditEvidenceLink",
      "CatalogPrimaryWorkbenchAuditEvidenceReadModel",
      "CatalogPrimaryWorkbenchAuditEvidenceStatus",
      "CatalogPrimaryWorkbenchAuditEvidenceTargetType",
      "CatalogPrimaryWorkbenchGovernanceControlKind",
      "CatalogPrimaryWorkbenchGovernanceControlsReadModel",
      "CatalogPrimaryWorkbenchGovernanceControlsStatus",
      "CatalogPrimaryWorkbenchGovernanceObservabilitySignalKey",
      "CatalogPrimaryWorkbenchHealthTriageAuditPreview",
      "CatalogPrimaryWorkbenchHealthTriageJob",
      "CatalogPrimaryWorkbenchHealthTriageProvider",
      "CatalogPrimaryWorkbenchHealthTriageReadModel",
      "CatalogPrimaryWorkbenchHealthTriageReadModelState",
      "CatalogPrimaryWorkbenchHealthTriageRolloutControl",
      "CatalogPrimaryWorkbenchHealthTriageStatus",
      "CatalogPrimaryWorkbenchHealthTriageUnit",
      "CatalogPrimaryWorkbenchLifecycleOperation",
      "CatalogPrimaryWorkbenchLifecycleOperationReadModel",
      "CatalogPrimaryWorkbenchLifecycleRecoveryReadModel",
      "CatalogPrimaryWorkbenchLifecycleRecoveryStatus",
    ],
    values: [],
    functions: [
      "assertPrimaryWorkbenchGovernanceControls",
      "assertPrimaryWorkbenchAuditEvidence",
      "assertPrimaryWorkbenchAuditEvidenceLink",
      "assertPrimaryWorkbenchHealthTriage",
      "assertPrimaryWorkbenchLifecycleRecovery",
    ],
    siblingExports: [
      "assertPrimaryWorkbenchHealthTriage",
      "assertPrimaryWorkbenchGovernanceControls",
      "assertPrimaryWorkbenchAuditEvidence",
      "assertPrimaryWorkbenchLifecycleRecovery",
    ],
  },
  "contract-validators": {
    types: [],
    values: ["validateCatalogPrimaryWorkbenchReadModelContract"],
    functions: ["validateCatalogPrimaryWorkbenchReadModelContract"],
    siblingExports: [],
  },
};

// Ordered thrown-message literals of every census function at ab95c339ef: 173 across 19 functions.
const baselineThrownMessages: Readonly<Record<string, readonly string[]>> = {
  action: [],
  assertCatalogPrimaryWorkbenchActionState: ["Unknown primary workbench action state '${value}' must fail closed."],
  assertCatalogPrimaryWorkbenchBlockerCategory: [
    "Unknown primary workbench blocker category '${value}' must fail closed.",
  ],
  assertPrimaryWorkbenchAuditEvidence: [
    "Primary workbench audit evidence contract is required.",
    "Primary workbench audit evidence status must be explicit.",
    "Primary workbench audit evidence return link must target the rebuilt workbench.",
    "Primary workbench audit evidence projection must use the canonical audit timeline query.",
    "Primary workbench missing audit projection must be unavailable.",
    "Primary workbench partial audit projection cannot report ready.",
    "Primary workbench audit evidence filter '${filterKey}' is required.",
    "Primary workbench audit evidence must not require source payload or profile snapshot access.",
    "Primary workbench audit evidence must list forbidden evidence request patterns.",
    "Primary workbench audit timeline rows must name event, time, category, and target.",
    "Primary workbench audit timeline rows must expose redacted evidence links.",
    "Primary workbench audit evidence must expose redacted summaries without legacy document workflows.",
  ],
  assertPrimaryWorkbenchAuditEvidenceLink: [
    "Primary workbench audit evidence links must be named and target rebuilt workbench evidence.",
    "Primary workbench audit evidence links must remain redaction-safe.",
  ],
  assertPrimaryWorkbenchBlockers: [],
  assertPrimaryWorkbenchConflictResolution: [
    "Primary workbench conflict resolution contract is required.",
    "Primary workbench conflict resolution status must be explicit.",
    "Primary workbench conflict resolution return link must target the rebuilt workbench.",
    "Primary workbench conflict resolution audit link must target the rebuilt workbench.",
    "Primary workbench conflict resolution rows require precedence rule evidence.",
    "Primary workbench conflict overrides need a rebuilt backend command before becoming available.",
    "Primary workbench conflict resolution rows must name observation, fact, and precedence rule.",
    "Primary workbench conflict resolution row state must be explicit.",
    "Primary workbench conflict resolution rows must show winning and losing candidate values.",
    "Primary workbench conflict resolution rows must expose evidence paths and diagnostics.",
  ],
  assertPrimaryWorkbenchGovernanceControls: [
    "Primary workbench governance controls contract is required.",
    "Primary workbench governance controls status must be explicit.",
    "Primary workbench governance controls return link must target the rebuilt workbench.",
    "Primary workbench governance controls audit link must target the rebuilt workbench.",
    "Primary workbench governance controls must expose rollout, worker, and removal evidence.",
    "Primary workbench governance controls must name control, metric, and label.",
    "Primary workbench governance control status must be explicit.",
    "Primary workbench governance control evidence link must target the rebuilt workbench.",
    "Primary workbench governance controls must cover sensitive action '${actionEntry.key}'.",
    "Primary workbench governance RBAC matrix must provide denied-state copy.",
    "Primary workbench governance destructive confirmation rows must be explicit.",
    "Primary workbench governance RBAC matrix must not preserve retired route patterns.",
    "Primary workbench governance observability signal '${signal}' is required.",
    "Primary workbench governance observability signal status must be explicit.",
    "Primary workbench governance observability signals require alert and runbook links.",
    "Primary workbench governance alert and runbook links must target approved observability.",
    "Primary workbench governance stale observability data must be degraded or unavailable.",
    "Primary workbench governance retired compatibility evidence must be removed.",
    "Primary workbench governance retired compatibility evidence must require complete removal.",
    "Primary workbench governance retirement evidence must remove '${surface}'.",
    "Primary workbench governance retirement evidence rows must be removed and linked.",
    "Primary workbench governance controls must not preserve a compatibility holding area.",
  ],
  assertPrimaryWorkbenchHealthTriage: [
    "Primary workbench health triage contract is required.",
    "Primary workbench health triage status must be explicit.",
    "Primary workbench health triage return link must target the rebuilt workbench.",
    "Primary workbench health triage units must name provider, unit, owner metric, and next action.",
    "Primary workbench health triage providers must name provider, owner metric, and next action.",
  ],
  assertPrimaryWorkbenchImportJobs: [
    "Primary workbench import jobs contract is required.",
    "Primary workbench import job results must expose redacted failure reasons.",
    "Primary workbench import job usage counts must be non-negative integers.",
    "Primary workbench import job failure reasons must stay redaction-safe.",
  ],
  assertPrimaryWorkbenchLifecycleRecovery: [
    "Primary workbench lifecycle recovery contract is required.",
    "Primary workbench lifecycle recovery status must be explicit.",
    "Primary workbench lifecycle recovery return link must target the rebuilt workbench.",
    "Primary workbench lifecycle recovery must preserve complete-removal retirement semantics.",
    "Primary workbench lifecycle recovery must expose ${operation} evidence.",
    "Primary workbench lifecycle recovery submit link must stay in the rebuilt workbench.",
    "Primary workbench lifecycle recovery destructive lifecycle actions require confirmation.",
    "Primary workbench profile retirement reference blocker must name concrete references.",
  ],
  assertPrimaryWorkbenchMergeCandidateReview: [
    "Primary workbench merge candidate review contract is required.",
    "Primary workbench merge candidate review freshness must be explicit.",
    "Primary workbench merge candidate count '${countKey}' is required.",
    "Primary workbench merge candidate rows must expose identity.",
    "Primary workbench merge candidate rows must expose contributing sources.",
    "Primary workbench ready merge candidates cannot carry promotion blockers.",
    "Primary workbench merge candidate detail must expose proposed Catalog mapping.",
    "Primary workbench merge candidate detail must expose source comparison and field provenance.",
    "Primary workbench merge candidate blocking conflict count must match its resolvable conflict detail.",
    "Primary workbench merge candidate rows must expose '${actionKey}'.",
    "Primary workbench split/update merge candidate actions require typed command previews.",
  ],
  assertPrimaryWorkbenchProfileAuthoring: [
    "Primary workbench profile authoring contract is required.",
    "Primary workbench profile authoring status must be explicit.",
    "Primary workbench profile authoring return link must target the rebuilt workbench.",
    "Primary workbench profile draft command must use the rebuilt provider-profile.clone boundary.",
    "Primary workbench profile draft submit link must target the rebuilt workbench.",
    "Primary workbench profile authoring ready state requires a selected profile.",
    "Primary workbench profile draft command must fail closed when profile selection is missing.",
    "Primary workbench selected profile must preserve provider, profile, and version identity.",
    "Primary workbench selected profile must expose immutable identity facts.",
    "Primary workbench profile draft command must preserve source provider and version context.",
    "Primary workbench profile authoring must expose guided section workspaces.",
    "Primary workbench profile section ${workspace.sectionKey} must belong to a navigation group.",
    "Primary workbench profile section ${workspace.sectionKey} must use section-scoped saves.",
    "Primary workbench profile section ${workspace.sectionKey} submit link must stay in the rebuilt workbench.",
    "Primary workbench profile section ${workspace.sectionKey} must expose guided controls.",
    "Primary workbench profile section ${workspace.sectionKey} must not expose raw JSON controls.",
    "Primary workbench profile section ${workspace.sectionKey} option-query details are required.",
    "Primary workbench profile section ${workspace.sectionKey} import-scope controls are required.",
    "Primary workbench profile section ${workspace.sectionKey} mapping rows are required.",
    "Primary workbench profile section ${workspace.sectionKey} option queries must expose canonical query metadata.",
    "Primary workbench profile section ${workspace.sectionKey} option queries must expose output mappings.",
    "Primary workbench profile section ${workspace.sectionKey} option-query cache state must be explainable.",
    "Primary workbench profile section ${workspace.sectionKey} import-scope controls must name the scope.",
    "Primary workbench profile section ${workspace.sectionKey} unavailable import scopes need a reason.",
    "Primary workbench profile section ${workspace.sectionKey} mapping rows must expose row metadata.",
    "Primary workbench profile section ${workspace.sectionKey} mapping rows must support diagnostics and long paths.",
    "Primary workbench profile section ${workspace.sectionKey} stale state must be explicit.",
    "Primary workbench profile section ${workspace.sectionKey} save outcome must be explicit.",
  ],
  assertPrimaryWorkbenchPromotionPreview: [
    "Primary workbench promotion preview contract is required.",
    "Primary workbench promotion preview scope is required.",
    "Primary workbench promotion preview must preserve per-observation partial failure scope.",
    "Primary workbench promotion preview validation coverage must be explicit.",
    "Primary workbench promotion preview must state the explicit promote-as-draft choice.",
    "Primary workbench promotion outcome count '${key}' is required.",
    "Primary workbench promotion execution safeguards must include idempotency and double-submit protection.",
    "Primary workbench promotion execution must reject stale ${staleProtection} previews.",
    "Primary workbench rejection decisions must require a reason.",
    "Primary workbench defer decisions must preserve review return semantics.",
    "Primary workbench reapply must use current active profile semantics.",
    "Primary workbench replay must use original source profile version semantics.",
  ],
  assertPrimaryWorkbenchPromotionResult: [
    "Primary workbench promotion results require durable outcome identity and timing.",
    "Primary workbench promotion results require an explicit terminal status.",
    "Primary workbench promotion result counts must be non-negative integers.",
    "Primary workbench promotion result counts must reconcile to the requested count.",
    "Primary workbench promotion results must expose redacted failure reasons.",
    "Primary workbench promotion failure reasons must stay redaction-safe.",
  ],
  assertPrimaryWorkbenchSourceOptions: [
    "Primary workbench source options contract is required.",
    "Primary workbench source options status must be explicit.",
    "Primary workbench source options freshness must be explicit.",
    "Primary workbench source option kinds must expose canonical query metadata.",
    "Primary workbench source option required parents must name the parent scope.",
    "Primary workbench source option missing parents require diagnostic text.",
    "Primary workbench source option pages must preserve option kind identity.",
    "Primary workbench source option page state must be explicit.",
    "Primary workbench source option pages must expose positive limits.",
    "Primary workbench source option page count must match item count.",
    "Primary workbench source option cache status must be explicit.",
    "Primary workbench source option cache source must be explicit.",
    "Primary workbench source option cached/live pages must include the cache key.",
    "Primary workbench source option query links must stay on typed option routes.",
    "Primary workbench source option refresh links must stay on typed option routes.",
    "Primary workbench source options must expose one page state per declared option kind.",
  ],
  assertPrimaryWorkbenchSourceScopeWorkset: [
    "Primary workbench source-scope workset contract is required.",
    "Primary workbench source-scope workset status must be explicit.",
    "Primary workbench source-scope workset must label the selected scope state.",
    "Primary workbench source-scope workset unit summary must match unit rows.",
    "Primary workbench source-scope workset unit rows must be unique by provider and unit.",
    "Primary workbench source-scope workset rows must link back to the typed workbench.",
    "Primary workbench source-scope workset row state must be explicit.",
    "Primary workbench source-scope workset command context must preserve provider identity.",
    "Primary workbench source-scope workset must fail closed until a source scope is selected.",
  ],
  assertPrimaryWorkbenchValidationReadiness: [
    "Primary workbench validation readiness contract is required.",
    "Primary workbench validation readiness status must be explicit.",
    "Primary workbench validation readiness return link must target the rebuilt workbench.",
    "Primary workbench validation readiness must expose fixture flows for the selected profile.",
    "Primary workbench validation fixture flows must be named and explicitly statused.",
    "Primary workbench validation dry-run evidence status must be explicit.",
    "Primary workbench validation dry-run evidence must summarize redaction.",
    "Primary workbench activation readiness status must be explicit.",
    "Primary workbench activation decision must expose the rebuilt activation command.",
    "Primary workbench activation decision must save evidence through typed profile sections.",
    "Primary workbench activation decision status must be explicit.",
    "Primary workbench activation decision must make ready activation actionable.",
    "Primary workbench validation readiness must not expose raw JSON workflow copy.",
  ],
  blocker: [],
  deploySkew: [],
  downstream: [],
  isSafePrimaryWorkbenchObservabilityLink: [],
  isSafePrimaryWorkbenchReturnPath: [],
  section: [],
  validateCatalogPrimaryWorkbenchReadModelContract: [
    "Primary workbench schema version mismatch must fail closed.",
    "Primary workbench route context is required for context preservation.",
    "Primary workbench security/privacy fields are required and must fail closed when missing.",
    "Primary workbench deploy-skew policy is required.",
    "Primary workbench deploy-skew policy is unsupported and must fail closed.",
    "Primary workbench instrumentation must be redaction-safe.",
  ],
  validatePrimaryWorkbenchRouteContext: [
    "Primary workbench route context section must be a rebuilt workspace or primary section key.",
    "Primary workbench route context selectedObservationIds must be an array.",
    "Primary workbench route context selectedObservationIds must be clean identifiers.",
    "Primary workbench route context Source Observation filters are required.",
    "Primary workbench route context filters must be clean query values.",
    "Primary workbench returnPath must be a safe rebuilt Catalog admin path.",
  ],
  validatePrimaryWorkbenchScopeContext: ["Primary workbench route scope must use clean structured scope fields."],
};
