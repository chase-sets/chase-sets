import { useMemo } from "react";
import { PageStepper, type PageStepperItem } from "@chase-sets/design-system";
import { t } from "@chase-sets/localization";
import type { CatalogPrimaryWorkbenchReadModel } from "../../../api/primary-workbench-admin-contracts";
import type { ImportToPromotionStageKey } from "./use-import-to-promotion-workspace";

export type PrimaryWorkbenchStageDescriptor = Readonly<{
  key: ImportToPromotionStageKey;
  label: string;
  description: string;
  summary: string;
  status: PageStepperItem["status"];
}>;

// Derive the three ordered stages and each stage's status (complete / current /
// upcoming / blocked) from the read model. The active stage is "current"; stages
// behind it are "complete"; stages with blockers surface as "blocked".
export function buildFlowStages(
  readModel: CatalogPrimaryWorkbenchReadModel,
  activeStage: ImportToPromotionStageKey,
): readonly PrimaryWorkbenchStageDescriptor[] {
  const review = readModel.sourceObservationReview;
  const runSyncBlocked = readModel.readiness.blockers.length > 0;
  const createBlocked = readModel.promotionPreview.blockers.length > 0;
  const syncDone = readModel.importJobs.jobs.length > 0 || review.counts.changed > 0;
  const createDone = Boolean(readModel.promotionResult);

  const order: ImportToPromotionStageKey[] = ["run-sync", "review-changes", "create-items"];
  const activeIndex = order.indexOf(activeStage);

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

  const blockedByStage: Record<ImportToPromotionStageKey, boolean> = {
    "run-sync": runSyncBlocked,
    "review-changes": false,
    "create-items": createBlocked,
  };
  const doneByStage: Record<ImportToPromotionStageKey, boolean> = {
    "run-sync": syncDone,
    "review-changes": review.promotionReadyCount === 0 && (createDone || syncDone),
    "create-items": createDone,
  };

  return order.map((key, index) => {
    const status: PageStepperItem["status"] = blockedByStage[key]
      ? "blocked"
      : index === activeIndex
        ? "current"
        : index < activeIndex || doneByStage[key]
          ? "complete"
          : "upcoming";

    return { ...descriptors[key], status };
  });
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
