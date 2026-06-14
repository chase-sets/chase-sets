import { useEffect, useMemo, useState } from "react";
import {
  BulkActionSurface,
  DenseAdminWorkbench,
  DenseAdminWorkbenchHeader,
  DenseAdminWorkbenchLayout,
  MetricStrip,
  OperationalStatusBanner,
  WorkbenchStack,
  type SectionNavigationGroup,
} from "@chase-sets/design-system";
import { t } from "@chase-sets/localization";
import type { CatalogPrimaryWorkbenchReadModel } from "../api/primary-workbench-admin-contracts";
import {
  CATALOG_CONTROL_PLANE_NAVIGATION_GROUPS,
  CATALOG_CONTROL_PLANE_WORKSPACES,
  type CatalogControlPlaneWorkspaceKey,
} from "./admin-control-plane/information-architecture";
import { CommandFormButton } from "./admin-control-plane/import-to-promotion/command-controls";
import { WorkbenchReturnLink } from "./admin-control-plane/import-to-promotion/workbench-formatting";
import {
  commandFeedbackDescription,
  commandSuccessTitle,
  type CatalogPrimaryWorkbenchCommandFeedback,
} from "./primary-workbench-command-feedback";
import { CATALOG_PRIMARY_WORKBENCH_WORKSPACE_RENDERERS } from "./workbench-workspace-renderers";
import {
  catalogPrimaryWorkbenchHref,
  catalogPrimaryWorkbenchSupportingHref,
  normalizeCatalogPrimaryWorkbenchSection,
} from "./primary-workbench-route-context";

// Superseded by the four nested integrations surface routes (#1739); kept until
// the legacy ?section= page is fully removed (#1749). The render registry and
// command-feedback copy now live in shared modules that the routes also consume.
export type { CatalogPrimaryWorkbenchCommandFeedback } from "./primary-workbench-command-feedback";
export { CATALOG_PRIMARY_WORKBENCH_WORKSPACE_RENDERERS } from "./workbench-workspace-renderers";

export interface CatalogPrimaryWorkbenchPageProps {
  readModel: CatalogPrimaryWorkbenchReadModel;
  commandFeedback?: CatalogPrimaryWorkbenchCommandFeedback | null;
}

export function CatalogPrimaryWorkbenchPage({ readModel, commandFeedback = null }: CatalogPrimaryWorkbenchPageProps) {
  const navigation = useMemo(() => navigationGroups(readModel), [readModel]);
  const [activeSection, setActiveSection] = useState(() => normalizeActiveWorkspace(readModel.routeContext.section));
  useEffect(() => {
    setActiveSection(normalizeActiveWorkspace(readModel.routeContext.section));
  }, [readModel.routeContext.section]);
  useEffect(() => {
    const handlePopState = () => {
      setActiveSection(
        normalizeActiveWorkspace(new URL(window.location.href).searchParams.get("section") ?? undefined),
      );
    };

    window.addEventListener("popstate", handlePopState);

    return () => window.removeEventListener("popstate", handlePopState);
  }, []);
  const handleSectionSelect = (key: string) => {
    const normalized = normalizeActiveWorkspace(key);
    setActiveSection(normalized);
    if (typeof window === "undefined") {
      return;
    }

    const href = findNavigationHref(navigation, key) ?? findNavigationHref(navigation, normalized);
    if (href) {
      window.history.pushState({ catalogPrimaryWorkbenchSection: normalized }, "", href);
    }
  };
  const renderActiveWorkspace =
    CATALOG_PRIMARY_WORKBENCH_WORKSPACE_RENDERERS[activeSection as CatalogControlPlaneWorkspaceKey] ??
    CATALOG_PRIMARY_WORKBENCH_WORKSPACE_RENDERERS["import-to-promotion"];
  // The supporting workspaces render their single "Back to import workbench"
  // affordance once in the header (no longer per-workspace); the primary import
  // workspace is the daily job itself, so it carries none.
  const showReturnLink = activeSection !== "import-to-promotion";

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
        onNavigationSelect={handleSectionSelect}
      >
        <BulkActionSurface>
          <WorkbenchStack>{renderActiveWorkspace(readModel)}</WorkbenchStack>
        </BulkActionSurface>
      </DenseAdminWorkbenchLayout>
    </DenseAdminWorkbench>
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

function navigationGroups(readModel: CatalogPrimaryWorkbenchReadModel): SectionNavigationGroup[] {
  const workspaces = new Map(CATALOG_CONTROL_PLANE_WORKSPACES.map((workspace) => [workspace.key, workspace]));

  return CATALOG_CONTROL_PLANE_NAVIGATION_GROUPS.map((group) => ({
    key: group.key,
    label: group.accessibleName,
    items: group.items.map((workspaceKey) => {
      const workspace = workspaces.get(workspaceKey);
      const supportState = workspace?.primaryPathRole === "default" ? "default" : supportNavigationState(readModel);

      return {
        key: workspaceKey,
        label: workspace?.accessibleName ?? workspaceKey,
        href:
          workspace?.primaryPathRole === "supporting-detour"
            ? catalogPrimaryWorkbenchSupportingHref(readModel.routeContext, workspace.key)
            : catalogPrimaryWorkbenchHref(readModel.routeContext, workspace?.key),
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

function findNavigationHref(groups: SectionNavigationGroup[], key: string): string | undefined {
  return groups.flatMap((group) => group.items).find((item) => item.key === key)?.href;
}

function normalizeActiveWorkspace(section: string | undefined): string {
  const normalizedSection = normalizeCatalogPrimaryWorkbenchSection(section);
  if (CATALOG_CONTROL_PLANE_WORKSPACES.some((workspace) => workspace.key === normalizedSection)) {
    return normalizedSection;
  }

  return "import-to-promotion";
}
