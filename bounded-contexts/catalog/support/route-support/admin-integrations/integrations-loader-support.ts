import type { ListResponse } from "@chase-sets/http/responses";
import type { LoaderFunctionArgs } from "react-router";
import type {
  CatalogProviderProfileVersionReview,
  SourceObservationIntegrationScope,
  SourceObservationListItem,
} from "../../../client";
import type {
  CatalogPrimaryWorkbenchLifecycleOperation,
  CatalogPrimaryWorkbenchRouteContext,
} from "../../../features/source-observations/api/primary-workbench-admin-contracts";
import type { CatalogAdminRollbackRetirementImpactSummaryReadModel } from "../../../features/source-observations/api/admin-control-plane-read-model-contracts";
import type {
  CatalogProviderProfileAuthoringModel,
  CatalogIntegrationControlPlaneOverview,
} from "../../../features/source-observations/ui/contracts";
import {
  loaderTelemetryEvents,
  recordCatalogControlPlaneEvents,
} from "../../../features/source-observations/ui/primary-workbench-telemetry";
import {
  buildCatalogPrimaryWorkbenchReadModelForSurface,
  buildCatalogPrimaryWorkbenchSourceObservationReviewQuery,
} from "../../../features/source-observations/ui/primary-workbench-read-model";
import { parseCatalogPrimaryWorkbenchRouteContext } from "../../../features/source-observations/ui/primary-workbench-route-context";
import type { CatalogControlPlaneRouteSurfaceKey } from "../../../features/source-observations/ui/admin-control-plane/information-architecture";
import type { CatalogPrimaryWorkbenchCommandFeedback } from "../../../features/source-observations/ui/primary-workbench-page";
import { createCatalogRequestApiClient } from "../../../support/request-support/api-client";
import { loadCatalogListRouteData } from "../../../support/shell-support/list-query-state";
import { commandFeedbackFromUrl } from "./integrations-command-feedback";

// Provider profiles + the control plane overview are the shared baseline every
// integrations surface route needs: the cross-surface metric strip, navigation,
// and readiness summary are derived from them on all four routes. Each route adds
// only the extra API waves its own surface slices consume (daily → review
// observations; providers → the selected authoring model; governance → lifecycle
// impacts; release → none beyond the baseline).
type CatalogIntegrationsBaseline = Readonly<{
  routeData: Awaited<ReturnType<typeof loadCatalogListRouteData<SourceObservationIntegrationScope>>>;
  profileReviews: ListResponse<CatalogProviderProfileVersionReview>;
  controlPlaneOverview: CatalogIntegrationControlPlaneOverview | null;
}>;

async function loadIntegrationsBaseline(request: Request): Promise<{
  api: ReturnType<typeof createCatalogRequestApiClient>;
  baseline: CatalogIntegrationsBaseline;
  routeContext: CatalogPrimaryWorkbenchRouteContext;
}> {
  const api = createCatalogRequestApiClient(request);
  const [routeData, profileReviews, controlPlaneOverview] = await Promise.all([
    loadCatalogListRouteData<SourceObservationIntegrationScope>(request, (query) =>
      api.listSourceObservationIntegrationScopes(query),
    ),
    api.listSourceObservationProviderProfiles<ListResponse<CatalogProviderProfileVersionReview>>(),
    api.getCatalogIntegrationControlPlaneOverview<CatalogIntegrationControlPlaneOverview>(),
  ]);

  return {
    api,
    baseline: { routeData, profileReviews, controlPlaneOverview },
    routeContext: parseCatalogPrimaryWorkbenchRouteContext(request.url),
  };
}

// Finalize a surface read model: record loader telemetry and return the route
// data shape the shared surface route view consumes. The per-surface read-model
// builder computes only the slices the given surface renders.
async function finalizeSurfaceLoad(input: {
  api: ReturnType<typeof createCatalogRequestApiClient>;
  request: Request;
  surface: CatalogControlPlaneRouteSurfaceKey;
  baseline: CatalogIntegrationsBaseline;
  profileAuthoringModel?: CatalogProviderProfileAuthoringModel | null;
  lifecycleImpacts?: Partial<
    Record<CatalogPrimaryWorkbenchLifecycleOperation, CatalogAdminRollbackRetirementImpactSummaryReadModel>
  > | null;
  reviewObservations?: ListResponse<SourceObservationListItem> | null;
  reviewPagination?: Readonly<{ limit: number; offset: number }>;
}) {
  const readModel = buildCatalogPrimaryWorkbenchReadModelForSurface(input.surface, {
    requestUrl: input.request.url,
    scopes: input.baseline.routeData.data,
    profileReviews: input.baseline.profileReviews,
    profileAuthoringModel: input.profileAuthoringModel ?? null,
    lifecycleImpacts: input.lifecycleImpacts ?? null,
    controlPlaneOverview: input.baseline.controlPlaneOverview,
    reviewObservations: input.reviewObservations ?? null,
    reviewPagination: input.reviewPagination,
    canManageCatalog: true,
  });
  await recordCatalogControlPlaneEvents(input.api, loaderTelemetryEvents(readModel));

  return {
    ...input.baseline.routeData,
    profileReviews: input.baseline.profileReviews,
    profileAuthoringModel: input.profileAuthoringModel ?? undefined,
    lifecycleImpacts: input.lifecycleImpacts ?? undefined,
    controlPlaneOverview: input.baseline.controlPlaneOverview,
    reviewObservations: input.reviewObservations ?? undefined,
    reviewPagination: input.reviewPagination,
    readModel,
    requestUrl: input.request.url,
    commandFeedback: commandFeedbackFromUrl(input.request.url),
  };
}

// Daily import-to-promotion surface (/admin/integrations). Loads the baseline
// plus the paginated Source Observation review wave; it never fetches the
// selected authoring model or lifecycle impacts, and the read model never
// computes the governance, lifecycle, release, or audit sub-models.
export async function loadDailySurface({ request }: LoaderFunctionArgs) {
  const { api, baseline, routeContext } = await loadIntegrationsBaseline(request);
  const reviewPagination = { limit: 25, offset: 0 };
  const reviewQuery = buildCatalogPrimaryWorkbenchSourceObservationReviewQuery(routeContext, reviewPagination);
  const reviewObservations = reviewQuery
    ? await api.listSourceObservations<ListResponse<SourceObservationListItem>>(reviewQuery)
    : null;

  return finalizeSurfaceLoad({
    api,
    request,
    surface: "daily",
    baseline,
    reviewObservations,
    reviewPagination,
  });
}

// Provider profiles + readiness surface (/admin/integrations/providers). Loads
// the baseline plus the selected provider profile authoring model that the
// validation readiness slice needs; it does not fetch the review wave or
// lifecycle impacts.
export async function loadProvidersSurface({ request }: LoaderFunctionArgs) {
  const { api, baseline, routeContext } = await loadIntegrationsBaseline(request);
  const profileAuthoringModel = await selectedProviderProfileAuthoringModel(api, routeContext);

  return finalizeSurfaceLoad({
    api,
    request,
    surface: "providers",
    baseline,
    profileAuthoringModel,
  });
}

// Govern-and-recover surface (/admin/integrations/governance). Loads the baseline
// plus the selected profile lifecycle impacts and authoring model. Lifecycle
// recovery's activation operation folds in validation readiness, which derives
// from the authoring model, so it is fetched here to render identically; the
// review wave is not.
export async function loadGovernanceSurface({ request }: LoaderFunctionArgs) {
  const { api, baseline, routeContext } = await loadIntegrationsBaseline(request);
  const [profileAuthoringModel, lifecycleImpacts] = await Promise.all([
    selectedProviderProfileAuthoringModel(api, routeContext),
    selectedProviderProfileLifecycleImpacts(api, routeContext),
  ]);

  return finalizeSurfaceLoad({
    api,
    request,
    surface: "governance",
    baseline,
    profileAuthoringModel,
    lifecycleImpacts,
  });
}

// Release evidence and health surface (/admin/integrations/release). Loads the
// baseline plus the selected profile authoring model and lifecycle impacts that
// the audit evidence slice folds in (it cites validation readiness and lifecycle
// recovery); the review wave is not fetched.
export async function loadReleaseSurface({ request }: LoaderFunctionArgs) {
  const { api, baseline, routeContext } = await loadIntegrationsBaseline(request);
  const [profileAuthoringModel, lifecycleImpacts] = await Promise.all([
    selectedProviderProfileAuthoringModel(api, routeContext),
    selectedProviderProfileLifecycleImpacts(api, routeContext),
  ]);

  return finalizeSurfaceLoad({
    api,
    request,
    surface: "release",
    baseline,
    profileAuthoringModel,
    lifecycleImpacts,
  });
}

async function selectedProviderProfileAuthoringModel(
  api: ReturnType<typeof createCatalogRequestApiClient>,
  context: CatalogPrimaryWorkbenchRouteContext,
): Promise<CatalogProviderProfileAuthoringModel | null> {
  if (!context.providerKey || !context.profileVersion) {
    return null;
  }

  return api.getSourceObservationProviderProfileAuthoringModel<CatalogProviderProfileAuthoringModel>(
    context.providerKey,
    context.profileVersion,
  );
}

async function selectedProviderProfileLifecycleImpacts(
  api: ReturnType<typeof createCatalogRequestApiClient>,
  context: CatalogPrimaryWorkbenchRouteContext,
): Promise<Partial<
  Record<CatalogPrimaryWorkbenchLifecycleOperation, CatalogAdminRollbackRetirementImpactSummaryReadModel>
> | null> {
  if (!context.providerKey || !context.profileVersion) {
    return null;
  }
  if (typeof api.getSourceObservationProviderProfileLifecycleImpact !== "function") {
    return null;
  }

  const providerKey = context.providerKey;
  const profileVersion = context.profileVersion;
  const operations: readonly CatalogPrimaryWorkbenchLifecycleOperation[] = [
    "activation",
    "rollback",
    "deprecate",
    "retire",
  ];
  const results = await Promise.allSettled(
    operations.map(async (operation) => ({
      operation,
      impact:
        await api.getSourceObservationProviderProfileLifecycleImpact<CatalogAdminRollbackRetirementImpactSummaryReadModel>(
          providerKey,
          profileVersion,
          operation,
        ),
    })),
  );
  const impacts: Partial<
    Record<CatalogPrimaryWorkbenchLifecycleOperation, CatalogAdminRollbackRetirementImpactSummaryReadModel>
  > = {};
  for (const result of results) {
    if (result.status === "fulfilled") {
      impacts[result.value.operation] = result.value.impact;
    }
  }

  return impacts;
}
