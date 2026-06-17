import type { ListResponse } from "@chase-sets/http/responses";
import { resolveActorFromAuthApi } from "@chase-sets/platform-runtime/auth";
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
  SourceObservationIntegrationOptionResponse,
} from "../../../features/source-observations/ui/contracts";
import {
  loaderTelemetryEvents,
  recordCatalogControlPlaneEvents,
} from "../../../features/source-observations/ui/primary-workbench-telemetry";
import {
  buildCatalogPrimaryWorkbenchReadModelForSurface,
  buildCatalogPrimaryWorkbenchSourceOptionRequests,
  buildCatalogPrimaryWorkbenchSourceObservationReviewQuery,
  type CatalogPrimaryWorkbenchSourceOptionPageSnapshot,
} from "../../../features/source-observations/ui/primary-workbench-read-model";
import { parseCatalogPrimaryWorkbenchRouteContext } from "../../../features/source-observations/ui/primary-workbench-route-context";
import {
  catalogPrimaryWorkbenchSourceOptionForcesRefresh,
  parseCatalogPrimaryWorkbenchSourceOptionIntent,
} from "../../../features/source-observations/ui/primary-workbench-source-option-refresh";
import type { CatalogControlPlaneRouteSurfaceKey } from "../../../features/source-observations/ui/admin-control-plane/information-architecture";
import type { CatalogPrimaryWorkbenchCommandFeedback } from "../../../features/source-observations/ui/primary-workbench-command-feedback";
import type { CatalogAliasReviewReadModel } from "../../../features/alias-equivalence/api/alias-review-admin-contracts";
import { CatalogApiError } from "../../../client";
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
  canManageCatalog: boolean;
}>;

async function loadIntegrationsBaseline(request: Request): Promise<{
  api: ReturnType<typeof createCatalogRequestApiClient>;
  baseline: CatalogIntegrationsBaseline;
  routeContext: CatalogPrimaryWorkbenchRouteContext;
}> {
  const api = createCatalogRequestApiClient(request);
  const [routeData, profileReviews, controlPlaneOverview, actor] = await Promise.all([
    loadCatalogListRouteData<SourceObservationIntegrationScope>(request, (query) =>
      api.listSourceObservationIntegrationScopes(query),
    ),
    api.listSourceObservationProviderProfiles<ListResponse<CatalogProviderProfileVersionReview>>(),
    api.getCatalogIntegrationControlPlaneOverview<CatalogIntegrationControlPlaneOverview>(),
    resolveActorFromAuthApi({ request }),
  ]);

  return {
    api,
    baseline: {
      routeData,
      profileReviews,
      controlPlaneOverview,
      canManageCatalog: actor?.permissions.includes("catalog.manage") ?? false,
    },
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
  sourceOptionPages?: readonly CatalogPrimaryWorkbenchSourceOptionPageSnapshot[] | null;
  aliasReview?: CatalogAliasReviewReadModel | null;
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
    sourceOptionPages: input.sourceOptionPages ?? null,
    canManageCatalog: input.baseline.canManageCatalog,
  });
  await recordCatalogControlPlaneEvents(input.api, loaderTelemetryEvents(readModel));

  return {
    readModel,
    requestUrl: input.request.url,
    commandFeedback: commandFeedbackFromUrl(input.request.url),
    aliasReview: input.aliasReview ?? null,
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
  const [reviewObservations, sourceOptionPages, aliasReview] = await Promise.all([
    reviewQuery ? api.listSourceObservations<ListResponse<SourceObservationListItem>>(reviewQuery) : null,
    selectedProviderSourceOptionPages(api, request, baseline, routeContext),
    selectedScopeAliasReview(api, routeContext),
  ]);

  return finalizeSurfaceLoad({
    api,
    request,
    surface: "daily",
    baseline,
    reviewObservations,
    reviewPagination,
    sourceOptionPages,
    aliasReview,
  });
}

// Fetch the #1908 alias-review read model for the selected provider/profile scope
// so the daily surface can surface alias candidates before promotion. Alias
// review is supplementary context: a missing endpoint (older API) or a transient
// failure must never break the import-to-promotion workflow, so this resolves to
// null on absence/error.
async function selectedScopeAliasReview(
  api: ReturnType<typeof createCatalogRequestApiClient>,
  context: CatalogPrimaryWorkbenchRouteContext,
): Promise<CatalogAliasReviewReadModel | null> {
  if (typeof api.getCatalogAliasReviewReadModel !== "function") {
    return null;
  }

  const query = new URLSearchParams();
  if (context.providerKey) {
    query.set("providerKey", context.providerKey);
  }
  if (context.profileVersion) {
    query.set("sourceProfileVersion", context.profileVersion);
  }

  try {
    return await api.getCatalogAliasReviewReadModel<CatalogAliasReviewReadModel>(query.toString());
  } catch {
    return null;
  }
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

  try {
    return await api.getSourceObservationProviderProfileAuthoringModel<CatalogProviderProfileAuthoringModel>(
      context.providerKey,
      context.profileVersion,
    );
  } catch (error) {
    // A deep-link from a missing/invalid-profile blocker can carry a provider +
    // a stale/unknown profileVersion. The backend answers that with 404; treat
    // it as the existing "no authoring model" absent state so the providers,
    // governance, and release surfaces render the author-a-profile path instead
    // of crashing. Genuine 5xx / unexpected errors still propagate.
    if (error instanceof CatalogApiError && error.status === 404) {
      return null;
    }
    throw error;
  }
}

async function selectedProviderSourceOptionPages(
  api: ReturnType<typeof createCatalogRequestApiClient>,
  request: Request,
  baseline: CatalogIntegrationsBaseline,
  routeContext: CatalogPrimaryWorkbenchRouteContext,
): Promise<readonly CatalogPrimaryWorkbenchSourceOptionPageSnapshot[]> {
  if (typeof api.listSourceObservationIntegrationOptions !== "function") {
    return [];
  }

  const requests = buildCatalogPrimaryWorkbenchSourceOptionRequests({
    requestUrl: request.url,
    scopes: baseline.routeData.data.items,
    profiles: baseline.profileReviews.items,
    routeContext,
    cacheOnly: true,
  });
  // A workbench reload stays cache-only; a per-group or refresh-all intent escalates
  // the matching request(s) to the force-refresh (live) query the read model exposes.
  const refreshIntent = parseCatalogPrimaryWorkbenchSourceOptionIntent(request.url);

  return Promise.all(
    requests.map(async (sourceOptionRequest): Promise<CatalogPrimaryWorkbenchSourceOptionPageSnapshot> => {
      if (
        sourceOptionRequest.parentRequired &&
        sourceOptionRequest.parentScope !== null &&
        !sourceOptionRequest.selectedParentValue
      ) {
        return { request: sourceOptionRequest };
      }

      const forceRefresh = catalogPrimaryWorkbenchSourceOptionForcesRefresh(
        refreshIntent,
        sourceOptionRequest.queryKind,
      );
      const href =
        forceRefresh && sourceOptionRequest.refreshHref
          ? sourceOptionRequest.refreshHref
          : sourceOptionRequest.queryHref;

      try {
        const query = new URL(href, request.url).searchParams.toString();
        const response =
          await api.listSourceObservationIntegrationOptions<SourceObservationIntegrationOptionResponse>(query);
        return { request: sourceOptionRequest, response };
      } catch (error) {
        return { request: sourceOptionRequest, error: sourceOptionPageError(error) };
      }
    }),
  );
}

function sourceOptionPageError(error: unknown): CatalogPrimaryWorkbenchSourceOptionPageSnapshot["error"] {
  if (error instanceof CatalogApiError) {
    const parsed = catalogApiErrorBody(error.body);
    return {
      status: error.status,
      code: parsed.code,
      message: parsed.message,
      rolloutBlocked: error.status === 403 && parsed.code === "catalog_integration_rollout_control_denied",
    };
  }

  return {
    status: null,
    code: "catalog_provider_option_query_unavailable",
    message: error instanceof Error ? error.message : "Provider source options are unavailable.",
    rolloutBlocked: false,
  };
}

function catalogApiErrorBody(body: unknown): Readonly<{ code: string; message: string }> {
  if (typeof body !== "object" || body === null || !("error" in body)) {
    return {
      code: "catalog_provider_option_query_unavailable",
      message: "Provider source options are unavailable.",
    };
  }

  const errorBody = (body as Readonly<{ error?: unknown }>).error;
  if (typeof errorBody !== "object" || errorBody === null) {
    return {
      code: "catalog_provider_option_query_unavailable",
      message: String(errorBody ?? "Provider source options are unavailable."),
    };
  }

  const fields = errorBody as Readonly<Record<string, unknown>>;
  return {
    code:
      typeof fields.code === "string" && fields.code.trim()
        ? fields.code.trim()
        : "catalog_provider_option_query_unavailable",
    message:
      typeof fields.message === "string" && fields.message.trim()
        ? fields.message.trim()
        : "Provider source options are unavailable.",
  };
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
