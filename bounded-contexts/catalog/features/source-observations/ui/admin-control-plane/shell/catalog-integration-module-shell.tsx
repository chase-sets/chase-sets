import { t } from "@chase-sets/localization";
import type { ReactNode } from "react";
import {
  OperationalStatusBanner,
  SegmentedControl,
  Stack,
  TaskSummary,
  WorkstationLayout,
} from "@chase-sets/design-system";
import type { CatalogProviderProfileVersionReview } from "../../contracts";
import { CATALOG_INTEGRATION_MODULE_AREAS, type CatalogIntegrationModuleArea, moduleAreaLabel } from "../registry";

export type CatalogIntegrationScopeSummary = Readonly<{
  scopes: number;
  total: number;
  observed: number;
  changed: number;
  promoted: number;
}>;

export type CatalogIntegrationModuleShellProps = Readonly<{
  area: CatalogIntegrationModuleArea;
  onAreaChange: (value: string) => void;
  selectedProfile: CatalogProviderProfileVersionReview | null;
  summary: CatalogIntegrationScopeSummary;
  activeJobCount: number;
  canManageCatalog: boolean;
  children: ReactNode;
}>;

export function CatalogIntegrationModuleShell({
  area,
  onAreaChange,
  selectedProfile,
  summary,
  activeJobCount,
  canManageCatalog,
  children,
}: CatalogIntegrationModuleShellProps) {
  return (
    <WorkstationLayout
      secondaryTitle="Module context"
      secondaryDescription="Selected profile health, operations, permissions, and the admin module map."
      primary={
        <Stack gap={4}>
          <SegmentedControl
            aria-label={t("catalog.features.sourceObservations.ui.adminControlPlane.catalog.integration.module.area")}
            value={area}
            onValueChange={onAreaChange}
            items={CATALOG_INTEGRATION_MODULE_AREAS}
            fullWidth
          />
          {children}
        </Stack>
      }
      secondary={
        <Stack gap={3}>
          <OperationalStatusBanner
            tone={canManageCatalog ? "success" : "warning"}
            title={canManageCatalog ? "Catalog manage enabled" : "View-only catalog access"}
            description={
              canManageCatalog
                ? "This operator can author profiles, run imports, reapply promoted observations, and manage lifecycle actions."
                : "This operator can inspect profiles, compare versions, dry-run fixtures, and review observations. Writes require catalog.manage."
            }
          />
          <TaskSummary
            title={t("catalog.features.sourceObservations.ui.adminControlPlane.selected.profile")}
            items={
              selectedProfile
                ? [
                    {
                      label: t("catalog.features.sourceObservations.ui.adminControlPlane.provider"),
                      value: selectedProfile.displayName,
                    },
                    {
                      label: t("catalog.features.sourceObservations.ui.adminControlPlane.version"),
                      value: selectedProfile.profileVersion,
                    },
                    {
                      label: t("catalog.features.sourceObservations.ui.adminControlPlane.lifecycle"),
                      value: selectedProfile.active ? "active" : selectedProfile.lifecycle,
                    },
                    {
                      label: t("catalog.features.sourceObservations.ui.adminControlPlane.validation"),
                      value: selectedProfile.validation.status,
                    },
                    {
                      label: t("catalog.features.sourceObservations.ui.adminControlPlane.mapping"),
                      value: selectedProfile.mappingOutputKind,
                    },
                    {
                      label: t("catalog.features.sourceObservations.ui.adminControlPlane.fixture.flows"),
                      value: String(selectedProfile.fixtures.coveredFlows.length),
                    },
                  ]
                : [
                    {
                      label: t("catalog.features.sourceObservations.ui.adminControlPlane.profile"),
                      value: "No profile selected",
                    },
                  ]
            }
          />
          <TaskSummary
            title={t("catalog.features.sourceObservations.ui.adminControlPlane.module.map")}
            items={[
              {
                label: t("catalog.features.sourceObservations.ui.adminControlPlane.current.area"),
                value: moduleAreaLabel(area),
              },
              {
                label: t("catalog.features.sourceObservations.ui.adminControlPlane.authoring"),
                value: "Profile basics, options, connector, mappings, references, and plans",
              },
              {
                label: t("catalog.features.sourceObservations.ui.adminControlPlane.validation"),
                value: "Fixture dry-runs, diagnostics, readiness, and semantic comparison",
              },
              {
                label: t("catalog.features.sourceObservations.ui.adminControlPlane.operations"),
                value: "Import, promote all, reapply, job status, and failure groups",
              },
              {
                label: t("catalog.features.sourceObservations.ui.adminControlPlane.audit"),
                value: "Migration evidence, authoring metadata, rollback, and retirement",
              },
            ]}
          />
          <TaskSummary
            title={t("catalog.features.sourceObservations.ui.adminControlPlane.operations")}
            items={[
              {
                label: t("catalog.features.sourceObservations.ui.adminControlPlane.scopes"),
                value: formatCount(summary.scopes),
              },
              {
                label: t("catalog.features.sourceObservations.ui.adminControlPlane.needs.review"),
                value: formatCount(summary.observed + summary.changed),
              },
              {
                label: t("catalog.features.sourceObservations.ui.adminControlPlane.promoted"),
                value: formatCount(summary.promoted),
              },
              {
                label: t("catalog.features.sourceObservations.ui.adminControlPlane.active.jobs"),
                value: formatCount(activeJobCount),
              },
            ]}
          />
        </Stack>
      }
    />
  );
}

function formatCount(value: number) {
  return new Intl.NumberFormat().format(value);
}
