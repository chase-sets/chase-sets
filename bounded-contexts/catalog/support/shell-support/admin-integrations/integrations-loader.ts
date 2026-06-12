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
  buildCatalogPrimaryWorkbenchReadModel,
  buildCatalogPrimaryWorkbenchSourceObservationReviewQuery,
} from "../../../features/source-observations/ui/primary-workbench-read-model";
import type { CatalogPrimaryWorkbenchCommandFeedback } from "../../../features/source-observations/ui/primary-workbench-page";
import { createCatalogRequestApiClient } from "../../../support/request-support/api-client";
import { loadCatalogListRouteData } from "../../../support/shell-support/list-query-state";

export async function loader({ request }: LoaderFunctionArgs) {
  const api = createCatalogRequestApiClient(request);
  const [routeData, profileReviews, controlPlaneOverview] = await Promise.all([
    loadCatalogListRouteData<SourceObservationIntegrationScope>(request, (query) =>
      api.listSourceObservationIntegrationScopes(query),
    ),
    api.listSourceObservationProviderProfiles<ListResponse<CatalogProviderProfileVersionReview>>(),
    api.getCatalogIntegrationControlPlaneOverview<CatalogIntegrationControlPlaneOverview>(),
  ]);
  const preliminaryReadModel = buildCatalogPrimaryWorkbenchReadModel({
    requestUrl: request.url,
    scopes: routeData.data,
    profileReviews,
    controlPlaneOverview,
    canManageCatalog: true,
  });
  const profileAuthoringModel = await selectedProviderProfileAuthoringModel(api, preliminaryReadModel.routeContext);
  const lifecycleImpacts = await selectedProviderProfileLifecycleImpacts(api, preliminaryReadModel.routeContext);
  const reviewPagination = { limit: 25, offset: 0 };
  const reviewQuery = buildCatalogPrimaryWorkbenchSourceObservationReviewQuery(
    preliminaryReadModel.routeContext,
    reviewPagination,
  );
  const reviewObservations = reviewQuery
    ? await api.listSourceObservations<ListResponse<SourceObservationListItem>>(reviewQuery)
    : null;
  const readModel = buildCatalogPrimaryWorkbenchReadModel({
    requestUrl: request.url,
    scopes: routeData.data,
    profileReviews,
    profileAuthoringModel,
    lifecycleImpacts,
    controlPlaneOverview,
    reviewObservations,
    reviewPagination,
    canManageCatalog: true,
  });
  await recordCatalogControlPlaneEvents(api, loaderTelemetryEvents(readModel));

  return {
    ...routeData,
    profileReviews,
    profileAuthoringModel,
    lifecycleImpacts,
    controlPlaneOverview,
    reviewObservations,
    reviewPagination,
    readModel,
    requestUrl: request.url,
    commandFeedback: commandFeedbackFromUrl(request.url),
  };
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

export function commandFeedbackFromUrl(url: string | URL): CatalogPrimaryWorkbenchCommandFeedback | null {
  const parsedUrl = typeof url === "string" ? new URL(url) : url;
  const status = parsedUrl.searchParams.get("commandStatus");
  const result = parsedUrl.searchParams.get("commandResult");
  const intent = parsedUrl.searchParams.get("commandIntent") ?? "unknown";

  if ((status !== "success" && status !== "error") || !isCommandFeedbackResult(result)) {
    return null;
  }

  return { status, intent, result };
}

function isCommandFeedbackResult(value: string | null): value is CatalogPrimaryWorkbenchCommandFeedback["result"] {
  return (
    value === "job-queued" ||
    value === "job-cancelled" ||
    value === "preview-ready" ||
    value === "draft-created" ||
    value === "profile-activated" ||
    value === "profile-rolled-back" ||
    value === "profile-deprecated" ||
    value === "profile-retired" ||
    value === "section-saved" ||
    value === "section-conflict" ||
    value === "section-invalid" ||
    value === "lifecycle-conflict" ||
    value === "confirmation-required" ||
    value === "preview-required" ||
    value === "job-required" ||
    value === "reason-required" ||
    value === "unsupported-command" ||
    value === "invalid-intent" ||
    value === "command-failed"
  );
}
