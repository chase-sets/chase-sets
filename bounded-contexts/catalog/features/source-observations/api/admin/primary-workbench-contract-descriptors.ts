import type {
  CatalogAdminControlPlaneFreshnessState,
  CatalogAdminControlPlanePaginationMode,
} from "./admin-control-plane-read-model-slos";
import type { CatalogAdminControlPlaneQueryKey } from "./admin-control-plane-read-model-contracts";
import type {
  CatalogPrimaryWorkbenchSectionKey,
  CatalogPrimaryWorkbenchCommandKey,
  CatalogPrimaryWorkbenchActionState,
  CatalogPrimaryWorkbenchBlockerCategory,
  CatalogPrimaryWorkbenchCopyKey,
  CatalogPrimaryWorkbenchInstrumentationDimension,
  CatalogPrimaryWorkbenchActionContract,
} from "./primary-workbench-shared-contracts";
import type { CatalogPrimaryWorkbenchRouteContextKey } from "./primary-workbench-selection-contracts";

export type CatalogPrimaryWorkbenchDeploySkewMode = "current" | "old-ui-new-api" | "new-ui-old-api";

export type CatalogPrimaryWorkbenchDeploySkewPolicy = Readonly<{
  mode: CatalogPrimaryWorkbenchDeploySkewMode;
  supported: boolean;
  failClosedBlocker: Extract<CatalogPrimaryWorkbenchBlockerCategory, "deploy-skew-unsupported-version">;
  forbiddenFallbacks: readonly string[];
}>;

export type CatalogPrimaryWorkbenchRetirementPolicy = Readonly<{
  term: "retire";
  requiredDisposition: "complete-removal";
  surfaces: readonly string[];
  forbiddenOutcomes: readonly string[];
}>;

export type CatalogPrimaryWorkbenchBlockerContract = Readonly<{
  category: CatalogPrimaryWorkbenchBlockerCategory;
  actionStates: readonly CatalogPrimaryWorkbenchActionState[];
  copyKey: CatalogPrimaryWorkbenchCopyKey;
  instrumentationDimension: Extract<CatalogPrimaryWorkbenchInstrumentationDimension, "blocker_category">;
  failClosed: boolean;
}>;

export type CatalogPrimaryWorkbenchSectionContract = Readonly<{
  key: CatalogPrimaryWorkbenchSectionKey;
  defaultVisible: boolean;
  queryKeys: readonly CatalogAdminControlPlaneQueryKey[];
  commands: readonly CatalogPrimaryWorkbenchCommandKey[];
  freshnessStates: readonly CatalogAdminControlPlaneFreshnessState[];
  pagination: CatalogAdminControlPlanePaginationMode;
  routeContextKeys: readonly CatalogPrimaryWorkbenchRouteContextKey[];
}>;

export type CatalogPrimaryWorkbenchDownstreamIssueKey =
  | "#1033"
  | "#1034"
  | "#1035"
  | "#1036"
  | "#1037"
  | "#1056"
  | "#1038"
  | "#1039"
  | "#1040"
  | "#1041"
  | "#1042"
  | "#1043"
  | "#1044"
  | "#1057"
  | "#1058"
  | "#1059"
  | "#1062"
  | "#1063"
  | "#1064"
  | "#1065";

export type CatalogPrimaryWorkbenchDownstreamContract = Readonly<{
  issue: CatalogPrimaryWorkbenchDownstreamIssueKey;
  consumes: readonly CatalogPrimaryWorkbenchSectionKey[];
  requiredFields: readonly string[];
}>;

export const catalogPrimaryWorkbenchSections = [
  section({
    key: "provider-scope-selection",
    defaultVisible: true,
    queryKeys: [
      "integration-health-summary",
      "provider-transport-readiness-summary",
      "active-profile-version-summary",
      "provider-source-options",
    ],
    commands: [],
    freshnessStates: ["fresh", "stale", "partial", "unavailable"],
    pagination: "none",
    routeContextKeys: ["section", "providerKey", "unitKey", "importScope", "profileVersion", "returnPath"],
  }),
  section({
    key: "readiness",
    defaultVisible: true,
    queryKeys: [
      "integration-health-summary",
      "profile-section-status-summary",
      "fixture-validation-summary",
      "activation-readiness-summary",
      "adapter-transport-diagnostics",
    ],
    commands: [],
    freshnessStates: ["fresh", "stale", "lagging", "partial", "unavailable"],
    pagination: "none",
    routeContextKeys: ["section", "providerKey", "unitKey", "importScope", "profileVersion", "returnPath"],
  }),
  section({
    key: "import-jobs",
    defaultVisible: true,
    queryKeys: ["import-job-progress-summary"],
    commands: ["scope.sync", "scope.import", "job.resume", "job.retry", "job.cancel"],
    freshnessStates: ["fresh", "stale", "lagging", "unavailable"],
    pagination: "sse",
    routeContextKeys: ["section", "providerKey", "unitKey", "importScope", "profileVersion", "jobId", "returnPath"],
  }),
  section({
    key: "source-observation-review",
    defaultVisible: true,
    queryKeys: ["source-observation-review-query"],
    commands: ["observation.reject", "observation.defer"],
    freshnessStates: ["fresh", "stale", "partial", "unavailable"],
    pagination: "cursor",
    routeContextKeys: [
      "providerKey",
      "section",
      "unitKey",
      "importScope",
      "profileVersion",
      "sourceObservationFilters",
      "selectedObservationIds",
      "returnPath",
    ],
  }),
  section({
    key: "conflict-resolution",
    defaultVisible: false,
    queryKeys: ["source-observation-review-query", "promotion-plan-preview", "audit-evidence-timeline"],
    commands: ["observation.promote", "observation.reject", "observation.defer"],
    freshnessStates: ["fresh", "stale", "partial", "unavailable"],
    pagination: "cursor",
    routeContextKeys: [
      "providerKey",
      "section",
      "unitKey",
      "importScope",
      "profileVersion",
      "sourceObservationFilters",
      "selectedObservationIds",
      "promotionPreviewId",
      "returnPath",
    ],
  }),
  section({
    key: "promotion-preview",
    defaultVisible: true,
    queryKeys: ["promotion-plan-preview"],
    commands: ["observation.promote"],
    freshnessStates: ["fresh", "stale", "partial", "unavailable"],
    pagination: "cursor",
    routeContextKeys: [
      "providerKey",
      "section",
      "unitKey",
      "importScope",
      "profileVersion",
      "selectedObservationIds",
      "promotionPreviewId",
      "returnPath",
    ],
  }),
  section({
    key: "promotion-result",
    defaultVisible: true,
    queryKeys: ["audit-evidence-timeline"],
    commands: ["observation.reapply", "observation.replay"],
    freshnessStates: ["fresh", "stale", "lagging", "partial", "unavailable"],
    pagination: "cursor",
    routeContextKeys: ["section", "providerKey", "unitKey", "profileVersion", "jobId", "returnPath"],
  }),
  section({
    key: "lifecycle-recovery",
    defaultVisible: false,
    queryKeys: ["rollback-retirement-impact-summary", "audit-evidence-timeline", "import-job-progress-summary"],
    commands: [
      "provider-profile.activate",
      "provider-profile.rollback",
      "provider-profile.deprecate",
      "provider-profile.retire",
    ],
    freshnessStates: ["fresh", "stale", "lagging", "partial", "unavailable"],
    pagination: "cursor",
    routeContextKeys: ["section", "providerKey", "unitKey", "profileVersion", "jobId", "returnPath"],
  }),
  section({
    key: "governance-controls",
    defaultVisible: false,
    queryKeys: [
      "integration-health-summary",
      "provider-transport-readiness-summary",
      "import-job-progress-summary",
      "source-observation-review-query",
      "promotion-plan-preview",
      "audit-evidence-timeline",
    ],
    commands: [
      "scope.sync",
      "scope.import",
      "observation.promote",
      "observation.reject",
      "observation.defer",
      "provider-profile.rollback",
      "provider-profile.deprecate",
      "provider-profile.retire",
      "observation.reapply",
      "observation.replay",
    ],
    freshnessStates: ["fresh", "stale", "lagging", "partial", "unavailable"],
    pagination: "cursor",
    routeContextKeys: ["section", "providerKey", "unitKey", "importScope", "profileVersion", "jobId", "returnPath"],
  }),
  section({
    key: "audit-evidence",
    defaultVisible: false,
    queryKeys: [
      "audit-evidence-timeline",
      "import-job-progress-summary",
      "source-observation-review-query",
      "promotion-plan-preview",
      "dry-run-evidence-summary",
      "rollback-retirement-impact-summary",
    ],
    commands: [],
    freshnessStates: ["fresh", "stale", "lagging", "partial", "unavailable"],
    pagination: "cursor",
    routeContextKeys: [
      "section",
      "providerKey",
      "unitKey",
      "importScope",
      "profileVersion",
      "sourceObservationFilters",
      "selectedObservationIds",
      "jobId",
      "promotionPreviewId",
      "returnPath",
    ],
  }),
  section({
    key: "supporting-evidence",
    defaultVisible: false,
    queryKeys: [
      "dry-run-evidence-summary",
      "semantic-version-comparison",
      "replay-reapply-impact-summary",
      "rollback-retirement-impact-summary",
      "audit-evidence-timeline",
    ],
    commands: [],
    freshnessStates: ["fresh", "stale", "lagging", "partial", "unavailable"],
    pagination: "cursor",
    routeContextKeys: ["section", "providerKey", "unitKey", "profileVersion", "returnPath"],
  }),
] as const satisfies readonly CatalogPrimaryWorkbenchSectionContract[];

export const catalogPrimaryWorkbenchActions = [
  action("scope.sync", "POST", "/api/catalog/source-observations/catalog-sync-scope/runs", "catalog.manage", {
    blockerCategories: [
      "permission-denied",
      "authorization-denied",
      "rollout-disabled",
      "kill-switch-active",
      "unit-selection-required",
      "import-scope-required",
      "missing-active-profile",
      "read-model-unavailable",
      "security-privacy-blocked",
      "deploy-skew-unsupported-version",
    ],
    idempotencyRequired: true,
  }),
  action("scope.import", "POST", "/api/catalog/source-observations/admin/import-jobs", "catalog.manage", {
    blockerCategories: [
      "rollout-disabled",
      "kill-switch-active",
      "rbac-missing",
      "provider-selection-required",
      "unit-selection-required",
      "import-scope-required",
      "missing-active-profile",
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
      "active-job-conflict",
      "concurrent-job",
      "security-privacy-blocked",
      "deploy-skew-unsupported-version",
    ],
    idempotencyRequired: true,
  }),
  action("job.resume", "POST", "/api/catalog/source-observations/admin/import-jobs/:jobId/resume", "catalog.manage", {
    blockerCategories: ["job-not-found"],
    idempotencyRequired: true,
  }),
  action("job.retry", "POST", "/api/catalog/source-observations/admin/import-jobs/:jobId/retry", "catalog.manage", {
    blockerCategories: ["idempotency-replay", "stale-replay", "security-privacy-blocked"],
    idempotencyRequired: true,
  }),
  action("job.cancel", "POST", "/api/catalog/source-observations/admin/import-jobs/:jobId/cancel", "catalog.manage", {
    blockerCategories: ["permission-denied", "authorization-denied", "unsupported-command"],
    idempotencyRequired: true,
  }),
  action(
    "provider-profile.clone",
    "POST",
    "/api/catalog/source-observations/admin/provider-profiles/:providerKey/:profileVersion/clone",
    "catalog.manage",
    {
      blockerCategories: [
        "permission-denied",
        "authorization-denied",
        "profile-version-missing",
        "active-job-conflict",
        "concurrent-job",
        "raw-json-retired",
      ],
      idempotencyRequired: true,
    },
  ),
  action(
    "provider-profile.activate",
    "POST",
    "/api/catalog/source-observations/admin/provider-profiles/:providerKey/:profileVersion/activate",
    "catalog.manage",
    {
      blockerCategories: [
        "permission-denied",
        "authorization-denied",
        "profile-version-missing",
        "activation-readiness-blocked",
        "migration-evidence-missing",
        "reference-impact-review-required",
        "active-job-conflict",
        "concurrent-job",
        "security-privacy-blocked",
        "deploy-skew-unsupported-version",
      ],
      confirmationRequired: true,
      idempotencyRequired: true,
    },
  ),
  action(
    "provider-profile.rollback",
    "POST",
    "/api/catalog/source-observations/admin/provider-profiles/:providerKey/:profileVersion/rollback",
    "catalog.manage",
    {
      blockerCategories: [
        "permission-denied",
        "authorization-denied",
        "profile-version-missing",
        "profile-lifecycle-conflict",
        "active-job-conflict",
        "concurrent-job",
        "security-privacy-blocked",
        "deploy-skew-unsupported-version",
      ],
      confirmationRequired: true,
      idempotencyRequired: true,
    },
  ),
  action(
    "provider-profile.deprecate",
    "POST",
    "/api/catalog/source-observations/admin/provider-profiles/:providerKey/:profileVersion/deprecate",
    "catalog.manage",
    {
      blockerCategories: [
        "permission-denied",
        "authorization-denied",
        "profile-version-missing",
        "profile-lifecycle-conflict",
        "active-job-conflict",
        "concurrent-job",
        "security-privacy-blocked",
        "deploy-skew-unsupported-version",
      ],
      confirmationRequired: true,
      idempotencyRequired: true,
    },
  ),
  action(
    "provider-profile.retire",
    "POST",
    "/api/catalog/source-observations/admin/provider-profiles/:providerKey/:profileVersion/retire",
    "catalog.manage",
    {
      blockerCategories: [
        "permission-denied",
        "authorization-denied",
        "profile-version-missing",
        "profile-lifecycle-conflict",
        "profile-retirement-references",
        "active-job-conflict",
        "concurrent-job",
        "security-privacy-blocked",
        "deploy-skew-unsupported-version",
      ],
      confirmationRequired: true,
      idempotencyRequired: true,
    },
  ),
  action(
    "provider-profile.edit-section",
    "PATCH",
    "/api/catalog/source-observations/admin/provider-profiles/:providerKey/:profileVersion/sections/:section",
    "catalog.manage",
    {
      blockerCategories: [
        "permission-denied",
        "authorization-denied",
        "profile-version-missing",
        "profile-section-read-only",
        "profile-section-stale",
        "profile-section-invalid",
        "active-job-conflict",
        "concurrent-job",
        "raw-json-retired",
      ],
      idempotencyRequired: true,
    },
  ),
  action("observation.promote", "POST", "/api/catalog/source-observations/admin/promotions", "catalog.manage", {
    blockerCategories: [
      "selection-empty",
      "no-promotion-eligible-observations",
      "duplicate-conflict",
      "stale-promotion-preview",
      "display-identity-unresolvable",
      "destructive-confirmation-required",
      "promotion-conflict",
      "active-job-conflict",
      "concurrent-job",
      "security-privacy-blocked",
      "deploy-skew-unsupported-version",
    ],
    confirmationRequired: true,
    idempotencyRequired: true,
  }),
  action("observation.reject", "POST", "/api/catalog/source-observations/admin/rejections", "catalog.manage", {
    blockerCategories: ["selection-empty", "permission-denied", "authorization-denied"],
    confirmationRequired: true,
    idempotencyRequired: true,
  }),
  action("observation.defer", "POST", "/api/catalog/source-observations/admin/deferrals", "catalog.manage", {
    blockerCategories: ["selection-empty", "permission-denied", "authorization-denied"],
    idempotencyRequired: true,
  }),
  action(
    "candidate.promote",
    "POST",
    "/api/catalog/source-observations/admin/merge-candidates/:candidateId/promote",
    "catalog.manage",
    {
      blockerCategories: [
        "selection-empty",
        "permission-denied",
        "authorization-denied",
        "promotion-conflict",
        "source-projection-stale",
      ],
      confirmationRequired: true,
      idempotencyRequired: true,
    },
  ),
  action(
    "candidate.split",
    "POST",
    "/api/catalog/source-observations/admin/merge-candidates/:candidateId/split",
    "catalog.manage",
    {
      blockerCategories: ["selection-empty", "permission-denied", "authorization-denied", "source-projection-stale"],
      confirmationRequired: true,
      idempotencyRequired: true,
    },
  ),
  action(
    "candidate.edit",
    "POST",
    "/api/catalog/source-observations/admin/merge-candidates/:candidateId/update",
    "catalog.manage",
    {
      blockerCategories: ["selection-empty", "permission-denied", "authorization-denied", "source-projection-stale"],
      idempotencyRequired: true,
    },
  ),
  action(
    "candidate.ignore",
    "POST",
    "/api/catalog/source-observations/admin/merge-candidates/:candidateId/ignore",
    "catalog.manage",
    {
      blockerCategories: ["selection-empty", "permission-denied", "authorization-denied"],
      confirmationRequired: true,
      idempotencyRequired: true,
    },
  ),
  action(
    "candidate.defer",
    "POST",
    "/api/catalog/source-observations/admin/merge-candidates/:candidateId/defer",
    "catalog.manage",
    {
      blockerCategories: ["selection-empty", "permission-denied", "authorization-denied"],
      idempotencyRequired: true,
    },
  ),
  action("observation.reapply", "POST", "/api/catalog/source-observations/admin/reapply-jobs", "catalog.manage", {
    blockerCategories: ["profile-version-missing", "stale-replay", "idempotency-replay", "security-privacy-blocked"],
    idempotencyRequired: true,
  }),
  action("observation.replay", "POST", "/api/catalog/source-observations/admin/replay-jobs", "catalog.manage", {
    blockerCategories: ["profile-version-missing", "stale-replay", "idempotency-replay", "security-privacy-blocked"],
    idempotencyRequired: true,
  }),
  action("alias.accept", "POST", "/api/catalog/alias-equivalence/admin/review", "catalog.manage", {
    idempotencyRequired: true,
  }),
  action("alias.reject", "POST", "/api/catalog/alias-equivalence/admin/review", "catalog.manage", {
    blockerCategories: ["permission-denied", "authorization-denied"],
    idempotencyRequired: true,
  }),
  action("alias.revoke", "POST", "/api/catalog/alias-equivalence/admin/review", "catalog.manage", {
    blockerCategories: ["permission-denied", "authorization-denied"],
    idempotencyRequired: true,
  }),
  action("alias.defer", "POST", "/api/catalog/alias-equivalence/admin/review", "catalog.manage", {
    idempotencyRequired: true,
  }),
] as const satisfies readonly CatalogPrimaryWorkbenchActionContract[];

export const catalogPrimaryWorkbenchBlockers = [
  blocker("permission-denied", ["denied"], "catalog.primary.import.denied"),
  blocker("authorization-denied", ["denied"], "catalog.primary.import.denied"),
  blocker("rollout-disabled", ["blocked"], "catalog.primary.import.blocked"),
  blocker("kill-switch-active", ["blocked"], "catalog.primary.import.blocked"),
  blocker("rbac-missing", ["denied"], "catalog.primary.import.denied"),
  blocker("active-job-conflict", ["blocked"], "catalog.primary.import.blocked"),
  blocker("concurrent-job", ["blocked"], "catalog.primary.import.blocked"),
  blocker("provider-selection-required", ["blocked"], "catalog.primary.providerScope.required"),
  blocker("unit-selection-required", ["blocked"], "catalog.primary.providerScope.required"),
  blocker("import-scope-required", ["blocked"], "catalog.primary.providerScope.required"),
  blocker("missing-active-profile", ["blocked"], "catalog.primary.providerScope.required"),
  blocker("profile-version-missing", ["blocked"], "catalog.primary.reapply.originalProfileMissing"),
  blocker("profile-section-read-only", ["blocked"], "catalog.primary.import.blocked"),
  blocker("profile-section-stale", ["blocked"], "catalog.primary.deploySkew.failClosed"),
  blocker("profile-section-invalid", ["blocked"], "catalog.primary.import.blocked"),
  blocker("profile-lifecycle-conflict", ["blocked"], "catalog.primary.reapply.originalProfileMissing"),
  blocker("profile-retirement-references", ["blocked"], "catalog.primary.reapply.originalProfileMissing"),
  blocker("activation-readiness-blocked", ["blocked"], "catalog.primary.import.blocked"),
  blocker("migration-evidence-missing", ["blocked"], "catalog.primary.import.blocked"),
  blocker("reference-impact-review-required", ["blocked"], "catalog.primary.import.blocked"),
  blocker("missing-fixture-coverage", ["blocked"], "catalog.primary.import.blocked"),
  blocker("fixture-validation-blocked", ["blocked"], "catalog.primary.import.blocked"),
  blocker("provider-credential-missing", ["blocked"], "catalog.primary.import.blocked"),
  blocker("provider-credential-invalid", ["blocked"], "catalog.primary.import.blocked"),
  blocker("provider-credential-expired", ["blocked"], "catalog.primary.import.blocked"),
  blocker("provider-transport-rate-limited", ["degraded"], "catalog.primary.import.blocked"),
  blocker("provider-transport-throttled", ["degraded"], "catalog.primary.import.blocked"),
  blocker("provider-transport-quota-exceeded", ["blocked"], "catalog.primary.import.blocked"),
  blocker("provider-transport-timeout", ["degraded"], "catalog.primary.import.blocked"),
  blocker("provider-transport-pagination-failure", ["blocked"], "catalog.primary.import.blocked"),
  blocker("provider-transport-partial-data", ["degraded"], "catalog.primary.import.blocked"),
  blocker("provider-transport-stale-cache", ["degraded"], "catalog.primary.import.blocked"),
  blocker("provider-transport-degraded", ["degraded"], "catalog.primary.import.blocked"),
  blocker("source-projection-stale", ["degraded"], "catalog.primary.review.blocked"),
  blocker("read-model-degraded", ["degraded"], "catalog.primary.review.blocked"),
  blocker("read-model-partial", ["degraded"], "catalog.primary.review.blocked"),
  blocker("read-model-unavailable", ["unavailable"], "catalog.primary.review.blocked"),
  blocker("job-not-found", ["disabled"], "catalog.primary.import.blocked"),
  blocker("observation-not-found", ["disabled"], "catalog.primary.review.empty"),
  blocker("selection-empty", ["disabled"], "catalog.primary.review.empty"),
  blocker("no-promotion-eligible-observations", ["disabled"], "catalog.primary.review.empty"),
  blocker("duplicate-conflict", ["blocked"], "catalog.primary.promotion.previewRequired"),
  blocker("promotion-conflict", ["blocked"], "catalog.primary.promotion.previewRequired"),
  blocker("destructive-confirmation-required", ["unsafe"], "catalog.primary.promotion.previewRequired"),
  blocker("stale-promotion-preview", ["blocked"], "catalog.primary.promotion.stalePreview"),
  blocker("display-identity-unresolvable", ["blocked"], "catalog.primary.promotion.previewRequired"),
  blocker("stale-replay", ["blocked"], "catalog.primary.reapply.originalProfileMissing"),
  blocker("idempotency-replay", ["blocked"], "catalog.primary.import.blocked"),
  blocker("security-privacy-blocked", ["unsafe"], "catalog.primary.promotion.securityBlocked"),
  blocker("unsupported-command", ["unavailable"], "catalog.primary.deploySkew.failClosed"),
  blocker("deploy-skew-unsupported-version", ["unavailable"], "catalog.primary.deploySkew.failClosed"),
  blocker("raw-json-retired", ["blocked"], "catalog.primary.deploySkew.failClosed"),
  blocker("legacy-selector-retired", ["blocked"], "catalog.primary.deploySkew.failClosed"),
] as const satisfies readonly CatalogPrimaryWorkbenchBlockerContract[];

export const catalogPrimaryWorkbenchDeploySkewPolicies = [
  deploySkew("current", true, []),
  deploySkew("old-ui-new-api", false, [
    "legacy provider selector",
    "retired admin module coupling",
    "raw JSON broad patch",
    "silent active-profile fallback",
  ]),
  deploySkew("new-ui-old-api", false, [
    "raw provider payload fallback",
    "generic disabled state",
    "support-only legacy route",
    "compatibility redirect",
  ]),
] as const satisfies readonly CatalogPrimaryWorkbenchDeploySkewPolicy[];

export const catalogPrimaryWorkbenchRetirementPolicy = {
  term: "retire",
  requiredDisposition: "complete-removal",
  surfaces: [
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
  ],
  forbiddenOutcomes: [
    "soft deprecation",
    "compatibility shim",
    "legacy support path",
    "migration of retired admin structure",
    "raw JSON escape hatch",
    "support-only preserved route",
    "documentation-only deprecation",
    "hidden flag fallback",
  ],
} as const satisfies CatalogPrimaryWorkbenchRetirementPolicy;

export const catalogPrimaryWorkbenchInstrumentationDimensions = [
  "provider_key",
  "unit_key",
  "import_scope",
  "profile_version",
  "source_observation_status",
  "promotion_disposition",
  "blocker_category",
  "action_key",
  "transport_category",
  "read_model_freshness",
  "route_context_preserved",
] as const satisfies readonly CatalogPrimaryWorkbenchInstrumentationDimension[];

export const catalogPrimaryWorkbenchDownstreamContracts = [
  downstream(
    "#1033",
    ["supporting-evidence"],
    [
      "profileAuthoring.status",
      "profileAuthoring.selectedProfile",
      "profileAuthoring.availableProfiles",
      "profileAuthoring.cloneDraft",
    ],
  ),
  downstream(
    "#1034",
    ["supporting-evidence"],
    [
      "profileAuthoring.sectionGroups",
      "profileAuthoring.sectionWorkspaces",
      "profileAuthoring.sectionWorkspaces.fields",
      "profileAuthoring.sectionWorkspaces.diagnostics",
      "profileAuthoring.sectionWorkspaces.saveOutcome",
    ],
  ),
  downstream(
    "#1035",
    ["supporting-evidence"],
    [
      "profileAuthoring.sectionWorkspaces.optionQueries",
      "profileAuthoring.sectionWorkspaces.importScopeControls",
      "profileAuthoring.sectionWorkspaces.mappingRows",
    ],
  ),
  downstream(
    "#1036",
    ["readiness", "supporting-evidence"],
    [
      "validationReadiness.status",
      "validationReadiness.fixtureFlows",
      "validationReadiness.dryRunEvidence.normalizedFacts",
      "validationReadiness.dryRunEvidence.duplicateCandidates",
      "validationReadiness.dryRunEvidence.selectedOptions",
      "validationReadiness.dryRunEvidence.promotionCommandPreview",
      "validationReadiness.semanticCompare",
      "validationReadiness.activationReadiness",
    ],
  ),
  downstream(
    "#1037",
    ["readiness", "supporting-evidence"],
    [
      "validationReadiness.activationDecision.status",
      "validationReadiness.activationDecision.actionState",
      "validationReadiness.activationDecision.blockers",
      "validationReadiness.activationDecision.affectedReferences",
      "validationReadiness.activationDecision.migrationEvidence",
      "validationReadiness.activationDecision.auditConsequences",
    ],
  ),
  downstream(
    "#1041",
    ["conflict-resolution", "source-observation-review", "promotion-preview", "supporting-evidence"],
    [
      "conflictResolution.rows",
      "conflictResolution.precedenceRules",
      "conflictResolution.overridePolicy",
      "conflictResolution.recentAuditEvents",
    ],
  ),
  downstream(
    "#1042",
    ["lifecycle-recovery", "supporting-evidence"],
    [
      "lifecycleRecovery.operations",
      "lifecycleRecovery.summary",
      "lifecycleRecovery.strictRetirement",
      "lifecycleRecovery.recentAuditEvents",
    ],
  ),
  downstream(
    "#1043",
    ["governance-controls", "readiness", "import-jobs", "promotion-preview", "supporting-evidence"],
    [
      "governanceControls.rolloutMode",
      "governanceControls.controls",
      "governanceControls.rbacMatrix",
      "governanceControls.observability.signals",
      "governanceControls.legacyRemovalEvidence",
    ],
  ),
  downstream(
    "#1044",
    [
      "audit-evidence",
      "import-jobs",
      "source-observation-review",
      "promotion-preview",
      "lifecycle-recovery",
      "governance-controls",
      "supporting-evidence",
    ],
    [
      "auditEvidence.filters",
      "auditEvidence.projectionState",
      "auditEvidence.redactionPolicy",
      "auditEvidence.timeline",
      "auditEvidence.evidenceLinks",
    ],
  ),
  downstream(
    "#1056",
    [
      "provider-scope-selection",
      "readiness",
      "import-jobs",
      "source-observation-review",
      "promotion-preview",
      "promotion-result",
    ],
    [
      "schemaVersion",
      "routeContext",
      "providerScope",
      "readiness",
      "importJobs",
      "sourceObservationReview",
      "promotionPreview",
      "actions",
    ],
  ),
  downstream(
    "#1038",
    ["provider-scope-selection", "readiness", "import-jobs"],
    ["providerScope.providers.units.importScopes", "readiness.providerTransport", "importJobs.jobs.consistency"],
  ),
  downstream(
    "#1039",
    ["source-observation-review", "promotion-preview"],
    [
      "sourceObservationReview.counts",
      "sourceObservationReview.cursor",
      "sourceObservationReview.evidenceSummariesRedacted",
      "sourceObservationReview.filters",
      "sourceObservationReview.pagination",
      "sourceObservationReview.rows",
      "sourceObservationReview.rows.actions",
      "sourceObservationReview.rows.promotionReadiness",
      "promotionPreview.dispositions",
    ],
  ),
  downstream(
    "#1040",
    ["promotion-preview", "promotion-result"],
    [
      "promotionPreview.scope",
      "promotionPreview.validation",
      "promotionPreview.outcomeCounts",
      "promotionPreview.commandPlanHash",
      "promotionPreview.executionSafeguards",
      "promotionPreview.reviewDecisions",
      "promotionPreview.profileWorkflows",
      "promotionResult.auditEvidenceIds",
    ],
  ),
  downstream(
    "#1057",
    ["provider-scope-selection", "import-jobs", "source-observation-review", "promotion-preview"],
    [
      "routeContext.section",
      "routeContext.providerKey",
      "routeContext.unitKey",
      "routeContext.importScope",
      "routeContext.sourceObservationFilters",
      "routeContext.selectedObservationIds",
      "routeContext.jobId",
      "routeContext.promotionPreviewId",
      "routeContext.returnPath",
    ],
  ),
  downstream(
    "#1058",
    ["readiness", "import-jobs", "source-observation-review", "promotion-preview"],
    ["actions.copyKey", "readiness.blockers"],
  ),
  downstream(
    "#1059",
    [
      "provider-scope-selection",
      "readiness",
      "import-jobs",
      "source-observation-review",
      "promotion-preview",
      "governance-controls",
    ],
    ["instrumentation.dimensions", "instrumentation.redactionSafe", "governanceControls.observability.signals"],
  ),
  downstream(
    "#1062",
    ["provider-scope-selection", "readiness", "import-jobs", "promotion-result"],
    ["providerScope.providers.providerKey", "readiness.providerTransport", "promotionResult.promotedCatalogItemIds"],
  ),
  downstream(
    "#1063",
    ["import-jobs", "promotion-preview"],
    ["importJobs.jobs.consistency", "promotionPreview.blockers"],
  ),
  downstream(
    "#1064",
    ["readiness", "promotion-preview", "promotion-result", "governance-controls"],
    [
      "securityPrivacy.redactionApplied",
      "securityPrivacy.unsafeEvidenceBlocked",
      "securityPrivacy.missingSecurityFieldsBlocker",
      "governanceControls.rbacMatrix",
    ],
  ),
  downstream("#1065", ["readiness", "import-jobs"], ["readiness.providerTransport", "readiness.blockers"]),
] as const satisfies readonly CatalogPrimaryWorkbenchDownstreamContract[];

function section(input: CatalogPrimaryWorkbenchSectionContract): CatalogPrimaryWorkbenchSectionContract {
  return input;
}

function action(
  key: CatalogPrimaryWorkbenchCommandKey,
  method: CatalogPrimaryWorkbenchActionContract["method"],
  routePattern: string,
  requiredPermission: CatalogPrimaryWorkbenchActionContract["requiredPermission"],
  options: Partial<
    Pick<
      CatalogPrimaryWorkbenchActionContract,
      "blockerCategories" | "idempotencyRequired" | "confirmationRequired" | "successState"
    >
  > = {},
): CatalogPrimaryWorkbenchActionContract {
  return {
    key,
    method,
    routePattern,
    requiredPermission,
    successState: options.successState ?? "available",
    blockerCategories: options.blockerCategories ?? [],
    idempotencyRequired: options.idempotencyRequired ?? false,
    confirmationRequired: options.confirmationRequired ?? false,
  };
}

function blocker(
  category: CatalogPrimaryWorkbenchBlockerCategory,
  actionStates: readonly CatalogPrimaryWorkbenchActionState[],
  copyKey: CatalogPrimaryWorkbenchCopyKey,
): CatalogPrimaryWorkbenchBlockerContract {
  return {
    category,
    actionStates,
    copyKey,
    instrumentationDimension: "blocker_category",
    failClosed: true,
  };
}

function deploySkew(
  mode: CatalogPrimaryWorkbenchDeploySkewMode,
  supported: boolean,
  forbiddenFallbacks: readonly string[],
): CatalogPrimaryWorkbenchDeploySkewPolicy {
  return {
    mode,
    supported,
    failClosedBlocker: "deploy-skew-unsupported-version",
    forbiddenFallbacks,
  };
}

function downstream(
  issue: CatalogPrimaryWorkbenchDownstreamIssueKey,
  consumes: readonly CatalogPrimaryWorkbenchSectionKey[],
  requiredFields: readonly string[],
): CatalogPrimaryWorkbenchDownstreamContract {
  return {
    issue,
    consumes,
    requiredFields,
  };
}
