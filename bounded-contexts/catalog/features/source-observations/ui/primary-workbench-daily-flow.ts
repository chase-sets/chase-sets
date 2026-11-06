import type {
  CatalogPrimaryWorkbenchBlockerCategory,
  CatalogPrimaryWorkbenchDailyStatusReadModel,
  CatalogPrimaryWorkbenchFlowReadModel,
  CatalogPrimaryWorkbenchFlowStageKey,
  CatalogPrimaryWorkbenchFlowStageState,
  CatalogPrimaryWorkbenchReadModel,
} from "../api/primary-workbench-admin-contracts";

// The daily flow's stages and status banners, decided once with the read model
// so every client draws the same page (ADR 0030: the owning API holds the rule).

type DailyFlowInput = Pick<
  CatalogPrimaryWorkbenchReadModel,
  "routeContext" | "readiness" | "importJobs" | "sourceObservationReview" | "promotionPreview" | "promotionResult"
>;

type DailyStatusInput = Pick<
  CatalogPrimaryWorkbenchReadModel,
  "readiness" | "importJobs" | "promotionPreview" | "actions"
>;

const flowStageOrder: readonly CatalogPrimaryWorkbenchFlowStageKey[] = ["run-sync", "review-changes", "create-items"];

export function catalogPrimaryWorkbenchDailyFlowFor(input: DailyFlowInput): CatalogPrimaryWorkbenchFlowReadModel {
  const openStage = routeSectionStage(input) ?? workStage(input);
  const review = input.sourceObservationReview;
  const syncDone = input.importJobs.jobs.length > 0 || review.counts.changed > 0;
  const createDone = Boolean(input.promotionResult);
  const blocked: Record<CatalogPrimaryWorkbenchFlowStageKey, boolean> = {
    "run-sync": input.readiness.blockers.length > 0,
    "review-changes": false,
    "create-items": input.promotionPreview.blockers.length > 0,
  };
  const done: Record<CatalogPrimaryWorkbenchFlowStageKey, boolean> = {
    "run-sync": syncDone,
    "review-changes": review.promotionReadyCount === 0 && (createDone || syncDone),
    "create-items": createDone,
  };

  return {
    openStage,
    stages: flowStageOrder.map((key) => {
      const facts = { key, blocked: blocked[key], done: done[key] };
      return { ...facts, state: catalogPrimaryWorkbenchFlowStageState(facts, openStage) };
    }),
  };
}

// A stage's state with `openStage` open: blocked wins; the open stage is
// current; stages before it, or already done, are complete; the rest upcoming.
export function catalogPrimaryWorkbenchFlowStageState(
  stage: Readonly<{ key: CatalogPrimaryWorkbenchFlowStageKey; blocked: boolean; done: boolean }>,
  openStage: CatalogPrimaryWorkbenchFlowStageKey,
): CatalogPrimaryWorkbenchFlowStageState {
  const index = flowStageOrder.indexOf(stage.key);
  const openIndex = flowStageOrder.indexOf(openStage);
  if (stage.blocked) {
    return "blocked";
  }
  if (index === openIndex) {
    return "current";
  }
  return index < openIndex || stage.done ? "complete" : "upcoming";
}

// The stage a routable handoff names (a deep link to one section).
function routeSectionStage(input: DailyFlowInput): CatalogPrimaryWorkbenchFlowStageKey | null {
  switch (input.routeContext.section) {
    case "import-jobs":
    case "provider-scope-selection":
    case "readiness":
      return "run-sync";
    case "source-observation-review":
    case "conflict-resolution":
      return "review-changes";
    case "promotion-preview":
    case "promotion-result":
      return "create-items";
    default:
      return null;
  }
}

// The first stage that still has work: a preview or result opens Create; rows in
// scope, ready candidates or changed evidence open Review; otherwise Run sync.
function workStage(input: DailyFlowInput): CatalogPrimaryWorkbenchFlowStageKey {
  if (input.promotionResult || input.promotionPreview.previewId) {
    return "create-items";
  }
  const review = input.sourceObservationReview;
  if (review.rows.length > 0 || review.promotionReadyCount > 0 || review.counts.changed > 0) {
    return "review-changes";
  }
  return "run-sync";
}

const governanceDenialBlockers = new Set<CatalogPrimaryWorkbenchBlockerCategory>([
  "permission-denied",
  "authorization-denied",
  "rbac-missing",
]);
const governanceStopBlockers = new Set<CatalogPrimaryWorkbenchBlockerCategory>([
  "rollout-disabled",
  "kill-switch-active",
]);
const blockingTransports = new Set<CatalogPrimaryWorkbenchReadModel["readiness"]["providerTransport"][number]>([
  "timeout",
  "pagination-failure",
  "degraded-provider",
]);

export function catalogPrimaryWorkbenchDailyStatusFor(
  input: DailyStatusInput,
): CatalogPrimaryWorkbenchDailyStatusReadModel {
  return { governance: governanceStatus(input), health: healthStatus(input) };
}

// Denial (RBAC) before a rollout stop, because an access failure is the more
// fundamental block.
function governanceStatus(input: DailyStatusInput): CatalogPrimaryWorkbenchDailyStatusReadModel["governance"] {
  const blockers = new Set<CatalogPrimaryWorkbenchBlockerCategory>([
    ...input.readiness.blockers,
    ...input.promotionPreview.blockers,
  ]);
  const denied =
    input.readiness.rbacAllowed === false ||
    input.actions.some((action) => action.state === "denied") ||
    [...governanceDenialBlockers].some((blocker) => blockers.has(blocker));
  if (denied) {
    return "denied";
  }
  const stopped =
    input.readiness.rolloutEnabled === false || [...governanceStopBlockers].some((blocker) => blockers.has(blocker));
  return stopped ? "stopped" : null;
}

// A blocking transport failure is blocked; any other transport, stale
// readiness or a failed job is degraded.
function healthStatus(input: DailyStatusInput): CatalogPrimaryWorkbenchDailyStatusReadModel["health"] {
  const transport = input.readiness.providerTransport;
  if (transport.some((category) => blockingTransports.has(category))) {
    return "blocked";
  }
  const degraded = transport.length > 0 || input.readiness.freshness !== "fresh" || input.importJobs.failedJobCount > 0;
  return degraded ? "degraded" : null;
}
