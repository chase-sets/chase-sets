import {
  Badge,
  Button,
  DataTable,
  KeyValueList,
  SideSheet,
  WorkbenchDataCell,
  WorkbenchDetailPanel,
  WorkbenchStack,
  WorkbenchText,
  WorkflowModule,
  type DataColumn,
} from "@chase-sets/design-system";
import { t } from "@chase-sets/localization";
import {
  EvidenceList,
  statusLabel,
  type DryRunEvidence,
  type EvidenceRow,
  type ValidationReadiness,
} from "./validation-shared";

export function DryRunSection({ validation }: { validation: ValidationReadiness }) {
  return (
    <WorkflowModule
      title={t("catalog.features.sourceObservations.ui.primaryWorkbench.validation.dryRun.title")}
      description={t("catalog.features.sourceObservations.ui.primaryWorkbench.validation.dryRun.description")}
      status={
        <Badge
          tone={validation.dryRunEvidence.some((evidence) => evidence.status === "blocked") ? "danger" : "success"}
        >
          proofs
        </Badge>
      }
      density="compact"
    >
      <DataTable
        rows={[...validation.dryRunEvidence]}
        columns={dryRunColumns}
        caption={t("catalog.features.sourceObservations.ui.primaryWorkbench.validation.dryRun.title")}
        getRowId={(row, index) => `${row.externalKey}-${index}`}
        density="compact"
        emptyTitle={t("catalog.features.sourceObservations.ui.primaryWorkbench.validation.dryRun.emptyTitle")}
        emptyDescription={t(
          "catalog.features.sourceObservations.ui.primaryWorkbench.validation.dryRun.emptyDescription",
        )}
      />
    </WorkflowModule>
  );
}

const dryRunColumns: DataColumn<DryRunEvidence>[] = [
  {
    key: "source",
    header: t("catalog.features.sourceObservations.ui.primaryWorkbench.validation.dryRun.table.source"),
    sortable: true,
    cell: (evidence) => (
      <WorkbenchDataCell
        title={evidence.externalKey}
        description={evidence.sourceUrl ?? "no source URL"}
        detail={evidence.sourceHash ?? "no source hash"}
      />
    ),
  },
  {
    key: "status",
    header: t("catalog.features.sourceObservations.ui.primaryWorkbench.validation.table.status"),
    mobileLabel: t("catalog.features.sourceObservations.ui.primaryWorkbench.validation.table.status"),
    cell: (evidence) => (
      <Badge tone={evidence.status === "completed" ? "success" : "danger"}>{statusLabel(evidence.status)}</Badge>
    ),
  },
  {
    key: "facts",
    header: t("catalog.features.sourceObservations.ui.primaryWorkbench.validation.dryRun.table.redactedFacts"),
    mobileLabel: t("catalog.features.sourceObservations.ui.primaryWorkbench.validation.dryRun.table.redactedFacts"),
    cell: (evidence) => <FactPreview facts={evidence.normalizedFacts} />,
  },
  {
    key: "diagnostics",
    header: t("catalog.features.sourceObservations.ui.primaryWorkbench.validation.table.diagnostics"),
    mobileLabel: t("catalog.features.sourceObservations.ui.primaryWorkbench.validation.table.diagnostics"),
    cell: (evidence) => (
      <WorkbenchDataCell
        title={evidence.diagnostics.length}
        titleWeight="regular"
        detail={evidence.diagnostics[0]?.diagnosticText ?? "No diagnostics"}
      />
    ),
  },
  {
    key: "inspect",
    header: t("catalog.features.sourceObservations.ui.primaryWorkbench.validation.table.inspect"),
    mobileLabel: t("catalog.features.sourceObservations.ui.primaryWorkbench.validation.table.inspect"),
    align: "right",
    cell: (evidence) => <DryRunEvidenceSheet evidence={evidence} />,
  },
];

function DryRunEvidenceSheet({ evidence }: { evidence: DryRunEvidence }) {
  return (
    <SideSheet
      title={t("catalog.features.sourceObservations.ui.primaryWorkbench.validation.dryRun.sheet.title", {
        value: evidence.externalKey,
      })}
      description={t("catalog.features.sourceObservations.ui.primaryWorkbench.validation.dryRun.sheet.description")}
      closeLabel="Close proof"
      width="lg"
      trigger={
        <Button size="sm" tone="secondary" leadingIcon="eye">
          {t("catalog.features.sourceObservations.ui.primaryWorkbench.validation.dryRun.inspect")}
        </Button>
      }
    >
      <WorkbenchStack>
        <KeyValueList
          density="compact"
          layout="grid"
          items={[
            { key: "External key", value: evidence.externalKey },
            { key: "Status", value: statusLabel(evidence.status) },
            { key: "Source URL", value: evidence.sourceUrl ?? "not captured" },
            { key: "Source hash", value: evidence.sourceHash ?? "not captured" },
          ]}
        />
        <KeyValueList
          density="compact"
          variant="surface"
          items={evidence.redactionSummary.map((item) => ({ key: item.label, value: item.value }))}
        />
        <KeyValueList
          density="compact"
          layout="grid"
          items={evidence.normalizedFacts.map((fact) => ({ key: fact.key, value: fact.value }))}
        />
        <EvidenceRows
          title={t("catalog.features.sourceObservations.ui.primaryWorkbench.validation.dryRun.duplicateCandidates")}
          rows={evidence.duplicateCandidates}
        />
        <EvidenceRows
          title={t("catalog.features.sourceObservations.ui.primaryWorkbench.validation.dryRun.selectedOptions")}
          rows={evidence.selectedOptions}
        />
        <PromotionCommandPreview commands={evidence.promotionCommandPreview} />
        <DryRunDiagnostics diagnostics={evidence.diagnostics} />
        <EvidenceList
          title={t("catalog.features.sourceObservations.ui.primaryWorkbench.validation.metric.auditEvidence")}
          items={evidence.auditEvidence}
        />
      </WorkbenchStack>
    </SideSheet>
  );
}

function FactPreview({ facts }: { facts: DryRunEvidence["normalizedFacts"] }) {
  const visibleFacts = facts.slice(0, 4);
  if (visibleFacts.length === 0) {
    return (
      <WorkbenchText size="xs">
        {t("catalog.features.sourceObservations.ui.primaryWorkbench.validation.dryRun.noFacts")}
      </WorkbenchText>
    );
  }

  return (
    <WorkbenchStack gap="sm">
      {visibleFacts.map((fact) => (
        <WorkbenchText key={fact.key} size="xs" wrap="break">
          {fact.key}: {fact.value}
        </WorkbenchText>
      ))}
      {facts.length > visibleFacts.length ? (
        <WorkbenchText size="xs" tone="tertiary">
          {facts.length - visibleFacts.length} more
        </WorkbenchText>
      ) : null}
    </WorkbenchStack>
  );
}

function EvidenceRows({ title, rows }: { title: string; rows: readonly EvidenceRow[] }) {
  return (
    <WorkbenchStack gap="sm">
      <WorkbenchText element="h3" tone="foreground" weight="semibold">
        {title}
      </WorkbenchText>
      {rows.length === 0 ? (
        <WorkbenchText>
          {t("catalog.features.sourceObservations.ui.primaryWorkbench.validation.evidence.emptyRows")}
        </WorkbenchText>
      ) : (
        rows.map((row) => (
          <KeyValueList
            key={row.key}
            density="compact"
            variant="surface"
            items={[
              { key: "Label", value: row.label },
              { key: "Path", value: row.path },
              { key: "Summary", value: row.summary },
              { key: "Owner", value: row.owner ?? "not declared" },
              { key: "Uses", value: row.uses.join(", ") || "not declared" },
            ]}
          />
        ))
      )}
    </WorkbenchStack>
  );
}

function PromotionCommandPreview({ commands }: { commands: DryRunEvidence["promotionCommandPreview"] }) {
  return (
    <WorkbenchStack gap="sm">
      <WorkbenchText element="h3" tone="foreground" weight="semibold">
        {t("catalog.features.sourceObservations.ui.primaryWorkbench.validation.dryRun.promotionCommandPreview")}
      </WorkbenchText>
      {commands.length === 0 ? (
        <WorkbenchText>
          {t("catalog.features.sourceObservations.ui.primaryWorkbench.validation.dryRun.noPromotionCommands")}
        </WorkbenchText>
      ) : (
        commands.map((command) => (
          <WorkbenchDetailPanel key={command.commandName}>
            <WorkbenchText tone="foreground" weight="semibold">
              {command.commandName}
            </WorkbenchText>
            <EvidenceRows
              title={t("catalog.features.sourceObservations.ui.primaryWorkbench.validation.dryRun.inputs")}
              rows={command.inputs}
            />
          </WorkbenchDetailPanel>
        ))
      )}
    </WorkbenchStack>
  );
}

function DryRunDiagnostics({ diagnostics }: { diagnostics: DryRunEvidence["diagnostics"] }) {
  return (
    <WorkbenchStack gap="sm">
      <WorkbenchText tone="foreground" weight="semibold">
        {t("catalog.features.sourceObservations.ui.primaryWorkbench.validation.table.diagnostics")}
      </WorkbenchText>
      {diagnostics.length === 0 ? (
        <WorkbenchText>
          {t("catalog.features.sourceObservations.ui.primaryWorkbench.validation.diagnostics.empty")}
        </WorkbenchText>
      ) : (
        diagnostics.map((diagnostic) => (
          <KeyValueList
            key={`${diagnostic.code}-${diagnostic.path}`}
            density="compact"
            variant="surface"
            items={[
              { key: "Code", value: diagnostic.code },
              { key: "Path", value: diagnostic.path },
              { key: "Section", value: diagnostic.domainConcept },
              { key: "Flow", value: diagnostic.fixtureFlow ?? "not flow-specific" },
              { key: "Diagnostic", value: diagnostic.diagnosticText },
            ]}
          />
        ))
      )}
    </WorkbenchStack>
  );
}
