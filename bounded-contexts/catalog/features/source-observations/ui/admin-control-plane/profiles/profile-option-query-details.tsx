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
import { optionQueryHealthTone, type ProfileSectionWorkspace } from "./profile-formatting";

export function ProviderOptionQueryDetails({ workspace }: { workspace: ProfileSectionWorkspace }) {
  if (workspace.sectionKey !== "provider-options" || workspace.optionQueries.length === 0) {
    return null;
  }

  const columns: DataColumn<ProfileSectionWorkspace["optionQueries"][number]>[] = [
    {
      key: "query",
      header: t("catalog.features.sourceObservations.ui.primaryWorkbench.profile.sectionDetails.table.query"),
      sortable: true,
      cell: (query) => (
        <WorkbenchDataCell
          title={query.displayName}
          description={query.queryKind}
          descriptionVariant="mono"
          badges={
            <BadgeCluster
              items={query.aliases.map((alias) => ({
                key: alias,
                label: alias,
                tone: "neutral",
              }))}
            />
          }
        />
      ),
    },
    {
      key: "scope",
      header: t("catalog.features.sourceObservations.ui.primaryWorkbench.profile.sectionDetails.table.scope"),
      mobileLabel: t("catalog.features.sourceObservations.ui.primaryWorkbench.profile.sectionDetails.table.scope"),
      cell: (query) => (
        <WorkbenchStack gap="sm">
          <BadgeCluster
            items={[
              { key: "scope", label: query.scope, tone: "info" },
              ...(query.parentScope
                ? [
                    {
                      key: "parent",
                      label: query.parentScope,
                      tone: query.parentRequired ? ("warning" as const) : ("neutral" as const),
                    },
                  ]
                : []),
            ]}
          />
          {query.parentDiagnosticText ? <WorkbenchText size="xs">{query.parentDiagnosticText}</WorkbenchText> : null}
          {query.parentValueKind ? <WorkbenchText size="xs">{query.parentValueKind}</WorkbenchText> : null}
        </WorkbenchStack>
      ),
    },
    {
      key: "operation",
      header: t("catalog.features.sourceObservations.ui.primaryWorkbench.profile.sectionDetails.table.operation"),
      mobileLabel: t("catalog.features.sourceObservations.ui.primaryWorkbench.profile.sectionDetails.table.operation"),
      cell: (query) => (
        <WorkbenchText size="xs" wrap="anywhere">
          {query.operation}
        </WorkbenchText>
      ),
    },
    {
      key: "output",
      header: t("catalog.features.sourceObservations.ui.primaryWorkbench.profile.sectionDetails.table.output"),
      mobileLabel: t("catalog.features.sourceObservations.ui.primaryWorkbench.profile.sectionDetails.table.output"),
      cell: (query) => (
        <WorkbenchStack gap="sm">
          {query.outputMappings.map((mapping) => (
            <WorkbenchDataCell
              key={mapping.key}
              title={mapping.label}
              description={mapping.path}
              descriptionVariant="mono"
            />
          ))}
        </WorkbenchStack>
      ),
    },
    {
      key: "cache",
      header: t("catalog.features.sourceObservations.ui.primaryWorkbench.profile.sectionDetails.table.cache"),
      mobileLabel: t("catalog.features.sourceObservations.ui.primaryWorkbench.profile.sectionDetails.table.cache"),
      cell: (query) => (
        <WorkbenchStack gap="sm">
          <BadgeCluster
            items={[
              {
                key: "status",
                label: query.cacheState.label,
                tone: optionQueryHealthTone(query.cacheState.status),
              },
              ...(query.cacheState.cacheOnly
                ? [
                    {
                      key: "cache-only",
                      label: t(
                        "catalog.features.sourceObservations.ui.primaryWorkbench.profile.sectionDetails.cacheOnly",
                      ),
                      tone: "warning" as const,
                    },
                  ]
                : []),
            ]}
          />
          <WorkbenchText size="xs">{query.cacheState.description}</WorkbenchText>
          {query.cacheState.diagnosticCodes.length > 0 ? (
            <WorkbenchText size="xs" wrap="anywhere">
              {query.cacheState.diagnosticCodes.join(", ")}
            </WorkbenchText>
          ) : null}
        </WorkbenchStack>
      ),
    },
  ];

  return (
    <EvidencePanel
      title={t("catalog.features.sourceObservations.ui.primaryWorkbench.profile.sectionDetails.optionQueries.title")}
      description={t(
        "catalog.features.sourceObservations.ui.primaryWorkbench.profile.sectionDetails.optionQueries.description",
      )}
      status={<Badge tone="neutral">{workspace.optionQueries.length}</Badge>}
    >
      <DataTable rows={[...workspace.optionQueries]} columns={columns} getRowId={(query) => query.queryKind} />
    </EvidencePanel>
  );
}
