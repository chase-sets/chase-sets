import { t } from "@chase-sets/localization";

// Catalog Control Plane information architecture — v2 blueprint (m90).
//
// This is the design-first contract the m90 implementation slices build against.
// It replaces the workspace-router IA in `information-architecture.ts` (now marked
// deprecated) with three operator pages, two utilities, and a per-entity action
// vocabulary. Operators fix in place: blockers resolve inline or in a drawer, never
// by detouring to another surface, so there is no `returnPath` and no `?section=`
// workspace router in this contract.
//
// The narrative rationale, the full capability crosswalk, and the disclosure rules
// live in `bounded-contexts/catalog/docs/catalog-control-plane-blueprint-v2.md`.

// ---------------------------------------------------------------------------
// Surfaces: three pages + two utilities
// ---------------------------------------------------------------------------

// The three primary operator pages. Each is a real route under /admin/catalog.
export type CatalogControlPlanePageKey = "catalog-home" | "scope-detail" | "provider-detail" | "settings";

// A utility is a supporting surface that is not one of the three journey pages.
// `settings` is its own governance page; `evidence` is a drawer that any entity on
// any page can open over itself without navigating away.
export type CatalogControlPlaneUtilityKey = "settings" | "evidence";

export type CatalogControlPlaneSurfaceKind = "page" | "drawer";

// The entities operator actions attach to. Actions belong to entities, not pages,
// so the same action renders wherever its entity appears (a list row, a detail
// header, or an evidence drawer).
export type CatalogControlPlaneEntityKey = "scope" | "candidate" | "observation" | "provider-profile" | "job" | "alias";

// How an action's result is disclosed to the operator. No shape navigates away.
export type CatalogControlPlaneFeedbackShape =
  // Transient success/error banner on the surface the action was invoked from.
  | "status-banner"
  // The entity's own list/detail row transitions state in place (accept, defer…).
  | "row-transition"
  // A typed, freshness-guarded preview renders inline and must be re-confirmed
  // before the committing action runs. Replaces the stale raw-JSON preview.
  | "preview-panel"
  // Destructive action: a typed match confirmation gates the command inline, then
  // a status banner reports the outcome.
  | "confirmation-gate"
  // An asynchronous job is enqueued and its progress is tracked on the entity.
  | "job-progress";

// Where an action or detail renders. Blockers may only resolve `inline` or in a
// `drawer`; `page` is reserved for opening the entity's own detail page as a
// forward navigation, never as a detour to fix a blocker.
export type CatalogControlPlaneDisclosure = "inline" | "drawer" | "page";

// The Catalog permission policy is binary: reads need `catalog.view`, every
// state-changing action needs `catalog.manage`. No new roles are defined here.
export type CatalogControlPlanePermission = "catalog.view" | "catalog.manage";

// The v2 route/query context keys. `returnPath`, `section`, and the detour
// telemetry keys are intentionally absent: there is nothing to return to and no
// workspace to highlight. Selection is durable page state, not a URL detour.
export type CatalogControlPlaneContextKeyV2 =
  | "scopeId"
  | "providerKey"
  | "profileVersion"
  | "candidateId"
  | "observationSelection"
  | "jobId"
  | "evidenceRef";

export type CatalogControlPlanePage = Readonly<{
  key: CatalogControlPlanePageKey;
  // Path segment appended to /admin/catalog. The catalog-home page is the base
  // route, so its segment is empty.
  pathSegment: string;
  accessibleName: string;
  // The operator job this page completes, in the operator's language.
  purpose: string;
  // Entities whose whole journey this page owns. An entity has exactly one home
  // page; it may still appear as a reference elsewhere.
  ownsEntities: readonly CatalogControlPlaneEntityKey[];
  // Whether this page surfaces the attention queue (work that needs an operator).
  hasAttentionQueue: boolean;
}>;

export type CatalogControlPlaneUtility = Readonly<{
  key: CatalogControlPlaneUtilityKey;
  kind: CatalogControlPlaneSurfaceKind;
  accessibleName: string;
  purpose: string;
  // For a page utility, the path segment under /admin/catalog. For a drawer
  // utility, the empty string: a drawer has no route of its own.
  pathSegment: string;
}>;

export type CatalogControlPlaneEntity = Readonly<{
  key: CatalogControlPlaneEntityKey;
  accessibleName: string;
  // The page that owns this entity's journey. Actions on the entity render here
  // and anywhere else the entity is listed.
  homePage: CatalogControlPlanePageKey;
}>;

export type CatalogControlPlaneAction = Readonly<{
  // Stable entity-scoped action id: `${entity}.${verb}`.
  id: string;
  entity: CatalogControlPlaneEntityKey;
  label: string;
  permission: CatalogControlPlanePermission;
  destructive: boolean;
  requiresReason: boolean;
  requiresConfirmation: boolean;
  feedbackShape: CatalogControlPlaneFeedbackShape;
  disclosure: CatalogControlPlaneDisclosure;
}>;

// A crosswalk row: where each of the eight deprecated workspaces lands in v2.
// `newHome` names the page/utility that absorbs the workspace's capability, or is
// `null` only when `disposition` is "dropped" (with a stated reason).
export type CatalogControlPlaneCapabilityMapEntry = Readonly<{
  workspace: string;
  disposition: "folded" | "moved" | "dropped";
  newHome: CatalogControlPlanePageKey | CatalogControlPlaneUtilityKey | null;
  rationale: string;
}>;

// Structural capabilities the milestone intentionally removes (not operator
// capabilities — machine internals). Listed so the deletion is explicit.
export type CatalogControlPlaneRetiredMachinery = Readonly<{
  capability: string;
  reason: string;
}>;

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------

export const CATALOG_CONTROL_PLANE_CONTEXT_KEYS_V2 = [
  "scopeId",
  "providerKey",
  "profileVersion",
  "candidateId",
  "observationSelection",
  "jobId",
  "evidenceRef",
] as const satisfies readonly CatalogControlPlaneContextKeyV2[];

export const CATALOG_CONTROL_PLANE_PAGES = [
  {
    key: "catalog-home",
    pathSegment: "",
    accessibleName: "Catalog home",
    purpose: "See every scope and the attention queue, then open the scope that needs work.",
    ownsEntities: [],
    hasAttentionQueue: true,
  },
  {
    key: "scope-detail",
    pathSegment: "scopes/:scopeId",
    accessibleName: "Scope detail",
    purpose:
      "Run the whole journey for one scope: import, review Source Observations, resolve conflicts and candidates, and promote — all in place.",
    ownsEntities: ["scope", "observation", "candidate", "alias", "job"],
    hasAttentionQueue: true,
  },
  {
    key: "provider-detail",
    pathSegment: "providers/:providerKey",
    accessibleName: "Provider detail",
    purpose:
      "Manage everything about one provider: profile authoring, validation readiness, and the linear activate/rollback/deprecate/retire lifecycle.",
    ownsEntities: ["provider-profile"],
    hasAttentionQueue: false,
  },
  {
    key: "settings",
    pathSegment: "settings",
    accessibleName: "Catalog control-plane settings",
    purpose: "Govern RBAC, rollout modes, kill switches, and observability ownership for the integration.",
    ownsEntities: [],
    hasAttentionQueue: false,
  },
] as const satisfies readonly CatalogControlPlanePage[];

export const CATALOG_CONTROL_PLANE_UTILITIES = [
  {
    key: "settings",
    kind: "page",
    accessibleName: "Catalog control-plane settings",
    purpose: "Governance controls: RBAC, rollout, kill switches, and operational metrics ownership.",
    pathSegment: "settings",
  },
  {
    key: "evidence",
    kind: "drawer",
    accessibleName: "Evidence drawer",
    purpose:
      "Trace who changed what, when, and with what redaction state for any entity — opened over the current page, never a detour.",
    pathSegment: "",
  },
] as const satisfies readonly CatalogControlPlaneUtility[];

export const CATALOG_CONTROL_PLANE_ENTITIES = [
  { key: "scope", accessibleName: "Scope", homePage: "scope-detail" },
  { key: "job", accessibleName: "Import job", homePage: "scope-detail" },
  { key: "observation", accessibleName: "Source Observation", homePage: "scope-detail" },
  { key: "candidate", accessibleName: "Merge candidate", homePage: "scope-detail" },
  { key: "alias", accessibleName: "Catalog Alias", homePage: "scope-detail" },
  { key: "provider-profile", accessibleName: "Provider profile", homePage: "provider-detail" },
] as const satisfies readonly CatalogControlPlaneEntity[];

// The complete per-entity wire vocabulary. Forms submit these ids directly;
// retired page-scoped intents have no compatibility aliases.
export const CATALOG_CONTROL_PLANE_ACTIONS = [
  // scope
  {
    id: "scope.sync",
    entity: "scope",
    label: t("catalog.features.sourceObservations.ui.controlPlaneV2.actions.scope.sync.label"),
    permission: "catalog.manage",
    destructive: false,
    requiresReason: false,
    requiresConfirmation: false,
    feedbackShape: "job-progress",
    disclosure: "inline",
  },
  {
    id: "scope.import",
    entity: "scope",
    label: t("catalog.features.sourceObservations.ui.controlPlaneV2.actions.scope.import.label"),
    permission: "catalog.manage",
    destructive: false,
    requiresReason: false,
    requiresConfirmation: false,
    feedbackShape: "job-progress",
    disclosure: "inline",
  },
  // job (import job lifecycle — retry/resume/cancel collapse to transitions)
  {
    id: "job.retry",
    entity: "job",
    label: t("catalog.features.sourceObservations.ui.controlPlaneV2.actions.job.retry.label"),
    permission: "catalog.manage",
    destructive: false,
    requiresReason: false,
    requiresConfirmation: false,
    feedbackShape: "job-progress",
    disclosure: "inline",
  },
  {
    id: "job.resume",
    entity: "job",
    label: t("catalog.features.sourceObservations.ui.controlPlaneV2.actions.job.resume.label"),
    permission: "catalog.manage",
    destructive: false,
    requiresReason: false,
    requiresConfirmation: false,
    feedbackShape: "job-progress",
    disclosure: "inline",
  },
  {
    id: "job.cancel",
    entity: "job",
    label: t("catalog.features.sourceObservations.ui.controlPlaneV2.actions.job.cancel.label"),
    permission: "catalog.manage",
    destructive: true,
    requiresReason: false,
    requiresConfirmation: true,
    feedbackShape: "confirmation-gate",
    disclosure: "inline",
  },
  // observation
  {
    id: "observation.promote",
    entity: "observation",
    label: t("catalog.features.sourceObservations.ui.controlPlaneV2.actions.observation.promote.label"),
    permission: "catalog.manage",
    destructive: false,
    requiresReason: false,
    requiresConfirmation: true,
    // The typed preview renders inline and must stay fresh; execute is the
    // confirmation of that preview. Preview and execute are phases of one guarded
    // action, not detached intents.
    feedbackShape: "preview-panel",
    disclosure: "inline",
  },
  {
    id: "observation.reject",
    entity: "observation",
    label: t("catalog.features.sourceObservations.ui.controlPlaneV2.actions.observation.reject.label"),
    permission: "catalog.manage",
    destructive: true,
    requiresReason: true,
    requiresConfirmation: false,
    feedbackShape: "row-transition",
    disclosure: "inline",
  },
  {
    id: "observation.defer",
    entity: "observation",
    label: t("catalog.features.sourceObservations.ui.controlPlaneV2.actions.observation.defer.label"),
    permission: "catalog.manage",
    destructive: false,
    requiresReason: false,
    requiresConfirmation: false,
    feedbackShape: "row-transition",
    disclosure: "inline",
  },
  {
    id: "observation.reapply",
    entity: "observation",
    label: t("catalog.features.sourceObservations.ui.controlPlaneV2.actions.observation.reapply.label"),
    permission: "catalog.manage",
    destructive: false,
    requiresReason: false,
    requiresConfirmation: false,
    feedbackShape: "job-progress",
    disclosure: "inline",
  },
  {
    id: "observation.replay",
    entity: "observation",
    label: t("catalog.features.sourceObservations.ui.controlPlaneV2.actions.observation.replay.label"),
    permission: "catalog.manage",
    destructive: false,
    requiresReason: false,
    requiresConfirmation: false,
    feedbackShape: "job-progress",
    disclosure: "inline",
  },
  // candidate (merge candidate)
  {
    id: "candidate.promote",
    entity: "candidate",
    label: t("catalog.features.sourceObservations.ui.controlPlaneV2.actions.candidate.promote.label"),
    permission: "catalog.manage",
    destructive: false,
    requiresReason: true,
    requiresConfirmation: false,
    feedbackShape: "status-banner",
    disclosure: "inline",
    // Single-candidate promote and the scope-level promote-all-ready bulk action
    // are the same entity verb applied to one candidate or to the ready set; the
    // bulk form only ever carries `ready` candidate IDs.
  },
  {
    id: "candidate.edit",
    entity: "candidate",
    label: t("catalog.features.sourceObservations.ui.controlPlaneV2.actions.candidate.edit.label"),
    permission: "catalog.manage",
    destructive: false,
    requiresReason: false,
    requiresConfirmation: true,
    // A typed field editor with a structured preview replaces the raw-JSON
    // textarea; the operator confirms the diff before saving.
    feedbackShape: "preview-panel",
    disclosure: "drawer",
  },
  {
    id: "candidate.split",
    entity: "candidate",
    label: t("catalog.features.sourceObservations.ui.controlPlaneV2.actions.candidate.split.label"),
    permission: "catalog.manage",
    destructive: false,
    requiresReason: false,
    requiresConfirmation: true,
    feedbackShape: "preview-panel",
    disclosure: "drawer",
  },
  {
    id: "candidate.ignore",
    entity: "candidate",
    label: t("catalog.features.sourceObservations.ui.controlPlaneV2.actions.candidate.ignore.label"),
    permission: "catalog.manage",
    destructive: true,
    requiresReason: true,
    requiresConfirmation: false,
    feedbackShape: "row-transition",
    disclosure: "inline",
  },
  {
    id: "candidate.defer",
    entity: "candidate",
    label: t("catalog.features.sourceObservations.ui.controlPlaneV2.actions.candidate.defer.label"),
    permission: "catalog.manage",
    destructive: false,
    requiresReason: true,
    requiresConfirmation: false,
    feedbackShape: "row-transition",
    disclosure: "inline",
    // Single-candidate defer and the scope-level defer-remainder bulk action are
    // the same entity verb over one candidate or the remainder set.
  },
  // alias (accept + auto-accept collapse to one accept action)
  {
    id: "alias.accept",
    entity: "alias",
    label: t("catalog.features.sourceObservations.ui.controlPlaneV2.actions.alias.accept.label"),
    permission: "catalog.manage",
    destructive: false,
    requiresReason: false,
    requiresConfirmation: false,
    feedbackShape: "row-transition",
    disclosure: "inline",
  },
  {
    id: "alias.reject",
    entity: "alias",
    label: t("catalog.features.sourceObservations.ui.controlPlaneV2.actions.alias.reject.label"),
    permission: "catalog.manage",
    destructive: true,
    requiresReason: true,
    requiresConfirmation: false,
    feedbackShape: "row-transition",
    disclosure: "inline",
  },
  {
    id: "alias.revoke",
    entity: "alias",
    label: t("catalog.features.sourceObservations.ui.controlPlaneV2.actions.alias.revoke.label"),
    permission: "catalog.manage",
    destructive: true,
    requiresReason: true,
    requiresConfirmation: false,
    feedbackShape: "row-transition",
    disclosure: "inline",
  },
  {
    id: "alias.defer",
    entity: "alias",
    label: t("catalog.features.sourceObservations.ui.controlPlaneV2.actions.alias.defer.label"),
    permission: "catalog.manage",
    destructive: false,
    requiresReason: false,
    requiresConfirmation: false,
    feedbackShape: "row-transition",
    disclosure: "inline",
  },
  // provider-profile
  {
    id: "provider-profile.clone",
    entity: "provider-profile",
    label: t("catalog.features.sourceObservations.ui.controlPlaneV2.actions.provider-profile.clone.label"),
    permission: "catalog.manage",
    destructive: false,
    requiresReason: false,
    requiresConfirmation: false,
    feedbackShape: "status-banner",
    disclosure: "inline",
  },
  {
    id: "provider-profile.edit-section",
    entity: "provider-profile",
    label: t("catalog.features.sourceObservations.ui.controlPlaneV2.actions.provider-profile.edit-section.label"),
    permission: "catalog.manage",
    destructive: false,
    requiresReason: false,
    requiresConfirmation: false,
    feedbackShape: "status-banner",
    disclosure: "inline",
  },
  {
    id: "provider-profile.activate",
    entity: "provider-profile",
    label: t("catalog.features.sourceObservations.ui.controlPlaneV2.actions.provider-profile.activate.label"),
    permission: "catalog.manage",
    destructive: true,
    requiresReason: false,
    requiresConfirmation: true,
    feedbackShape: "confirmation-gate",
    disclosure: "inline",
  },
  {
    id: "provider-profile.rollback",
    entity: "provider-profile",
    label: t("catalog.features.sourceObservations.ui.controlPlaneV2.actions.provider-profile.rollback.label"),
    permission: "catalog.manage",
    destructive: true,
    requiresReason: false,
    requiresConfirmation: true,
    feedbackShape: "confirmation-gate",
    disclosure: "inline",
  },
  {
    id: "provider-profile.deprecate",
    entity: "provider-profile",
    label: t("catalog.features.sourceObservations.ui.controlPlaneV2.actions.provider-profile.deprecate.label"),
    permission: "catalog.manage",
    destructive: true,
    requiresReason: false,
    requiresConfirmation: true,
    feedbackShape: "confirmation-gate",
    disclosure: "inline",
  },
  {
    id: "provider-profile.retire",
    entity: "provider-profile",
    label: t("catalog.features.sourceObservations.ui.controlPlaneV2.actions.provider-profile.retire.label"),
    permission: "catalog.manage",
    destructive: true,
    requiresReason: false,
    requiresConfirmation: true,
    feedbackShape: "confirmation-gate",
    disclosure: "inline",
  },
] as const satisfies readonly CatalogControlPlaneAction[];

export type CatalogControlPlaneActionId = (typeof CATALOG_CONTROL_PLANE_ACTIONS)[number]["id"];

// The eight deprecated workspaces, each mapped to its v2 home. Nothing is dropped:
// standalone triage/audit pages fold into inline readiness and the evidence drawer.
export const CATALOG_CONTROL_PLANE_CAPABILITY_MAP = [
  {
    workspace: "import-to-promotion",
    disposition: "moved",
    newHome: "scope-detail",
    rationale:
      "The import → observation-review → promotion journey is the scope-detail page; the attention queue that starts it lives on catalog-home.",
  },
  {
    workspace: "health-triage",
    disposition: "folded",
    newHome: "scope-detail",
    rationale:
      "Readiness stops being a standalone page and renders as inline blocker banners on the affected scope (and, for transport, on provider-detail); the operator fixes in place.",
  },
  {
    workspace: "profile-authoring",
    disposition: "moved",
    newHome: "provider-detail",
    rationale: "Profile drafting and section editing are part of one provider's linear profile lifecycle.",
  },
  {
    workspace: "validation-readiness",
    disposition: "folded",
    newHome: "provider-detail",
    rationale:
      "Fixture, dry-run, compare, activation, credential, and transport readiness render inline on provider-detail as the gate before activate — not a separate destination.",
  },
  {
    workspace: "conflict-resolution",
    disposition: "folded",
    newHome: "scope-detail",
    rationale:
      "Source-fact conflicts resolve inline on the observation they block; precedence and audit evidence open in the evidence drawer.",
  },
  {
    workspace: "lifecycle-recovery",
    disposition: "moved",
    newHome: "provider-detail",
    rationale:
      "Rollback/deprecate/retire are the provider profile lifecycle on provider-detail; observation reapply/replay recovery lives on scope-detail with its observations.",
  },
  {
    workspace: "governance-controls",
    disposition: "moved",
    newHome: "settings",
    rationale: "RBAC, rollout, kill switches, and observability ownership are the Settings page.",
  },
  {
    workspace: "audit-evidence",
    disposition: "folded",
    newHome: "evidence",
    rationale:
      "Audit traceability becomes the Evidence drawer, openable over any entity on any page instead of its own page.",
  },
] as const satisfies readonly CatalogControlPlaneCapabilityMapEntry[];

// Machine internals the milestone deletes. These are structural, not operator
// capabilities: no operator job is lost, but the detour machinery is gone.
export const CATALOG_CONTROL_PLANE_RETIRED_MACHINERY = [
  {
    capability: "returnPath propagation",
    reason: "Blockers resolve inline or in a drawer, so there is never a surface to return from.",
  },
  {
    capability: "?section= workspace router",
    reason: "Three real pages replace one route that switched among eight stacked workspaces.",
  },
  {
    capability: "detour telemetry and workflow blockedBy map",
    reason: "There are no cross-surface detours left to instrument once every blocker is fixed in place.",
  },
  {
    capability: "stale raw-JSON promotion/candidate preview",
    reason: "Replaced by typed, freshness-guarded preview panels on the promote and candidate-edit actions.",
  },
] as const satisfies readonly CatalogControlPlaneRetiredMachinery[];

// ---------------------------------------------------------------------------
// Lookups
// ---------------------------------------------------------------------------

export function catalogControlPlanePageByKey(key: CatalogControlPlanePageKey): CatalogControlPlanePage {
  const page = CATALOG_CONTROL_PLANE_PAGES.find((candidate) => candidate.key === key);
  if (!page) {
    throw new Error(`Unknown Catalog Control Plane page '${key}'.`);
  }
  return page;
}

export function catalogControlPlaneEntityByKey(key: CatalogControlPlaneEntityKey): CatalogControlPlaneEntity {
  const entity = CATALOG_CONTROL_PLANE_ENTITIES.find((candidate) => candidate.key === key);
  if (!entity) {
    throw new Error(`Unknown Catalog Control Plane entity '${key}'.`);
  }
  return entity;
}

export function catalogControlPlaneActionsForEntity(
  entity: CatalogControlPlaneEntityKey,
): readonly CatalogControlPlaneAction[] {
  return CATALOG_CONTROL_PLANE_ACTIONS.filter((action) => action.entity === entity);
}
