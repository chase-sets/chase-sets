import {
  Badge,
  Button,
  DataTable,
  EmptyState,
  Form,
  KeyValueList,
  LinkButton,
  MetricStrip,
  OperationalStatusBanner,
  SideSheet,
  WorkflowModule,
  WorkflowReadinessChecklist,
  type DataColumn,
  type WorkflowReadinessItem,
} from "@chase-sets/design-system";
import { t } from "@chase-sets/localization";
import type { CatalogPrimaryWorkbenchReadModel } from "../../../api/primary-workbench-admin-contracts";
import { getCatalogPrimaryWorkbenchBlockerCopy } from "../../primary-workbench-copy";

type ValidationReadiness = CatalogPrimaryWorkbenchReadModel["validationReadiness"];
type FixtureFlow = ValidationReadiness["fixtureFlows"][number];
type DryRunEvidence = ValidationReadiness["dryRunEvidence"][number];
type SemanticSection = ValidationReadiness["semanticCompare"]["sections"][number];
type ActivationGroup = ValidationReadiness["activationReadiness"]["groups"][number];
type ActivationDecision = ValidationReadiness["activationDecision"];
type EvidenceRow = DryRunEvidence["duplicateCandidates"][number];
type BadgeTone = "success" | "warning" | "danger" | "neutral" | "info" | "accent";

export function CatalogIntegrationValidationReadinessWorkspace({
  readModel,
}: Readonly<{
  readModel: CatalogPrimaryWorkbenchReadModel;
}>) {
  const validation = readModel.validationReadiness;

  return (
    <section className="grid min-w-0 gap-4" data-catalog-validation-readiness-workspace="true">
      <WorkflowModule
        title={t("catalog.features.sourceObservations.ui.primaryWorkbench.validation.title")}
        description={t("catalog.features.sourceObservations.ui.primaryWorkbench.validation.description")}
        status={<Badge tone={statusTone(validation.status)}>{statusLabel(validation.status)}</Badge>}
        actions={
          <LinkButton size="sm" tone="secondary" leadingIcon="chevronLeft" href={validation.returnToPrimaryHref}>
            {t("catalog.features.sourceObservations.ui.primaryWorkbench.validation.back")}
          </LinkButton>
        }
        headingLevel={2}
        density="compact"
      >
        <div className="grid gap-4">
          <OperationalStatusBanner
            tone={validation.status === "blocked" ? "danger" : validation.status === "ready" ? "success" : "warning"}
            title={validationBannerTitle(validation)}
            description={validationBannerDescription(validation)}
          />
          <MetricStrip
            items={[
              {
                label: t("catalog.features.sourceObservations.ui.primaryWorkbench.validation.metric.fixtureFlows"),
                value: `${validation.summary.readyFixtureFlows}/${validation.summary.totalFixtureFlows}`,
                trend: `${validation.summary.blockedFixtureFlows} blocked`,
              },
              {
                label: t("catalog.features.sourceObservations.ui.primaryWorkbench.validation.metric.dryRunProofs"),
                value: String(validation.summary.dryRunEvidenceCount),
                trend: validation.freshness,
              },
              {
                label: t("catalog.features.sourceObservations.ui.primaryWorkbench.validation.metric.semanticChanges"),
                value: String(validation.summary.semanticChangeCount),
                trend: `${validation.summary.unchangedSectionCount} unchanged sections`,
              },
              {
                label: t("catalog.features.sourceObservations.ui.primaryWorkbench.validation.metric.readinessBlockers"),
                value: String(validation.summary.blockingReadinessChecks),
                trend: validation.activationReadiness.status,
              },
              {
                label: t("catalog.features.sourceObservations.ui.primaryWorkbench.validation.metric.auditEvidence"),
                value: String(validation.summary.auditEvidenceCount),
                trend: validation.selectedProfileVersion ?? "no profile selected",
              },
            ]}
          />
        </div>
      </WorkflowModule>

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
          getRowId={(row) => row.flow}
          density="compact"
          emptyTitle={t("catalog.features.sourceObservations.ui.primaryWorkbench.validation.fixture.emptyTitle")}
          emptyDescription={t(
            "catalog.features.sourceObservations.ui.primaryWorkbench.validation.fixture.emptyDescription",
          )}
        />
      </WorkflowModule>

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
          getRowId={(row, index) => `${row.externalKey}-${index}`}
          density="compact"
          emptyTitle={t("catalog.features.sourceObservations.ui.primaryWorkbench.validation.dryRun.emptyTitle")}
          emptyDescription={t(
            "catalog.features.sourceObservations.ui.primaryWorkbench.validation.dryRun.emptyDescription",
          )}
        />
      </WorkflowModule>

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
        <div className="grid gap-4 xl:grid-cols-[minmax(0,22rem)_minmax(0,1fr)]">
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
                value: validation.semanticCompare.fixtureCoverage
                  .map((flow) => `${flow.flow}:${flow.status}`)
                  .join(", "),
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
            getRowId={(row) => row.sectionKey}
            density="compact"
            emptyTitle={t("catalog.features.sourceObservations.ui.primaryWorkbench.validation.compare.emptyTitle")}
            emptyDescription={t(
              "catalog.features.sourceObservations.ui.primaryWorkbench.validation.compare.emptyDescription",
            )}
          />
        </div>
        <UnchangedSections sections={validation.semanticCompare.unchangedSections} />
      </WorkflowModule>

      <WorkflowModule
        title={t("catalog.features.sourceObservations.ui.primaryWorkbench.validation.activation.title")}
        description={t("catalog.features.sourceObservations.ui.primaryWorkbench.validation.activation.description")}
        status={
          <Badge tone={validation.activationReadiness.status === "ready" ? "success" : "danger"}>
            {validation.activationReadiness.status}
          </Badge>
        }
        density="compact"
      >
        <KeyValueList
          density="compact"
          layout="grid"
          items={[
            { key: "Reference count", value: String(validation.activationReadiness.referenceCount) },
            {
              key: "Migration evidence",
              value: validation.activationReadiness.requiresMigrationEvidence ? "required" : "not required",
            },
            { key: "Status", value: validation.activationReadiness.status },
          ]}
        />
        <div className="grid gap-4 lg:grid-cols-2">
          {validation.activationReadiness.groups.map((group) => (
            <ActivationGroupChecklist key={group.domainConcept} group={group} />
          ))}
        </div>
      </WorkflowModule>

      <ActivationDecisionModule readModel={readModel} />
    </section>
  );
}

function ActivationDecisionModule({ readModel }: { readModel: CatalogPrimaryWorkbenchReadModel }) {
  const validation = readModel.validationReadiness;
  const decision = validation.activationDecision;

  return (
    <WorkflowModule
      title={t("catalog.features.sourceObservations.ui.primaryWorkbench.validation.activationDecision.title")}
      description={t(
        "catalog.features.sourceObservations.ui.primaryWorkbench.validation.activationDecision.description",
      )}
      status={<Badge tone={decisionTone(decision.status)}>{statusLabel(decision.status)}</Badge>}
      actions={
        <LinkButton
          size="sm"
          tone="secondary"
          leadingIcon="externalLink"
          href={decision.auditConsequences.auditEvidenceUrl}
        >
          {t("catalog.features.sourceObservations.ui.primaryWorkbench.validation.activationDecision.auditLink")}
        </LinkButton>
      }
      density="compact"
    >
      <div className="grid gap-4">
        <OperationalStatusBanner
          tone={decision.status === "ready" ? "success" : decision.status === "blocked" ? "danger" : "warning"}
          title={activationDecisionTitle(decision)}
          description={activationDecisionDescription(decision)}
        />
        <MetricStrip
          items={[
            {
              label: t(
                "catalog.features.sourceObservations.ui.primaryWorkbench.validation.activationDecision.metric.references",
              ),
              value: String(decision.affectedReferences.referenceCount),
              trend: decision.affectedReferences.requiresMigrationEvidence
                ? t(
                    "catalog.features.sourceObservations.ui.primaryWorkbench.validation.activationDecision.metric.migrationRequired",
                  )
                : t(
                    "catalog.features.sourceObservations.ui.primaryWorkbench.validation.activationDecision.metric.migrationNotRequired",
                  ),
            },
            {
              label: t(
                "catalog.features.sourceObservations.ui.primaryWorkbench.validation.activationDecision.metric.importEligibility",
              ),
              value: statusLabel(decision.importEligibility),
              trend: statusLabel(validation.activationReadiness.status),
            },
            {
              label: t(
                "catalog.features.sourceObservations.ui.primaryWorkbench.validation.activationDecision.metric.evidence",
              ),
              value: statusLabel(decision.migrationEvidence.state),
              trend: decision.migrationEvidence.recordedAt ?? readModel.generatedAt,
            },
            {
              label: t(
                "catalog.features.sourceObservations.ui.primaryWorkbench.validation.activationDecision.metric.action",
              ),
              value: statusLabel(decision.actionState),
              trend: decision.lifecycle ?? t("catalog.features.sourceObservations.ui.primaryWorkbench.not.selected"),
            },
          ]}
        />

        <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(20rem,26rem)]">
          <div className="grid min-w-0 gap-4">
            <KeyValueList
              density="compact"
              layout="grid"
              items={[
                {
                  key: t(
                    "catalog.features.sourceObservations.ui.primaryWorkbench.validation.activationDecision.key.provider",
                  ),
                  value:
                    decision.providerKey ?? t("catalog.features.sourceObservations.ui.primaryWorkbench.not.selected"),
                },
                {
                  key: t(
                    "catalog.features.sourceObservations.ui.primaryWorkbench.validation.activationDecision.key.profile",
                  ),
                  value:
                    decision.profileVersion ??
                    t("catalog.features.sourceObservations.ui.primaryWorkbench.not.selected"),
                },
                {
                  key: t(
                    "catalog.features.sourceObservations.ui.primaryWorkbench.validation.activationDecision.key.before",
                  ),
                  value:
                    decision.migrationEvidence.mappingFingerprintBefore ??
                    t("catalog.features.sourceObservations.ui.primaryWorkbench.not.selected"),
                },
                {
                  key: t(
                    "catalog.features.sourceObservations.ui.primaryWorkbench.validation.activationDecision.key.after",
                  ),
                  value:
                    decision.migrationEvidence.mappingFingerprintAfter ??
                    t("catalog.features.sourceObservations.ui.primaryWorkbench.not.selected"),
                },
                {
                  key: t(
                    "catalog.features.sourceObservations.ui.primaryWorkbench.validation.activationDecision.key.events",
                  ),
                  value: decision.auditConsequences.eventNames.join(", "),
                },
                {
                  key: t(
                    "catalog.features.sourceObservations.ui.primaryWorkbench.validation.activationDecision.key.audit",
                  ),
                  value: decision.auditConsequences.summary,
                },
              ]}
            />
            <EvidenceList
              title={t(
                "catalog.features.sourceObservations.ui.primaryWorkbench.validation.activationDecision.replay.title",
              )}
              items={decision.affectedReferences.replayImplications}
            />
            <ActivationBlockerList decision={decision} />
          </div>

          <div className="grid min-w-0 gap-4">
            <MigrationEvidenceForm readModel={readModel} decision={decision} />
            <ActivateProfileForm readModel={readModel} decision={decision} />
          </div>
        </div>
      </div>
    </WorkflowModule>
  );
}

const fixtureColumns: DataColumn<FixtureFlow>[] = [
  {
    key: "flow",
    header: t("catalog.features.sourceObservations.ui.primaryWorkbench.validation.fixture.table.flow"),
    sortable: true,
    cell: (flow) => (
      <div className="grid min-w-0 gap-1">
        <span className="text-sm font-semibold text-foreground">{flow.label}</span>
        <span className="break-words text-xs text-secondary">
          {flow.payloadPath ?? flow.payloadFile ?? "no payload"}
        </span>
      </div>
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
      <div className="grid min-w-0 gap-1 text-xs text-secondary">
        <span>{flow.expectedStatus ?? "not declared"}</span>
        <span>
          {flow.expectedPromotionCommands.length}{" "}
          {t("catalog.features.sourceObservations.ui.primaryWorkbench.validation.fixture.table.promotionCommands")}
        </span>
        <span>
          {flow.expectedHashEvidencePaths.length}{" "}
          {t("catalog.features.sourceObservations.ui.primaryWorkbench.validation.fixture.table.hashPaths")}
        </span>
        <span>
          {flow.expectedMergeEvidencePaths.length}{" "}
          {t("catalog.features.sourceObservations.ui.primaryWorkbench.validation.fixture.table.mergePaths")}
        </span>
      </div>
    ),
  },
  {
    key: "diagnostics",
    header: t("catalog.features.sourceObservations.ui.primaryWorkbench.validation.table.diagnostics"),
    mobileLabel: t("catalog.features.sourceObservations.ui.primaryWorkbench.validation.table.diagnostics"),
    cell: (flow) => (
      <div className="grid min-w-0 gap-1">
        <span className="text-sm text-foreground">{flow.diagnostics.length}</span>
        <span className="break-words text-xs leading-5 text-secondary">
          {flow.diagnostics[0]?.diagnosticText ?? "No diagnostics"}
        </span>
      </div>
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

const dryRunColumns: DataColumn<DryRunEvidence>[] = [
  {
    key: "source",
    header: t("catalog.features.sourceObservations.ui.primaryWorkbench.validation.dryRun.table.source"),
    sortable: true,
    cell: (evidence) => (
      <div className="grid min-w-0 gap-1">
        <span className="text-sm font-semibold text-foreground">{evidence.externalKey}</span>
        <span className="break-words text-xs text-secondary">{evidence.sourceUrl ?? "no source URL"}</span>
        <span className="break-words text-xs text-secondary">{evidence.sourceHash ?? "no source hash"}</span>
      </div>
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
      <div className="grid min-w-0 gap-1">
        <span className="text-sm text-foreground">{evidence.diagnostics.length}</span>
        <span className="break-words text-xs leading-5 text-secondary">
          {evidence.diagnostics[0]?.diagnosticText ?? "No diagnostics"}
        </span>
      </div>
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

const semanticColumns: DataColumn<SemanticSection>[] = [
  {
    key: "section",
    header: t("catalog.features.sourceObservations.ui.primaryWorkbench.validation.compare.table.section"),
    sortable: true,
    cell: (section) => (
      <div className="grid min-w-0 gap-1">
        <span className="text-sm font-semibold text-foreground">{section.domainConcept}</span>
        <span className="break-words text-xs text-secondary">{section.sectionKey}</span>
      </div>
    ),
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
      <div className="grid min-w-0 gap-1">
        <span className="text-sm text-foreground">{section.changeCount}</span>
        <span className="break-words text-xs leading-5 text-secondary">
          {section.changes[0]?.activationImpact ?? "No activation-impacting changes"}
        </span>
      </div>
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
      <div className="grid gap-4">
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
      </div>
    </SideSheet>
  );
}

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
      <div className="grid gap-4">
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
      </div>
    </SideSheet>
  );
}

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
      <div className="grid gap-4">
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
      </div>
    </SideSheet>
  );
}

function ActivationGroupChecklist({ group }: { group: ActivationGroup }) {
  const items: WorkflowReadinessItem[] = group.checks.map((check) => ({
    key: check.checkKey,
    label: check.diagnosticText,
    status: check.status === "blocked" ? "blocked" : check.severity === "warning" ? "warning" : "passed",
    statusLabel: check.status,
    description: check.remediation,
    meta: (
      <>
        <Badge tone="neutral">{check.code}</Badge>
        <span className="break-words">{check.path}</span>
      </>
    ),
  }));

  return (
    <div className="grid min-w-0 gap-2 rounded-md border border-border-subtle p-3">
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-foreground">{group.domainConcept}</h3>
        <Badge tone={group.status === "ready" ? "success" : "danger"}>{group.status}</Badge>
      </div>
      <WorkflowReadinessChecklist items={items} emptyState="No readiness checks" />
    </div>
  );
}

function MigrationEvidenceForm({
  readModel,
  decision,
}: {
  readModel: CatalogPrimaryWorkbenchReadModel;
  decision: ActivationDecision;
}) {
  const disabled = !isDecisionActionAvailable(decision.saveEvidenceState);
  const evidence = decision.migrationEvidence;
  const evidenceHelpId = "catalog-activation-migration-evidence-help";
  const controlClassName =
    "min-h-10 rounded-md border border-border-subtle bg-surface px-3 py-2 text-sm font-normal text-foreground disabled:bg-surface-muted disabled:text-secondary";

  return (
    <Form
      spacing="md"
      method="post"
      action={decision.workspaceHref}
      data-catalog-validation-evidence-form="true"
      className="grid min-w-0 gap-3 rounded-md border border-border-subtle p-4"
    >
      <ValidationContextHiddenInputs readModel={readModel} intent={decision.evidenceCommandKey} />
      <input type="hidden" name="sectionKey" value="migration-evidence" />
      <input type="hidden" name="migrationFingerprintBefore" value={evidence.mappingFingerprintBefore ?? ""} />
      <input type="hidden" name="migrationFingerprintAfter" value={evidence.mappingFingerprintAfter ?? ""} />
      <input type="hidden" name="migrationRecordedAt" value={evidence.recordedAt ?? readModel.generatedAt} />
      <label className="grid gap-1 text-sm font-semibold text-foreground">
        {t("catalog.features.sourceObservations.ui.primaryWorkbench.validation.activationDecision.evidence.label")}
        <textarea
          className={`${controlClassName} min-h-28`}
          name="migrationEvidenceText"
          defaultValue={evidence.evidenceText}
          disabled={disabled}
          required={decision.affectedReferences.requiresMigrationEvidence}
          aria-describedby={evidenceHelpId}
        />
      </label>
      <span id={evidenceHelpId} className="text-xs leading-5 text-secondary">
        {t("catalog.features.sourceObservations.ui.primaryWorkbench.validation.activationDecision.evidence.help")}
      </span>
      <label className="grid gap-1 text-sm font-semibold text-foreground">
        {t("catalog.features.sourceObservations.ui.primaryWorkbench.validation.activationDecision.fixtureRun.label")}
        <input
          className={controlClassName}
          name="migrationFixtureRunId"
          defaultValue={evidence.fixtureRunId ?? ""}
          disabled={disabled}
        />
      </label>
      <Button type="submit" leadingIcon="check" disabled={disabled}>
        {t("catalog.features.sourceObservations.ui.primaryWorkbench.validation.activationDecision.evidence.save")}
      </Button>
      <ActivationBlockerBadges blockers={decision.saveEvidenceBlockers} />
    </Form>
  );
}

function ActivateProfileForm({
  readModel,
  decision,
}: {
  readModel: CatalogPrimaryWorkbenchReadModel;
  decision: ActivationDecision;
}) {
  const disabled = !isDecisionActionAvailable(decision.actionState);

  return (
    <Form
      spacing="md"
      method="post"
      action={decision.workspaceHref}
      data-catalog-activate-profile-form="true"
      className="grid min-w-0 gap-3 rounded-md border border-border-subtle p-4"
    >
      <ValidationContextHiddenInputs readModel={readModel} intent={decision.activationCommandKey} />
      <KeyValueList
        density="compact"
        items={[
          {
            key: t("catalog.features.sourceObservations.ui.primaryWorkbench.validation.activationDecision.key.action"),
            value: statusLabel(decision.actionState),
          },
          {
            key: t(
              "catalog.features.sourceObservations.ui.primaryWorkbench.validation.activationDecision.key.migration",
            ),
            value: statusLabel(decision.migrationEvidence.state),
          },
        ]}
      />
      <Button type="submit" leadingIcon="check" disabled={disabled}>
        {t("catalog.features.sourceObservations.ui.primaryWorkbench.validation.activationDecision.activate")}
      </Button>
      <ActivationBlockerBadges blockers={decision.blockers} />
    </Form>
  );
}

function ValidationContextHiddenInputs({
  readModel,
  intent,
}: {
  readModel: CatalogPrimaryWorkbenchReadModel;
  intent: ActivationDecision["activationCommandKey"] | ActivationDecision["evidenceCommandKey"];
}) {
  const context = readModel.routeContext;
  const decision = readModel.validationReadiness.activationDecision;

  return (
    <>
      <input type="hidden" name="_intent" value={intent} />
      <input type="hidden" name="providerKey" value={decision.providerKey ?? context.providerKey ?? ""} />
      <input type="hidden" name="unitKey" value={context.unitKey ?? ""} />
      <input type="hidden" name="importScope" value={context.importScope ?? ""} />
      <input type="hidden" name="profileVersion" value={decision.profileVersion ?? context.profileVersion ?? ""} />
      <input type="hidden" name="selectedObservationIds" value={context.selectedObservationIds.join(",")} />
      <input type="hidden" name="jobId" value={context.jobId ?? ""} />
      <input type="hidden" name="promotionPreviewId" value={context.promotionPreviewId ?? ""} />
    </>
  );
}

function ActivationBlockerList({ decision }: { decision: ActivationDecision }) {
  if (decision.blockers.length === 0 && decision.saveEvidenceBlockers.length === 0) {
    return (
      <Badge tone="success">
        {t("catalog.features.sourceObservations.ui.primaryWorkbench.validation.activationDecision.noBlockers")}
      </Badge>
    );
  }

  return (
    <div className="grid min-w-0 gap-2">
      <h3 className="text-sm font-semibold text-foreground">
        {t("catalog.features.sourceObservations.ui.primaryWorkbench.validation.activationDecision.blockers")}
      </h3>
      <ActivationBlockerBadges blockers={[...new Set([...decision.blockers, ...decision.saveEvidenceBlockers])]} />
    </div>
  );
}

function ActivationBlockerBadges({ blockers }: { blockers: ActivationDecision["blockers"] }) {
  if (blockers.length === 0) {
    return null;
  }

  return (
    <div className="grid min-w-0 gap-1.5">
      {blockers.map((blocker) => {
        const copy = getCatalogPrimaryWorkbenchBlockerCopy(blocker);

        return (
          <div key={blocker} className="grid min-w-0 gap-1">
            <div className="flex min-w-0 flex-wrap gap-1.5">
              <Badge tone="danger">{copy.label}</Badge>
            </div>
            <span className="text-xs leading-5 text-secondary">
              {copy.reason} {t("catalog.features.sourceObservations.ui.primaryWorkbench.copy.next.prefix")}{" "}
              {copy.nextStep}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function FactPreview({ facts }: { facts: DryRunEvidence["normalizedFacts"] }) {
  const visibleFacts = facts.slice(0, 4);
  if (visibleFacts.length === 0) {
    return (
      <span className="text-xs text-secondary">
        {t("catalog.features.sourceObservations.ui.primaryWorkbench.validation.dryRun.noFacts")}
      </span>
    );
  }

  return (
    <div className="grid min-w-0 gap-1">
      {visibleFacts.map((fact) => (
        <span key={fact.key} className="break-words text-xs leading-5 text-secondary">
          {fact.key}: {fact.value}
        </span>
      ))}
      {facts.length > visibleFacts.length ? (
        <span className="text-xs text-tertiary">{facts.length - visibleFacts.length} more</span>
      ) : null}
    </div>
  );
}

function EvidenceRows({ title, rows }: { title: string; rows: readonly EvidenceRow[] }) {
  return (
    <div className="grid min-w-0 gap-2">
      <h3 className="text-sm font-semibold text-foreground">{title}</h3>
      {rows.length === 0 ? (
        <span className="text-sm text-secondary">
          {t("catalog.features.sourceObservations.ui.primaryWorkbench.validation.evidence.emptyRows")}
        </span>
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
    </div>
  );
}

function PromotionCommandPreview({ commands }: { commands: DryRunEvidence["promotionCommandPreview"] }) {
  return (
    <div className="grid min-w-0 gap-2">
      <h3 className="text-sm font-semibold text-foreground">
        {t("catalog.features.sourceObservations.ui.primaryWorkbench.validation.dryRun.promotionCommandPreview")}
      </h3>
      {commands.length === 0 ? (
        <span className="text-sm text-secondary">
          {t("catalog.features.sourceObservations.ui.primaryWorkbench.validation.dryRun.noPromotionCommands")}
        </span>
      ) : (
        commands.map((command) => (
          <div key={command.commandName} className="grid min-w-0 gap-2 rounded-md border border-border-subtle p-3">
            <div className="text-sm font-semibold text-foreground">{command.commandName}</div>
            <EvidenceRows
              title={t("catalog.features.sourceObservations.ui.primaryWorkbench.validation.dryRun.inputs")}
              rows={command.inputs}
            />
          </div>
        ))
      )}
    </div>
  );
}

function DryRunDiagnostics({ diagnostics }: { diagnostics: DryRunEvidence["diagnostics"] }) {
  return (
    <div className="grid min-w-0 gap-2">
      <h3 className="text-sm font-semibold text-foreground">
        {t("catalog.features.sourceObservations.ui.primaryWorkbench.validation.table.diagnostics")}
      </h3>
      {diagnostics.length === 0 ? (
        <span className="text-sm text-secondary">
          {t("catalog.features.sourceObservations.ui.primaryWorkbench.validation.diagnostics.empty")}
        </span>
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
    </div>
  );
}

function DiagnosticList({ diagnostics }: { diagnostics: FixtureFlow["diagnostics"] }) {
  if (diagnostics.length === 0) {
    return (
      <span className="text-sm text-secondary">
        {t("catalog.features.sourceObservations.ui.primaryWorkbench.validation.fixture.emptyDiagnostics")}
      </span>
    );
  }

  return (
    <div className="grid min-w-0 gap-2">
      <h3 className="text-sm font-semibold text-foreground">
        {t("catalog.features.sourceObservations.ui.primaryWorkbench.validation.table.diagnostics")}
      </h3>
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
    </div>
  );
}

function EvidenceList({ title, items }: { title: string; items: readonly string[] }) {
  return (
    <div className="grid min-w-0 gap-2">
      <h3 className="text-sm font-semibold text-foreground">{title}</h3>
      {items.length === 0 ? (
        <span className="text-sm text-secondary">
          {t("catalog.features.sourceObservations.ui.primaryWorkbench.validation.evidence.noneDeclared")}
        </span>
      ) : (
        <div className="flex min-w-0 flex-wrap gap-1.5">
          {items.map((item) => (
            <Badge key={item} tone="neutral">
              <span className="break-words">{item}</span>
            </Badge>
          ))}
        </div>
      )}
    </div>
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

  return (
    <div className="flex min-w-0 flex-wrap gap-1.5">
      {blockers.map((blocker) => (
        <Badge key={blocker} tone="danger">
          {blocker}
        </Badge>
      ))}
    </div>
  );
}

function UnchangedSections({ sections }: { sections: ValidationReadiness["semanticCompare"]["unchangedSections"] }) {
  if (sections.length === 0) {
    return null;
  }

  return (
    <div className="flex min-w-0 flex-wrap gap-1.5">
      {sections.map((section) => (
        <Badge key={section.sectionKey} tone="neutral">
          {section.domainConcept}
        </Badge>
      ))}
    </div>
  );
}

function validationBannerTitle(validation: ValidationReadiness): string {
  if (validation.status === "unavailable") {
    return "Select a profile to validate";
  }
  if (validation.status === "blocked") {
    return "Validation is blocking activation";
  }
  if (validation.status === "degraded") {
    return "Validation has reviewable changes";
  }

  return "Validation is ready";
}

function validationBannerDescription(validation: ValidationReadiness): string {
  if (validation.status === "unavailable") {
    return "Provider, unit, and profile context are required before validation evidence can be reviewed.";
  }
  if (validation.status === "blocked") {
    return "Resolve fixture, dry-run, or activation blockers before previewing promotion for this profile.";
  }
  if (validation.status === "degraded") {
    return "Review semantic changes and unchanged areas before returning to the primary promotion flow.";
  }

  return "Fixture coverage, dry-run evidence, semantic comparison, and activation checks are aligned.";
}

function statusTone(status: ValidationReadiness["status"]): BadgeTone {
  if (status === "ready") return "success";
  if (status === "blocked" || status === "unavailable") return "danger";
  return "warning";
}

function decisionTone(status: ActivationDecision["status"]): BadgeTone {
  if (status === "ready") return "success";
  if (status === "blocked") return "danger";
  return "warning";
}

function activationDecisionTitle(decision: ActivationDecision): string {
  if (decision.status === "ready") {
    return t(
      "catalog.features.sourceObservations.ui.primaryWorkbench.validation.activationDecision.banner.ready.title",
    );
  }
  if (decision.status === "blocked") {
    return t(
      "catalog.features.sourceObservations.ui.primaryWorkbench.validation.activationDecision.banner.blocked.title",
    );
  }

  return t(
    "catalog.features.sourceObservations.ui.primaryWorkbench.validation.activationDecision.banner.unavailable.title",
  );
}

function activationDecisionDescription(decision: ActivationDecision): string {
  if (decision.status === "ready") {
    return t(
      "catalog.features.sourceObservations.ui.primaryWorkbench.validation.activationDecision.banner.ready.description",
    );
  }
  if (decision.status === "blocked") {
    return t(
      "catalog.features.sourceObservations.ui.primaryWorkbench.validation.activationDecision.banner.blocked.description",
    );
  }

  return t(
    "catalog.features.sourceObservations.ui.primaryWorkbench.validation.activationDecision.banner.unavailable.description",
  );
}

function isDecisionActionAvailable(state: ActivationDecision["actionState"]): boolean {
  return state === "available" || state === "degraded";
}

function fixtureTone(status: FixtureFlow["status"]): BadgeTone {
  if (status === "ready") return "success";
  if (status === "warning") return "warning";
  return "danger";
}

function semanticTone(status: SemanticSection["status"]): BadgeTone {
  if (status === "valid") return "success";
  if (status === "warning") return "warning";
  return "danger";
}

function statusLabel(value: string): string {
  return value
    .split("-")
    .map((segment) => segment.replace(/^\w/, (char) => char.toUpperCase()))
    .join(" ");
}
