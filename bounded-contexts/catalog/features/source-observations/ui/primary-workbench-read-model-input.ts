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
import type { CatalogSyncProviderParticipationPreview } from "../api/catalog-sync-scope-planner";
import type { CatalogPrimaryWorkbenchSourceOptionPageSnapshot } from "./primary-workbench-source-options";
import type { SourceObservationPromotionOutcomeRecord } from "../api/runtime";

export type CatalogPrimaryWorkbenchReadModelFailure =
  | "control-plane-overview"
  | "integration-scopes"
  | "merge-candidate-review"
  | "provider-profiles"
  | "source-observation-review";

export type CatalogPrimaryWorkbenchInput = Readonly<{
  requestUrl: string | URL;
  /** Injectable clock for freshness/age derivations (health triage); defaults to now. */
  now?: string;
  scopes: ListResponse<SourceObservationIntegrationScope>;
  profileReviews: ListResponse<CatalogProviderProfileVersionReview>;
  profileAuthoringModel?: CatalogProviderProfileAuthoringModel | null;
  controlPlaneOverview: CatalogIntegrationControlPlaneOverview | null;
  readModelFailures?: readonly CatalogPrimaryWorkbenchReadModelFailure[];
  lifecycleImpacts?: Partial<
    Record<CatalogPrimaryWorkbenchLifecycleOperation, CatalogAdminRollbackRetirementImpactSummaryReadModel>
  > | null;
  catalogSyncPreview?: CatalogSyncProviderParticipationPreview | null;
  sourceOptionPages?: readonly CatalogPrimaryWorkbenchSourceOptionPageSnapshot[] | null;
  reviewObservations?: ListResponse<SourceObservationListItem> | null;
  mergeCandidates?: ListResponse<CatalogMergeCandidateListItem> | null;
  promotionOutcome?: SourceObservationPromotionOutcomeRecord | null;
  reviewPagination?: Readonly<{ limit: number; offset: number }>;
  canManageCatalog: boolean;
}>;
