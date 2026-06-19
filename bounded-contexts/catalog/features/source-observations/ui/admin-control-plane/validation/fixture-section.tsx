import {
  Badge,
  BadgeCluster,
  Button,
  DataTable,
  KeyValueList,
  SideSheet,
  WorkbenchDataCell,
  WorkbenchStack,
  WorkbenchText,
  WorkbenchValueList,
  WorkflowModule,
  type DataColumn,
} from "@chase-sets/design-system";
import { t } from "@chase-sets/localization";
import {
  EvidenceList,
  statusLabel,
  type BadgeTone,
  type FixtureFlow,
  type ValidationReadiness,
} from "./validation-shared";

export function FixtureSection({ validation }: { validation: ValidationReadiness }) {
  return (
    <WorkflowModule
      title={t("catalog.features.sourceObservations.ui.primaryWorkbench.validation.fixture.title")}
      description={t("catalog.features.sourceObservations.ui.primaryWorkbench.validation.fixture.description")}
      status={
        <Badge tone={validation.summary.blockedFixtureFlows > 0 ? "danger" : "success"}>
          {t("catalog.features.sourceObservations.ui.primaryWorkbench.validation.fixture.coveredFlows")}
        </Badge>
      }
      density="compact"
    >
      <DataTable
        rows={[...validation.fixtureFlows]}
        columns={fixtureColumns}
        caption={t("catalog.features.sourceObservations.ui.primaryWorkbench.validation.fixture.title")}
        getRowId={(row) => row.flow}
        density="compact"
        emptyTitle={t("catalog.features.sourceObservations.ui.primaryWorkbench.validation.fixture.emptyTitle")}
        emptyDescription={t(
          "catalog.features.sourceObservations.ui.primaryWorkbench.validation.fixture.emptyDescription",
        )}
      />
    </WorkflowModule>
  );
}

const fixtureColumns: DataColumn<FixtureFlow>[] = [
  {
    key: "flow",
    header: t("catalog.features.sourceObservations.ui.primaryWorkbench.validation.fixture.table.flow"),
    sortable: true,
    cell: (flow) => (
      <WorkbenchDataCell title={flow.label} description={flow.payloadPath ?? flow.payloadFile ?? "no payload"} />
    ),
  },
  {
    key: "status",
    header: t("catalog.features.sourceObservations.ui.primaryWorkbench.validation.table.status"),
    mobileLabel: t("catalog.features.sourceObservations.ui.primaryWorkbench.validation.table.status"),
    cell: (flow) => <Badge tone={fixtureTone(flow.status)}>{statusLabel(flow.status)}</Badge>,
  },
  {
    key: "expectations",
    header: t("catalog.features.sourceObservations.ui.primaryWorkbench.validation.fixture.table.expectedEvidence"),
    mobileLabel: t("catalog.features.sourceObservations.ui.primaryWorkbench.validation.fixture.table.expectedEvidence"),
    cell: (flow) => (
      <WorkbenchValueList>
        <WorkbenchText size="xs">{flow.expectedStatus ?? "not declared"}</WorkbenchText>
        <WorkbenchText size="xs">
          {flow.expectedPromotionCommands.length}{" "}
          {t("catalog.features.sourceObservations.ui.primaryWorkbench.validation.fixture.table.promotionCommands")}
        </WorkbenchText>
        <WorkbenchText size="xs">
          {flow.expectedHashEvidencePaths.length}{" "}
          {t("catalog.features.sourceObservations.ui.primaryWorkbench.validation.fixture.table.hashPaths")}
        </WorkbenchText>
        <WorkbenchText size="xs">
          {flow.expectedMergeEvidencePaths.length}{" "}
          {t("catalog.features.sourceObservations.ui.primaryWorkbench.validation.fixture.table.mergePaths")}
        </WorkbenchText>
      </WorkbenchValueList>
    ),
  },
  {
    key: "diagnostics",
    header: t("catalog.features.sourceObservations.ui.primaryWorkbench.validation.table.diagnostics"),
    mobileLabel: t("catalog.features.sourceObservations.ui.primaryWorkbench.validation.table.diagnostics"),
    cell: (flow) => (
      <WorkbenchDataCell
        title={flow.diagnostics.length}
        titleWeight="regular"
        detail={flow.diagnostics[0]?.diagnosticText ?? "No diagnostics"}
      />
    ),
  },
  {
    key: "action",
    header: t("catalog.features.sourceObservations.ui.primaryWorkbench.validation.table.inspect"),
    mobileLabel: t("catalog.features.sourceObservations.ui.primaryWorkbench.validation.table.inspect"),
    align: "right",
    cell: (flow) => <FixtureFlowSheet flow={flow} />,
  },
];

function FixtureFlowSheet({ flow }: { flow: FixtureFlow }) {
  return (
    <SideSheet
      title={t("catalog.features.sourceObservations.ui.primaryWorkbench.validation.fixture.sheet.title", {
        value: flow.label,
      })}
      description={t("catalog.features.sourceObservations.ui.primaryWorkbench.validation.fixture.sheet.description")}
      closeLabel="Close fixture"
      width="lg"
      trigger={
        <Button size="sm" tone="secondary" leadingIcon="eye">
          {t("catalog.features.sourceObservations.ui.primaryWorkbench.validation.fixture.inspect")}
        </Button>
      }
    >
      <WorkbenchStack>
        <KeyValueList
          density="compact"
          items={[
            { key: "Flow", value: flow.flow },
            { key: "Status", value: statusLabel(flow.status) },
            { key: "Payload file", value: flow.payloadFile ?? "not declared" },
            { key: "Payload path", value: flow.payloadPath ?? "not declared" },
            { key: "Sample payload", value: flow.samplePayloadAvailable ? "available" : "not available" },
          ]}
        />
        <EvidenceList
          title={t("catalog.features.sourceObservations.ui.primaryWorkbench.validation.fixture.expectedDiagnostics")}
          items={flow.expectedDiagnosticPaths}
        />
        <EvidenceList
          title={t("catalog.features.sourceObservations.ui.primaryWorkbench.validation.fixture.expectedHashEvidence")}
          items={flow.expectedHashEvidencePaths}
        />
        <EvidenceList
          title={t("catalog.features.sourceObservations.ui.primaryWorkbench.validation.fixture.expectedMergeEvidence")}
          items={flow.expectedMergeEvidencePaths}
        />
        <EvidenceList
          title={t(
            "catalog.features.sourceObservations.ui.primaryWorkbench.validation.fixture.expectedPromotionCommands",
          )}
          items={flow.expectedPromotionCommands}
        />
        <DiagnosticList diagnostics={flow.diagnostics} />
        <BlockerBadges blockers={flow.blockers} />
      </WorkbenchStack>
    </SideSheet>
  );
}

function DiagnosticList({ diagnostics }: { diagnostics: FixtureFlow["diagnostics"] }) {
  if (diagnostics.length === 0) {
    return (
      <WorkbenchText>
        {t("catalog.features.sourceObservations.ui.primaryWorkbench.validation.fixture.emptyDiagnostics")}
      </WorkbenchText>
    );
  }

  return (
    <WorkbenchStack gap="sm">
      <WorkbenchText tone="foreground" weight="semibold">
        {t("catalog.features.sourceObservations.ui.primaryWorkbench.validation.table.diagnostics")}
      </WorkbenchText>
      {diagnostics.map((diagnostic) => (
        <KeyValueList
          key={`${diagnostic.path}-${diagnostic.diagnosticText}`}
          density="compact"
          variant="surface"
          items={[
            { key: "Severity", value: diagnostic.severity },
            { key: "Path", value: diagnostic.path },
            { key: "Diagnostic", value: diagnostic.diagnosticText },
          ]}
        />
      ))}
    </WorkbenchStack>
  );
}

function BlockerBadges({ blockers }: { blockers: readonly string[] }) {
  if (blockers.length === 0) {
    return (
      <Badge tone="success">
        {t("catalog.features.sourceObservations.ui.primaryWorkbench.validation.blockers.empty")}
      </Badge>
    );
  }

  return <BadgeCluster items={blockers.map((blocker) => ({ key: blocker, label: blocker, tone: "danger" }))} />;
}

function fixtureTone(status: FixtureFlow["status"]): BadgeTone {
  if (status === "ready") return "success";
  if (status === "warning") return "warning";
  return "danger";
}
