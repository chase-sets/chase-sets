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
  buildCatalogPrimaryWorkbenchDeferredSourceOptions,
  buildCatalogPrimaryWorkbenchReadModelForSurface,
  buildCatalogPrimaryWorkbenchSourceOptionRequests,
  buildCatalogPrimaryWorkbenchSourceObservationReviewQuery,
  type CatalogPrimaryWorkbenchSourceOptionPageSnapshot,
} from "../../../features/source-observations/ui/primary-workbench-read-model";
import type { CatalogPrimaryWorkbenchReadModel } from "../../../features/source-observations/api/primary-workbench-admin-contracts";
import {
  catalogPrimaryWorkbenchHref,
  parseCatalogPrimaryWorkbenchRouteContext,
} from "../../../features/source-observations/ui/primary-workbench-route-context";
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
// impacts; health → none beyond the baseline).
type CatalogIntegrationsBaseline = Readonly<{
  routeData: Awaited<ReturnType<typeof loadCatalogListRouteData<SourceObservationIntegrationScope>>>;
  profileReviews: ListResponse<CatalogProviderProfileVersionReview>;
  controlPlaneOverview: CatalogIntegrationControlPlaneOverview | null;
  canManageCatalog: boolean;
}>;

// The daily import surface consumes only `readiness`, `unitActivity`, and
// `providerReadiness` from the control-plane overview (the metric strip, the
// import-jobs activity strip, and the provider-scope selector); it never reads the
// audit-lifecycle entries, which feed only the governance/release evidence slices.
// So the daily loader requests the audit-trimmed `daily` overview (#1972) — skipping
// the server-side audit projection and ~11% of the at-scale payload — while the
// providers/governance/release surfaces keep fetching the `full` overview their
// evidence slices cite.
type CatalogIntegrationsBaselineAudience = "full" | "daily";

async function loadIntegrationsBaseline(
  request: Request,
  audience: CatalogIntegrationsBaselineAudience = "full",
): Promise<{
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
    api.getCatalogIntegrationControlPlaneOverview<CatalogIntegrationControlPlaneOverview>(audience),
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
}) {
  // The source-option fan-out is no longer fetched here: every surface builds its
  // read model without the option pages, so `sourceOptions` is the structural
  // skeleton. The daily surface streams the populated slice separately (#1970);
  // the other surfaces do not render the status panel at all.
  const readModel = buildCatalogPrimaryWorkbenchReadModelForSurface(input.surface, {
    requestUrl: input.request.url,
    scopes: input.baseline.routeData.data,
    profileReviews: input.baseline.profileReviews,
    profileAuthoringModel: input.profileAuthoringModel ?? null,
    lifecycleImpacts: input.lifecycleImpacts ?? null,
    controlPlaneOverview: input.baseline.controlPlaneOverview,
    reviewObservations: input.reviewObservations ?? null,
    reviewPagination: input.reviewPagination,
    sourceOptionPages: null,
    canManageCatalog: input.baseline.canManageCatalog,
  });
  await recordCatalogControlPlaneEvents(input.api, loaderTelemetryEvents(readModel));

  return {
    readModel,
    requestUrl: input.request.url,
    commandFeedback: commandFeedbackFromUrl(input.request.url),
  };
}

// Daily import-to-promotion surface (/admin/integrations). Awaits only the
// baseline plus the paginated Source Observation review wave — the data the
// shell, metric strip, and 3-stage flow paint from — and DEFERS the supplementary
// loads behind streamed promises (#1970): the source-option fan-out (~150–250 KB,
// feeds only the secondary status panel) and the alias-review read model
// (supplementary pre-promotion context). The read model is built without the
// option pages, so `sourceOptions` is its structural skeleton (declared kinds +
// not-loaded pages) at first paint; the populated slice streams in behind a
// Suspense boundary. It never fetches the selected authoring model or lifecycle
// impacts, and the read model never computes the governance, lifecycle, release,
// or audit sub-models.
export async function loadDailySurface({ request }: LoaderFunctionArgs) {
  const { api, baseline, routeContext } = await loadIntegrationsBaseline(request, "daily");
  const normalizedRouteContext = normalizedDailyRouteContext(request, baseline, routeContext);
  const reviewRouteContext = routeContext.providerKey ? normalizedRouteContext : routeContext;
  const reviewPagination = dailyReviewPaginationFor(reviewRouteContext);
  const reviewQuery = buildCatalogPrimaryWorkbenchSourceObservationReviewQuery(reviewRouteContext, reviewPagination);
  const reviewObservations = reviewQuery
    ? await api.listSourceObservations<ListResponse<SourceObservationListItem>>(reviewQuery)
    : null;

  const { readModel, requestUrl, commandFeedback } = await finalizeSurfaceLoad({
    api,
    request,
    surface: "daily",
    baseline,
    reviewObservations,
    reviewPagination,
  });

  return {
    readModel,
    requestUrl,
    commandFeedback,
    // Streamed supplementary values. Each is a plain promise the route view
    // renders behind <Suspense>/<Await>; react-router serializes them so the
    // document flushes the shell first and the panels stream in. The fail-soft
    // boundary (null/empty on absence/error) lives INSIDE each promise, so a
    // missing endpoint or transient failure resolves to an empty/absent panel
    // rather than rejecting the boundary into an error page.
    deferredSourceOptions: deferredSourceOptionsSlice(
      api,
      request,
      baseline,
      readModel.routeContext,
      readModel.sourceOptions,
    ),
    deferredAliasReview: selectedScopeAliasReview(api, readModel.routeContext),
  };
}

function normalizedDailyRouteContext(
  request: Request,
  baseline: CatalogIntegrationsBaseline,
  routeContext: CatalogPrimaryWorkbenchRouteContext,
): CatalogPrimaryWorkbenchRouteContext {
  return buildCatalogPrimaryWorkbenchReadModelForSurface("daily", {
    requestUrl: request.url,
    scopes: baseline.routeData.data,
    profileReviews: baseline.profileReviews,
    controlPlaneOverview: baseline.controlPlaneOverview,
    reviewObservations: null,
    reviewPagination: dailyReviewPaginationFor(routeContext),
    sourceOptionPages: null,
    canManageCatalog: baseline.canManageCatalog,
  }).routeContext;
}

// Resolve the streamed source-options slice: fetch the option fan-out (fail-soft
// per page, as `selectedProviderSourceOptionPages` already guarantees) and build
// the populated `sourceOptions` slice from the same baseline inputs the shell's
// skeleton was derived from. Returning the fully-built slice (not the raw pages)
// keeps the large provider option snapshots out of the browser payload while the
// status panel consumes a ready-to-render value behind its Await boundary.
async function deferredSourceOptionsSlice(
  api: ReturnType<typeof createCatalogRequestApiClient>,
  request: Request,
  baseline: CatalogIntegrationsBaseline,
  routeContext: CatalogPrimaryWorkbenchRouteContext,
  fallbackSourceOptions: CatalogPrimaryWorkbenchReadModel["sourceOptions"],
): Promise<CatalogPrimaryWorkbenchReadModel["sourceOptions"]> {
  try {
    const sourceOptionPages = await selectedProviderSourceOptionPages(api, request, baseline, routeContext);
    const normalizedRequestUrl = new URL(catalogPrimaryWorkbenchHref(routeContext), request.url).toString();

    return buildCatalogPrimaryWorkbenchDeferredSourceOptions({
      requestUrl: normalizedRequestUrl,
      scopes: baseline.routeData.data,
      profileReviews: baseline.profileReviews,
      controlPlaneOverview: baseline.controlPlaneOverview,
      sourceOptionPages,
      canManageCatalog: baseline.canManageCatalog,
    });
  } catch {
    return fallbackSourceOptions;
  }
}

// Resolve the Source Observation review page window from the durable, URL-backed
// pager cursor (reviewOffset/reviewLimit) the route context carries. The offset
// and limit are already parsed and validated as non-negative/positive integers;
// here we only clamp the page size to a sane band and snap the offset onto a page
// boundary so the daily loader and the pager hrefs agree on every reachable page.
const dailyReviewPageSize = 25;
const dailyReviewMaxPageSize = 100;

function dailyReviewPaginationFor(
  routeContext: CatalogPrimaryWorkbenchRouteContext,
): Readonly<{ limit: number; offset: number }> {
  const limit = Math.min(Math.max(routeContext.reviewLimit ?? dailyReviewPageSize, 1), dailyReviewMaxPageSize);
  const requestedOffset = Math.max(routeContext.reviewOffset ?? 0, 0);
  const offset = Math.floor(requestedOffset / limit) * limit;

  return { limit, offset };
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

// Integration health surface (/admin/integrations/health). Loads the baseline
// plus the selected profile authoring model and lifecycle impacts that the audit
// timeline slice folds in (it cites validation readiness and lifecycle
// recovery); the review wave is not fetched.
export async function loadHealthSurface({ request }: LoaderFunctionArgs) {
  const { api, baseline, routeContext } = await loadIntegrationsBaseline(request);
  const [profileAuthoringModel, lifecycleImpacts] = await Promise.all([
    selectedProviderProfileAuthoringModel(api, routeContext),
    selectedProviderProfileLifecycleImpacts(api, routeContext),
  ]);

  return finalizeSurfaceLoad({
    api,
    request,
    surface: "health",
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
    // governance, and health surfaces render the author-a-profile path instead
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
  const requestsToResolve =
    refreshIntent?.queryKind && refreshIntent.action !== "force-refresh-all"
      ? requests.filter((sourceOptionRequest) => sourceOptionRequest.queryKind === refreshIntent.queryKind)
      : requests;

  return Promise.all(
    requestsToResolve.map(async (sourceOptionRequest): Promise<CatalogPrimaryWorkbenchSourceOptionPageSnapshot> => {
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
