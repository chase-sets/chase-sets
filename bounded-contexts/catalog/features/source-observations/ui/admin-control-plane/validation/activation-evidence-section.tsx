import {
  Badge,
  BadgeCluster,
  Button,
  HiddenInput,
  KeyValueList,
  LinkButton,
  MetricStrip,
  OperationalStatusBanner,
  StatusReasonList,
  Textarea,
  TextInput,
  WorkbenchDetailPanel,
  WorkbenchForm,
  WorkbenchGrid,
  WorkbenchStack,
  WorkbenchText,
  WorkflowModule,
  WorkflowReadinessChecklist,
  type WorkflowReadinessItem,
} from "@chase-sets/design-system";
import { t } from "@chase-sets/localization";
import type { CatalogPrimaryWorkbenchReadModel } from "../../../api/primary-workbench-admin-contracts";
import { getCatalogPrimaryWorkbenchBlockerCopy } from "../../primary-workbench-copy";
import {
  EvidenceList,
  statusLabel,
  type ActivationDecision,
  type ActivationGroup,
  type BadgeTone,
  type ValidationReadiness,
} from "./validation-shared";

export function ActivationReadinessSection({ validation }: { validation: ValidationReadiness }) {
  return (
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
      <WorkbenchGrid columns="two">
        {validation.activationReadiness.groups.map((group) => (
          <ActivationGroupChecklist key={group.domainConcept} group={group} />
        ))}
      </WorkbenchGrid>
    </WorkflowModule>
  );
}

export function ActivationDecisionModule({ readModel }: { readModel: CatalogPrimaryWorkbenchReadModel }) {
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
      <WorkbenchStack>
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

        <WorkbenchGrid columns="detail">
          <WorkbenchStack>
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
          </WorkbenchStack>

          <WorkbenchStack>
            <MigrationEvidenceForm readModel={readModel} decision={decision} />
            <ActivateProfileForm readModel={readModel} decision={decision} />
          </WorkbenchStack>
        </WorkbenchGrid>
      </WorkbenchStack>
    </WorkflowModule>
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
      <BadgeCluster
        items={[
          { key: "code", label: check.code, tone: "neutral" },
          { key: "path", label: check.path, tone: "neutral" },
        ]}
      />
    ),
  }));

  return (
    <WorkbenchDetailPanel>
      <BadgeCluster
        items={[
          { key: "domain", label: group.domainConcept, tone: "neutral" },
          { key: "status", label: group.status, tone: group.status === "ready" ? "success" : "danger" },
        ]}
      />
      <WorkflowReadinessChecklist items={items} emptyState="No readiness checks" />
    </WorkbenchDetailPanel>
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

  return (
    <WorkbenchForm method="post" action={decision.workspaceHref} data-catalog-validation-evidence-form="true">
      <ValidationContextHiddenInputs readModel={readModel} intent={decision.evidenceCommandKey} />
      <HiddenInput name="sectionKey" value="migration-evidence" />
      <HiddenInput name="migrationFingerprintBefore" value={evidence.mappingFingerprintBefore ?? ""} />
      <HiddenInput name="migrationFingerprintAfter" value={evidence.mappingFingerprintAfter ?? ""} />
      <HiddenInput name="migrationRecordedAt" value={evidence.recordedAt ?? readModel.generatedAt} />
      <Textarea
        label={t(
          "catalog.features.sourceObservations.ui.primaryWorkbench.validation.activationDecision.evidence.label",
        )}
        description={t(
          "catalog.features.sourceObservations.ui.primaryWorkbench.validation.activationDecision.evidence.help",
        )}
        name="migrationEvidenceText"
        defaultValue={evidence.evidenceText}
        disabled={disabled}
        required={decision.affectedReferences.requiresMigrationEvidence}
      />
      <TextInput
        label={t(
          "catalog.features.sourceObservations.ui.primaryWorkbench.validation.activationDecision.fixtureRun.label",
        )}
        name="migrationFixtureRunId"
        defaultValue={evidence.fixtureRunId ?? ""}
        disabled={disabled}
      />
      <Button type="submit" leadingIcon="check" disabled={disabled}>
        {t("catalog.features.sourceObservations.ui.primaryWorkbench.validation.activationDecision.evidence.save")}
      </Button>
      <ActivationBlockerBadges blockers={decision.saveEvidenceBlockers} />
    </WorkbenchForm>
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
    <WorkbenchForm method="post" action={decision.workspaceHref} data-catalog-activate-profile-form="true">
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
    </WorkbenchForm>
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
      <HiddenInput name="_intent" value={intent} />
      <HiddenInput name="providerKey" value={decision.providerKey ?? context.providerKey ?? ""} />
      <HiddenInput name="unitKey" value={context.unitKey ?? ""} />
      <HiddenInput name="importScope" value={context.importScope ?? ""} />
      <HiddenInput name="profileVersion" value={decision.profileVersion ?? context.profileVersion ?? ""} />
      <HiddenInput name="selectedObservationIds" value={context.selectedObservationIds.join(",")} />
      <HiddenInput name="jobId" value={context.jobId ?? ""} />
      <HiddenInput name="promotionPreviewId" value={context.promotionPreviewId ?? ""} />
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
    <WorkbenchStack gap="sm">
      <WorkbenchText tone="foreground" weight="semibold">
        {t("catalog.features.sourceObservations.ui.primaryWorkbench.validation.activationDecision.blockers")}
      </WorkbenchText>
      <ActivationBlockerBadges blockers={[...new Set([...decision.blockers, ...decision.saveEvidenceBlockers])]} />
    </WorkbenchStack>
  );
}

function ActivationBlockerBadges({ blockers }: { blockers: ActivationDecision["blockers"] }) {
  if (blockers.length === 0) {
    return null;
  }

  return (
    <StatusReasonList
      compact
      nextStepPrefix={t("catalog.features.sourceObservations.ui.primaryWorkbench.copy.next.prefix")}
      items={blockers.map((blocker) => {
        const copy = getCatalogPrimaryWorkbenchBlockerCopy(blocker);

        return {
          key: blocker,
          label: copy.label,
          reason: copy.reason,
          nextStep: copy.nextStep,
          tone: "danger",
        } as const;
      })}
    />
  );
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

function decisionTone(status: ActivationDecision["status"]): BadgeTone {
  if (status === "ready") return "success";
  if (status === "blocked") return "danger";
  return "warning";
}

function isDecisionActionAvailable(state: ActivationDecision["actionState"]): boolean {
  return state === "available" || state === "degraded";
}
