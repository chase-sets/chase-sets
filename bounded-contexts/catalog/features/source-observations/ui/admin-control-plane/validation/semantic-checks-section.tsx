import {
  Badge,
  BadgeCluster,
  Button,
  DataTable,
  EmptyState,
  KeyValueList,
  SideSheet,
  WorkbenchDataCell,
  WorkbenchGrid,
  WorkbenchStack,
  WorkflowModule,
  type DataColumn,
} from "@chase-sets/design-system";
import { t } from "@chase-sets/localization";
import { statusLabel, type BadgeTone, type SemanticSection, type ValidationReadiness } from "./validation-shared";

export function SemanticCompareSection({ validation }: { validation: ValidationReadiness }) {
  return (
    <WorkflowModule
      title={t("catalog.features.sourceObservations.ui.primaryWorkbench.validation.compare.title")}
      description={t("catalog.features.sourceObservations.ui.primaryWorkbench.validation.compare.description")}
      status={
        <Badge tone={validation.semanticCompare.mappingFingerprint.changed ? "warning" : "success"}>
          {validation.semanticCompare.mappingFingerprint.changed ? "changed" : "unchanged"}
        </Badge>
      }
      density="compact"
    >
      <WorkbenchGrid columns="sidebar">
        <KeyValueList
          density="compact"
          variant="surface"
          items={[
            {
              key: "Candidate fingerprint",
              value: validation.semanticCompare.mappingFingerprint.candidate ?? "not set",
            },
            { key: "Active fingerprint", value: validation.semanticCompare.mappingFingerprint.active ?? "not set" },
            {
              key: "Fixture coverage",
              value: validation.semanticCompare.fixtureCoverage.map((flow) => `${flow.flow}:${flow.status}`).join(", "),
            },
            {
              key: "Activation impact",
              value:
                validation.semanticCompare.activationImpact.join("; ") || "No activation-impacting changes detected.",
            },
          ]}
        />
        <DataTable
          rows={[...validation.semanticCompare.sections]}
          columns={semanticColumns}
          caption={t("catalog.features.sourceObservations.ui.primaryWorkbench.validation.compare.title")}
          getRowId={(row) => row.sectionKey}
          density="compact"
          emptyTitle={t("catalog.features.sourceObservations.ui.primaryWorkbench.validation.compare.emptyTitle")}
          emptyDescription={t(
            "catalog.features.sourceObservations.ui.primaryWorkbench.validation.compare.emptyDescription",
          )}
        />
      </WorkbenchGrid>
      <UnchangedSections sections={validation.semanticCompare.unchangedSections} />
    </WorkflowModule>
  );
}

const semanticColumns: DataColumn<SemanticSection>[] = [
  {
    key: "section",
    header: t("catalog.features.sourceObservations.ui.primaryWorkbench.validation.compare.table.section"),
    sortable: true,
    cell: (section) => <WorkbenchDataCell title={section.domainConcept} description={section.sectionKey} />,
  },
  {
    key: "status",
    header: t("catalog.features.sourceObservations.ui.primaryWorkbench.validation.table.status"),
    mobileLabel: t("catalog.features.sourceObservations.ui.primaryWorkbench.validation.table.status"),
    cell: (section) => <Badge tone={semanticTone(section.status)}>{section.status}</Badge>,
  },
  {
    key: "changes",
    header: t("catalog.features.sourceObservations.ui.primaryWorkbench.validation.compare.table.changes"),
    mobileLabel: t("catalog.features.sourceObservations.ui.primaryWorkbench.validation.compare.table.changes"),
    cell: (section) => (
      <WorkbenchDataCell
        title={section.changeCount}
        titleWeight="regular"
        detail={section.changes[0]?.activationImpact ?? "No activation-impacting changes"}
      />
    ),
  },
  {
    key: "inspect",
    header: t("catalog.features.sourceObservations.ui.primaryWorkbench.validation.table.inspect"),
    mobileLabel: t("catalog.features.sourceObservations.ui.primaryWorkbench.validation.table.inspect"),
    align: "right",
    cell: (section) => <SemanticSectionSheet section={section} />,
  },
];

function SemanticSectionSheet({ section }: { section: SemanticSection }) {
  return (
    <SideSheet
      title={t("catalog.features.sourceObservations.ui.primaryWorkbench.validation.compare.sheet.title", {
        value: section.domainConcept,
      })}
      description={t("catalog.features.sourceObservations.ui.primaryWorkbench.validation.compare.sheet.description")}
      closeLabel="Close compare"
      width="lg"
      trigger={
        <Button size="sm" tone="secondary" leadingIcon="eye">
          {t("catalog.features.sourceObservations.ui.primaryWorkbench.validation.compare.inspect")}
        </Button>
      }
    >
      <WorkbenchStack>
        {section.changes.length === 0 ? (
          <EmptyState
            title={t("catalog.features.sourceObservations.ui.primaryWorkbench.validation.compare.noChanges.title")}
            description={t(
              "catalog.features.sourceObservations.ui.primaryWorkbench.validation.compare.noChanges.description",
            )}
          />
        ) : (
          section.changes.map((change) => (
            <KeyValueList
              key={`${change.path}-${change.label}`}
              density="compact"
              variant="surface"
              items={[
                { key: "Path", value: change.path },
                { key: "Label", value: change.label },
                { key: "Candidate", value: change.candidateSummary },
                { key: "Active", value: change.activeSummary },
                { key: "Impact", value: change.activationImpact },
              ]}
            />
          ))
        )}
      </WorkbenchStack>
    </SideSheet>
  );
}

function UnchangedSections({ sections }: { sections: ValidationReadiness["semanticCompare"]["unchangedSections"] }) {
  if (sections.length === 0) {
    return null;
  }

  return (
    <BadgeCluster
      items={sections.map((section) => ({
        key: section.sectionKey,
        label: section.domainConcept,
        tone: "neutral",
      }))}
    />
  );
}

function semanticTone(status: SemanticSection["status"]): BadgeTone {
  if (status === "valid") return "success";
  if (status === "warning") return "warning";
  return "danger";
}
