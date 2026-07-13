import { Suspense, type ReactElement } from "react";
import { Await } from "react-router";
import { ProgressiveDisclosure } from "@chase-sets/design-system";
import { t } from "@chase-sets/localization";
import type { CatalogControlPlaneRouteSurfaceKey } from "./admin-control-plane/information-architecture";
import type { CatalogPrimaryWorkbenchReadModel } from "../api/primary-workbench-admin-contracts";
import type {
  CatalogScopeSyncUnitStateReadModel,
  CatalogSyncRun,
  SourceObservationIntegrationImportPreview,
} from "./contracts";
import type { CatalogAliasReviewReadModel } from "../../alias-equivalence/api/alias-review-admin-contracts";
import type { CatalogAttentionQueueReadModel } from "../../attention-queue/api/contracts";
import { CatalogAttentionQueuePanel } from "../../attention-queue/ui/attention-queue-panel";
import type { CatalogPrimaryWorkbenchCommandFeedback } from "./primary-workbench-command-feedback";
import { CatalogIntegrationsSurfacePage } from "./integrations-surface-page";
import { CatalogIntegrationAliasReviewWorkspace } from "./admin-control-plane/alias-review/alias-review-workspace";
import { DeferredSupplementaryPanel } from "./deferred-supplementary-panel";
import { catalogPrimaryWorkbenchHref } from "./primary-workbench-route-context";

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
  // daily surface renders it in the top-of-page slot. Absent on the other surfaces.
  deferredAttentionQueue?: Promise<CatalogAttentionQueueReadModel | null> | null;
}>;

// Shared thin view for the four integrations surface routes. The route loaders
// already slice the read model per audience surface, so this component only
// composes the page chrome around the server-produced model.
export function CatalogIntegrationsSurfaceRouteView({
  surface,
  routeData,
  commandFeedback,
}: Readonly<{
  surface: CatalogControlPlaneRouteSurfaceKey;
  routeData: CatalogIntegrationsRouteData;
  // Optional command-feedback override. The daily surface stays put after a
  // run-sync / promote command and supplies the action result here so the banner
  // renders in place; the other surfaces leave it undefined and read the feedback
  // their loader parsed from the post-command redirect query.
  commandFeedback?: CatalogPrimaryWorkbenchCommandFeedback | null;
}>) {
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
    <DeferredAttentionQueueSlot
      deferredAttentionQueue={routeData.deferredAttentionQueue}
      readModel={routeData.readModel}
    />
  ) : null;

  return (
    <CatalogIntegrationsSurfacePage
      surface={surface}
      readModel={routeData.readModel}
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
      <Await resolve={deferredAliasReview}>
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
// top-of-page inbox paints once the (supplementary) queue read model resolves,
// and renders nothing on absence/error rather than breaking the daily surface.
function DeferredAttentionQueueSlot({
  deferredAttentionQueue,
  readModel,
}: Readonly<{
  deferredAttentionQueue: Promise<CatalogAttentionQueueReadModel | null>;
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
      <Await resolve={deferredAttentionQueue}>
        {(attentionQueue) =>
          attentionQueue ? (
            <CatalogAttentionQueuePanel
              readModel={attentionQueue}
              actionHref={catalogPrimaryWorkbenchHref(readModel.routeContext, "import-to-promotion")}
              canManage={readModel.readiness.rbacAllowed}
            />
          ) : null
        }
      </Await>
    </Suspense>
  );
}
