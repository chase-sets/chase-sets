import {
  Badge,
  BadgeCluster,
  DataTable,
  EvidencePanel,
  WorkbenchDataCell,
  WorkbenchStack,
  WorkbenchText,
  type DataColumn,
} from "@chase-sets/design-system";
import { t } from "@chase-sets/localization";
import { mappingAffordanceLabels, type ProfileSectionWorkspace } from "./profile-formatting";

export function MappingRowDetails({ workspace }: { workspace: ProfileSectionWorkspace }) {
  if (workspace.mappingRows.length === 0) {
    return null;
  }

  const columns: DataColumn<ProfileSectionWorkspace["mappingRows"][number]>[] = [
    {
      key: "mapping",
      header: t("catalog.features.sourceObservations.ui.primaryWorkbench.profile.sectionDetails.table.mapping"),
      sortable: true,
      cell: (row) => <WorkbenchDataCell title={row.label} description={row.path} descriptionVariant="mono" />,
    },
    {
      key: "summary",
      header: t("catalog.features.sourceObservations.ui.primaryWorkbench.profile.sectionDetails.table.summary"),
      mobileLabel: t("catalog.features.sourceObservations.ui.primaryWorkbench.profile.sectionDetails.table.summary"),
      cell: (row) => (
        <WorkbenchText size="xs" wrap="anywhere">
          {row.summary}
        </WorkbenchText>
      ),
    },
    {
      key: "ownership",
      header: t("catalog.features.sourceObservations.ui.primaryWorkbench.profile.sectionDetails.table.ownership"),
      mobileLabel: t("catalog.features.sourceObservations.ui.primaryWorkbench.profile.sectionDetails.table.ownership"),
      cell: (row) => (
        <WorkbenchStack gap="sm">
          <BadgeCluster
            items={[
              ...(row.owner ? [{ key: "owner", label: row.owner, tone: "info" as const }] : []),
              ...(row.redaction
                ? [
                    {
                      key: "redaction",
                      label: row.redaction,
                      tone: row.redaction === "none" ? ("neutral" as const) : ("warning" as const),
                    },
                  ]
                : []),
            ]}
          />
          {row.uses.length > 0 ? (
            <WorkbenchText size="xs" wrap="anywhere">
              {row.uses.join(", ")}
            </WorkbenchText>
          ) : null}
        </WorkbenchStack>
      ),
    },
    {
      key: "editor",
      header: t("catalog.features.sourceObservations.ui.primaryWorkbench.profile.sectionDetails.table.editorMetadata"),
      mobileLabel: t(
        "catalog.features.sourceObservations.ui.primaryWorkbench.profile.sectionDetails.table.editorMetadata",
      ),
      cell: (row) => (
        <BadgeCluster
          items={[
            ...mappingAffordanceLabels(row).map((label) => ({
              key: label,
              label,
              tone: "neutral" as const,
            })),
            ...row.diagnostics.map((diagnostic) => ({
              key: `${diagnostic.path}:${diagnostic.diagnosticText}`,
              label: diagnostic.path,
              tone: diagnostic.severity === "error" ? ("danger" as const) : ("warning" as const),
            })),
          ]}
        />
      ),
    },
  ];

  return (
    <EvidencePanel
      title={t("catalog.features.sourceObservations.ui.primaryWorkbench.profile.sectionDetails.mappingRows.title")}
      description={t(
        "catalog.features.sourceObservations.ui.primaryWorkbench.profile.sectionDetails.mappingRows.description",
      )}
      status={<Badge tone="neutral">{workspace.mappingRows.length}</Badge>}
    >
      <DataTable rows={[...workspace.mappingRows]} columns={columns} getRowId={(row) => row.key} />
    </EvidencePanel>
  );
}
