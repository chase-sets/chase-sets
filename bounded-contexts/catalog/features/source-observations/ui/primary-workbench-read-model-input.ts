import type { ListResponse } from "@chase-sets/http/responses";
import type { CatalogAdminRollbackRetirementImpactSummaryReadModel } from "../api/admin-control-plane-read-model-contracts";
import type { CatalogPrimaryWorkbenchLifecycleOperation } from "../api/primary-workbench-admin-contracts";
import type {
  CatalogIntegrationControlPlaneOverview,
  CatalogMergeCandidateListItem,
  CatalogProviderProfileAuthoringModel,
  CatalogProviderProfileVersionReview,
  SourceObservationIntegrationScope,
  SourceObservationListItem,
} from "./contracts";
import type { CatalogPrimaryWorkbenchSourceOptionPageSnapshot } from "./primary-workbench-source-options";

export type CatalogPrimaryWorkbenchReadModelFailure =
  | "control-plane-overview"
  | "integration-scopes"
  | "merge-candidate-review"
  | "provider-profiles"
  | "source-observation-review";

export type CatalogPrimaryWorkbenchInput = Readonly<{
  requestUrl: string | URL;
  scopes: ListResponse<SourceObservationIntegrationScope>;
  profileReviews: ListResponse<CatalogProviderProfileVersionReview>;
  profileAuthoringModel?: CatalogProviderProfileAuthoringModel | null;
  controlPlaneOverview: CatalogIntegrationControlPlaneOverview | null;
  readModelFailures?: readonly CatalogPrimaryWorkbenchReadModelFailure[];
  lifecycleImpacts?: Partial<
    Record<CatalogPrimaryWorkbenchLifecycleOperation, CatalogAdminRollbackRetirementImpactSummaryReadModel>
  > | null;
  sourceOptionPages?: readonly CatalogPrimaryWorkbenchSourceOptionPageSnapshot[] | null;
  reviewObservations?: ListResponse<SourceObservationListItem> | null;
  mergeCandidates?: ListResponse<CatalogMergeCandidateListItem> | null;
  reviewPagination?: Readonly<{ limit: number; offset: number }>;
  canManageCatalog: boolean;
}>;
