import { useEffect, useMemo, useState } from "react";
import type { CatalogPrimaryWorkbenchReadModel } from "../../../api/primary-workbench-admin-contracts";
import { buildSteps, type PrimaryWorkbenchStep } from "./primary-steps-module";
import { isReviewableObservationRow } from "../source-observation-review/source-observation-review-module";

type SourceObservationReviewRow = CatalogPrimaryWorkbenchReadModel["sourceObservationReview"]["rows"][number];

const OBSERVATION_KEY_SEPARATOR = String.fromCharCode(0x1f);

export type ImportToPromotionWorkspaceState = Readonly<{
  steps: readonly PrimaryWorkbenchStep[];
  selectableStepKeys: Set<string>;
  selectedKeys: Set<string>;
  setSelectedKeys: React.Dispatch<React.SetStateAction<Set<string>>>;
  selectedCount: number;
  selectedObservationKeys: Set<string>;
  setSelectedObservationKeys: React.Dispatch<React.SetStateAction<Set<string>>>;
  selectedEligibleObservationCount: number;
  selectedReviewableObservationCount: number;
}>;

export function useImportToPromotionWorkspace(
  readModel: CatalogPrimaryWorkbenchReadModel,
): ImportToPromotionWorkspaceState {
  const steps = useMemo(() => [...buildSteps(readModel)], [readModel]);
  const selectableStepKeys = useMemo(
    () =>
      new Set<string>(
        steps.filter((step) => step.state === "available" || step.state === "degraded").map((step) => step.key),
      ),
    [steps],
  );
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(() => new Set(["review", "preview"]));
  const selectedCount = [...selectedKeys].filter((key) => selectableStepKeys.has(key)).length;
  const [selectedObservationKeys, setSelectedObservationKeys] = useState<Set<string>>(
    () => new Set(readModel.sourceObservationReview.selectedObservationIds),
  );
  const selectedObservationRouteKey =
    readModel.sourceObservationReview.selectedObservationIds.join(OBSERVATION_KEY_SEPARATOR);
  useEffect(() => {
    setSelectedObservationKeys(
      new Set(
        selectedObservationRouteKey.length > 0 ? selectedObservationRouteKey.split(OBSERVATION_KEY_SEPARATOR) : [],
      ),
    );
  }, [selectedObservationRouteKey]);
  const selectedObservationRows = readModel.sourceObservationReview.rows.filter((row: SourceObservationReviewRow) =>
    selectedObservationKeys.has(row.observationId),
  );
  const selectedEligibleObservationCount = selectedObservationRows.filter(
    (row) => row.promotionReadiness.state === "eligible",
  ).length;
  const selectedReviewableObservationCount = selectedObservationRows.filter(isReviewableObservationRow).length;

  return {
    steps,
    selectableStepKeys,
    selectedKeys,
    setSelectedKeys,
    selectedCount,
    selectedObservationKeys,
    setSelectedObservationKeys,
    selectedEligibleObservationCount,
    selectedReviewableObservationCount,
  };
}
