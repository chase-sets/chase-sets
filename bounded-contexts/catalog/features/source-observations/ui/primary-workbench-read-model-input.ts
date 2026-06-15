import type { ListResponse } from "@chase-sets/http/responses";
import type { CatalogAdminRollbackRetirementImpactSummaryReadModel } from "../api/admin-control-plane-read-model-contracts";
import type { CatalogIntegrationDataResetEvidencePacket } from "../api/catalog-integration-data-reset-evidence";
import type { CatalogPrimaryWorkbenchLifecycleOperation } from "../api/primary-workbench-admin-contracts";
import type {
  CatalogIntegrationControlPlaneOverview,
  CatalogProviderProfileAuthoringModel,
  CatalogProviderProfileVersionReview,
  SourceObservationIntegrationScope,
  SourceObservationListItem,
} from "./contracts";
import type { CatalogPrimaryWorkbenchTemporaryReleaseScaffoldingInput } from "./primary-workbench-clean-reset-release";
import type { CatalogPrimaryWorkbenchSourceOptionPageSnapshot } from "./primary-workbench-source-options";

export type CatalogPrimaryWorkbenchInput = Readonly<{
  requestUrl: string | URL;
  scopes: ListResponse<SourceObservationIntegrationScope>;
  profileReviews: ListResponse<CatalogProviderProfileVersionReview>;
  profileAuthoringModel?: CatalogProviderProfileAuthoringModel | null;
  controlPlaneOverview: CatalogIntegrationControlPlaneOverview | null;
  cleanResetEvidence?: CatalogIntegrationDataResetEvidencePacket | null;
  temporaryReleaseScaffolding?: readonly CatalogPrimaryWorkbenchTemporaryReleaseScaffoldingInput[] | null;
  lifecycleImpacts?: Partial<
    Record<CatalogPrimaryWorkbenchLifecycleOperation, CatalogAdminRollbackRetirementImpactSummaryReadModel>
  > | null;
  sourceOptionPages?: readonly CatalogPrimaryWorkbenchSourceOptionPageSnapshot[] | null;
  reviewObservations?: ListResponse<SourceObservationListItem> | null;
  reviewPagination?: Readonly<{ limit: number; offset: number }>;
  canManageCatalog: boolean;
}>;
