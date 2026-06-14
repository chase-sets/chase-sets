import {
  Badge,
  LinkButton,
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
import { catalogPrimaryWorkbenchSupportingHref } from "../../primary-workbench-route-context";

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
