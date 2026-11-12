import type { LoaderFunctionArgs } from "react-router";
import type {
  CatalogSyncRun,
  CatalogScopeSyncUnitStateReadModel,
} from "../../../features/source-observations/ui/contracts";
import type { CatalogSyncScope } from "../../../features/source-observations/api/catalog-sync-scope-planner";
import type {
  CatalogPrimaryWorkbenchReadModel,
  CatalogPrimaryWorkbenchRouteContext,
} from "../../../features/source-observations/api/primary-workbench-admin-contracts";
import { assertPrimaryWorkbenchSourceOptions } from "../../../features/source-observations/api/admin/primary-workbench-selection-contracts";
import type {
  CatalogPrimaryWorkbenchSurfaceKey,
  CatalogPrimaryWorkbenchSurfaceRead,
} from "../../../features/source-observations/api/admin/primary-workbench-surface-read";
import {
  loaderTelemetryEvents,
  recordCatalogControlPlaneEvents,
} from "../../../features/source-observations/ui/primary-workbench-telemetry";
import type { CatalogAliasReviewReadModel } from "../../../features/alias-equivalence/api/alias-review-admin-contracts";
import type { CatalogAttentionQueueReadModel } from "../../../features/attention-queue/api/contracts";
import {
  CATALOG_ATTENTION_QUEUE_UNAVAILABLE,
  resolveCatalogAttentionQueueResult,
  type CatalogDeferredAttentionQueueResult,
} from "./attention-queue-result";
import { createCatalogRequestApiClient } from "../../../support/request-support/api-client";
import type { CatalogDailyImportPreview } from "../../../features/source-observations/api/admin/daily-import-preview";
import { commandFeedbackFromUrl } from "./integrations-command-feedback";

// The integrations surfaces read their workbench from the Catalog API, which
// composes it from its own services (see `primary-workbench-surface-read.ts`).
// These loaders pass the route location, record loader telemetry, and stream the
// supplementary panels behind Suspense so the shell paints first.
async function loadSurface(
  request: Request,
  surface: CatalogPrimaryWorkbenchSurfaceKey,
  api: ReturnType<typeof createCatalogRequestApiClient> = createCatalogRequestApiClient(request),
) {
  let surfaceRead = await api.getCatalogPrimaryWorkbenchSurface<CatalogPrimaryWorkbenchSurfaceRead>(
    surface,
    requestLocation(request),
  );
  try {
    assertPrimaryWorkbenchSourceOptions(surfaceRead.readModel.sourceOptions);
  } catch {
    surfaceRead = {
      ...surfaceRead,
      readModel: {
        ...surfaceRead.readModel,
        sourceOptions: {
          ...surfaceRead.readModel.sourceOptions,
          guidedFields: [],
          freeTextApplicable: false,
          contextSummary: null,
          status: "unavailable",
          freshness: "unavailable",
        },
      },
    };
  }
  await recordCatalogControlPlaneEvents(api, loaderTelemetryEvents(surfaceRead.readModel));

  return { api, surfaceRead };
}

function requestLocation(request: Request): string {
  const url = new URL(request.url);
  return `${url.pathname}${url.search}`;
}

// Daily import-to-promotion surface (/catalog/integrations). Awaits only the
// surface read, the data the shell, metric strip, and 3-stage flow paint from,
// and DEFERS the supplementary loads behind streamed promises: the populated
// source-option slice (~150-250 KB, feeds only the secondary status panel), the
// import preview, the sync run and scope sync state, the alias-review read model,
// and the attention queue. The read model's `sourceOptions` is its structural
// skeleton at first paint.
export async function loadDailySurface({ request }: LoaderFunctionArgs) {
  return loadDailySurfaceForRequest(request);
}

// Scope Detail composes the same daily journey against a synthetic, canonical
// Scope Record URL, so it shares this request-level entry point.
export async function loadDailySurfaceForRequest(request: Request) {
  const api = createCatalogRequestApiClient(request);
  // The source-option read starts alongside the surface read rather than after
  // it, so the status panel streams in as soon as the option pages resolve.
  const sourceOptionsRead = settledSourceOptionsRead(api, request);
  const { surfaceRead } = await loadSurface(request, "daily", api);
  const { readModel } = surfaceRead;

  return {
    readModel,
    requestUrl: request.url,
    commandFeedback: commandFeedbackFromUrl(request.url),
    // Streamed supplementary values. Each is a plain promise the route view
    // renders behind <Suspense>/<Await>; react-router serializes them so the
    // document flushes the shell first and the panels stream in. The fail-soft
    // boundary (null/empty on absence/error, or the attention queue's explicit
    // `unavailable` branch) lives INSIDE each promise, so a missing endpoint or
    // transient failure resolves to an absent or visibly degraded panel rather
    // than rejecting the boundary into an error page.
    deferredSourceOptions: sourceOptionsRead.then((sourceOptions) => sourceOptions ?? readModel.sourceOptions),
    deferredImportPreview: settledImportPreviewRead(api, request),
    deferredCatalogSyncRun: selectedCatalogSyncRun(api, readModel.routeContext),
    deferredScopeSyncState: selectedCatalogScopeSyncState(api, surfaceRead.catalogSyncScope),
    deferredAliasReview: selectedScopeAliasReview(api, readModel.routeContext),
    deferredAttentionQueue: selectedAttentionQueue(api),
  };
}

// Govern-and-recover surface (/catalog/integrations/governance and settings).
export async function loadGovernanceSurface({ request }: LoaderFunctionArgs) {
  const { surfaceRead } = await loadSurface(request, "governance");
  return surfaceRouteData(request, surfaceRead);
}

// Integration health surface (/catalog/integrations/health and the provider
// detail page, which composes from health).
export async function loadHealthSurface({ request }: LoaderFunctionArgs) {
  const { surfaceRead } = await loadSurface(request, "health");
  return surfaceRouteData(request, surfaceRead);
}

function surfaceRouteData(request: Request, surfaceRead: CatalogPrimaryWorkbenchSurfaceRead) {
  return {
    readModel: surfaceRead.readModel,
    providerRefreshSchedules: surfaceRead.providerRefreshSchedules,
    operatorSession: surfaceRead.operatorSession,
    operatorSessionActorKey: surfaceRead.operatorSessionActorKey,
    requestUrl: request.url,
    commandFeedback: commandFeedbackFromUrl(request.url),
  };
}

// The populated source-options slice, composed by the Catalog API from the
// complete option lists. Null when the read fails, so the panel keeps the
// skeleton the shell painted.
async function settledSourceOptionsRead(
  api: ReturnType<typeof createCatalogRequestApiClient>,
  request: Request,
): Promise<CatalogPrimaryWorkbenchReadModel["sourceOptions"] | null> {
  try {
    const sourceOptions = await api.getCatalogPrimaryWorkbenchDeferredSourceOptions<
      CatalogPrimaryWorkbenchReadModel["sourceOptions"]
    >(requestLocation(request));
    assertPrimaryWorkbenchSourceOptions(sourceOptions);
    return sourceOptions;
  } catch {
    return null;
  }
}

// Fetch the unified attention queue for the daily home surface. Like the
// alias review, it is supplementary "needs-you" context streamed behind an Await
// boundary, and it stays fail-soft for the import-to-promotion workflow: a
// missing endpoint (older API), a transport rejection, or a response the
// loader-local parser refuses resolves to `unavailable` — never a rejected
// boundary. Fail-soft means visible degradation, not silent absence: only a
// fully validated read model becomes `ready`, so the route can tell "nothing
// needs you" apart from "the queue could not be read".
async function selectedAttentionQueue(
  api: ReturnType<typeof createCatalogRequestApiClient>,
): Promise<CatalogDeferredAttentionQueueResult> {
  if (typeof api.getCatalogAttentionQueueReadModel !== "function") {
    return CATALOG_ATTENTION_QUEUE_UNAVAILABLE;
  }
  let response: unknown;
  try {
    response = await api.getCatalogAttentionQueueReadModel<CatalogAttentionQueueReadModel>();
  } catch {
    return CATALOG_ATTENTION_QUEUE_UNAVAILABLE;
  }
  return resolveCatalogAttentionQueueResult(response);
}

// The supplementary read owns every preview rule; transport failure stays absent.
async function settledImportPreviewRead(
  api: ReturnType<typeof createCatalogRequestApiClient>,
  request: Request,
): Promise<CatalogDailyImportPreview> {
  try {
    return await api.getCatalogPrimaryWorkbenchDeferredImportPreview(requestLocation(request));
  } catch {
    return null;
  }
}

async function selectedCatalogSyncRun(
  api: ReturnType<typeof createCatalogRequestApiClient>,
  context: CatalogPrimaryWorkbenchRouteContext,
): Promise<CatalogSyncRun | null> {
  if (!context.jobId || typeof api.getCatalogSyncRun !== "function") {
    return null;
  }

  try {
    return await api.getCatalogSyncRun<CatalogSyncRun>(context.jobId);
  } catch {
    return null;
  }
}

// The durable per-scope sync state (survives across runs), keyed off the Catalog
// sync scope the surface read names: the same scope the "Sync scope" action
// submits, so the state panel and the fan-out always agree on which scope they mean.
async function selectedCatalogScopeSyncState(
  api: ReturnType<typeof createCatalogRequestApiClient>,
  scope: CatalogSyncScope | null,
): Promise<readonly CatalogScopeSyncUnitStateReadModel[] | null> {
  if (!scope || typeof api.getCatalogSyncScopeState !== "function") {
    return null;
  }

  try {
    const response = await api.getCatalogSyncScopeState<{ items?: readonly CatalogScopeSyncUnitStateReadModel[] }>(
      scope,
    );
    return response.items ?? null;
  } catch {
    return null;
  }
}

// Fetch the alias-review read model for the selected provider/profile scope
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
