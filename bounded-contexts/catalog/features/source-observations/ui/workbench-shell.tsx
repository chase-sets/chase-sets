import type { ReactNode } from "react";
import {
  BulkActionSurface,
  Button,
  DenseAdminWorkbench,
  DenseAdminWorkbenchHeader,
  MetricStrip,
  NativeSelect,
  OperationalStatusBanner,
  TextInput,
  WorkbenchActionRow,
  WorkbenchForm,
  WorkbenchFormGrid,
  WorkbenchStack,
} from "@chase-sets/design-system";
import { t } from "@chase-sets/localization";
import type { CatalogPrimaryWorkbenchReadModel } from "../api/primary-workbench-admin-contracts";
import type { CatalogControlPlaneRouteSurfaceKey } from "./admin-control-plane/information-architecture";
import { CommandFormButton } from "./admin-control-plane/import-to-promotion/command-controls";
import { WorkbenchReturnLink } from "./admin-control-plane/import-to-promotion/workbench-formatting";
import type { CatalogPrimaryWorkbenchCommandFeedback } from "./primary-workbench-command-feedback";
import { commandFeedbackDescription, commandSuccessTitle } from "./primary-workbench-command-feedback";

export interface CatalogWorkbenchShellProps {
  readModel: CatalogPrimaryWorkbenchReadModel;
  commandFeedback?: CatalogPrimaryWorkbenchCommandFeedback | null;
  // The audience surface this shell wraps. Drives the single per-surface return
  // affordance: the supporting surfaces (providers, governance, release) render
  // one "Back to import workbench" link; the daily surface is the primary job and
  // renders none.
  surface: CatalogControlPlaneRouteSurfaceKey;
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
        actions={
          <>
            {showReturnLink ? <WorkbenchReturnLink routeContext={readModel.routeContext} /> : null}
            <CommandFormButton readModel={readModel} intent="start-provider-import" leadingIcon="refreshCcw">
              {t("catalog.features.sourceObservations.ui.primaryWorkbench.pull.provider.data")}
            </CommandFormButton>
            <CommandFormButton readModel={readModel} intent="preview-promotion" tone="secondary" leadingIcon="check">
              {t("catalog.features.sourceObservations.ui.primaryWorkbench.preview.promotion")}
            </CommandFormButton>
          </>
        }
      />

      {commandFeedback ? <CommandFeedbackBanner feedback={commandFeedback} /> : null}
      {surface === "daily" ? <ProviderImportContextForm readModel={readModel} /> : null}

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
            label: t("catalog.features.sourceObservations.ui.primaryWorkbench.metric.blockers"),
            value: String(readModel.readiness.blockers.length + readModel.promotionPreview.blockers.length),
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

function ProviderImportContextForm({ readModel }: { readModel: CatalogPrimaryWorkbenchReadModel }) {
  const providerOptions = readModel.providerScope.providers.map((provider) => ({
    value: provider.providerKey,
    label: provider.displayName,
  }));
  const selectedProviderKey = readModel.routeContext.providerKey ?? providerOptions[0]?.value ?? "";
  const units = readModel.providerScope.providers.flatMap((provider) =>
    provider.units.map((unit) => ({ provider, unit })),
  );
  const unitOptions = units.map(({ provider, unit }) => ({
    value: unit.unitKey,
    label: unit.unitKey,
    description: [provider.displayName, unit.productDomain, unit.productForm].filter(Boolean).join(" / "),
  }));
  const selectedUnit = units.find(({ unit }) => unit.unitKey === readModel.routeContext.unitKey)?.unit;
  const profileVersion = readModel.routeContext.profileVersion ?? selectedUnit?.activeProfile?.profileVersion ?? "";

  return (
    <WorkbenchForm method="get" action="/catalog/integrations">
      <WorkbenchFormGrid columns="three">
        <NativeSelect
          name="providerKey"
          label={t("catalog.features.sourceObservations.ui.primaryWorkbench.importContext.provider")}
          items={providerOptions}
          defaultValue={selectedProviderKey}
          required
        />
        <NativeSelect
          name="unitKey"
          label={t("catalog.features.sourceObservations.ui.primaryWorkbench.importContext.unit")}
          items={unitOptions}
          defaultValue={readModel.routeContext.unitKey ?? unitOptions[0]?.value ?? ""}
          required
        />
        <TextInput
          name="importScope"
          label={t("catalog.features.sourceObservations.ui.primaryWorkbench.importContext.scope")}
          defaultValue={readModel.routeContext.importScope ?? ""}
          required
        />
      </WorkbenchFormGrid>
      <WorkbenchActionRow align="between" stackOnMobile>
        <TextInput
          name="profileVersion"
          label={t("catalog.features.sourceObservations.ui.primaryWorkbench.importContext.profileVersion")}
          defaultValue={profileVersion}
        />
        <Button type="submit" leadingIcon="check">
          {t("catalog.features.sourceObservations.ui.primaryWorkbench.importContext.apply")}
        </Button>
      </WorkbenchActionRow>
    </WorkbenchForm>
  );
}

function CommandFeedbackBanner({ feedback }: { feedback: CatalogPrimaryWorkbenchCommandFeedback }) {
  return (
    <OperationalStatusBanner
      tone={feedback.status === "success" ? "success" : "warning"}
      title={
        feedback.status === "success"
          ? commandSuccessTitle(feedback.result)
          : t("catalog.features.sourceObservations.ui.primaryWorkbench.command.feedback.error.title")
      }
      description={commandFeedbackDescription(feedback)}
    />
  );
}
