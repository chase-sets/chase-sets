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

// "conflict-resolution" is retired as a standalone workspace: blocking conflicts,
// candidate values, and precedence now render inline in the merge candidate review
// drawer, where conflict resolution already happens at promote time (see
// catalog-merge-candidate.ts requireConflictResolutionsForBlockingConflicts).
export type CatalogControlPlaneWorkspaceKey =
  | "import-to-promotion"
  | "health-triage"
  | "governance-controls"
  | "audit-evidence";

export type CatalogControlPlaneNavigationGroupKey = "primary" | "unblock" | "govern" | "verify";

// Each audience surface is a real nested route under /admin/integrations.
// The route path is the screen router; the workspace key (carried as ?section=)
// only identifies the precise workspace within a multi-workspace surface for
// active-nav highlighting and detour telemetry.
//
// "providers" is retired here: profile authoring, validation readiness,
// and lifecycle recovery are no longer stacked ?section= workspaces on
// /admin/integrations/providers. They are one v2 Provider detail page
// (/catalog/providers/:providerKey, see information-architecture-v2.ts) with a
// linear draft -> validate -> activate flow and version-history row actions —
// not a detour surface this deprecated IA routes to.
export type CatalogControlPlaneRouteSurfaceKey = "daily" | "governance" | "health";

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
    items: ["health-triage"],
  },
  {
    key: "govern",
    accessibleName: "Govern and recover",
    items: ["governance-controls"],
  },
  {
    key: "verify",
    accessibleName: "Integration health",
    items: ["audit-evidence"],
  },
] as const satisfies readonly CatalogControlPlaneNavigationGroup[];

// The three remaining audience surfaces, each a real nested route under
// /admin/integrations. The daily surface renders only the primary
// import-to-promotion job; the other two render their grouped supporting
// workspaces stacked. Listed in nav order. "providers" is retired: see
// the CatalogControlPlaneRouteSurfaceKey comment above.
export const CATALOG_CONTROL_PLANE_ROUTE_SURFACES = [
  {
    key: "daily",
    pathSegment: "",
    accessibleName: "Daily import to promotion",
    workspaces: ["import-to-promotion"],
  },
  {
    key: "governance",
    pathSegment: "governance",
    accessibleName: "Govern and recover",
    workspaces: ["governance-controls"],
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
    blockedBy: ["health-triage"],
  },
  {
    workflow: "Health triage",
    startsIn: "health-triage",
    completesIn: "import-to-promotion",
    requiredEvidence: ["Read-model freshness", "Semantic readiness", "Transport readiness"],
    blockedBy: ["governance-controls"],
  },
  {
    workflow: "Imports, jobs, Source Observation review, promotion, reapply, replay",
    startsIn: "import-to-promotion",
    completesIn: "import-to-promotion",
    requiredEvidence: ["Durable job state", "Observation evidence", "Promotion command plan", "Recovery result"],
    blockedBy: ["governance-controls"],
  },
  {
    workflow: "Lifecycle, rollout, RBAC, observability, and audit evidence",
    startsIn: "governance-controls",
    completesIn: "audit-evidence",
    requiredEvidence: ["Permission result", "Rollout mode", "Operational metric", "Audit record"],
    blockedBy: [],
  },
] as const satisfies readonly CatalogControlPlaneWorkflowMapEntry[];

export function catalogControlPlaneWorkspaceByKey(key: CatalogControlPlaneWorkspaceKey): CatalogControlPlaneWorkspace {
  const workspace = CATALOG_CONTROL_PLANE_WORKSPACES.find((candidate) => candidate.key === key);
  if (!workspace) {
    throw new Error(`Unknown Catalog Control Plane workspace '${key}'.`);
  }
  return workspace;
}
