// @deprecated m90 blueprint slice — superseded by the v2 blueprint in
// `information-architecture-v2.ts` (three pages + two utilities, per-entity action
// vocabulary, no workspace router, no returnPath). This workspace-router IA and its
// live consumers are owned for deletion by the m90 implementation slices
// (catalog-home, scope-detail, provider-detail, settings + evidence drawer, typed
// promotion preview). It stays in place only until those slices land; do not extend
// it. See bounded-contexts/catalog/docs/catalog-control-plane-blueprint-v2.md.
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
  | "conflict-resolution"
  | "lifecycle-recovery"
  | "governance-controls"
  | "audit-evidence";

export type CatalogControlPlaneNavigationGroupKey = "primary" | "unblock" | "govern" | "verify";

// Each audience surface is a real nested route under /admin/integrations.
// The route path is the screen router; the workspace key (carried as ?section=)
// only identifies the precise workspace within a multi-workspace surface for
// active-nav highlighting and detour telemetry.
export type CatalogControlPlaneRouteSurfaceKey = "daily" | "providers" | "governance" | "health";

export type CatalogControlPlaneWorkspace = Readonly<{
  key: CatalogControlPlaneWorkspaceKey;
  routeSegment: string;
  routeSurface: CatalogControlPlaneRouteSurfaceKey;
  accessibleName: string;
  group: CatalogControlPlaneNavigationGroupKey;
  keyboardOrder: number;
  operatorJob: string;
  startsAt: string;
  completesAt: string;
  evidenceScope: readonly string[];
  primaryPathRole: "default" | "supporting-detour";
  linkBackContextKeys: readonly CatalogControlPlaneContextKey[];
}>;

export type CatalogControlPlaneRouteSurface = Readonly<{
  key: CatalogControlPlaneRouteSurfaceKey;
  // Path segment appended to /admin/integrations. The daily surface is the base
  // route, so its segment is empty.
  pathSegment: string;
  accessibleName: string;
  // Workspaces rendered, in order, by this route. The first workspace is the
  // surface default when no precise workspace is selected.
  workspaces: readonly CatalogControlPlaneWorkspaceKey[];
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
    routeSurface: "daily",
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
  },
  {
    key: "health-triage",
    routeSegment: "triage",
    routeSurface: "health",
    accessibleName: "Health triage",
    group: "unblock",
    keyboardOrder: 20,
    operatorJob: "Explain whether import, review, or promotion is safe right now.",
    startsAt: "A degraded or blocked provider/unit/scope summary.",
    completesAt: "Named blocker owner, affected primary action, and return link.",
    evidenceScope: ["Semantic readiness", "Transport readiness", "Projection freshness", "Diagnostic counts"],
    primaryPathRole: "supporting-detour",
    linkBackContextKeys: ["section", "providerKey", "unitKey", "importScope", "jobId", "returnPath"],
  },
  {
    key: "profile-authoring",
    routeSegment: "profile-work",
    routeSurface: "providers",
    accessibleName: "Profile authoring",
    group: "unblock",
    keyboardOrder: 30,
    operatorJob: "Inspect, draft, and edit provider profile sections that shape Source Observations.",
    startsAt: "Selected provider profile version or missing-profile blocker.",
    completesAt: "Saved draft, active profile snapshot, or section-level diagnostic result.",
    evidenceScope: ["Profile overview", "Section diagnostics", "Dirty state", "Save outcome"],
    primaryPathRole: "supporting-detour",
    linkBackContextKeys: ["section", "providerKey", "unitKey", "profileVersion", "returnPath"],
  },
  {
    key: "validation-readiness",
    routeSegment: "readiness",
    routeSurface: "providers",
    accessibleName: "Validation readiness",
    group: "unblock",
    keyboardOrder: 40,
    operatorJob:
      "Prove profile changes with fixtures, dry runs, semantic compare, activation readiness, and provider credential and transport availability.",
    startsAt: "Fixture, dry-run, compare, activation, credential, or provider transport blocker.",
    completesAt: "Validation and provider readiness evidence attached to the blocked import or promotion action.",
    evidenceScope: [
      "Fixture result",
      "Dry-run facts",
      "Semantic diff",
      "Activation readiness",
      "Provider credential state",
      "Provider transport limits",
    ],
    primaryPathRole: "supporting-detour",
    linkBackContextKeys: ["section", "providerKey", "unitKey", "importScope", "profileVersion", "returnPath"],
  },
  {
    key: "conflict-resolution",
    routeSegment: "conflicts",
    routeSurface: "governance",
    accessibleName: "Conflict resolution",
    group: "govern",
    keyboardOrder: 60,
    operatorJob: "Explain source fact conflicts, precedence rules, promotion blocking, and audit evidence.",
    startsAt: "Duplicate, conflict, changed-source, or promotion-conflict evidence on Source Observations.",
    completesAt: "Conflict state is auto-resolved, reviewed, or clearly blocking promotion with evidence.",
    evidenceScope: ["Affected facts", "Candidate values", "Precedence rules", "Audit evidence"],
    primaryPathRole: "supporting-detour",
    linkBackContextKeys: [
      "section",
      "providerKey",
      "unitKey",
      "importScope",
      "profileVersion",
      "sourceObservationFilters",
      "selectedObservationIds",
      "promotionPreviewId",
      "returnPath",
    ],
  },
  {
    key: "lifecycle-recovery",
    routeSegment: "lifecycle",
    routeSurface: "governance",
    accessibleName: "Lifecycle recovery",
    group: "govern",
    keyboardOrder: 70,
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
  },
  {
    key: "governance-controls",
    routeSegment: "controls",
    routeSurface: "governance",
    accessibleName: "Governance controls",
    group: "govern",
    keyboardOrder: 80,
    operatorJob: "Control RBAC, rollout, kill switches, observability, and degraded state ownership.",
    startsAt: "Denied, disabled, rollout-stopped, or degraded primary action.",
    completesAt: "Allowed action or explicit fail-closed reason with owner and metric.",
    evidenceScope: ["RBAC matrix", "Rollout mode", "Kill switches", "Operational metrics"],
    primaryPathRole: "supporting-detour",
    linkBackContextKeys: ["section", "providerKey", "unitKey", "importScope", "jobId", "returnPath"],
  },
  {
    key: "audit-evidence",
    routeSegment: "evidence",
    routeSurface: "health",
    accessibleName: "Audit evidence",
    group: "verify",
    keyboardOrder: 100,
    operatorJob: "Trace who changed what, when, and with what redaction state across the integration.",
    startsAt: "An audit or traceability request for a provider, profile, job, or promotion.",
    completesAt: "A traceable audit timeline linked back to the primary work item.",
    evidenceScope: ["Audit timeline", "Change attribution", "Redaction state", "Affected work item links"],
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
    items: ["health-triage", "profile-authoring", "validation-readiness"],
  },
  {
    key: "govern",
    accessibleName: "Govern and recover",
    items: ["conflict-resolution", "lifecycle-recovery", "governance-controls"],
  },
  {
    key: "verify",
    accessibleName: "Integration health",
    items: ["audit-evidence"],
  },
] as const satisfies readonly CatalogControlPlaneNavigationGroup[];

// The four audience surfaces, each a real nested route under /admin/integrations.
// The daily surface renders only the primary import-to-promotion job; the other
// three render their grouped supporting workspaces stacked. Listed in nav order.
export const CATALOG_CONTROL_PLANE_ROUTE_SURFACES = [
  {
    key: "daily",
    pathSegment: "",
    accessibleName: "Daily import to promotion",
    workspaces: ["import-to-promotion"],
  },
  {
    key: "providers",
    pathSegment: "providers",
    accessibleName: "Provider profiles and readiness",
    workspaces: ["profile-authoring", "validation-readiness"],
  },
  {
    key: "governance",
    pathSegment: "governance",
    accessibleName: "Govern and recover",
    workspaces: ["conflict-resolution", "lifecycle-recovery", "governance-controls"],
  },
  {
    key: "health",
    pathSegment: "health",
    accessibleName: "Integration health",
    workspaces: ["audit-evidence", "health-triage"],
  },
] as const satisfies readonly CatalogControlPlaneRouteSurface[];

export function catalogControlPlaneRouteSurface(
  key: CatalogControlPlaneRouteSurfaceKey,
): CatalogControlPlaneRouteSurface {
  const surface = CATALOG_CONTROL_PLANE_ROUTE_SURFACES.find((candidate) => candidate.key === key);
  if (!surface) {
    throw new Error(`Unknown Catalog Control Plane route surface '${key}'.`);
  }
  return surface;
}

export function catalogControlPlaneRouteSurfaceForWorkspace(
  key: CatalogControlPlaneWorkspaceKey,
): CatalogControlPlaneRouteSurface {
  return catalogControlPlaneRouteSurface(catalogControlPlaneWorkspaceByKey(key).routeSurface);
}

export const CATALOG_CONTROL_PLANE_WORKFLOW_MAP = [
  {
    workflow: "Primary import-to-promotion path",
    startsIn: "import-to-promotion",
    completesIn: "import-to-promotion",
    requiredEvidence: ["Import readiness", "Job progress", "Source Observation review", "Promotion preview"],
    blockedBy: ["health-triage", "profile-authoring", "validation-readiness"],
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
    blockedBy: ["profile-authoring", "governance-controls"],
  },
  {
    workflow: "Imports, jobs, Source Observation review, promotion, reapply, replay",
    startsIn: "import-to-promotion",
    completesIn: "import-to-promotion",
    requiredEvidence: ["Durable job state", "Observation evidence", "Promotion command plan", "Recovery result"],
    blockedBy: ["conflict-resolution", "lifecycle-recovery", "governance-controls"],
  },
  {
    workflow: "Conflict resolution and source precedence",
    startsIn: "conflict-resolution",
    completesIn: "import-to-promotion",
    requiredEvidence: ["Affected facts", "Candidate values", "Precedence rule", "Audit evidence"],
    blockedBy: ["governance-controls", "audit-evidence"],
  },
  {
    workflow: "Lifecycle, rollout, RBAC, observability, and audit evidence",
    startsIn: "governance-controls",
    completesIn: "audit-evidence",
    requiredEvidence: ["Permission result", "Rollout mode", "Operational metric", "Audit record"],
    blockedBy: ["lifecycle-recovery"],
  },
] as const satisfies readonly CatalogControlPlaneWorkflowMapEntry[];

export function catalogControlPlaneWorkspaceByKey(key: CatalogControlPlaneWorkspaceKey): CatalogControlPlaneWorkspace {
  const workspace = CATALOG_CONTROL_PLANE_WORKSPACES.find((candidate) => candidate.key === key);
  if (!workspace) {
    throw new Error(`Unknown Catalog Control Plane workspace '${key}'.`);
  }
  return workspace;
}
