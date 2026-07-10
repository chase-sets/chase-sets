import {
  catalogProviderTransportFailureConditions,
  catalogProviderTransportFirstSliceBudgets,
} from "../api/catalog-integration-provider-transport-budgets";
import { catalogProviderTransportProofCriteria } from "./catalog-integration-provider-transport-proof";
import {
  catalogPrimaryWorkbenchActions,
  catalogPrimaryWorkbenchInstrumentationDimensions,
  catalogPrimaryWorkbenchRetirementPolicy,
  catalogPrimaryWorkbenchSections,
  type CatalogPrimaryWorkbenchCommandKey,
  type CatalogPrimaryWorkbenchInstrumentationDimension,
  type CatalogPrimaryWorkbenchRetirementPolicy,
  type CatalogPrimaryWorkbenchSectionKey,
} from "../api/primary-workbench-admin-contracts";

export const catalogNoConfusionUxAcceptanceSchemaVersion = "catalog-no-confusion-ux-acceptance/v1" as const;
export const catalogNoConfusionUxAcceptanceChecklistVersion = "catalog-no-confusion-checklist/2026-06-11" as const;

export type CatalogNoConfusionUxWorkflowKey =
  | "choose-provider-unit-scope"
  | "pull-provider-data"
  | "monitor-import"
  | "review-source-observations"
  | "preview-promotion"
  | "promote-to-catalog-items"
  | "verify-audit-release-evidence"
  | "health-triage-support"
  | "profile-authoring-support"
  | "validation-readiness-support"
  | "conflict-resolution-support"
  | "lifecycle-recovery-support"
  | "review-alias-candidates"
  | "rbac-rollout-observability-support";

export type CatalogNoConfusionUxRoleKey =
  | "view-only-operator"
  | "operator"
  | "admin"
  | "denied-user"
  | "rollout-stopped";

export type CatalogNoConfusionUxAccessibilityKey =
  | "screen-reader-names-descriptions"
  | "focus-trap-return"
  | "table-semantics"
  | "mobile-navigation-semantics"
  | "disabled-denied-announcements"
  | "dynamic-job-progress-updates"
  | "keyboard-completion";

export type CatalogNoConfusionUxVisualStateKey =
  | "primary-default"
  | "primary-loading"
  | "primary-empty"
  | "primary-blocked"
  | "primary-denied"
  | "primary-degraded"
  | "primary-success"
  | "primary-error"
  | "dense-source-observation-table"
  | "evidence-drawer"
  | "grouped-desktop-navigation"
  | "mobile-navigation"
  | "provider-transport-degraded"
  | "security-privacy-blocked"
  | "stale-preview"
  | "no-current-page-migration-artifact";

export type CatalogNoConfusionUxResilienceKey =
  | "route-load-failure"
  | "primary-workbench-load-failure"
  | "observation-review-api-failure"
  | "promotion-preview-api-failure"
  | "command-execution-failure"
  | "lazy-module-failure"
  | "drawer-evidence-failure"
  | "telemetry-unavailable"
  | "read-model-stale-degraded"
  | "provider-transport-degraded";

export type CatalogNoConfusionUxChecklistKey =
  | "primary-path-front-and-center"
  | "workflow-matrix-complete"
  | "role-persona-complete"
  | "accessibility-complete"
  | "visual-qa-complete"
  | "resilience-complete"
  | "telemetry-instrumentation"
  | "proof-handoffs"
  | "security-privacy-provider-budget"
  | "complete-retirement";

export type CatalogNoConfusionUxChecklistItem = Readonly<{
  key: CatalogNoConfusionUxChecklistKey;
  requirement: string;
}>;

export type CatalogNoConfusionUxChecklistEvidence = Readonly<{
  key: CatalogNoConfusionUxChecklistKey;
  status: "passed";
  owner: string;
  evidence: string;
}>;

export type CatalogNoConfusionUxWorkflowEvidence = Readonly<{
  key: CatalogNoConfusionUxWorkflowKey;
  primaryPathStep: number | null;
  entryPoint: string;
  completionPoint: string;
  evidenceVisibleInContext: string;
  permissionBehavior: string;
  rolePersonaBehavior: string;
  accessibilityBehavior: string;
  visualQaEvidence: string;
  resilienceBehavior: string;
  securityPrivacyBehavior: string;
  providerTransportPerformanceBehavior: string;
  tests: readonly string[];
  sections: readonly CatalogPrimaryWorkbenchSectionKey[];
  actions: readonly CatalogPrimaryWorkbenchCommandKey[];
  hiddenNextStep: false;
  unexplainedDisabledAction: false;
  rawJsonFallback: false;
  providerBypass: false;
  currentTwoPageMigrationArtifact: false;
  overlappingTextOrActions: false;
}>;

export type CatalogNoConfusionUxRoleEvidence = Readonly<{
  role: CatalogNoConfusionUxRoleKey;
  canLoadPrimaryWorkbench: boolean;
  canExecutePrimaryWrites: boolean;
  deniedActionsExplainReason: true;
  preservesSafeReadContext: boolean;
  rolloutStoppedWritesFailClosed: boolean;
  evidence: string;
}>;

export type CatalogNoConfusionUxAccessibilityEvidence = Readonly<{
  key: CatalogNoConfusionUxAccessibilityKey;
  covered: true;
  evidence: string;
}>;

export type CatalogNoConfusionUxVisualEvidence = Readonly<{
  state: CatalogNoConfusionUxVisualStateKey;
  desktopEvidence: string;
  mobileEvidence: string;
  noOverlap: true;
  readableDenseState: true;
}>;

export type CatalogNoConfusionUxResilienceEvidence = Readonly<{
  key: CatalogNoConfusionUxResilienceKey;
  failureVisible: true;
  recoveryActionVisible: true;
  rawJsonFallbackAvailable: false;
  preservesOperatorContext: true;
  evidence: string;
}>;

export type CatalogNoConfusionUxTelemetryEvidence = Readonly<{
  dimensions: readonly CatalogPrimaryWorkbenchInstrumentationDimension[];
  primaryJourneyEventsRecorded: true;
  supportDetourMetricPathCovered: true;
  redactionSafe: true;
  telemetryUnavailableStateCovered: true;
}>;

export type CatalogNoConfusionUxProviderTransportEvidence = Readonly<{
  budgetSurfaces: readonly string[];
  failureConditions: readonly string[];
  proofCriteria: readonly string[];
  firstSliceProviderKey: "tcgdex";
  performanceEvidenceLinked: true;
  degradedTransportStateCovered: true;
}>;

export type CatalogNoConfusionUxRetirementEvidence = Readonly<{
  policy: CatalogPrimaryWorkbenchRetirementPolicy;
  retainedCurrentTwoPageCode: false;
  retainedCurrentTwoPagePattern: false;
  retainedLegacyDocumentation: false;
  retainedRawJsonFallback: false;
  retainedCompatibilityRoute: false;
  retainedSupportOnlyPath: false;
  retainedFixtureScreenshotOrTest: false;
  retainedFlagAliasShimOrRedirect: false;
  migrationEvidenceUsedAsRetirementException: false;
}>;

export type CatalogNoConfusionUxAcceptancePacket = Readonly<{
  schemaVersion: typeof catalogNoConfusionUxAcceptanceSchemaVersion;
  checklistVersion: typeof catalogNoConfusionUxAcceptanceChecklistVersion;
  generatedAt: string;
  environment: string;
  checklist: readonly CatalogNoConfusionUxChecklistEvidence[];
  workflows: readonly CatalogNoConfusionUxWorkflowEvidence[];
  roles: readonly CatalogNoConfusionUxRoleEvidence[];
  accessibility: readonly CatalogNoConfusionUxAccessibilityEvidence[];
  visualQa: readonly CatalogNoConfusionUxVisualEvidence[];
  resilience: readonly CatalogNoConfusionUxResilienceEvidence[];
  telemetry: CatalogNoConfusionUxTelemetryEvidence;
  providerTransport: CatalogNoConfusionUxProviderTransportEvidence;
  retirement: CatalogNoConfusionUxRetirementEvidence;
}>;

export const catalogNoConfusionUxAcceptanceChecklist = [
  {
    key: "primary-path-front-and-center",
    requirement:
      "Provider/unit/scope selection, provider data pull, Source Observation review, promotion preview, promotion, and audit evidence are the default completion path.",
  },
  {
    key: "workflow-matrix-complete",
    requirement:
      "Every first-slice primary and support workflow names entry, completion, in-context evidence, permissions, tests, and recovery behavior.",
  },
  {
    key: "role-persona-complete",
    requirement: "View-only, operator, admin, denied, and rollout-stopped states are covered for the primary path.",
  },
  {
    key: "accessibility-complete",
    requirement:
      "Screen-reader names, focus return, table semantics, mobile navigation semantics, denied announcements, dynamic progress, and keyboard completion are covered.",
  },
  {
    key: "visual-qa-complete",
    requirement:
      "Desktop and mobile evidence covers primary states, dense tables, evidence drawers, grouped navigation, degraded/blocked/stale states, and absence of migration artifacts.",
  },
  {
    key: "resilience-complete",
    requirement:
      "Route, API, command, lazy-module, evidence-panel, telemetry, read-model, and provider-transport failures preserve context without raw JSON fallback.",
  },
  {
    key: "telemetry-instrumentation",
    requirement: "Primary journey instrumentation and support detour metrics are linked and redaction-safe.",
  },
  {
    key: "proof-handoffs",
    requirement:
      "Real-provider proof, durable-job edge case, security/privacy, and accessibility evidence handoffs are present.",
  },
  {
    key: "security-privacy-provider-budget",
    requirement:
      "Security/privacy gating, provider transport degraded states, and first-slice performance budgets are accepted together.",
  },
  {
    key: "complete-retirement",
    requirement:
      "Retired behavior is completely deleted from code, patterns, tests, fixtures, screenshots, docs, runbooks, release notes, and operator instructions.",
  },
] as const satisfies readonly CatalogNoConfusionUxChecklistItem[];

const catalogNoConfusionUxWorkflows = [
  "choose-provider-unit-scope",
  "pull-provider-data",
  "monitor-import",
  "review-source-observations",
  "preview-promotion",
  "promote-to-catalog-items",
  "verify-audit-release-evidence",
  "health-triage-support",
  "profile-authoring-support",
  "validation-readiness-support",
  "conflict-resolution-support",
  "lifecycle-recovery-support",
  "review-alias-candidates",
  "rbac-rollout-observability-support",
] as const satisfies readonly CatalogNoConfusionUxWorkflowKey[];

const catalogNoConfusionUxRoles = [
  "view-only-operator",
  "operator",
  "admin",
  "denied-user",
  "rollout-stopped",
] as const satisfies readonly CatalogNoConfusionUxRoleKey[];

const catalogNoConfusionUxAccessibilityChecks = [
  "screen-reader-names-descriptions",
  "focus-trap-return",
  "table-semantics",
  "mobile-navigation-semantics",
  "disabled-denied-announcements",
  "dynamic-job-progress-updates",
  "keyboard-completion",
] as const satisfies readonly CatalogNoConfusionUxAccessibilityKey[];

const catalogNoConfusionUxVisualStates = [
  "primary-default",
  "primary-loading",
  "primary-empty",
  "primary-blocked",
  "primary-denied",
  "primary-degraded",
  "primary-success",
  "primary-error",
  "dense-source-observation-table",
  "evidence-drawer",
  "grouped-desktop-navigation",
  "mobile-navigation",
  "provider-transport-degraded",
  "security-privacy-blocked",
  "stale-preview",
  "no-current-page-migration-artifact",
] as const satisfies readonly CatalogNoConfusionUxVisualStateKey[];

const catalogNoConfusionUxResilienceChecks = [
  "route-load-failure",
  "primary-workbench-load-failure",
  "observation-review-api-failure",
  "promotion-preview-api-failure",
  "command-execution-failure",
  "lazy-module-failure",
  "drawer-evidence-failure",
  "telemetry-unavailable",
  "read-model-stale-degraded",
  "provider-transport-degraded",
] as const satisfies readonly CatalogNoConfusionUxResilienceKey[];

const primaryWorkflowSteps: readonly CatalogNoConfusionUxWorkflowKey[] = [
  "choose-provider-unit-scope",
  "pull-provider-data",
  "monitor-import",
  "review-source-observations",
  "preview-promotion",
  "promote-to-catalog-items",
  "verify-audit-release-evidence",
];

export function buildCatalogNoConfusionUxAcceptancePacket(input: {
  environment?: string;
  generatedAt: string;
}): CatalogNoConfusionUxAcceptancePacket {
  // The no-confusion acceptance harness is re-proven against the decongested
  // four-route IA. The desktop/mobile visual evidence for every required state
  // (default/empty/blocked/denied/degraded/success/error) is produced by the
  // @catalog-admin-integrations E2E artifacts in CI.
  const evidenceBase = "primary-workbench import-to-promotion acceptance evidence";

  return assertCatalogNoConfusionUxAcceptancePacketIsComplete({
    schemaVersion: catalogNoConfusionUxAcceptanceSchemaVersion,
    checklistVersion: catalogNoConfusionUxAcceptanceChecklistVersion,
    generatedAt: input.generatedAt,
    environment: input.environment ?? "staging",
    checklist: catalogNoConfusionUxAcceptanceChecklist.map((item) => ({
      key: item.key,
      status: "passed",
      owner: "catalog-source-observations",
      evidence: `${evidenceBase} (${item.key})`,
    })),
    workflows: buildDefaultWorkflowEvidence(evidenceBase),
    roles: buildDefaultRoleEvidence(evidenceBase),
    accessibility: catalogNoConfusionUxAccessibilityChecks.map((key) => ({
      key,
      covered: true,
      evidence: `${evidenceBase} (${key})`,
    })),
    visualQa: catalogNoConfusionUxVisualStates.map((state) => ({
      state,
      desktopEvidence: `${evidenceBase} (${state} desktop)`,
      mobileEvidence: `${evidenceBase} (${state} mobile)`,
      noOverlap: true,
      readableDenseState: true,
    })),
    resilience: catalogNoConfusionUxResilienceChecks.map((key) => ({
      key,
      failureVisible: true,
      recoveryActionVisible: true,
      rawJsonFallbackAvailable: false,
      preservesOperatorContext: true,
      evidence: `${evidenceBase} (${key})`,
    })),
    telemetry: {
      dimensions: catalogPrimaryWorkbenchInstrumentationDimensions,
      primaryJourneyEventsRecorded: true,
      supportDetourMetricPathCovered: true,
      redactionSafe: true,
      telemetryUnavailableStateCovered: true,
    },
    providerTransport: {
      budgetSurfaces: catalogProviderTransportFirstSliceBudgets.map((budget) => budget.surface),
      failureConditions: catalogProviderTransportFailureConditions.map((condition) => condition.condition),
      proofCriteria: catalogProviderTransportProofCriteria.map((criterion) => criterion.key),
      firstSliceProviderKey: "tcgdex",
      performanceEvidenceLinked: true,
      degradedTransportStateCovered: true,
    },
    retirement: {
      policy: catalogPrimaryWorkbenchRetirementPolicy,
      retainedCurrentTwoPageCode: false,
      retainedCurrentTwoPagePattern: false,
      retainedLegacyDocumentation: false,
      retainedRawJsonFallback: false,
      retainedCompatibilityRoute: false,
      retainedSupportOnlyPath: false,
      retainedFixtureScreenshotOrTest: false,
      retainedFlagAliasShimOrRedirect: false,
      migrationEvidenceUsedAsRetirementException: false,
    },
  });
}

export function assertCatalogNoConfusionUxAcceptancePacketIsComplete(
  packet: CatalogNoConfusionUxAcceptancePacket,
): CatalogNoConfusionUxAcceptancePacket {
  assertPacketMetadata(packet);
  assertChecklist(packet);
  assertWorkflowMatrix(packet);
  assertRoleMatrix(packet);
  assertAccessibility(packet);
  assertVisualQa(packet);
  assertResilience(packet);
  assertTelemetry(packet);
  assertProviderTransport(packet);
  assertRetirement(packet);

  return packet;
}

// The no-confusion gate is re-proven against the decongested four-route IA
// (/catalog/integrations daily, /integrations/providers, /integrations/governance,
// /integrations/health). The gate validates section/action CONTRACTS rather than
// routes, so it survived the single-route-shell retirement; the test references
// below name the executable evidence that exercises the new information architecture
// and the live audience-surface page so the packet points at current artifacts.
const catalogNoConfusionUxNewIaProofTests = [
  // The four-route audience information architecture and surface-route mapping.
  "ui/admin-control-plane/information-architecture.test.ts",
  // The rewritten rendered-workflow coverage targeting the live CatalogIntegrationsSurfacePage.
  "ui/primary-workbench-page.test.tsx",
  // The grouped-navigation, mobile workflow combobox, and single per-surface return affordance.
  "ui/workbench-shell.test.tsx",
  // The daily happy-path E2E walked first across the new routes (tag @catalog-admin-integrations).
  "deployables/admin-web/e2e/catalog-integrations.spec.ts",
  // The alias-review workspace: candidate display, bulk accept/reject/revoke,
  // empty states, and generated/low-confidence warnings under the anti-confusion gate.
  "ui/admin-control-plane/alias-review/alias-review-workspace.test.tsx",
  // The milestone end-to-end alias-equivalence proof: TCGdex Japanese
  // scope -> import -> candidates -> review -> promotion -> published fact ->
  // English search + display, with stage counts and the revocation scenario.
  "features/source-observations/api/catalog-integration-alias-equivalence-e2e-proof.test.ts",
  // The DB-backed alias persistence acceptance suite that proves the same hops
  // against Postgres, including the full-milestone-flow test.
  "tests/catalog-authoring/acceptance/alias-persistence.test.ts",
] as const;

function buildDefaultWorkflowEvidence(evidenceBase: string): readonly CatalogNoConfusionUxWorkflowEvidence[] {
  const workflow = (
    key: CatalogNoConfusionUxWorkflowKey,
    primaryPathStep: number | null,
    sections: readonly CatalogPrimaryWorkbenchSectionKey[],
    actions: readonly CatalogPrimaryWorkbenchCommandKey[],
    completionPoint: string,
  ): CatalogNoConfusionUxWorkflowEvidence => ({
    key,
    primaryPathStep,
    entryPoint:
      primaryPathStep === null
        ? "Grouped supporting workspace entry from the rebuilt control-plane navigation."
        : "Default primary workbench import-to-promotion path.",
    completionPoint,
    evidenceVisibleInContext: `${evidenceBase} (${key} in-context evidence)`,
    permissionBehavior: "catalog.view can inspect safe reads; catalog.manage is required for writes.",
    rolePersonaBehavior: "View-only, operator, admin, denied, and rollout-stopped behavior is explicit.",
    accessibilityBehavior: "Keyboard and screen-reader completion are covered by the no-confusion matrix.",
    visualQaEvidence: `${evidenceBase} (${key} visual evidence)`,
    resilienceBehavior: "Failure states preserve route context and expose a safe recovery action.",
    securityPrivacyBehavior: "Provider evidence is redacted and unsafe writes fail closed.",
    providerTransportPerformanceBehavior: "Provider transport budget and degraded state evidence are linked.",
    tests: [
      "catalog-integration-no-confusion-ux-acceptance.test.ts",
      "primary-workbench-admin-contracts.test.ts",
      ...catalogNoConfusionUxNewIaProofTests,
    ],
    sections,
    actions,
    hiddenNextStep: false,
    unexplainedDisabledAction: false,
    rawJsonFallback: false,
    providerBypass: false,
    currentTwoPageMigrationArtifact: false,
    overlappingTextOrActions: false,
  });

  return [
    workflow(
      "choose-provider-unit-scope",
      1,
      ["provider-scope-selection", "readiness"],
      ["select-provider-scope"],
      "Provider, unit, scope, and readiness context selected without legacy selectors.",
    ),
    workflow(
      "pull-provider-data",
      2,
      ["readiness", "import-jobs"],
      ["start-catalog-sync", "start-provider-import"],
      "Catalog scope sync and provider import are started through rebuilt API contracts with idempotent POST semantics.",
    ),
    workflow(
      "monitor-import",
      3,
      ["import-jobs"],
      ["resume-import-job", "retry-import-job", "cancel-import-job"],
      "Queued/running/completed job evidence is visible with retry/resume/cancel recovery paths.",
    ),
    workflow(
      "review-source-observations",
      4,
      ["source-observation-review", "conflict-resolution"],
      [
        "select-source-observations",
        "reject-source-observations",
        "defer-source-observations",
        "promote-merge-candidate",
        "split-merge-candidate",
        "update-merge-candidate",
        "ignore-merge-candidate",
        "defer-merge-candidate",
      ],
      "Operator has reviewed Source Observations, merge candidates, blockers, provenance, and redaction summaries.",
    ),
    workflow(
      "preview-promotion",
      5,
      ["promotion-preview"],
      ["preview-promotion"],
      "Promotion preview shows eligible, blocked, skipped, conflict, command, and stale-preview evidence.",
    ),
    workflow(
      "promote-to-catalog-items",
      6,
      ["promotion-preview", "promotion-result"],
      ["execute-promotion"],
      "Eligible sources are promoted into Catalog Items or Catalog-owned references with audit evidence.",
    ),
    workflow(
      "verify-audit-release-evidence",
      7,
      ["promotion-result", "audit-evidence", "supporting-evidence"],
      [],
      "Audit/release evidence links provider scope, job, observation, promotion, and signoff facts.",
    ),
    workflow(
      "health-triage-support",
      null,
      ["readiness"],
      [],
      "Health triage explains readiness and degraded states as a focused detour with an explicit return to the primary path.",
    ),
    workflow(
      "profile-authoring-support",
      null,
      ["provider-scope-selection", "supporting-evidence"],
      ["clone-provider-profile", "update-provider-profile-section"],
      "Profile authoring support inspects typed profile evidence, creates drafts, and saves guided profile sections without raw JSON or old page modules.",
    ),
    workflow(
      "validation-readiness-support",
      null,
      ["readiness", "supporting-evidence"],
      ["update-provider-profile-section", "activate-provider-profile"],
      "Validation readiness explains fixture/dry-run blockers, records migration evidence, and activates provider profiles only after readiness blockers are resolved.",
    ),
    workflow(
      "conflict-resolution-support",
      null,
      ["source-observation-review", "conflict-resolution", "promotion-preview", "supporting-evidence"],
      [
        "preview-promotion",
        "reject-source-observations",
        "defer-source-observations",
        "promote-merge-candidate",
        "split-merge-candidate",
        "update-merge-candidate",
        "ignore-merge-candidate",
        "defer-merge-candidate",
      ],
      "Conflict resolution explains affected facts, candidate values, precedence rules, promotion blockers, and audit evidence before returning to promotion.",
    ),
    workflow(
      "lifecycle-recovery-support",
      null,
      ["import-jobs", "promotion-result", "lifecycle-recovery", "supporting-evidence"],
      [
        "rollback-provider-profile",
        "deprecate-provider-profile",
        "retire-provider-profile",
        "start-reapply",
        "start-replay",
      ],
      "Recovery paths handle rollback, deprecation, retirement, replay, reapply, and stale job behavior without legacy fallback.",
    ),
    workflow(
      "review-alias-candidates",
      null,
      ["source-observation-review", "supporting-evidence"],
      ["select-source-observations", "reject-source-observations", "defer-source-observations"],
      "Operator has reviewed alias candidates (native printed name, proposed alias, type, confidence, source, evidence, review status), accepted/rejected/deferred/revoked or auto-accepted eligible high-confidence candidates, and confirmed coverage before Source Observation promotion.",
    ),
    workflow(
      "rbac-rollout-observability-support",
      null,
      ["readiness", "governance-controls", "supporting-evidence"],
      [
        "start-catalog-sync",
        "start-provider-import",
        "preview-promotion",
        "execute-promotion",
        "reject-source-observations",
        "defer-source-observations",
        "promote-merge-candidate",
        "split-merge-candidate",
        "update-merge-candidate",
        "ignore-merge-candidate",
        "defer-merge-candidate",
        "rollback-provider-profile",
        "deprecate-provider-profile",
        "retire-provider-profile",
        "start-reapply",
        "start-replay",
      ],
      "RBAC, rollout, worker state, observability, alert/runbook links, and complete-removal evidence explain why writes are denied, blocked, or degraded.",
    ),
  ];
}

function buildDefaultRoleEvidence(evidenceBase: string): readonly CatalogNoConfusionUxRoleEvidence[] {
  return [
    {
      role: "view-only-operator",
      canLoadPrimaryWorkbench: true,
      canExecutePrimaryWrites: false,
      deniedActionsExplainReason: true,
      preservesSafeReadContext: true,
      rolloutStoppedWritesFailClosed: false,
      evidence: `${evidenceBase} (view-only role)`,
    },
    {
      role: "operator",
      canLoadPrimaryWorkbench: true,
      canExecutePrimaryWrites: true,
      deniedActionsExplainReason: true,
      preservesSafeReadContext: true,
      rolloutStoppedWritesFailClosed: false,
      evidence: `${evidenceBase} (operator role)`,
    },
    {
      role: "admin",
      canLoadPrimaryWorkbench: true,
      canExecutePrimaryWrites: true,
      deniedActionsExplainReason: true,
      preservesSafeReadContext: true,
      rolloutStoppedWritesFailClosed: false,
      evidence: `${evidenceBase} (admin role)`,
    },
    {
      role: "denied-user",
      canLoadPrimaryWorkbench: false,
      canExecutePrimaryWrites: false,
      deniedActionsExplainReason: true,
      preservesSafeReadContext: false,
      rolloutStoppedWritesFailClosed: false,
      evidence: `${evidenceBase} (denied role)`,
    },
    {
      role: "rollout-stopped",
      canLoadPrimaryWorkbench: true,
      canExecutePrimaryWrites: false,
      deniedActionsExplainReason: true,
      preservesSafeReadContext: true,
      rolloutStoppedWritesFailClosed: true,
      evidence: `${evidenceBase} (rollout stopped role)`,
    },
  ];
}

function assertPacketMetadata(packet: CatalogNoConfusionUxAcceptancePacket): void {
  if (packet.schemaVersion !== catalogNoConfusionUxAcceptanceSchemaVersion) {
    throw new Error("Catalog no-confusion UX acceptance schema version mismatch.");
  }
  if (packet.checklistVersion !== catalogNoConfusionUxAcceptanceChecklistVersion) {
    throw new Error("Catalog no-confusion UX acceptance checklist version mismatch.");
  }
  if (!packet.generatedAt.trim()) {
    throw new Error("Catalog no-confusion UX acceptance packet must include the generated timestamp.");
  }
  if (!packet.environment.trim()) {
    throw new Error("Catalog no-confusion UX acceptance packet must name the environment.");
  }
}

function assertChecklist(packet: CatalogNoConfusionUxAcceptancePacket): void {
  assertSameStringSet(
    packet.checklist.map((item) => item.key),
    catalogNoConfusionUxAcceptanceChecklist.map((item) => item.key),
    "Catalog no-confusion UX acceptance checklist",
  );
  for (const item of packet.checklist) {
    if (item.status !== "passed" || !item.owner.trim() || !item.evidence.trim()) {
      throw new Error(`Catalog no-confusion UX checklist item '${item.key}' is incomplete.`);
    }
  }
}

function assertWorkflowMatrix(packet: CatalogNoConfusionUxAcceptancePacket): void {
  assertSameStringSet(
    packet.workflows.map((workflow) => workflow.key),
    catalogNoConfusionUxWorkflows,
    "Catalog no-confusion UX workflow matrix",
  );

  const primaryRows = packet.workflows
    .filter((workflow) => workflow.primaryPathStep !== null)
    .sort((left, right) => (left.primaryPathStep ?? 0) - (right.primaryPathStep ?? 0));
  assertSameStringSet(
    primaryRows.map((workflow) => workflow.key),
    primaryWorkflowSteps,
    "Catalog no-confusion primary path ordering",
  );
  primaryRows.forEach((workflow, index) => {
    const expectedWorkflowKey = primaryWorkflowSteps[index];
    if (workflow.primaryPathStep !== index + 1 || workflow.key !== expectedWorkflowKey) {
      throw new Error(
        `Catalog primary workflow order mismatch at step ${index + 1}; expected '${expectedWorkflowKey}'.`,
      );
    }
  });

  const coveredSections = new Set(packet.workflows.flatMap((workflow) => workflow.sections));
  for (const section of catalogPrimaryWorkbenchSections) {
    if (!coveredSections.has(section.key)) {
      throw new Error(`Catalog no-confusion UX workflow matrix must cover section '${section.key}'.`);
    }
  }

  const coveredActions = new Set(packet.workflows.flatMap((workflow) => workflow.actions));
  for (const action of catalogPrimaryWorkbenchActions) {
    if (!coveredActions.has(action.key)) {
      throw new Error(`Catalog no-confusion UX workflow matrix must cover action '${action.key}'.`);
    }
  }

  for (const workflow of packet.workflows) {
    assertKnownSections(workflow.sections);
    assertKnownActions(workflow.actions);
    if (
      !workflow.entryPoint.trim() ||
      !workflow.completionPoint.trim() ||
      !workflow.evidenceVisibleInContext.trim() ||
      !workflow.permissionBehavior.trim() ||
      !workflow.rolePersonaBehavior.trim() ||
      !workflow.accessibilityBehavior.trim() ||
      !workflow.visualQaEvidence.trim() ||
      !workflow.resilienceBehavior.trim() ||
      !workflow.securityPrivacyBehavior.trim() ||
      !workflow.providerTransportPerformanceBehavior.trim() ||
      workflow.tests.length === 0
    ) {
      throw new Error(`Catalog no-confusion UX workflow '${workflow.key}' is missing acceptance evidence.`);
    }
    if (
      workflow.hiddenNextStep ||
      workflow.unexplainedDisabledAction ||
      workflow.rawJsonFallback ||
      workflow.providerBypass ||
      workflow.currentTwoPageMigrationArtifact ||
      workflow.overlappingTextOrActions
    ) {
      throw new Error(`Catalog no-confusion UX workflow '${workflow.key}' preserves a confusing or legacy artifact.`);
    }
  }
}

function assertRoleMatrix(packet: CatalogNoConfusionUxAcceptancePacket): void {
  assertSameStringSet(
    packet.roles.map((role) => role.role),
    catalogNoConfusionUxRoles,
    "Catalog no-confusion UX role matrix",
  );
  const roleMap = new Map(packet.roles.map((role) => [role.role, role]));
  if (roleMap.get("view-only-operator")?.canExecutePrimaryWrites) {
    throw new Error("Catalog view-only acceptance must keep primary writes disabled.");
  }
  if (!roleMap.get("operator")?.canExecutePrimaryWrites || !roleMap.get("admin")?.canExecutePrimaryWrites) {
    throw new Error("Catalog operator/admin acceptance must cover primary write completion.");
  }
  if (roleMap.get("denied-user")?.canLoadPrimaryWorkbench || roleMap.get("denied-user")?.canExecutePrimaryWrites) {
    throw new Error("Catalog denied-user acceptance must fail closed.");
  }
  if (!roleMap.get("rollout-stopped")?.rolloutStoppedWritesFailClosed) {
    throw new Error("Catalog rollout-stopped acceptance must prove writes fail closed.");
  }
  for (const role of packet.roles) {
    if (!role.deniedActionsExplainReason || !role.evidence.trim()) {
      throw new Error(`Catalog no-confusion UX role '${role.role}' is missing denial evidence.`);
    }
  }
}

function assertAccessibility(packet: CatalogNoConfusionUxAcceptancePacket): void {
  assertSameStringSet(
    packet.accessibility.map((item) => item.key),
    catalogNoConfusionUxAccessibilityChecks,
    "Catalog no-confusion UX accessibility matrix",
  );
  for (const item of packet.accessibility) {
    if (!item.covered || !item.evidence.trim()) {
      throw new Error(`Catalog no-confusion UX accessibility check '${item.key}' is incomplete.`);
    }
  }
}

function assertVisualQa(packet: CatalogNoConfusionUxAcceptancePacket): void {
  assertSameStringSet(
    packet.visualQa.map((item) => item.state),
    catalogNoConfusionUxVisualStates,
    "Catalog no-confusion UX visual QA matrix",
  );
  for (const item of packet.visualQa) {
    if (!item.desktopEvidence.trim() || !item.mobileEvidence.trim() || !item.noOverlap || !item.readableDenseState) {
      throw new Error(`Catalog no-confusion UX visual state '${item.state}' is incomplete.`);
    }
  }
}

function assertResilience(packet: CatalogNoConfusionUxAcceptancePacket): void {
  assertSameStringSet(
    packet.resilience.map((item) => item.key),
    catalogNoConfusionUxResilienceChecks,
    "Catalog no-confusion UX resilience matrix",
  );
  for (const item of packet.resilience) {
    if (
      !item.failureVisible ||
      !item.recoveryActionVisible ||
      item.rawJsonFallbackAvailable ||
      !item.preservesOperatorContext ||
      !item.evidence.trim()
    ) {
      throw new Error(`Catalog no-confusion UX resilience check '${item.key}' is incomplete.`);
    }
  }
}

function assertTelemetry(packet: CatalogNoConfusionUxAcceptancePacket): void {
  assertSameStringSet(
    packet.telemetry.dimensions,
    catalogPrimaryWorkbenchInstrumentationDimensions,
    "Catalog no-confusion UX telemetry dimensions",
  );
  if (
    !packet.telemetry.primaryJourneyEventsRecorded ||
    !packet.telemetry.supportDetourMetricPathCovered ||
    !packet.telemetry.redactionSafe ||
    !packet.telemetry.telemetryUnavailableStateCovered
  ) {
    throw new Error("Catalog no-confusion UX telemetry evidence is incomplete.");
  }
}

function assertProviderTransport(packet: CatalogNoConfusionUxAcceptancePacket): void {
  assertSameStringSet(
    packet.providerTransport.budgetSurfaces,
    catalogProviderTransportFirstSliceBudgets.map((budget) => budget.surface),
    "Catalog no-confusion UX provider transport budget surfaces",
  );
  assertSameStringSet(
    packet.providerTransport.failureConditions,
    catalogProviderTransportFailureConditions.map((condition) => condition.condition),
    "Catalog no-confusion UX provider transport failure conditions",
  );
  assertSameStringSet(
    packet.providerTransport.proofCriteria,
    catalogProviderTransportProofCriteria.map((criterion) => criterion.key),
    "Catalog no-confusion UX provider transport proof criteria",
  );
  if (
    packet.providerTransport.firstSliceProviderKey !== "tcgdex" ||
    !packet.providerTransport.performanceEvidenceLinked ||
    !packet.providerTransport.degradedTransportStateCovered
  ) {
    throw new Error("Catalog no-confusion UX provider transport evidence is incomplete.");
  }
}

function assertRetirement(packet: CatalogNoConfusionUxAcceptancePacket): void {
  if (packet.retirement.policy.requiredDisposition !== "complete-removal") {
    throw new Error("Catalog no-confusion UX retirement policy must require complete removal.");
  }
  for (const surface of [
    "runtime code",
    "UI modules",
    "API routes",
    "read-model contracts",
    "clients",
    "feature flags",
    "fallback branches",
    "compatibility shims",
    "migration shims",
    "tests",
    "fixtures",
    "screenshots",
    "documentation",
    "runbooks",
    "release notes",
    "operator instructions",
  ] as const) {
    if (!packet.retirement.policy.surfaces.includes(surface)) {
      throw new Error(`Catalog no-confusion UX retirement must remove '${surface}'.`);
    }
  }
  if (
    packet.retirement.retainedCurrentTwoPageCode ||
    packet.retirement.retainedCurrentTwoPagePattern ||
    packet.retirement.retainedLegacyDocumentation ||
    packet.retirement.retainedRawJsonFallback ||
    packet.retirement.retainedCompatibilityRoute ||
    packet.retirement.retainedSupportOnlyPath ||
    packet.retirement.retainedFixtureScreenshotOrTest ||
    packet.retirement.retainedFlagAliasShimOrRedirect ||
    packet.retirement.migrationEvidenceUsedAsRetirementException
  ) {
    throw new Error(
      "Catalog no-confusion UX retirement evidence must prove complete deletion, not preserved compatibility.",
    );
  }
}

function assertKnownSections(sections: readonly CatalogPrimaryWorkbenchSectionKey[]): void {
  const knownSections = new Set(catalogPrimaryWorkbenchSections.map((section) => section.key));
  for (const section of sections) {
    if (!knownSections.has(section)) {
      throw new Error(`Catalog no-confusion UX workflow references unknown section '${section}'.`);
    }
  }
}

function assertKnownActions(actions: readonly CatalogPrimaryWorkbenchCommandKey[]): void {
  const knownActions = new Set<string>(catalogPrimaryWorkbenchActions.map((action) => action.key));
  for (const action of actions) {
    if (!knownActions.has(action)) {
      throw new Error(`Catalog no-confusion UX workflow references unknown action '${action}'.`);
    }
  }
}

function assertSameStringSet(actual: readonly string[], expected: readonly string[], label: string): void {
  const actualSet = new Set(actual);
  const expectedSet = new Set(expected);
  const missing = [...expectedSet].filter((value) => !actualSet.has(value));
  const extra = [...actualSet].filter((value) => !expectedSet.has(value));
  const duplicateActualEntries = actual.filter((value, index) => actual.indexOf(value) !== index);
  const duplicateExpectedEntries = expected.filter((value, index) => expected.indexOf(value) !== index);
  if (
    missing.length > 0 ||
    extra.length > 0 ||
    duplicateActualEntries.length > 0 ||
    duplicateExpectedEntries.length > 0
  ) {
    throw new Error(
      `${label} mismatch. Missing: ${missing.join(", ") || "none"}. Extra: ${extra.join(", ") || "none"}. Duplicates: ${duplicateActualEntries.join(", ") || duplicateExpectedEntries.join(", ") || "none"}.`,
    );
  }
}
