import { useCallback, useEffect, useMemo, useState } from "react";
import type { CatalogPrimaryWorkbenchReadModel } from "../../../api/primary-workbench-admin-contracts";
import { isReviewableObservationRow } from "../source-observation-review/source-observation-review-module";
import {
  observationSelectionScopeKey,
  readPersistedObservationSelection,
  writePersistedObservationSelection,
} from "../../primary-workbench-selection-store";

type SourceObservationReviewRow = CatalogPrimaryWorkbenchReadModel["sourceObservationReview"]["rows"][number];

// Unit separator: joins the selected observation ids into one comparable key so a
// URL-driven selection change is detected by value, not by array identity.
const OBSERVATION_KEY_SEPARATOR = String.fromCharCode(0x1f);

// The three ordered stages of the daily flow. Only one stage is expanded at a
// time; the rest render a collapsed summary. Stage selection is the single piece
// of view state besides observation selection.
export type ImportToPromotionStageKey = "run-sync" | "review-changes" | "create-items";

export type ImportToPromotionWorkspaceState = Readonly<{
  activeStage: ImportToPromotionStageKey;
  setActiveStage: (stage: ImportToPromotionStageKey) => void;
  blockers: readonly CatalogPrimaryWorkbenchReadModel["readiness"]["blockers"][number][];
  selectedObservationKeys: Set<string>;
  setSelectedObservationKeys: (keys: Set<string>) => void;
  selectedEligibleObservationCount: number;
  selectedReviewableObservationCount: number;
}>;

// The stage the read model implies right now: the first stage that still has work
// or a blocker, so "where do I run a sync / create items?" is answerable at a
// glance without hunting through collapsed sections. This is SERVER TRUTH — it is
// recomputed from the latest read model on every render, so an in-place command
// revalidation (a returned-data command, a live poll, or a fetcher
// submit) re-derives it and moves the stepper to where work actually moved.
function serverDerivedActiveStage(readModel: CatalogPrimaryWorkbenchReadModel): ImportToPromotionStageKey {
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

function routeTargetStage(readModel: CatalogPrimaryWorkbenchReadModel): ImportToPromotionStageKey | null {
  switch (readModel.routeContext.section) {
    case "import-jobs":
    case "provider-scope-selection":
    case "readiness":
      return "run-sync";
    case "source-observation-review":
    case "conflict-resolution":
      return "review-changes";
    case "promotion-preview":
    case "promotion-result":
      return "create-items";
    default:
      return null;
  }
}

export function useImportToPromotionWorkspace(
  readModel: CatalogPrimaryWorkbenchReadModel,
): ImportToPromotionWorkspaceState {
  const { activeStage, setActiveStage } = useReconciledActiveStage(readModel);
  const { selectedObservationKeys, setSelectedObservationKeys } = useDurableObservationSelection(readModel);

  // One normalized blocker set for the whole flow: deduplicate readiness and
  // promotion-command blockers so the consolidated affordance renders each once.
  const blockers = useMemo(
    () => [...new Set([...readModel.readiness.blockers, ...readModel.promotionPreview.blockers])],
    [readModel.readiness.blockers, readModel.promotionPreview.blockers],
  );

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

// Reconcile the open stage with server truth and route-section handoffs while
// letting an explicit operator stage click win until the next command.
//
// The stage is a recomputed derivation rather than a frozen `useState(useMemo(...))`
// initial value (freezing it would ignore every recomputed default after mount).
// Instead the server-derived stage is recomputed each render and a thin, ephemeral
// manual override is layered on top:
//   - The override is remembered alongside the server stage that was in effect
//     when the operator clicked. While the server stage is unchanged (a poll
//     or fetcher submit refreshes the read model but does not move where work
//     is), the override holds — so an explicit click survives an in-place
//     revalidation.
//   - When the server stage CHANGES (a command — preview/promote/defer/reject —
//     moved the work), the override is stale by definition, so it is dropped and
//     the stepper follows server truth to the new stage.
// Comparing the server stage against the value captured at click time during
// render (not in an effect) keeps `activeStage` a pure derivation with no extra
// commit, so the stepper never flickers through an intermediate stage.
function useReconciledActiveStage(readModel: CatalogPrimaryWorkbenchReadModel): {
  activeStage: ImportToPromotionStageKey;
  setActiveStage: (stage: ImportToPromotionStageKey) => void;
} {
  const derivedStage = routeTargetStage(readModel) ?? serverDerivedActiveStage(readModel);
  // The operator's explicit choice and the derived stage that was in effect when
  // they made it. A null override means "follow server truth".
  const [override, setOverride] = useState<{
    stage: ImportToPromotionStageKey;
    derivedStageAtSelection: ImportToPromotionStageKey;
  } | null>(null);

  // A command or routable handoff moved the work: the override predates it, so
  // discard it and let the derived stage win. Reconciled during render so the
  // very next paint already shows the derived stage — no transitional render on
  // the stale override.
  const overrideIsStale = override !== null && override.derivedStageAtSelection !== derivedStage;
  if (overrideIsStale) {
    setOverride(null);
  }

  const activeStage = overrideIsStale || override === null ? derivedStage : override.stage;

  const setActiveStage = useCallback(
    (stage: ImportToPromotionStageKey) => {
      // Capture the derived stage in effect at click time so the override is
      // invalidated the moment a later command or route handoff changes it.
      setOverride({
        stage,
        derivedStageAtSelection: routeTargetStage(readModel) ?? serverDerivedActiveStage(readModel),
      });
    },
    [readModel],
  );

  return { activeStage, setActiveStage };
}

// Collapse observation selection to ONE durable source of truth: a
// sessionStorage-backed working set keyed by the current review scope
// (provider/unit/import-scope/profile) — see `primary-workbench-selection-store.ts`.
// This is "durable page state, not a URL detour" per the Catalog Control Plane v2
// blueprint: selection survives a reload or in-tab navigation for its scope
// without ever touching the query string, so a 500-row bulk selection never
// inflates the URL. A deep link that DOES carry `selectedObservationIds` (an
// explicit share link, or a redirect from a just-completed command) still seeds
// the initial selection and is immediately folded into the durable working set;
// after that, the URL is no longer the source of truth.
function useDurableObservationSelection(readModel: CatalogPrimaryWorkbenchReadModel): {
  selectedObservationKeys: Set<string>;
  setSelectedObservationKeys: (keys: Set<string>) => void;
} {
  const scopeKey = observationSelectionScopeKey({
    providerKey: readModel.routeContext.providerKey,
    unitKey: readModel.routeContext.unitKey,
    importScope: readModel.routeContext.importScope,
    profileVersion: readModel.routeContext.profileVersion,
  });
  const urlSelectionKey = readModel.routeContext.selectedObservationIds.join(OBSERVATION_KEY_SEPARATOR);

  const [selectedObservationKeys, setSelectedObservationKeys] = useState<Set<string>>(() => {
    if (readModel.routeContext.selectedObservationIds.length > 0) {
      return new Set(readModel.routeContext.selectedObservationIds);
    }
    return new Set(readPersistedObservationSelection(scopeKey));
  });

  // Reconcile on scope change or an explicit URL-carried selection (a deep link
  // or a just-completed command's redirect): a non-empty URL selection wins and
  // is folded into durable storage; otherwise fall back to whatever this scope's
  // durable working set already holds (a reload with no selection in the URL).
  useEffect(() => {
    if (urlSelectionKey.length > 0) {
      const keys = urlSelectionKey.split(OBSERVATION_KEY_SEPARATOR);
      setSelectedObservationKeys(new Set(keys));
      writePersistedObservationSelection(scopeKey, keys);
      return;
    }
    setSelectedObservationKeys(new Set(readPersistedObservationSelection(scopeKey)));
  }, [urlSelectionKey, scopeKey]);

  const persistSelection = useCallback(
    (keys: Set<string>) => {
      // Instant, purely client-side: no navigation, no query-string write, so
      // selecting rows never grows the URL regardless of selection size.
      setSelectedObservationKeys(keys);
      writePersistedObservationSelection(scopeKey, [...keys]);
    },
    [scopeKey],
  );

  return { selectedObservationKeys, setSelectedObservationKeys: persistSelection };
}
