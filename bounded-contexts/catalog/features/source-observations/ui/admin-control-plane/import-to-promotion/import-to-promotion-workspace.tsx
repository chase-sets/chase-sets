import {
  Accordion,
  LinkButton,
  OperationalStatusBanner,
  ProgressiveDisclosure,
  WorkbenchStack,
  WorkbenchText,
} from "@chase-sets/design-system";
import { t } from "@chase-sets/localization";
import type { CatalogPrimaryWorkbenchReadModel } from "../../../api/primary-workbench-admin-contracts";
import { catalogPrimaryWorkbenchSupportingHref } from "../../primary-workbench-route-context";
import { CatalogIntegrationImportJobsModule } from "../import-jobs/import-jobs-module";
import { CatalogIntegrationSourceObservationReviewModule } from "../source-observation-review/source-observation-review-module";
import { CommandFormButton } from "./command-controls";
import { CatalogIntegrationCreateItemsStage } from "./create-items-stage";
import { buildFlowStages, CatalogIntegrationFlowStepper } from "./primary-steps-module";
import { useImportToPromotionWorkspace, type ImportToPromotionStageKey } from "./use-import-to-promotion-workspace";
import { WorkspaceBlockerPanel } from "./workbench-formatting";

// The daily import-to-promotion workspace, framed as an explicit three-stage
// linear flow: Run sync -> Review changes -> Create / update items. The stepper
// names the path; the accordion keeps only the active stage expanded while the
// others collapse to a summary. Jobs and command-plan detail render as supporting
// context inside their stage, and the promotion preview is folded into the inline
// confirmation of the create/update action (no separate stale-able preview step).
export function CatalogIntegrationImportToPromotionWorkspace({
  readModel,
}: Readonly<{
  readModel: CatalogPrimaryWorkbenchReadModel;
}>) {
  const {
    activeStage,
    setActiveStage,
    blockers,
    selectedObservationKeys,
    setSelectedObservationKeys,
    selectedEligibleObservationCount,
    selectedReviewableObservationCount,
  } = useImportToPromotionWorkspace(readModel);
  const stages = buildFlowStages(readModel, activeStage);

  const stageContent: Record<ImportToPromotionStageKey, React.ReactNode> = {
    "run-sync": (
      <WorkbenchStack>
        <WorkbenchText size="sm" tone="secondary">
          {t("catalog.features.sourceObservations.ui.primaryWorkbench.stage.runSync.description")}
        </WorkbenchText>
        <CommandFormButton readModel={readModel} intent="start-provider-import" leadingIcon="refreshCcw">
          {t("catalog.features.sourceObservations.ui.primaryWorkbench.pull.provider.data")}
        </CommandFormButton>
        <ProgressiveDisclosure
          title={t("catalog.features.sourceObservations.ui.primaryWorkbench.stage.supporting.jobs")}
          icon="inbox"
          defaultOpen
        >
          <CatalogIntegrationImportJobsModule readModel={readModel} />
        </ProgressiveDisclosure>
      </WorkbenchStack>
    ),
    "review-changes": (
      <CatalogIntegrationSourceObservationReviewModule
        readModel={readModel}
        selectedObservationKeys={selectedObservationKeys}
        onSelectedObservationKeysChange={setSelectedObservationKeys}
        selectedEligibleObservationCount={selectedEligibleObservationCount}
        selectedReviewableObservationCount={selectedReviewableObservationCount}
      />
    ),
    "create-items": <CatalogIntegrationCreateItemsStage readModel={readModel} />,
  };

  return (
    <WorkbenchStack>
      <OperationalStatusBanner
        tone={blockers.length > 0 ? "warning" : "success"}
        title={
          blockers.length > 0
            ? t("catalog.features.sourceObservations.ui.primaryWorkbench.banner.blocked.title")
            : t("catalog.features.sourceObservations.ui.primaryWorkbench.banner.ready.title")
        }
        description={
          blockers.length > 0
            ? t("catalog.features.sourceObservations.ui.primaryWorkbench.banner.blocked.description")
            : t("catalog.features.sourceObservations.ui.primaryWorkbench.banner.ready.description")
        }
        action={
          <LinkButton
            size="sm"
            tone="secondary"
            leadingIcon="externalLink"
            href={
              readModel.readiness.auditEvidenceUrl ??
              catalogPrimaryWorkbenchSupportingHref(readModel.routeContext, "audit-evidence")
            }
          >
            {t("catalog.features.sourceObservations.ui.primaryWorkbench.view.supporting.evidence")}
          </LinkButton>
        }
      />

      <CatalogIntegrationFlowStepper stages={stages} />

      <WorkspaceBlockerPanel blockers={blockers} resolveContext={readModel.routeContext} />

      <Accordion
        type="single"
        collapsible={false}
        value={activeStage}
        onValueChange={(value) => setActiveStage((value || activeStage) as ImportToPromotionStageKey)}
        items={stages.map((stage) => ({
          value: stage.key,
          trigger: (
            <WorkbenchStack gap="sm">
              <WorkbenchText tone="foreground" weight="semibold">
                {stage.label}
              </WorkbenchText>
              <WorkbenchText size="xs" tone="secondary">
                {stage.summary}
              </WorkbenchText>
            </WorkbenchStack>
          ),
          content: stageContent[stage.key],
        }))}
      />
    </WorkbenchStack>
  );
}
