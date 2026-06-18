import { Accordion, ProgressiveDisclosure, WorkbenchStack, WorkbenchText } from "@chase-sets/design-system";
import { t } from "@chase-sets/localization";
import type { CatalogPrimaryWorkbenchReadModel } from "../../../api/primary-workbench-admin-contracts";
import { CatalogIntegrationImportJobsModule } from "../import-jobs/import-jobs-module";
import { CatalogIntegrationSourceObservationReviewModule } from "../source-observation-review/source-observation-review-module";
import { CommandFormButton } from "./command-controls";
import { CatalogIntegrationCreateItemsStage } from "./create-items-stage";
import { buildFlowStages, CatalogIntegrationFlowStepper } from "./primary-steps-module";
import { useImportToPromotionWorkspace, type ImportToPromotionStageKey } from "./use-import-to-promotion-workspace";
import {
  DailyGovernanceStatusIndicator,
  DailyHealthStatusIndicator,
  WorkspaceBlockerPanel,
} from "./workbench-formatting";

// The daily import-to-promotion workspace, framed as an explicit three-stage
// linear flow: Run sync -> Review changes -> Create / update items. The stepper
// names the path; the accordion keeps only the active stage expanded while the
// others collapse to a summary. Jobs and command-plan detail render as supporting
// context inside their stage, and the promotion preview is folded into the inline
// confirmation of the create/update action (no separate stale-able preview step).
export function CatalogIntegrationImportToPromotionWorkspace({
  readModel,
  aliasVisibility = null,
}: Readonly<{
  readModel: CatalogPrimaryWorkbenchReadModel;
  // Optional alias-review visibility slot (#1908): the composition root supplies
  // the alias-review workspace so operators see proposed alias equivalents while
  // reviewing Source Observations before promotion. The workspace stays agnostic
  // of the alias read model by accepting it as a rendered node.
  aliasVisibility?: React.ReactNode;
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
        aliasVisibility={aliasVisibility}
      />
    ),
    "create-items": <CatalogIntegrationCreateItemsStage readModel={readModel} />,
  };

  return (
    <WorkbenchStack>
      {/* Governance (denied/stopped) and health (degraded/blocked) are genuinely
          distinct signals — each fires only on its specific signal and renders
          nothing in the common case — so they stay as scoped indicators. The
          generic "ready / blocked" status banner was removed: the stepper carries
          per-stage blocked status (structural) and WorkspaceBlockerPanel is the one
          authoritative "is the path blocked and why" region, so a third generic
          restatement only added noise. */}
      <DailyGovernanceStatusIndicator readModel={readModel} />

      <DailyHealthStatusIndicator readModel={readModel} />

      <CatalogIntegrationFlowStepper stages={stages} />

      <WorkspaceBlockerPanel blockers={blockers} resolveContext={readModel.routeContext} />

      <Accordion
        type="single"
        collapsible={false}
        value={activeStage}
        // An explicit stage click is the operator's override: it wins over server
        // truth until the next command moves the work (see useReconciledActiveStage).
        // A single-collapsible accordion only ever emits a real stage value, so the
        // `|| activeStage` guards the (unreachable) empty-collapse case.
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
