import {
  Badge,
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
} from "../../../api/primary-workbench-admin-contracts";
import { getCatalogPrimaryWorkbenchBlockerCopy } from "../../primary-workbench-copy";

type ImportJobRow = CatalogPrimaryWorkbenchReadModel["importJobs"]["jobs"][number];

// One normalized blocker affordance for the whole daily flow. Collapses the
// readiness and promotion-command blockers into a single deduplicated panel so
// blockers are presented once with consistent label/reason/next-step taxonomy
// instead of being repeated per step, job, observation, command, and readiness.
export function WorkspaceBlockerPanel({ blockers }: { blockers: readonly CatalogPrimaryWorkbenchBlockerCategory[] }) {
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
        <BlockerList blockers={visibleBlockers} />
      </WorkbenchStack>
    </WorkbenchDetailPanel>
  );
}

export function BlockerList({
  blockers,
  compact = false,
  hideWhenEmpty = false,
}: {
  blockers: readonly CatalogPrimaryWorkbenchBlockerCategory[];
  compact?: boolean;
  hideWhenEmpty?: boolean;
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
        };
      })}
    />
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
