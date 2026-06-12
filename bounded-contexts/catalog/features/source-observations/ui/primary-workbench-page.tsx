import { useEffect, useMemo, useState } from "react";
import {
  Badge,
  BulkActionSurface,
  DenseAdminWorkbench,
  DenseAdminWorkbenchHeader,
  DenseAdminWorkbenchLayout,
  LinkButton,
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
} from "./admin-control-plane/information-architecture";
import { CatalogIntegrationConflictResolutionWorkspace } from "./admin-control-plane/conflicts/conflict-resolution-workspace";
import { CatalogIntegrationAuditEvidenceWorkspace } from "./admin-control-plane/evidence/audit-evidence-workspace";
import { CatalogIntegrationCleanResetReleaseWorkspace } from "./admin-control-plane/evidence/clean-reset-release-workspace";
import { CatalogIntegrationGovernanceControlsWorkspace } from "./admin-control-plane/governance/governance-controls-workspace";
import { CatalogIntegrationHealthTriageWorkspace } from "./admin-control-plane/health/integration-health-dashboard";
import { CatalogIntegrationImportToPromotionWorkspace } from "./admin-control-plane/import-to-promotion/import-to-promotion-workspace";
import { CatalogIntegrationLifecycleRecoveryWorkspace } from "./admin-control-plane/lifecycle/lifecycle-recovery-workspace";
import { CatalogIntegrationProfileAuthoringWorkspace } from "./admin-control-plane/profiles/profile-authoring-workspace";
import { CatalogIntegrationValidationReadinessWorkspace } from "./admin-control-plane/validation/validation-readiness-workspace";
import { CommandFormButton } from "./admin-control-plane/import-to-promotion/command-controls";
import {
  catalogPrimaryWorkbenchHref,
  catalogPrimaryWorkbenchSupportingHref,
  normalizeCatalogPrimaryWorkbenchSection,
} from "./primary-workbench-route-context";

export type CatalogPrimaryWorkbenchCommandFeedback = Readonly<{
  status: "success" | "error";
  intent: string;
  result:
    | "job-queued"
    | "job-cancelled"
    | "preview-ready"
    | "draft-created"
    | "profile-activated"
    | "profile-rolled-back"
    | "profile-deprecated"
    | "profile-retired"
    | "section-saved"
    | "section-conflict"
    | "section-invalid"
    | "lifecycle-conflict"
    | "confirmation-required"
    | "preview-required"
    | "job-required"
    | "reason-required"
    | "unsupported-command"
    | "invalid-intent"
    | "command-failed";
}>;

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
  const implementedSupportWorkspace =
    activeSection === "health-triage" ? (
      <CatalogIntegrationHealthTriageWorkspace readModel={readModel} />
    ) : activeSection === "profile-authoring" ? (
      <CatalogIntegrationProfileAuthoringWorkspace readModel={readModel} />
    ) : activeSection === "validation-readiness" ? (
      <CatalogIntegrationValidationReadinessWorkspace readModel={readModel} />
    ) : activeSection === "conflict-resolution" ? (
      <CatalogIntegrationConflictResolutionWorkspace readModel={readModel} />
    ) : activeSection === "lifecycle-recovery" ? (
      <CatalogIntegrationLifecycleRecoveryWorkspace readModel={readModel} />
    ) : activeSection === "governance-controls" ? (
      <CatalogIntegrationGovernanceControlsWorkspace readModel={readModel} />
    ) : activeSection === "clean-reset-release" ? (
      <CatalogIntegrationCleanResetReleaseWorkspace readModel={readModel} />
    ) : activeSection === "audit-evidence" ? (
      <CatalogIntegrationAuditEvidenceWorkspace readModel={readModel} />
    ) : null;

  return (
    <DenseAdminWorkbench data-catalog-primary-workbench="true">
      <DenseAdminWorkbenchHeader
        eyebrow={t("catalog.features.sourceObservations.ui.primaryWorkbench.eyebrow")}
        title={t("catalog.features.sourceObservations.ui.primaryWorkbench.title")}
        description={t("catalog.features.sourceObservations.ui.primaryWorkbench.description")}
        actions={
          <>
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
          <WorkbenchStack>
            {implementedSupportWorkspace ?? <CatalogIntegrationImportToPromotionWorkspace readModel={readModel} />}
          </WorkbenchStack>
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

function commandSuccessTitle(result: CatalogPrimaryWorkbenchCommandFeedback["result"]): string {
  if (result === "preview-ready") {
    return t("catalog.features.sourceObservations.ui.primaryWorkbench.command.feedback.preview.title");
  }
  if (result === "job-cancelled") {
    return t("catalog.features.sourceObservations.ui.primaryWorkbench.command.feedback.cancelled.title");
  }
  if (result === "draft-created") {
    return t("catalog.features.sourceObservations.ui.primaryWorkbench.command.feedback.draft.title");
  }
  if (result === "profile-activated") {
    return t("catalog.features.sourceObservations.ui.primaryWorkbench.command.feedback.activation.title");
  }
  if (result === "profile-rolled-back") {
    return t("catalog.features.sourceObservations.ui.primaryWorkbench.command.feedback.rollback.title");
  }
  if (result === "profile-deprecated") {
    return t("catalog.features.sourceObservations.ui.primaryWorkbench.command.feedback.deprecated.title");
  }
  if (result === "profile-retired") {
    return t("catalog.features.sourceObservations.ui.primaryWorkbench.command.feedback.retired.title");
  }
  if (result === "section-saved") {
    return t("catalog.features.sourceObservations.ui.primaryWorkbench.command.feedback.section.title");
  }

  return t("catalog.features.sourceObservations.ui.primaryWorkbench.command.feedback.queued.title");
}

function commandFeedbackDescription(feedback: CatalogPrimaryWorkbenchCommandFeedback): string {
  if (feedback.status === "success") {
    if (feedback.result === "preview-ready") {
      return t("catalog.features.sourceObservations.ui.primaryWorkbench.command.feedback.preview.description");
    }
    if (feedback.result === "job-cancelled") {
      return t("catalog.features.sourceObservations.ui.primaryWorkbench.command.feedback.cancelled.description");
    }
    if (feedback.result === "draft-created") {
      return t("catalog.features.sourceObservations.ui.primaryWorkbench.command.feedback.draft.description");
    }
    if (feedback.result === "profile-activated") {
      return t("catalog.features.sourceObservations.ui.primaryWorkbench.command.feedback.activation.description");
    }
    if (feedback.result === "profile-rolled-back") {
      return t("catalog.features.sourceObservations.ui.primaryWorkbench.command.feedback.rollback.description");
    }
    if (feedback.result === "profile-deprecated") {
      return t("catalog.features.sourceObservations.ui.primaryWorkbench.command.feedback.deprecated.description");
    }
    if (feedback.result === "profile-retired") {
      return t("catalog.features.sourceObservations.ui.primaryWorkbench.command.feedback.retired.description");
    }
    if (feedback.result === "section-saved") {
      return t("catalog.features.sourceObservations.ui.primaryWorkbench.command.feedback.section.description");
    }

    return t("catalog.features.sourceObservations.ui.primaryWorkbench.command.feedback.queued.description");
  }

  switch (feedback.result) {
    case "preview-required":
      return t("catalog.features.sourceObservations.ui.primaryWorkbench.command.feedback.preview.required");
    case "job-required":
      return t("catalog.features.sourceObservations.ui.primaryWorkbench.command.feedback.job.required");
    case "reason-required":
      return t("catalog.features.sourceObservations.ui.primaryWorkbench.command.feedback.reason.required");
    case "section-conflict":
      return t("catalog.features.sourceObservations.ui.primaryWorkbench.command.feedback.section.conflict");
    case "section-invalid":
      return t("catalog.features.sourceObservations.ui.primaryWorkbench.command.feedback.section.invalid");
    case "lifecycle-conflict":
      return t("catalog.features.sourceObservations.ui.primaryWorkbench.command.feedback.lifecycle.conflict");
    case "confirmation-required":
      return t("catalog.features.sourceObservations.ui.primaryWorkbench.command.feedback.confirmation.required");
    case "unsupported-command":
      return t("catalog.features.sourceObservations.ui.primaryWorkbench.command.feedback.unsupported");
    case "invalid-intent":
      return t("catalog.features.sourceObservations.ui.primaryWorkbench.command.feedback.invalid.intent");
    case "command-failed":
    default:
      return t("catalog.features.sourceObservations.ui.primaryWorkbench.command.feedback.failed");
  }
}
