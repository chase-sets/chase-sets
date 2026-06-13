import {
  Badge,
  LinkButton,
  MetricStrip,
  OperationalStatusBanner,
  WorkbenchStack,
  WorkflowModule,
} from "@chase-sets/design-system";
import { t } from "@chase-sets/localization";
import type { CatalogPrimaryWorkbenchReadModel } from "../../../api/primary-workbench-admin-contracts";
import { ActivationDecisionModule, ActivationReadinessSection } from "./activation-evidence-section";
import { DryRunSection } from "./dry-run-section";
import { FixtureSection } from "./fixture-section";
import { SemanticCompareSection } from "./semantic-checks-section";
import type { BadgeTone, ValidationReadiness } from "./validation-shared";
import { statusLabel } from "./validation-shared";

export function CatalogIntegrationValidationReadinessWorkspace({
  readModel,
}: Readonly<{
  readModel: CatalogPrimaryWorkbenchReadModel;
}>) {
  const validation = readModel.validationReadiness;

  return (
    <WorkbenchStack element="section" data-catalog-validation-readiness-workspace="true">
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
        <WorkbenchStack>
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
        </WorkbenchStack>
      </WorkflowModule>

      <FixtureSection validation={validation} />
      <DryRunSection validation={validation} />
      <SemanticCompareSection validation={validation} />
      <ActivationReadinessSection validation={validation} />
      <ActivationDecisionModule readModel={readModel} />
    </WorkbenchStack>
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
