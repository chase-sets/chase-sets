export type CatalogControlPlaneContextKey =
  | "section"
  | "providerKey"
  | "unitKey"
  | "importScope"
  | "profileVersion"
  | "sourceObservationFilters"
  | "selectedObservationIds"
  | "jobId"
  | "promotionPreviewId"
  | "returnPath";

export type CatalogControlPlaneWorkspaceKey =
  | "import-to-promotion"
  | "health-triage"
  | "profile-authoring"
  | "validation-readiness"
  | "adapter-readiness"
  | "lifecycle-recovery"
  | "governance-controls"
  | "audit-evidence";

export type CatalogControlPlaneNavigationGroupKey = "primary" | "unblock" | "govern" | "verify";

export type CatalogControlPlaneWorkspace = Readonly<{
  key: CatalogControlPlaneWorkspaceKey;
  routeSegment: string;
  accessibleName: string;
  group: CatalogControlPlaneNavigationGroupKey;
  keyboardOrder: number;
  operatorJob: string;
  startsAt: string;
  completesAt: string;
  evidenceScope: readonly string[];
  primaryPathRole: "default" | "supporting-detour";
  linkBackContextKeys: readonly CatalogControlPlaneContextKey[];
  consumesIssues: readonly number[];
}>;

export type CatalogControlPlaneNavigationGroup = Readonly<{
  key: CatalogControlPlaneNavigationGroupKey;
  accessibleName: string;
  items: readonly CatalogControlPlaneWorkspaceKey[];
}>;

export type CatalogControlPlaneWorkflowMapEntry = Readonly<{
  workflow: string;
  startsIn: CatalogControlPlaneWorkspaceKey;
  completesIn: CatalogControlPlaneWorkspaceKey;
  requiredEvidence: readonly string[];
  blockedBy: readonly CatalogControlPlaneWorkspaceKey[];
}>;

export type CatalogControlPlaneRebuildReleaseRule = Readonly<{
  key: string;
  rule: string;
  verification: string;
}>;

export const CATALOG_CONTROL_PLANE_CONTEXT_KEYS = [
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
] as const satisfies readonly CatalogControlPlaneContextKey[];

export const CATALOG_CONTROL_PLANE_WORKSPACES = [
  {
    key: "import-to-promotion",
    routeSegment: "workbench",
    accessibleName: "Import to promotion workbench",
    group: "primary",
    keyboardOrder: 10,
    operatorJob: "Pull provider data, review Source Observations, and promote eligible sources.",
    startsAt: "Provider, ingestion unit, and import scope selection.",
    completesAt: "Promotion result, recovery state, and audit evidence for the selected scope.",
    evidenceScope: [
      "Import readiness",
      "Active and recent jobs",
      "Source Observation review state",
      "Promotion preview",
      "Promotion or recovery result",
      "Audit evidence",
    ],
    primaryPathRole: "default",
    linkBackContextKeys: CATALOG_CONTROL_PLANE_CONTEXT_KEYS,
    consumesIssues: [1049, 1056, 1038, 1039, 1040],
  },
  {
    key: "health-triage",
    routeSegment: "triage",
    accessibleName: "Health triage",
    group: "unblock",
    keyboardOrder: 20,
    operatorJob: "Explain whether import, review, or promotion is safe right now.",
    startsAt: "A degraded or blocked provider/unit/scope summary.",
    completesAt: "Named blocker owner, affected primary action, and return link.",
    evidenceScope: ["Semantic readiness", "Transport readiness", "Projection freshness", "Diagnostic counts"],
    primaryPathRole: "supporting-detour",
    linkBackContextKeys: ["section", "providerKey", "unitKey", "importScope", "jobId", "returnPath"],
    consumesIssues: [1032, 1060, 1058],
  },
  {
    key: "profile-authoring",
    routeSegment: "profile-work",
    accessibleName: "Profile authoring",
    group: "unblock",
    keyboardOrder: 30,
    operatorJob: "Inspect, draft, and edit provider profile sections that shape Source Observations.",
    startsAt: "Selected provider profile version or missing-profile blocker.",
    completesAt: "Saved draft, active profile snapshot, or section-level diagnostic result.",
    evidenceScope: ["Profile overview", "Section diagnostics", "Dirty state", "Save outcome"],
    primaryPathRole: "supporting-detour",
    linkBackContextKeys: ["section", "providerKey", "unitKey", "profileVersion", "returnPath"],
    consumesIssues: [1033, 1034, 1035],
  },
  {
    key: "validation-readiness",
    routeSegment: "readiness",
    accessibleName: "Validation readiness",
    group: "unblock",
    keyboardOrder: 40,
    operatorJob: "Prove profile changes with fixtures, dry runs, semantic compare, and activation readiness.",
    startsAt: "Fixture, dry-run, compare, or activation blocker.",
    completesAt: "Validation evidence attached to the blocked import or promotion action.",
    evidenceScope: ["Fixture result", "Dry-run facts", "Semantic diff", "Activation readiness"],
    primaryPathRole: "supporting-detour",
    linkBackContextKeys: ["section", "providerKey", "unitKey", "importScope", "profileVersion", "returnPath"],
    consumesIssues: [1036, 1037],
  },
  {
    key: "adapter-readiness",
    routeSegment: "adapter",
    accessibleName: "Adapter readiness",
    group: "unblock",
    keyboardOrder: 50,
    operatorJob: "Inspect provider transport, option query, credential, and import-scope availability.",
    startsAt: "Provider transport, credential, option query, or scope blocker.",
    completesAt: "Import can proceed or shows a provider-owned remediation.",
    evidenceScope: ["Credential state", "Adapter state", "Option cache state", "Provider transport limits"],
    primaryPathRole: "supporting-detour",
    linkBackContextKeys: ["section", "providerKey", "unitKey", "importScope", "returnPath"],
    consumesIssues: [1035, 1065],
  },
  {
    key: "lifecycle-recovery",
    routeSegment: "lifecycle",
    accessibleName: "Lifecycle recovery",
    group: "govern",
    keyboardOrder: 60,
    operatorJob: "Rollback, retire, deprecate, replay, or reapply profile behavior that affects the primary path.",
    startsAt: "Bad activation, stale preview, profile lifecycle, or reapply blocker.",
    completesAt: "Recovery result with affected observations, jobs, profile versions, and audit evidence.",
    evidenceScope: ["Affected references", "Replay impact", "Reapply impact", "Rollback or retirement plan"],
    primaryPathRole: "supporting-detour",
    linkBackContextKeys: [
      "section",
      "providerKey",
      "unitKey",
      "importScope",
      "profileVersion",
      "sourceObservationFilters",
      "jobId",
      "promotionPreviewId",
      "returnPath",
    ],
    consumesIssues: [1040, 1041, 1042, 1045, 1063],
  },
  {
    key: "governance-controls",
    routeSegment: "controls",
    accessibleName: "Governance controls",
    group: "govern",
    keyboardOrder: 70,
    operatorJob: "Control RBAC, rollout, kill switches, observability, and degraded state ownership.",
    startsAt: "Denied, disabled, rollout-stopped, or degraded primary action.",
    completesAt: "Allowed action or explicit fail-closed reason with owner and metric.",
    evidenceScope: ["RBAC matrix", "Rollout mode", "Kill switches", "Operational metrics"],
    primaryPathRole: "supporting-detour",
    linkBackContextKeys: ["section", "providerKey", "unitKey", "importScope", "jobId", "returnPath"],
    consumesIssues: [1043, 1059, 1064],
  },
  {
    key: "audit-evidence",
    routeSegment: "evidence",
    accessibleName: "Audit evidence",
    group: "verify",
    keyboardOrder: 80,
    operatorJob: "Verify who changed what, what evidence shipped, and what release proof exists.",
    startsAt: "Audit, smoke, release, or signoff evidence request.",
    completesAt: "Traceable audit/release evidence linked to the primary work item.",
    evidenceScope: ["Audit timeline", "Release evidence", "Smoke proof", "Risk register links"],
    primaryPathRole: "supporting-detour",
    linkBackContextKeys: [
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
    consumesIssues: [1044, 1061, 1088],
  },
] as const satisfies readonly CatalogControlPlaneWorkspace[];

export const CATALOG_CONTROL_PLANE_NAVIGATION_GROUPS = [
  {
    key: "primary",
    accessibleName: "Primary workflow",
    items: ["import-to-promotion"],
  },
  {
    key: "unblock",
    accessibleName: "Unblock provider data",
    items: ["health-triage", "profile-authoring", "validation-readiness", "adapter-readiness"],
  },
  {
    key: "govern",
    accessibleName: "Govern and recover",
    items: ["lifecycle-recovery", "governance-controls"],
  },
  {
    key: "verify",
    accessibleName: "Verify release evidence",
    items: ["audit-evidence"],
  },
] as const satisfies readonly CatalogControlPlaneNavigationGroup[];

export const CATALOG_CONTROL_PLANE_WORKFLOW_MAP = [
  {
    workflow: "Primary import-to-promotion path",
    startsIn: "import-to-promotion",
    completesIn: "import-to-promotion",
    requiredEvidence: ["Import readiness", "Job progress", "Source Observation review", "Promotion preview"],
    blockedBy: ["health-triage", "profile-authoring", "validation-readiness", "adapter-readiness"],
  },
  {
    workflow: "Health triage",
    startsIn: "health-triage",
    completesIn: "import-to-promotion",
    requiredEvidence: ["Read-model freshness", "Semantic readiness", "Transport readiness"],
    blockedBy: ["governance-controls"],
  },
  {
    workflow: "Profile overview, drafting, and section editing",
    startsIn: "profile-authoring",
    completesIn: "import-to-promotion",
    requiredEvidence: ["Profile version", "Section diagnostics", "Save outcome"],
    blockedBy: ["validation-readiness", "governance-controls"],
  },
  {
    workflow: "Validation, dry run, compare, and activation readiness",
    startsIn: "validation-readiness",
    completesIn: "import-to-promotion",
    requiredEvidence: ["Fixture result", "Dry-run evidence", "Semantic compare", "Activation readiness"],
    blockedBy: ["profile-authoring", "adapter-readiness", "governance-controls"],
  },
  {
    workflow: "Imports, jobs, Source Observation review, promotion, reapply, replay",
    startsIn: "import-to-promotion",
    completesIn: "import-to-promotion",
    requiredEvidence: ["Durable job state", "Observation evidence", "Promotion command plan", "Recovery result"],
    blockedBy: ["lifecycle-recovery", "governance-controls"],
  },
  {
    workflow: "Lifecycle, rollout, RBAC, observability, and audit evidence",
    startsIn: "governance-controls",
    completesIn: "audit-evidence",
    requiredEvidence: ["Permission result", "Rollout mode", "Operational metric", "Audit record"],
    blockedBy: ["lifecycle-recovery"],
  },
] as const satisfies readonly CatalogControlPlaneWorkflowMapEntry[];

export const CATALOG_CONTROL_PLANE_REBUILD_RELEASE_RULES = [
  {
    key: "single-primary-workbench",
    rule: "The launch admin experience starts on one rebuilt import-to-promotion workbench.",
    verification: "The Catalog context contributes the Integrations route for the primary workbench.",
  },
  {
    key: "support-detours",
    rule: "Support workspaces exist only to unblock, govern, recover, or verify the primary job.",
    verification: "Every supporting workspace preserves return context back to the primary workbench.",
  },
  {
    key: "complete-retirement",
    rule: "Retired artifacts are removed from code, product patterns, tests, scripts, screenshots, and docs.",
    verification: "Static guards fail when retired page artifacts, namespaces, nav entries, or file paths reappear.",
  },
] as const satisfies readonly CatalogControlPlaneRebuildReleaseRule[];

export function catalogControlPlaneWorkspaceByKey(key: CatalogControlPlaneWorkspaceKey): CatalogControlPlaneWorkspace {
  const workspace = CATALOG_CONTROL_PLANE_WORKSPACES.find((candidate) => candidate.key === key);
  if (!workspace) {
    throw new Error(`Unknown Catalog Control Plane workspace '${key}'.`);
  }
  return workspace;
}
