import {
  Badge,
  LinkButton,
  OperationalStatusBanner,
  StatusReasonList,
  WorkbenchDetailPanel,
  WorkbenchStack,
  WorkbenchText,
} from "@chase-sets/design-system";
import { t } from "@chase-sets/localization";
import type {
  CatalogPrimaryWorkbenchActionState,
  CatalogPrimaryWorkbenchBlockerCategory,
  CatalogPrimaryWorkbenchReadModel,
  CatalogPrimaryWorkbenchRouteContext,
} from "../../../api/primary-workbench-admin-contracts";
import { getCatalogPrimaryWorkbenchBlockerCopy } from "../../primary-workbench-copy";
import { catalogControlPlaneWorkspaceByKey } from "../information-architecture";
import {
  catalogPrimaryWorkbenchReturnPath,
  catalogPrimaryWorkbenchSupportingHref,
} from "../../primary-workbench-route-context";

type ImportJobRow = CatalogPrimaryWorkbenchReadModel["importJobs"]["jobs"][number];

// One normalized blocker affordance for the whole daily flow. Collapses the
// readiness and promotion-command blockers into a single deduplicated panel so
// blockers are presented once with consistent label/reason/next-step taxonomy
// instead of being repeated per step, job, observation, command, and readiness.
// On the daily route it also deep-links each blocker into the provider-setup
// workspace that clears it, carrying return context back to the exact import scope.
export function WorkspaceBlockerPanel({
  blockers,
  resolveContext,
}: {
  blockers: readonly CatalogPrimaryWorkbenchBlockerCategory[];
  resolveContext?: CatalogPrimaryWorkbenchRouteContext;
}) {
  const visibleBlockers = uniqueBlockers(blockers);
  if (visibleBlockers.length === 0) {
    return null;
  }

  return (
    <WorkbenchDetailPanel>
      <WorkbenchStack gap="sm">
        <WorkbenchText tone="foreground" weight="semibold">
          {t("catalog.features.sourceObservations.ui.primaryWorkbench.stage.blockers.title")}
        </WorkbenchText>
        <WorkbenchText size="xs">
          {t("catalog.features.sourceObservations.ui.primaryWorkbench.stage.blockers.summary", {
            count: visibleBlockers.length,
          })}
        </WorkbenchText>
        <BlockerList blockers={visibleBlockers} resolveContext={resolveContext} />
      </WorkbenchStack>
    </WorkbenchDetailPanel>
  );
}

// Governance is rare, privileged ops kept off the daily route. When a primary
// command is denied (RBAC) or stopped (rollout / kill switch), the daily flow
// does NOT host the full RBAC/rollout panel — it shows only this slim indicator
// that deep-links into the governance-controls workspace carrying return context
// back to the daily job. Everything else (the full matrix, kill switches,
// observability) lives on /admin/integrations/governance.
type CatalogDailyGovernanceStatus = "denied" | "stopped";

const governanceDenialBlockers = new Set<CatalogPrimaryWorkbenchBlockerCategory>([
  "permission-denied",
  "authorization-denied",
  "rbac-missing",
]);
const governanceStopBlockers = new Set<CatalogPrimaryWorkbenchBlockerCategory>([
  "rollout-disabled",
  "kill-switch-active",
]);

// Detect whether a primary command is denied or stopped by governance, from the
// shared core read model the daily surface already loads (no governance slice
// required). Denial takes precedence over a rollout stop because an access
// failure is the more fundamental block. Returns null when nothing is
// governance-blocked, so the daily flow renders no indicator in the common case.
export function catalogDailyGovernanceStatus(
  readModel: CatalogPrimaryWorkbenchReadModel,
): CatalogDailyGovernanceStatus | null {
  const blockers = new Set<CatalogPrimaryWorkbenchBlockerCategory>([
    ...readModel.readiness.blockers,
    ...readModel.promotionPreview.blockers,
  ]);
  const denied =
    readModel.readiness.rbacAllowed === false ||
    readModel.actions.some((action) => action.state === "denied") ||
    [...governanceDenialBlockers].some((blocker) => blockers.has(blocker));
  if (denied) {
    return "denied";
  }
  const stopped =
    readModel.readiness.rolloutEnabled === false ||
    [...governanceStopBlockers].some((blocker) => blockers.has(blocker));

  return stopped ? "stopped" : null;
}

// The slim daily denied/stopped indicator. A compact tone-danger banner that
// names the governance failure mode and links into governance-controls with the
// daily working set as return context — the only governance affordance the daily
// route carries. Renders nothing when no primary command is governance-blocked.
export function DailyGovernanceStatusIndicator({
  readModel,
}: Readonly<{
  readModel: CatalogPrimaryWorkbenchReadModel;
}>) {
  const status = catalogDailyGovernanceStatus(readModel);
  if (!status) {
    return null;
  }

  return (
    <OperationalStatusBanner
      data-catalog-daily-governance-status={status}
      tone="danger"
      title={t(`catalog.features.sourceObservations.ui.primaryWorkbench.governanceStatus.${status}.title`)}
      description={t(`catalog.features.sourceObservations.ui.primaryWorkbench.governanceStatus.${status}.description`)}
      action={
        <LinkButton
          size="sm"
          tone="secondary"
          trailingIcon="chevronRight"
          href={catalogPrimaryWorkbenchSupportingHref(readModel.routeContext, "governance-controls")}
        >
          {t("catalog.features.sourceObservations.ui.primaryWorkbench.governanceStatus.open")}
        </LinkButton>
      }
    />
  );
}

// Health triage is observability work kept off the daily route: the full
// readiness/transport/rollout/job/audit dashboard lives on
// /admin/integrations/health. When the daily working set is health-degraded or
// blocked, the daily flow does NOT host that dashboard — it shows only this slim
// indicator that deep-links into health triage on the health surface carrying
// return context back to the daily job. Mirrors DailyGovernanceStatusIndicator.
type CatalogDailyHealthStatus = "degraded" | "blocked";

const transportBlockingTransports = new Set<CatalogPrimaryWorkbenchReadModel["readiness"]["providerTransport"][number]>(
  ["timeout", "pagination-failure", "degraded-provider"],
);

// Derive the daily health signal from the core read model the daily surface
// already loads — provider transport degradation, stale read-model freshness, and
// failed jobs — without computing the full health-triage slice (which the daily
// surface deliberately omits). A blocking transport failure surfaces as
// "blocked"; softer degradation (partial data, stale cache, throttling, stale
// freshness, failed jobs) surfaces as "degraded". Returns null when health is
// nominal, so the daily flow renders no indicator in the common case.
export function catalogDailyHealthStatus(readModel: CatalogPrimaryWorkbenchReadModel): CatalogDailyHealthStatus | null {
  const transport = readModel.readiness.providerTransport;
  if (transport.some((category) => transportBlockingTransports.has(category))) {
    return "blocked";
  }
  const degraded =
    transport.length > 0 || readModel.readiness.freshness !== "fresh" || readModel.importJobs.failedJobCount > 0;

  return degraded ? "degraded" : null;
}

// The slim daily degraded/blocked health indicator. A compact tone-warning/danger
// banner that names the degradation and links into health triage on the release
// surface with the daily working set as return context — the only health
// affordance the daily route carries. Renders nothing when health is nominal.
export function DailyHealthStatusIndicator({
  readModel,
}: Readonly<{
  readModel: CatalogPrimaryWorkbenchReadModel;
}>) {
  const status = catalogDailyHealthStatus(readModel);
  if (!status) {
    return null;
  }

  return (
    <OperationalStatusBanner
      data-catalog-daily-health-status={status}
      tone={status === "blocked" ? "danger" : "warning"}
      title={t(`catalog.features.sourceObservations.ui.primaryWorkbench.healthStatus.${status}.title`)}
      description={t(`catalog.features.sourceObservations.ui.primaryWorkbench.healthStatus.${status}.description`)}
      action={
        <LinkButton
          size="sm"
          tone="secondary"
          trailingIcon="chevronRight"
          href={catalogPrimaryWorkbenchSupportingHref(readModel.routeContext, "health-triage")}
        >
          {t("catalog.features.sourceObservations.ui.primaryWorkbench.healthStatus.open")}
        </LinkButton>
      }
    />
  );
}

// The single "Back to import workbench" affordance for a supporting surface. The
// release, providers, and governance surfaces stack multiple workspaces; rather
// than each workspace repeating an identical return link, the surface header
// renders this once. The href is the daily
// working set the operator detoured from — identical for every workspace on the
// surface — so one link per surface is correct.
export function WorkbenchReturnLink({
  routeContext,
}: Readonly<{
  routeContext: CatalogPrimaryWorkbenchRouteContext;
}>) {
  return (
    <LinkButton
      size="sm"
      tone="secondary"
      leadingIcon="chevronLeft"
      href={catalogPrimaryWorkbenchReturnPath(routeContext)}
    >
      {t("catalog.features.sourceObservations.ui.primaryWorkbench.returnToWorkbench")}
    </LinkButton>
  );
}

export function BlockerList({
  blockers,
  compact = false,
  hideWhenEmpty = false,
  resolveContext,
}: {
  blockers: readonly CatalogPrimaryWorkbenchBlockerCategory[];
  compact?: boolean;
  hideWhenEmpty?: boolean;
  // When set (daily route), each blocker whose support target is a separate
  // workspace renders a deep link to that workspace carrying return context.
  resolveContext?: CatalogPrimaryWorkbenchRouteContext;
}) {
  const visibleBlockers = uniqueBlockers(blockers);
  if (visibleBlockers.length === 0) {
    if (hideWhenEmpty) {
      return null;
    }

    return <Badge tone="success">{t("catalog.features.sourceObservations.ui.primaryWorkbench.none")}</Badge>;
  }

  return (
    <StatusReasonList
      compact={compact}
      nextStepPrefix={t("catalog.features.sourceObservations.ui.primaryWorkbench.copy.next.prefix")}
      items={visibleBlockers.map((blocker) => {
        const copy = getCatalogPrimaryWorkbenchBlockerCopy(blocker);

        return {
          key: blocker,
          label: copy.label,
          reason: copy.reason,
          nextStep: copy.nextStep,
          tone: blockerTone(blocker),
          action: resolveContext ? blockerResolveLink(blocker, resolveContext) : undefined,
        };
      })}
    />
  );
}

// Deep link a blocker into the workspace that clears it, carrying the daily
// working set as the return path. Skipped when the support target is the daily
// import-to-promotion workspace itself (there is nowhere to detour to).
function blockerResolveLink(
  blocker: CatalogPrimaryWorkbenchBlockerCategory,
  context: CatalogPrimaryWorkbenchRouteContext,
) {
  const supportTarget = getCatalogPrimaryWorkbenchBlockerCopy(blocker).supportTarget;
  if (supportTarget === "import-to-promotion") {
    return undefined;
  }
  const workspace = catalogControlPlaneWorkspaceByKey(supportTarget);

  return (
    <LinkButton
      size="sm"
      tone="secondary"
      trailingIcon="chevronRight"
      href={catalogPrimaryWorkbenchSupportingHref(context, supportTarget)}
    >
      {t("catalog.features.sourceObservations.ui.primaryWorkbench.stage.blockers.resolveIn", {
        workspace: workspace.accessibleName,
      })}
    </LinkButton>
  );
}

export function uniqueBlockers(
  blockers: readonly CatalogPrimaryWorkbenchBlockerCategory[],
): readonly CatalogPrimaryWorkbenchBlockerCategory[] {
  return [...new Set(blockers)];
}

export function actionTone(state: CatalogPrimaryWorkbenchActionState) {
  if (state === "available") {
    return "success";
  }
  if (state === "denied" || state === "blocked" || state === "unsafe") {
    return "danger";
  }
  if (state === "degraded") {
    return "warning";
  }
  return "neutral";
}

export function blockerTone(blocker: CatalogPrimaryWorkbenchBlockerCategory) {
  const group = getCatalogPrimaryWorkbenchBlockerCopy(blocker).group;
  if (group === "permission" || group === "rollout" || group === "security-privacy" || group === "retirement") {
    return "danger";
  }
  if (group === "provider-transport" || group === "resilience" || group === "job") {
    return "warning";
  }

  return blocker.includes("blocked") ? "danger" : "warning";
}

export function profileSnapshotLabel(
  profileSnapshot: ImportJobRow["profileSnapshot"],
  fallbackVersion: string | null,
): string {
  if (profileSnapshot) {
    return `${profileSnapshot.profileKey}@${profileSnapshot.profileVersion}`;
  }

  return fallbackVersion ?? t("catalog.features.sourceObservations.ui.primaryWorkbench.not.selected");
}

export function stateLabel(state: string): string {
  return state
    .split("-")
    .join(" ")
    .replace(/^\w/, (char) => char.toUpperCase());
}
