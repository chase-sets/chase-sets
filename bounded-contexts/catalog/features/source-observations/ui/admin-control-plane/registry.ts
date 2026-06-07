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
    label: t("catalog.features.sourceObservations.ui.integrationManagementPage.health"),
    icon: "dashboard",
  },
  {
    value: "authoring",
    label: t("catalog.features.sourceObservations.ui.integrationManagementPage.authoring"),
    icon: "settings",
  },
  {
    value: "validation",
    label: t("catalog.features.sourceObservations.ui.integrationManagementPage.validation"),
    icon: "badgeCheck",
  },
  {
    value: "operations",
    label: t("catalog.features.sourceObservations.ui.integrationManagementPage.operations"),
    icon: "refreshCcw",
  },
  {
    value: "audit",
    label: t("catalog.features.sourceObservations.ui.integrationManagementPage.audit"),
    icon: "search",
  },
] satisfies CatalogIntegrationModuleAreaItem[];

export const CATALOG_INTEGRATION_WORKFLOW_MODULES = [
  {
    key: "admin-control-plane-shell",
    label: "Admin Control Plane shell",
    area: "health",
    status: "implemented",
    childIssue: 763,
  },
  {
    key: "integration-health-dashboard",
    label: "Integration health dashboard",
    area: "health",
    status: "implemented",
    childIssue: 777,
  },
  {
    key: "profile-workspace",
    label: "Provider profile workspace",
    area: "authoring",
    status: "implemented",
    childIssue: 778,
  },
  {
    key: "profile-list",
    label: "Provider profile list",
    area: "health",
    status: "implemented",
    childIssue: 763,
  },
  {
    key: "profile-lifecycle-actions",
    label: "Profile lifecycle actions",
    area: "audit",
    status: "implemented",
    childIssue: 779,
  },
  {
    key: "section-editors",
    label: "Profile section editors",
    area: "authoring",
    status: "planned-child-issue",
    childIssue: 765,
  },
  {
    key: "fixture-validation-workbench",
    label: "Fixture validation workbench",
    area: "validation",
    status: "implemented",
    childIssue: 778,
  },
  {
    key: "dry-run-workbench",
    label: "Dry-run workbench",
    area: "validation",
    status: "implemented",
    childIssue: 778,
  },
  {
    key: "profile-compare-panel",
    label: "Profile compare panel",
    area: "validation",
    status: "implemented",
    childIssue: 778,
  },
  {
    key: "readiness-workflow",
    label: "Activation readiness workflow",
    area: "validation",
    status: "implemented",
    childIssue: 778,
  },
  {
    key: "import-workbench",
    label: "Import workbench",
    area: "operations",
    status: "implemented",
    childIssue: 779,
  },
  {
    key: "job-monitor-drawer",
    label: "Integration job monitor",
    area: "operations",
    status: "implemented",
    childIssue: 779,
  },
  {
    key: "source-observation-review-workbench",
    label: "Source Observation review workbench",
    area: "operations",
    status: "planned-child-issue",
    childIssue: 779,
  },
  {
    key: "promotion-reapply-workflows",
    label: "Promote and reapply workflows",
    area: "operations",
    status: "implemented",
    childIssue: 779,
  },
  {
    key: "adapter-readiness-panel",
    label: "Adapter readiness panel",
    area: "health",
    status: "implemented",
    childIssue: 777,
  },
  {
    key: "integration-audit-log",
    label: "Integration audit lifecycle",
    area: "audit",
    status: "implemented",
    childIssue: 777,
  },
  {
    key: "rollback-retirement-workflow",
    label: "Rollback and retirement workflow",
    area: "audit",
    status: "implemented",
    childIssue: 779,
  },
] as const satisfies readonly CatalogIntegrationWorkflowModule[];

export function moduleAreaLabel(area: CatalogIntegrationModuleArea): string {
  return CATALOG_INTEGRATION_MODULE_AREAS.find((item) => item.value === area)?.label ?? area;
}
