import { t } from "@chase-sets/localization";
import type { SegmentedControlItem } from "@chase-sets/design-system";

export type CatalogIntegrationModuleArea = "health" | "authoring" | "validation" | "operations" | "audit";
type CatalogIntegrationModuleAreaItem = SegmentedControlItem & { value: CatalogIntegrationModuleArea };

export type CatalogIntegrationWorkflowModule = Readonly<{
  key: string;
  label: string;
  area: CatalogIntegrationModuleArea;
  status: "implemented" | "planned-child-issue";
  childIssue: number | null;
}>;

export const CATALOG_INTEGRATION_MODULE_AREAS = [
  {
    value: "health",
    label: t("catalog.features.sourceObservations.ui.adminControlPlane.health"),
    icon: "dashboard",
  },
  {
    value: "authoring",
    label: t("catalog.features.sourceObservations.ui.adminControlPlane.authoring"),
    icon: "settings",
  },
  {
    value: "validation",
    label: t("catalog.features.sourceObservations.ui.adminControlPlane.validation"),
    icon: "badgeCheck",
  },
  {
    value: "operations",
    label: t("catalog.features.sourceObservations.ui.adminControlPlane.operations"),
    icon: "refreshCcw",
  },
  {
    value: "audit",
    label: t("catalog.features.sourceObservations.ui.adminControlPlane.audit"),
    icon: "search",
  },
] satisfies CatalogIntegrationModuleAreaItem[];

export const CATALOG_INTEGRATION_WORKFLOW_MODULES = [
  {
    key: "admin-control-plane-shell",
    label: t("catalog.features.sourceObservations.ui.adminControlPlane.admin.control.plane.shell"),
    area: "health",
    status: "implemented",
    childIssue: 763,
  },
  {
    key: "integration-health-dashboard",
    label: t("catalog.features.sourceObservations.ui.adminControlPlane.integration.health.dashboard"),
    area: "health",
    status: "implemented",
    childIssue: 777,
  },
  {
    key: "profile-workspace",
    label: t("catalog.features.sourceObservations.ui.adminControlPlane.provider.profile.workspace"),
    area: "authoring",
    status: "implemented",
    childIssue: 778,
  },
  {
    key: "profile-list",
    label: t("catalog.features.sourceObservations.ui.adminControlPlane.provider.profile.list"),
    area: "health",
    status: "implemented",
    childIssue: 763,
  },
  {
    key: "profile-lifecycle-actions",
    label: t("catalog.features.sourceObservations.ui.adminControlPlane.profile.lifecycle.actions"),
    area: "audit",
    status: "implemented",
    childIssue: 779,
  },
  {
    key: "section-editors",
    label: t("catalog.features.sourceObservations.ui.adminControlPlane.profile.section.editors"),
    area: "authoring",
    status: "planned-child-issue",
    childIssue: 765,
  },
  {
    key: "fixture-validation-workbench",
    label: t("catalog.features.sourceObservations.ui.adminControlPlane.fixture.validation.workbench"),
    area: "validation",
    status: "implemented",
    childIssue: 778,
  },
  {
    key: "dry-run-workbench",
    label: t("catalog.features.sourceObservations.ui.adminControlPlane.dry.run.workbench"),
    area: "validation",
    status: "implemented",
    childIssue: 778,
  },
  {
    key: "profile-compare-panel",
    label: t("catalog.features.sourceObservations.ui.adminControlPlane.profile.compare.panel"),
    area: "validation",
    status: "implemented",
    childIssue: 778,
  },
  {
    key: "readiness-workflow",
    label: t("catalog.features.sourceObservations.ui.adminControlPlane.activation.readiness.workflow"),
    area: "validation",
    status: "implemented",
    childIssue: 778,
  },
  {
    key: "import-workbench",
    label: t("catalog.features.sourceObservations.ui.adminControlPlane.import.workbench"),
    area: "operations",
    status: "implemented",
    childIssue: 779,
  },
  {
    key: "job-monitor-drawer",
    label: t("catalog.features.sourceObservations.ui.adminControlPlane.integration.job.monitor"),
    area: "operations",
    status: "implemented",
    childIssue: 779,
  },
  {
    key: "source-observation-review-workbench",
    label: t("catalog.features.sourceObservations.ui.adminControlPlane.source.observation.review.workbench"),
    area: "operations",
    status: "implemented",
    childIssue: 779,
  },
  {
    key: "promotion-reapply-workflows",
    label: t("catalog.features.sourceObservations.ui.adminControlPlane.promote.and.reapply.workflows"),
    area: "operations",
    status: "implemented",
    childIssue: 779,
  },
  {
    key: "adapter-readiness-panel",
    label: t("catalog.features.sourceObservations.ui.adminControlPlane.adapter.readiness.panel"),
    area: "health",
    status: "implemented",
    childIssue: 777,
  },
  {
    key: "integration-audit-log",
    label: t("catalog.features.sourceObservations.ui.adminControlPlane.integration.audit.lifecycle"),
    area: "audit",
    status: "implemented",
    childIssue: 777,
  },
  {
    key: "rollback-retirement-workflow",
    label: t("catalog.features.sourceObservations.ui.adminControlPlane.rollback.and.retirement.workflow"),
    area: "audit",
    status: "implemented",
    childIssue: 779,
  },
] as const satisfies readonly CatalogIntegrationWorkflowModule[];

export function moduleAreaLabel(area: CatalogIntegrationModuleArea): string {
  return CATALOG_INTEGRATION_MODULE_AREAS.find((item) => item.value === area)?.label ?? area;
}
