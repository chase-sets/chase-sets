import type { ReactElement } from "react";
import { Box } from "@chase-sets/design-system";
import type { CatalogPrimaryWorkbenchReadModel } from "../api/primary-workbench-admin-contracts";
import type {
  CatalogScopeSyncUnitStateReadModel,
  CatalogSyncRun,
  SourceObservationIntegrationImportPreview,
} from "./contracts";
import type { CatalogPrimaryWorkbenchCommandFeedback } from "./primary-workbench-command-feedback";
import type { CatalogControlPlaneWorkspaceKey } from "./admin-control-plane/information-architecture";
import { CatalogIntegrationAuditEvidenceWorkspace } from "./admin-control-plane/evidence/audit-evidence-workspace";
import { CatalogControlPlaneSettingsPage } from "./admin-control-plane/settings/catalog-control-plane-settings-page";
import { CatalogIntegrationHealthTriageWorkspace } from "./admin-control-plane/health/integration-health-dashboard";
import { CatalogIntegrationImportToPromotionWorkspace } from "./admin-control-plane/import-to-promotion/import-to-promotion-workspace";
import { CatalogIntegrationLifecycleRecoveryWorkspace } from "./admin-control-plane/lifecycle/lifecycle-recovery-workspace";
import { CatalogIntegrationProfileAuthoringWorkspace } from "./admin-control-plane/profiles/profile-authoring-workspace";
import { CatalogIntegrationValidationReadinessWorkspace } from "./admin-control-plane/validation/validation-readiness-workspace";

// Optional slots a route surface may supply to the workspaces it renders. Slots
// are rendered nodes the composition root owns (e.g. the alias-review
// workspace), so the IA render registry stays agnostic of their data sources.
export type CatalogPrimaryWorkbenchWorkspaceSlots = Readonly<{
  aliasVisibility?: ReactElement | null;
  commandFeedback?: CatalogPrimaryWorkbenchCommandFeedback | null;
  deferredSourceOptions?: Promise<CatalogPrimaryWorkbenchReadModel["sourceOptions"]> | null;
  deferredImportPreview?: Promise<SourceObservationIntegrationImportPreview | null> | null;
  deferredCatalogSyncRun?: Promise<CatalogSyncRun | null> | null;
  deferredScopeSyncState?: Promise<readonly CatalogScopeSyncUnitStateReadModel[] | null> | null;
}>;

export type CatalogPrimaryWorkbenchWorkspaceRenderer = (
  readModel: CatalogPrimaryWorkbenchReadModel,
  slots: CatalogPrimaryWorkbenchWorkspaceSlots,
) => ReactElement;

// Single source of truth for which IA workspace renders which workspace component.
// Typed as a total record over CatalogControlPlaneWorkspaceKey so a declared-but-unrendered
// section fails the TypeScript build, and the IA<->render parity test asserts both directions.
export const CATALOG_PRIMARY_WORKBENCH_WORKSPACE_RENDERERS: Readonly<
  Record<CatalogControlPlaneWorkspaceKey, CatalogPrimaryWorkbenchWorkspaceRenderer>
> = {
  "import-to-promotion": (readModel, slots) => (
    <CatalogIntegrationImportToPromotionWorkspace
      readModel={readModel}
      aliasVisibility={slots.aliasVisibility}
      commandFeedback={slots.commandFeedback}
      deferredSourceOptions={slots.deferredSourceOptions}
      deferredImportPreview={slots.deferredImportPreview}
      deferredCatalogSyncRun={slots.deferredCatalogSyncRun}
      deferredScopeSyncState={slots.deferredScopeSyncState}
    />
  ),
  "health-triage": (readModel) => <CatalogIntegrationHealthTriageWorkspace readModel={readModel} />,
  "profile-authoring": (readModel) => <CatalogIntegrationProfileAuthoringWorkspace readModel={readModel} />,
  "validation-readiness": (readModel) => <CatalogIntegrationValidationReadinessWorkspace readModel={readModel} />,
  "lifecycle-recovery": (readModel) => <CatalogIntegrationLifecycleRecoveryWorkspace readModel={readModel} />,
  "governance-controls": (readModel) => <CatalogControlPlaneSettingsPage readModel={readModel} />,
  "audit-evidence": (readModel) => <CatalogIntegrationAuditEvidenceWorkspace readModel={readModel} />,
};

// Render the workspaces for a route surface, in IA order. The daily route passes
// a single workspace; the other three pass their grouped workspaces. Optional
// slots (alias-review visibility) are threaded to the workspace that consumes
// them; workspaces that ignore the slots render unchanged.
export function renderCatalogWorkbenchSurfaceWorkspaces(
  readModel: CatalogPrimaryWorkbenchReadModel,
  workspaceKeys: readonly CatalogControlPlaneWorkspaceKey[],
  slots: CatalogPrimaryWorkbenchWorkspaceSlots = {},
): readonly ReactElement[] {
  return workspaceKeys.map((workspaceKey) => {
    const renderWorkspace = CATALOG_PRIMARY_WORKBENCH_WORKSPACE_RENDERERS[workspaceKey];
    return <Box key={workspaceKey}>{renderWorkspace(readModel, slots)}</Box>;
  });
}
