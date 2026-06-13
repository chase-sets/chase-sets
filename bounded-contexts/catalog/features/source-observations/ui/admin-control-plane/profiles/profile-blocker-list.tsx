import { Badge, StatusReasonList } from "@chase-sets/design-system";
import { t } from "@chase-sets/localization";
import type { CatalogPrimaryWorkbenchBlockerCategory } from "../../../api/primary-workbench-admin-contracts";
import { getCatalogPrimaryWorkbenchBlockerCopy } from "../../primary-workbench-copy";

export function ProfileBlockerList({ blockers }: { blockers: readonly CatalogPrimaryWorkbenchBlockerCategory[] }) {
  if (blockers.length === 0) {
    return <Badge tone="success">{t("catalog.features.sourceObservations.ui.primaryWorkbench.none")}</Badge>;
  }

  return (
    <StatusReasonList
      nextStepPrefix={t("catalog.features.sourceObservations.ui.primaryWorkbench.copy.next.prefix")}
      items={blockers.map((blocker) => {
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

function blockerTone(blocker: CatalogPrimaryWorkbenchBlockerCategory) {
  if (blocker.includes("permission") || blocker.includes("authorization")) {
    return "danger";
  }
  if (blocker.includes("active-job") || blocker.includes("concurrent")) {
    return "warning";
  }

  return "danger";
}
