import { useEffect, useMemo, useState } from "react";
import type { CatalogPrimaryWorkbenchReadModel } from "../../../api/primary-workbench-admin-contracts";
import { isReviewableObservationRow } from "../source-observation-review/source-observation-review-module";

type SourceObservationReviewRow = CatalogPrimaryWorkbenchReadModel["sourceObservationReview"]["rows"][number];

const OBSERVATION_KEY_SEPARATOR = String.fromCharCode(0x1f);

// The three ordered stages of the daily flow. Only one stage is expanded at a
// time; the rest render a collapsed summary. Stage selection is the single piece
// of view state besides observation selection (the old split step-selection state
// is removed).
export type ImportToPromotionStageKey = "run-sync" | "review-changes" | "create-items";

export type ImportToPromotionWorkspaceState = Readonly<{
  activeStage: ImportToPromotionStageKey;
  setActiveStage: (stage: ImportToPromotionStageKey) => void;
  blockers: readonly CatalogPrimaryWorkbenchReadModel["readiness"]["blockers"][number][];
  selectedObservationKeys: Set<string>;
  setSelectedObservationKeys: React.Dispatch<React.SetStateAction<Set<string>>>;
  selectedEligibleObservationCount: number;
  selectedReviewableObservationCount: number;
}>;

// Pick the stage the operator should land on: the first stage that still has work
// or a blocker, so "where do I run a sync / create items?" is answerable at a
// glance without hunting through collapsed sections.
function defaultActiveStage(readModel: CatalogPrimaryWorkbenchReadModel): ImportToPromotionStageKey {
  if (readModel.promotionResult || readModel.promotionPreview.previewId) {
    return "create-items";
  }
  // Anything to review (rows in scope, ready candidates, or changed evidence)
  // lands on the review stage so the changes are in front.
  if (
    readModel.sourceObservationReview.rows.length > 0 ||
    readModel.sourceObservationReview.promotionReadyCount > 0 ||
    readModel.sourceObservationReview.counts.changed > 0
  ) {
    return "review-changes";
  }
  // Otherwise there is nothing to review yet: keep Run sync expanded so the
  // operator can pull provider data and watch the durable import.
  return "run-sync";
}

export function useImportToPromotionWorkspace(
  readModel: CatalogPrimaryWorkbenchReadModel,
): ImportToPromotionWorkspaceState {
  const initialStage = useMemo(() => defaultActiveStage(readModel), [readModel]);
  const [activeStage, setActiveStage] = useState<ImportToPromotionStageKey>(initialStage);

  // One normalized blocker set for the whole flow: deduplicate readiness and
  // promotion-command blockers so the consolidated affordance renders each once.
  const blockers = useMemo(
    () => [...new Set([...readModel.readiness.blockers, ...readModel.promotionPreview.blockers])],
    [readModel.readiness.blockers, readModel.promotionPreview.blockers],
  );

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
    activeStage,
    setActiveStage,
    blockers,
    selectedObservationKeys,
    setSelectedObservationKeys,
    selectedEligibleObservationCount,
    selectedReviewableObservationCount,
  };
}
