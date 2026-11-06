import { Suspense, useMemo, useState, type ReactElement } from "react";
import { Await } from "react-router";
import { OperationalStatusBanner, ProgressiveDisclosure } from "@chase-sets/design-system";
import { t } from "@chase-sets/localization";
import type { CatalogControlPlaneRouteSurfaceKey } from "./admin-control-plane/information-architecture";
import type { CatalogPrimaryWorkbenchReadModel } from "../api/primary-workbench-admin-contracts";
import type {
  CatalogScopeSyncUnitStateReadModel,
  CatalogSyncRun,
  SourceObservationIntegrationImportPreview,
  CatalogIntegrationsCommandResult,
} from "./contracts";
import type { CatalogAliasReviewReadModel } from "../../alias-equivalence/api/alias-review-admin-contracts";
import type { CatalogDeferredAttentionQueueResult } from "../../attention-queue/api/contracts";
import { CatalogAttentionQueuePanel } from "../../attention-queue/ui/attention-queue-panel";
import type { CatalogPrimaryWorkbenchCommandFeedback } from "./primary-workbench-command-feedback";
import { CatalogIntegrationsSurfacePage } from "./integrations-surface-page";
import { CatalogIntegrationAliasReviewWorkspace } from "./admin-control-plane/alias-review/alias-review-workspace";
import { DeferredSupplementaryPanel } from "./deferred-supplementary-panel";
import { catalogPrimaryWorkbenchHref } from "./primary-workbench-route-context";
import {
  projectPromotionReceipt,
  promotionReceiptHasCompleteCoverage,
  promotionReceiptMatchesContext,
  promotionValidationFor,
} from "./primary-workbench-source-observation-review";

// The data every integrations surface loader returns. The server owns read-model
// composition; keeping the raw backing inputs out of the browser prevents large
// integration snapshots from being serialized twice and freezing hydration.
export type CatalogIntegrationsRouteData = Readonly<{
  readModel: CatalogPrimaryWorkbenchReadModel;
  commandFeedback?: CatalogPrimaryWorkbenchCommandFeedback | null;
  requestUrl: string;
  // Streamed supplementary values. The daily surface loader returns these
  // as promises so the shell, metric strip, and 3-stage flow paint before the
  // ~150–250 KB source-option fan-out and the supplementary alias-review resolve;
  // the other surfaces leave them absent. The server builds the full
  // `sourceOptions` slice inside the promise (not the raw pages), so the populated
  // value the status panel consumes is ready-to-render and the large provider
  // option snapshots never reach the browser payload. Each promise resolves
  // null/empty on absence/error, so the streamed boundary stays fail-soft.
  deferredSourceOptions?: Promise<CatalogPrimaryWorkbenchReadModel["sourceOptions"]> | null;
  deferredImportPreview?: Promise<SourceObservationIntegrationImportPreview | null> | null;
  deferredCatalogSyncRun?: Promise<CatalogSyncRun | null> | null;
  deferredScopeSyncState?: Promise<readonly CatalogScopeSyncUnitStateReadModel[] | null> | null;
  deferredAliasReview?: Promise<CatalogAliasReviewReadModel | null> | null;
  // The unified attention queue. Streamed like the alias review; the
  // daily surface renders it in the top-of-page slot. Absent on the other
  // surfaces. Unlike the nullable slices above it resolves to a closed
  // `ready | unavailable` result, so a queue that could not be read renders an
  // honest warning instead of disappearing.
  deferredAttentionQueue?: Promise<CatalogDeferredAttentionQueueResult> | null;
}>;

// Shared thin view for the four integrations surface routes. The route loaders
// already slice the read model per audience surface, so this component only
// composes the page chrome around the server-produced model.
export function CatalogIntegrationsSurfaceRouteView({
  surface,
  routeData,
  commandFeedback,
  commandResult = null,
  actionPending = false,
}: Readonly<{
  surface: CatalogControlPlaneRouteSurfaceKey;
  routeData: CatalogIntegrationsRouteData;
  // Optional command-feedback override. The daily surface stays put after a
  // run-sync / promote command and supplies the action result here so the banner
  // renders in place; the other surfaces leave it undefined and read the feedback
  // their loader parsed from the post-command redirect query.
  commandFeedback?: CatalogPrimaryWorkbenchCommandFeedback | null;
  commandResult?: CatalogIntegrationsCommandResult | null;
  actionPending?: boolean;
}>) {
  const readModel = useOriginalPromotionReceipt(routeData, surface === "daily" ? commandResult : null, actionPending);
  // The alias-review workspace POSTs its accept/reject/revoke forms to the daily
  // integrations route action (the composition root supplies this href), which
  // dispatches the aggregate commands. Only the daily loader streams the
  // alias read model, so the slot renders behind a Suspense boundary that shows a
  // skeleton while the supplementary load streams in and resolves to nothing when
  // the (fail-soft) promise yields null.
  const aliasVisibility = routeData.deferredAliasReview ? (
    <DeferredAliasReviewSlot deferredAliasReview={routeData.deferredAliasReview} readModel={routeData.readModel} />
  ) : null;

  const attentionQueue = routeData.deferredAttentionQueue ? (
    <DeferredAttentionQueueSlot deferredAttentionQueue={routeData.deferredAttentionQueue} readModel={readModel} />
  ) : null;

  return (
    <CatalogIntegrationsSurfacePage
      surface={surface}
      readModel={readModel}
      commandFeedback={commandFeedback ?? routeData.commandFeedback}
      aliasVisibility={aliasVisibility}
      attentionQueue={attentionQueue}
      deferredSourceOptions={routeData.deferredSourceOptions ?? null}
      deferredImportPreview={routeData.deferredImportPreview ?? null}
      deferredCatalogSyncRun={routeData.deferredCatalogSyncRun ?? null}
      deferredScopeSyncState={routeData.deferredScopeSyncState ?? null}
    />
  );
}

export function useOriginalPromotionReceipt(
  routeData: CatalogIntegrationsRouteData,
  result: CatalogIntegrationsCommandResult | null,
  pending: boolean,
): CatalogPrimaryWorkbenchReadModel {
  const model = routeData.readModel;
  const evidence = JSON.stringify([
    model.routeContext,
    model.sourceObservationReview,
    model.promotionPreview.validation,
    model.promotionPreview.currentFingerprint,
  ]);
  const [binding, setBinding] = useState({
    result,
    requestUrl: routeData.requestUrl,
    evidence,
    submittedEvidence: null as string | null,
    stale: false,
    settled: !pending,
  });
  let current = binding;
  if (binding.result !== result) {
    const submittedEvidence = binding.settled ? null : binding.submittedEvidence;
    current = {
      result,
      requestUrl: routeData.requestUrl,
      evidence,
      submittedEvidence,
      stale: submittedEvidence !== null && submittedEvidence !== evidence,
      settled: !pending,
    };
    setBinding(current);
  } else if (pending && binding.settled) {
    current = { ...binding, submittedEvidence: evidence, settled: false, stale: true };
    setBinding(current);
  } else if (
    !binding.stale &&
    (binding.requestUrl !== routeData.requestUrl || (binding.settled && binding.evidence !== evidence))
  ) {
    current = { ...binding, stale: true };
    setBinding(current);
  } else if (!binding.settled && !pending) {
    current = {
      ...binding,
      settled: true,
      evidence,
      stale: binding.stale || (binding.submittedEvidence !== null && binding.submittedEvidence !== evidence),
    };
    setBinding(current);
  }
  const original =
    result?.feedback.status === "success" && result.feedback.result === "preview-ready"
      ? result.promotionReceipt
      : null;
  const receipt = useMemo(() => (original ? projectPromotionReceipt(original) : null), [original]);
  if (!receipt || !result) {
    return model;
  }
  const sameIds =
    JSON.stringify([...receipt.selection.observationIds].sort()) ===
    JSON.stringify([...result.context.selectedObservationIds].sort());
  const sameContext = promotionReceiptMatchesContext(receipt, model.routeContext);
  const currentFingerprint = model.promotionPreview.currentFingerprint;
  const valid =
    !pending &&
    !current.stale &&
    sameIds &&
    receipt.previewId === result.context.promotionPreviewId &&
    receipt.selection.promoteAsDraft === (result.context.promoteAsDraft === true) &&
    promotionReceiptMatchesContext(receipt, result.context) &&
    sameContext &&
    (!model.promotionPreview.previewId || model.promotionPreview.previewId === receipt.previewId) &&
    (!currentFingerprint || currentFingerprint === receipt.preview.fingerprint) &&
    promotionReceiptHasCompleteCoverage(receipt) &&
    model.readiness.rbacAllowed &&
    model.sourceObservationReview.freshness === "fresh" &&
    model.promotionPreview.blockers.length === 0;
  return {
    ...model,
    // The token belongs to the POST only. Generated links never serialize it.
    routeContext: { ...(sameContext ? result.context : model.routeContext), promotionPreviewId: null },
    promotionPreview: {
      ...model.promotionPreview,
      previewId: receipt.previewId,
      receipt,
      validation: promotionValidationFor(result.context, receipt.preview.validation),
      freshness: pending ? "unavailable" : valid ? "fresh" : "stale",
      scope: {
        ...model.promotionPreview.scope,
        kind: receipt.selection.observationIds.length > 0 ? "explicit-rows" : "matching-filter",
        selectedObservationIds: receipt.selection.observationIds,
      },
      executionSafeguards: {
        ...model.promotionPreview.executionSafeguards,
        previewFresh: valid,
        stalePreviewRejected: !valid,
      },
    },
  };
}

// Stream the supplementary alias-review workspace behind a Suspense/Await
// boundary. The promise is fail-soft (null on absence/error), so a resolved null
// renders nothing — never an error page — and the skeleton paints while the
// supplementary alias read model streams in after the primary review queue.
function DeferredAliasReviewSlot({
  deferredAliasReview,
  readModel,
}: Readonly<{
  deferredAliasReview: Promise<CatalogAliasReviewReadModel | null>;
  readModel: CatalogPrimaryWorkbenchReadModel;
}>): ReactElement {
  return (
    <Suspense
      fallback={
        <DeferredSupplementaryPanel
          title={t("catalog.features.sourceObservations.ui.aliasReview.title")}
          label={t("catalog.features.sourceObservations.ui.primaryWorkbench.deferred.aliasReview.loading")}
        />
      }
    >
      <Await
        resolve={deferredAliasReview}
        errorElement={
          <OperationalStatusBanner
            tone="warning"
            role="status"
            data-catalog-deferred-panel="unavailable"
            title={t("catalog.features.sourceObservations.ui.aliasReview.title")}
            description={t("catalog.features.sourceObservations.ui.primaryWorkbench.copy.label.unavailable")}
          />
        }
      >
        {(aliasReview) =>
          aliasReview ? (
            // Language-edition equivalence review lives on Scope Detail, scoped
            // to one scope. The generic all-scopes alias table stays reachable
            // from the daily path but no longer streams open by default — an
            // operator opens it explicitly when they want the cross-scope view.
            <ProgressiveDisclosure
              title={t("catalog.features.sourceObservations.ui.aliasReview.allScopes.title")}
              description={t("catalog.features.sourceObservations.ui.aliasReview.allScopes.description")}
              summary={t("catalog.features.sourceObservations.ui.aliasReview.allScopes.summary", {
                count: aliasReview.counts.needsReview,
              })}
              defaultOpen={false}
              tone={aliasReview.counts.needsReview > 0 ? "warning" : "neutral"}
            >
              <CatalogIntegrationAliasReviewWorkspace
                readModel={aliasReview}
                actionHref={catalogPrimaryWorkbenchHref(readModel.routeContext, "import-to-promotion")}
                canManageAliases={readModel.readiness.rbacAllowed}
              />
            </ProgressiveDisclosure>
          ) : null
        }
      </Await>
    </Suspense>
  );
}

// Stream the attention queue behind a fail-soft Suspense/Await boundary so the
// top-of-page inbox paints once the (supplementary) queue read model resolves.
// A `ready` result renders the queue (its own empty state is the only "nothing
// needs you"); an `unavailable` result renders one localized warning in the same
// slot, following the Seller Desk precedent of warning about an unreadable
// attention source without blanking the usable workflow beneath it. Recovery is
// a page reload — this slice adds no in-place retry.
function DeferredAttentionQueueSlot({
  deferredAttentionQueue,
  readModel,
}: Readonly<{
  deferredAttentionQueue: Promise<CatalogDeferredAttentionQueueResult>;
  readModel: CatalogPrimaryWorkbenchReadModel;
}>): ReactElement {
  return (
    <Suspense
      fallback={
        <DeferredSupplementaryPanel
          title={t("catalog.features.attentionQueue.title")}
          label={t("catalog.features.attentionQueue.loading")}
        />
      }
    >
      <Await
        resolve={deferredAttentionQueue}
        errorElement={
          <OperationalStatusBanner
            tone="warning"
            role="status"
            data-catalog-attention-queue="unavailable"
            title={t("catalog.features.attentionQueue.unavailable.title")}
            description={t("catalog.features.attentionQueue.unavailable.description")}
          />
        }
      >
        {(attentionQueue) =>
          attentionQueue.status === "ready" ? (
            <CatalogAttentionQueuePanel
              readModel={attentionQueue.readModel}
              actionHref={catalogPrimaryWorkbenchHref(readModel.routeContext, "import-to-promotion")}
              canManage={readModel.readiness.rbacAllowed}
            />
          ) : (
            <OperationalStatusBanner
              tone="warning"
              role="status"
              data-catalog-attention-queue="unavailable"
              title={t("catalog.features.attentionQueue.unavailable.title")}
              description={t("catalog.features.attentionQueue.unavailable.description")}
            />
          )
        }
      </Await>
    </Suspense>
  );
}
