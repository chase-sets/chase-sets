import {
  Badge,
  DataTable,
  EvidencePanel,
  LinkButton,
  WorkbenchDataCell,
  WorkbenchStack,
  WorkbenchText,
  WorkbenchValueList,
  type DataColumn,
} from "@chase-sets/design-system";
import { t } from "@chase-sets/localization";
import { stateLabel } from "../import-to-promotion/workbench-formatting";
import { importScopeTone, type ProfileSectionWorkspace } from "./profile-formatting";

export function ImportScopeControlDetails({ workspace }: { workspace: ProfileSectionWorkspace }) {
  if (workspace.importScopeControls.length === 0) {
    return null;
  }

  const columns: DataColumn<ProfileSectionWorkspace["importScopeControls"][number]>[] = [
    {
      key: "scope",
      header: t("catalog.features.sourceObservations.ui.primaryWorkbench.profile.sectionDetails.table.importScope"),
      sortable: true,
      cell: (scope) => (
        <WorkbenchDataCell
          title={scope.label}
          description={scope.scope}
          descriptionVariant="mono"
          detail={scope.importScope}
        />
      ),
    },
    {
      key: "state",
      header: t("catalog.features.sourceObservations.ui.primaryWorkbench.profile.sectionDetails.table.state"),
      mobileLabel: t("catalog.features.sourceObservations.ui.primaryWorkbench.profile.sectionDetails.table.state"),
      cell: (scope) => (
        <WorkbenchStack gap="sm">
          <Badge tone={importScopeTone(scope.state)}>{stateLabel(scope.state)}</Badge>
          {scope.reason ? <WorkbenchText size="xs">{scope.reason}</WorkbenchText> : null}
        </WorkbenchStack>
      ),
    },
    {
      key: "volume",
      header: t("catalog.features.sourceObservations.ui.primaryWorkbench.profile.sectionDetails.table.volume"),
      mobileLabel: t("catalog.features.sourceObservations.ui.primaryWorkbench.profile.sectionDetails.table.volume"),
      cell: (scope) => (
        <WorkbenchValueList>
          <WorkbenchText size="xs">
            {t("catalog.features.sourceObservations.ui.primaryWorkbench.profile.sectionDetails.volume.expected", {
              count: String(scope.expectedObservationCount),
            })}
          </WorkbenchText>
          <WorkbenchText size="xs">
            {t("catalog.features.sourceObservations.ui.primaryWorkbench.profile.sectionDetails.volume.observed", {
              count: String(scope.observedCount),
            })}
          </WorkbenchText>
          <WorkbenchText size="xs">
            {t("catalog.features.sourceObservations.ui.primaryWorkbench.profile.sectionDetails.volume.changed", {
              count: String(scope.changedCount),
            })}
          </WorkbenchText>
          <WorkbenchText size="xs">
            {t("catalog.features.sourceObservations.ui.primaryWorkbench.profile.sectionDetails.volume.promoted", {
              count: String(scope.promotedCount),
            })}
          </WorkbenchText>
          <WorkbenchText size="xs">
            {t("catalog.features.sourceObservations.ui.primaryWorkbench.profile.sectionDetails.volume.rejected", {
              count: String(scope.rejectedCount),
            })}
          </WorkbenchText>
        </WorkbenchValueList>
      ),
    },
    {
      key: "action",
      header: t("catalog.features.sourceObservations.ui.primaryWorkbench.table.action"),
      mobileLabel: t("catalog.features.sourceObservations.ui.primaryWorkbench.table.action"),
      align: "right",
      cell: (scope) =>
        scope.href ? (
          <LinkButton size="sm" tone={scope.state === "selected" ? "secondary" : "primary"} href={scope.href}>
            {scope.state === "selected"
              ? t("catalog.features.sourceObservations.ui.primaryWorkbench.profile.sectionDetails.action.selected")
              : t("catalog.features.sourceObservations.ui.primaryWorkbench.profile.sectionDetails.action.useScope")}
          </LinkButton>
        ) : (
          <Badge tone="neutral">
            {t("catalog.features.sourceObservations.ui.primaryWorkbench.profile.sectionDetails.action.unavailable")}
          </Badge>
        ),
    },
  ];

  return (
    <EvidencePanel
      title={t("catalog.features.sourceObservations.ui.primaryWorkbench.profile.sectionDetails.importScopes.title")}
      description={t(
        "catalog.features.sourceObservations.ui.primaryWorkbench.profile.sectionDetails.importScopes.description",
      )}
      status={<Badge tone="neutral">{workspace.importScopeControls.length}</Badge>}
    >
      <DataTable
        rows={[...workspace.importScopeControls]}
        columns={columns}
        caption={t("catalog.features.sourceObservations.ui.primaryWorkbench.profile.sectionDetails.importScopes.title")}
        getRowId={(scope) => scope.scope}
      />
    </EvidencePanel>
  );
}
