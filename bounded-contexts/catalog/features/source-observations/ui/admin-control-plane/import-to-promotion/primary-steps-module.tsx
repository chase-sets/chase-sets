import { useMemo } from "react";
import { PageStepper, type PageStepperItem } from "@chase-sets/design-system";
import { t } from "@chase-sets/localization";
import type { CatalogPrimaryWorkbenchReadModel } from "../../../api/primary-workbench-admin-contracts";
import { catalogPrimaryWorkbenchFlowStageState } from "../../primary-workbench-daily-flow";
import type { ImportToPromotionStageKey } from "./use-import-to-promotion-workspace";

export type PrimaryWorkbenchStageDescriptor = Readonly<{
  key: ImportToPromotionStageKey;
  label: string;
  description: string;
  summary: string;
  status: PageStepperItem["status"];
}>;

// The three ordered stages with their copy, and each stage's status from the
// read model's flow with `activeStage` open (the read model's open stage unless
// the operator opened another).
export function buildFlowStages(
  readModel: CatalogPrimaryWorkbenchReadModel,
  activeStage: ImportToPromotionStageKey,
): readonly PrimaryWorkbenchStageDescriptor[] {
  const review = readModel.sourceObservationReview;
  const createDone = Boolean(readModel.promotionResult);

  const descriptors: Record<ImportToPromotionStageKey, Omit<PrimaryWorkbenchStageDescriptor, "status">> = {
    "run-sync": {
      key: "run-sync",
      label: t("catalog.features.sourceObservations.ui.primaryWorkbench.stage.runSync.label"),
      description: t("catalog.features.sourceObservations.ui.primaryWorkbench.stage.runSync.description"),
      summary: t("catalog.features.sourceObservations.ui.primaryWorkbench.stage.runSync.summary", {
        active: readModel.importJobs.activeJobCount,
        observed: review.counts.observed,
        changed: review.counts.changed,
      }),
    },
    "review-changes": {
      key: "review-changes",
      label: t("catalog.features.sourceObservations.ui.primaryWorkbench.stage.review.label"),
      description: t("catalog.features.sourceObservations.ui.primaryWorkbench.stage.review.description"),
      summary: t("catalog.features.sourceObservations.ui.primaryWorkbench.stage.review.summary", {
        changed: review.counts.changed,
        ready: review.promotionReadyCount,
      }),
    },
    "create-items": {
      key: "create-items",
      label: t("catalog.features.sourceObservations.ui.primaryWorkbench.stage.create.label"),
      description: t("catalog.features.sourceObservations.ui.primaryWorkbench.stage.create.description"),
      summary: createDone
        ? t("catalog.features.sourceObservations.ui.primaryWorkbench.stage.create.summary", {
            count: readModel.promotionResult?.promotedCatalogItemIds.length ?? 0,
          })
        : t("catalog.features.sourceObservations.ui.primaryWorkbench.stage.create.summary.pending"),
    },
  };

  return readModel.flow.stages.map((stage) => ({
    ...descriptors[stage.key],
    status:
      activeStage === readModel.flow.openStage
        ? stage.state
        : catalogPrimaryWorkbenchFlowStageState(stage, activeStage),
  }));
}

// The ordered three-stage stepper. Renders the flow as an explicit, linear
// "Run sync -> Review changes -> Create / update items" path so an operator can
// answer "where do I run a sync / create items?" at a glance.
export function CatalogIntegrationFlowStepper({
  stages,
}: Readonly<{
  stages: readonly PrimaryWorkbenchStageDescriptor[];
}>) {
  const items = useMemo<PageStepperItem[]>(
    () =>
      stages.map((stage) => ({
        label: stage.label,
        description: stage.description,
        status: stage.status,
      })),
    [stages],
  );

  return <PageStepper items={items} orientation="responsive" />;
}
