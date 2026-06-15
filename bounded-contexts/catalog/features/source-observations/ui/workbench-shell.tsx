import type { ReactNode } from "react";
import {
  BulkActionSurface,
  Button,
  DenseAdminWorkbench,
  DenseAdminWorkbenchHeader,
  DenseAdminWorkbenchLayout,
  MetricStrip,
  NativeSelect,
  OperationalStatusBanner,
  TextInput,
  WorkbenchActionRow,
  WorkbenchForm,
  WorkbenchFormGrid,
  WorkbenchStack,
  type SectionNavigationGroup,
} from "@chase-sets/design-system";
import { t } from "@chase-sets/localization";
import type { CatalogPrimaryWorkbenchReadModel } from "../api/primary-workbench-admin-contracts";
import {
  CATALOG_CONTROL_PLANE_ROUTE_SURFACES,
  CATALOG_CONTROL_PLANE_WORKSPACES,
  type CatalogControlPlaneRouteSurfaceKey,
} from "./admin-control-plane/information-architecture";
import { CommandFormButton } from "./admin-control-plane/import-to-promotion/command-controls";
import { WorkbenchReturnLink } from "./admin-control-plane/import-to-promotion/workbench-formatting";
import type { CatalogPrimaryWorkbenchCommandFeedback } from "./primary-workbench-command-feedback";
import { commandFeedbackDescription, commandSuccessTitle } from "./primary-workbench-command-feedback";
import { catalogPrimaryWorkbenchHref, catalogPrimaryWorkbenchSupportingHref } from "./primary-workbench-route-context";

export interface CatalogWorkbenchShellProps {
  readModel: CatalogPrimaryWorkbenchReadModel;
  commandFeedback?: CatalogPrimaryWorkbenchCommandFeedback | null;
  // The audience surface this shell wraps. Drives the single per-surface return
  // affordance: the supporting surfaces (providers, governance, release) render
  // one "Back to import workbench" link; the daily surface is the primary job and
  // renders none.
  surface: CatalogControlPlaneRouteSurfaceKey;
  // The precise workspace key that is active on this surface. Drives nav highlight.
  activeSection: string;
  // The composed surface body (one workspace for the daily route, the grouped
  // workspaces for the other three). The shell owns no per-surface logic.
  children: ReactNode;
}

// Shared chrome for every integrations surface route: cross-surface header,
// metric strip, and grouped navigation that links to the four real routes. Each
// route composes this shell around its own surface body, so no surface-specific
// rendering lives here.
export function CatalogWorkbenchShell({
  readModel,
  commandFeedback = null,
  surface,
  activeSection,
  children,
}: CatalogWorkbenchShellProps) {
  const navigation = surfaceNavigationGroups(readModel);
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

      <DenseAdminWorkbenchLayout
        navigationGroups={navigation}
        activeNavigationKey={activeSection}
        navigationLabel={t("catalog.features.sourceObservations.ui.primaryWorkbench.navigation.label")}
        mobileNavigationLabel={t("catalog.features.sourceObservations.ui.primaryWorkbench.navigation.mobile.label")}
        onNavigationSelect={(key) => navigateToWorkspace(navigation, key)}
      >
        <BulkActionSurface>
          <WorkbenchStack>{children}</WorkbenchStack>
        </BulkActionSurface>
      </DenseAdminWorkbenchLayout>
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
    description: [provider.displayName, unit.productDomain, unit.productForm, unit.ingestionPurpose]
      .filter(Boolean)
      .join(" / "),
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

// Mobile cross-workspace navigation: the "Choose Catalog workflow" combobox
// selects a workspace key; navigate the browser to that workspace's real surface
// route using the same hrefs the desktop nav links already carry. Each workspace
// lives on a real nested route, so this is a genuine route navigation rather than
// a query-param section switch. Generic to every surface (no daily special-case).
function navigateToWorkspace(groups: SectionNavigationGroup[], key: string): void {
  if (typeof window === "undefined") {
    return;
  }

  const href = groups.flatMap((group) => group.items).find((item) => item.key === key)?.href;
  if (href) {
    window.location.assign(href);
  }
}

// One nav group per audience surface. Items link to the surface route (the daily
// route for the primary workspace, the grouped routes for supporting workspaces),
// so navigation is real route navigation rather than a query-param section switch.
function surfaceNavigationGroups(readModel: CatalogPrimaryWorkbenchReadModel): SectionNavigationGroup[] {
  const workspaces = new Map(CATALOG_CONTROL_PLANE_WORKSPACES.map((workspace) => [workspace.key, workspace]));

  return CATALOG_CONTROL_PLANE_ROUTE_SURFACES.map((surface) => ({
    key: surface.key,
    label: surface.accessibleName,
    items: surface.workspaces.map((workspaceKey) => {
      const workspace = workspaces.get(workspaceKey);
      const supportState = workspace?.primaryPathRole === "default" ? "default" : supportNavigationState(readModel);

      return {
        key: workspaceKey,
        label: workspace?.accessibleName ?? workspaceKey,
        href:
          workspace?.primaryPathRole === "supporting-detour"
            ? catalogPrimaryWorkbenchSupportingHref(readModel.routeContext, workspaceKey)
            : catalogPrimaryWorkbenchHref(readModel.routeContext, workspaceKey),
        description: workspace?.operatorJob,
        count:
          workspaceKey === "import-to-promotion" ? readModel.sourceObservationReview.promotionReadyCount : undefined,
        state: supportState,
        statusLabel: supportState === "warning" ? "Detour" : undefined,
      };
    }),
  }));
}

function supportNavigationState(readModel: CatalogPrimaryWorkbenchReadModel) {
  return readModel.readiness.blockers.length > 0 || readModel.promotionPreview.blockers.length > 0
    ? ("warning" as const)
    : ("default" as const);
}
