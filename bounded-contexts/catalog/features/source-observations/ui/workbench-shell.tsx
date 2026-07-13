import { type ReactNode } from "react";
import {
  BulkActionSurface,
  DenseAdminWorkbench,
  DenseAdminWorkbenchHeader,
  MetricStrip,
  OperationalStatusBanner,
  WorkbenchStack,
} from "@chase-sets/design-system";
import { t } from "@chase-sets/localization";
import type { CatalogPrimaryWorkbenchReadModel } from "../api/primary-workbench-admin-contracts";
import type { CatalogControlPlaneRouteSurfaceKey } from "./admin-control-plane/information-architecture";
import { CatalogImportContextBar } from "./admin-control-plane/import-to-promotion/import-context-bar";
import { WorkbenchReturnLink } from "./admin-control-plane/import-to-promotion/workbench-formatting";
import type { CatalogPrimaryWorkbenchCommandFeedback } from "./primary-workbench-command-feedback";
import {
  commandErrorTitle,
  commandFeedbackDescription,
  commandSuccessTitle,
} from "./primary-workbench-command-feedback";

export interface CatalogWorkbenchShellProps {
  readModel: CatalogPrimaryWorkbenchReadModel;
  commandFeedback?: CatalogPrimaryWorkbenchCommandFeedback | null;
  // The audience surface this shell wraps. Drives the single per-surface return
  // affordance: the supporting surfaces (providers, governance, health) render
  // one "Back to import workbench" link; the daily surface is the primary job and
  // renders none.
  surface: CatalogControlPlaneRouteSurfaceKey;
  // The unified attention queue rendered in the top-of-page slot on the
  // daily home surface, above the metric strip. Absent on the other surfaces.
  attentionQueue?: ReactNode;
  // Streamed source-options slice. When the daily loader defers the
  // option fan-out it passes the promise here and the status panel renders behind
  // a Suspense boundary; when absent (the other surfaces, or a test that supplies
  // a fully-populated read model), the panel reads the synchronous slice on
  // `readModel.sourceOptions` directly.
  deferredSourceOptions?: Promise<CatalogPrimaryWorkbenchReadModel["sourceOptions"]> | null;
  // The composed surface body (one workspace for the daily route, the grouped
  // workspaces for the other three). The shell owns no per-surface logic.
  children: ReactNode;
}

// Shared chrome for every integrations surface route: the cross-surface header,
// metric strip, and surface body. Cross-surface navigation lives in the admin
// shell side nav (the nested "Integrations" manifest group), not in the page, so
// this shell renders only the active surface's content.
export function CatalogWorkbenchShell({
  readModel,
  commandFeedback = null,
  surface,
  attentionQueue = null,
  deferredSourceOptions = null,
  children,
}: CatalogWorkbenchShellProps) {
  // The daily surface is the primary import-to-promotion job, so it carries no
  // return link; every supporting surface returns to it through the one link the
  // header renders (rather than each stacked workspace repeating it).
  const showReturnLink = surface !== "daily";

  return (
    <DenseAdminWorkbench data-catalog-primary-workbench="true">
      <DenseAdminWorkbenchHeader
        eyebrow={t("catalog.features.sourceObservations.ui.primaryWorkbench.eyebrow")}
        title={t("catalog.features.sourceObservations.ui.primaryWorkbench.title")}
        description={t("catalog.features.sourceObservations.ui.primaryWorkbench.description")}
        // The header carries only the per-surface return link. The primary
        // actions are NOT duplicated here: each stage owns its action exactly
        // once ("Pull provider data" in Run sync, "Preview promotion" in the
        // review selection surface and the Create / update stage), and the
        // three-stage stepper provides the at-a-glance wayfinding instead of the
        // header.
        actions={showReturnLink ? <WorkbenchReturnLink routeContext={readModel.routeContext} /> : null}
      />

      {commandFeedback ? <CommandFeedbackBanner feedback={commandFeedback} /> : null}

      {/* Top-of-page slot: the unified attention queue — the needs-you
          inbox — renders above the import context bar and metric strip on the
          daily home surface so operators see everything that needs them first. */}
      {surface === "daily" ? attentionQueue : null}

      {/* Step 0 — Choose import scope. "Choosing what to import" (provider / unit /
          guided scope / profile + the synced source-options status) is a distinct
          concern from the import -> promote flow that follows, so it lives in one
          cohesive, collapsible bar ahead of the three-stage stepper (Run sync ->
          Review -> Create) rather than stacked inline by the shell. The bar opens
          until a scope is chosen, then collapses to a one-line summary with an edit
          affordance; expand/edit is client state + the shared fetcher submit,
          so it never full-reloads. */}
      {surface === "daily" ? (
        <CatalogImportContextBar readModel={readModel} deferredSourceOptions={deferredSourceOptions} />
      ) : null}

      <MetricStrip
        items={[
          {
            label: t("catalog.features.sourceObservations.ui.primaryWorkbench.metric.observed"),
            value: String(readModel.sourceObservationReview.counts.observed),
            trend: t("catalog.features.sourceObservations.ui.primaryWorkbench.metric.changed", {
              count: readModel.sourceObservationReview.counts.changed,
            }),
          },
          {
            label: t("catalog.features.sourceObservations.ui.primaryWorkbench.metric.ready.for.preview"),
            value: String(readModel.sourceObservationReview.promotionReadyCount),
            trend: t("catalog.features.sourceObservations.ui.primaryWorkbench.metric.promotion.candidates"),
          },
          {
            label: t("catalog.features.sourceObservations.ui.primaryWorkbench.metric.active.jobs"),
            value: String(readModel.importJobs.activeJobCount),
            trend: t("catalog.features.sourceObservations.ui.primaryWorkbench.metric.job.view", {
              freshness: readModel.importJobs.freshness,
            }),
          },
          {
            // Blockers live once in the
            // authoritative WorkspaceBlockerPanel (with the stepper's per-stage
            // blocked status as the structural cue). This slot instead surfaces
            // the promotion's write blast radius — the count of draft Catalog
            // Item updates the previewed promotion will make — a fail-closed fact
            // the stepper summaries do not restate.
            label: t("catalog.features.sourceObservations.ui.primaryWorkbench.command.count.catalogItemUpdates"),
            value: String(readModel.promotionPreview.destructiveCount),
            trend: t("catalog.features.sourceObservations.ui.primaryWorkbench.metric.fail.closed"),
          },
        ]}
      />

      <BulkActionSurface>
        <WorkbenchStack>{children}</WorkbenchStack>
      </BulkActionSurface>
    </DenseAdminWorkbench>
  );
}

function CommandFeedbackBanner({ feedback }: { feedback: CatalogPrimaryWorkbenchCommandFeedback }) {
  return (
    <OperationalStatusBanner
      tone={feedback.status === "success" ? "success" : "warning"}
      title={feedback.status === "success" ? commandSuccessTitle(feedback.result) : commandErrorTitle(feedback.result)}
      description={commandFeedbackDescription(feedback)}
    />
  );
}
