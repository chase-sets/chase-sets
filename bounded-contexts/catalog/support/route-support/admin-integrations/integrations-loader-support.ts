import type { LoaderFunctionArgs } from "react-router";
import type {
  CatalogSyncRun,
  CatalogScopeSyncUnitStateReadModel,
  SourceObservationIntegrationImportPreview,
  SourceObservationIntegrationJobScope,
} from "../../../features/source-observations/ui/contracts";
import type { CatalogSyncScope } from "../../../features/source-observations/api/catalog-sync-scope-planner";
import type {
  CatalogPrimaryWorkbenchReadModel,
  CatalogPrimaryWorkbenchRouteContext,
} from "../../../features/source-observations/api/primary-workbench-admin-contracts";
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
import { integrationScopeFromContext } from "./integrations-command-context";
import { commandFeedbackFromUrl } from "./integrations-command-feedback";

const IMPORT_PREVIEW_TIMEOUT_MS = 2_500;

// The integrations surfaces read their workbench from the Catalog API, which
// composes it from its own services (see `primary-workbench-surface-read.ts`).
// These loaders pass the route location, record loader telemetry, and stream the
// supplementary panels behind Suspense so the shell paints first.
async function loadSurface(
  request: Request,
  surface: CatalogPrimaryWorkbenchSurfaceKey,
  api: ReturnType<typeof createCatalogRequestApiClient> = createCatalogRequestApiClient(request),
) {
  const surfaceRead = await api.getCatalogPrimaryWorkbenchSurface<CatalogPrimaryWorkbenchSurfaceRead>(
    surface,
    requestLocation(request),
  );
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
    deferredImportPreview: selectedImportPreview(api, readModel.routeContext),
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
    return await api.getCatalogPrimaryWorkbenchDeferredSourceOptions<CatalogPrimaryWorkbenchReadModel["sourceOptions"]>(
      requestLocation(request),
    );
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

async function selectedImportPreview(
  api: ReturnType<typeof createCatalogRequestApiClient>,
  context: CatalogPrimaryWorkbenchRouteContext,
): Promise<SourceObservationIntegrationImportPreview | null> {
  if (!context.providerKey || !context.unitKey || !context.importScope) {
    return null;
  }
  if (typeof api.previewSourceObservationIntegrationImport !== "function") {
    return null;
  }

  try {
    const expectedScope = integrationScopeFromContext(context);
    const preview = await withImportPreviewTimeout(
      api.previewSourceObservationIntegrationImport<SourceObservationIntegrationImportPreview>(expectedScope),
      IMPORT_PREVIEW_TIMEOUT_MS,
    );

    return importPreviewMatchesSelectedScope(preview, expectedScope) ? preview : null;
  } catch (error) {
    if (error instanceof CatalogImportPreviewTimeoutError) {
      throw error;
    }
    return null;
  }
}

export function importPreviewMatchesSelectedScope(
  preview: SourceObservationIntegrationImportPreview,
  expectedScope: SourceObservationIntegrationJobScope,
): boolean {
  return (
    scopeFieldMatches(preview.providerKey, expectedScope.provider) &&
    scopeFieldMatches(preview.scope.provider, expectedScope.provider) &&
    scopeFieldMatches(preview.scope.ingestionUnitKey, expectedScope.ingestionUnitKey) &&
    scopeFieldMatches(preview.scope.language, expectedScope.language) &&
    scopeFieldMatches(preview.scope.productLineId, expectedScope.productLineId) &&
    scopeFieldMatches(preview.scope.seriesId, expectedScope.seriesId) &&
    scopeAnyFieldMatches([preview.scope.setId, preview.scope.setName], [expectedScope.setId, expectedScope.setName]) &&
    (preview.scope.productId ?? null) === (expectedScope.productId ?? null)
  );
}

function scopeFieldMatches(actual: string | null | undefined, expected: string | null | undefined): boolean {
  const expectedValue = normalizedScopeValue(expected);
  if (!expectedValue) {
    return true;
  }

  return normalizedScopeValue(actual) === expectedValue;
}

function scopeAnyFieldMatches(
  actuals: readonly (string | null | undefined)[],
  expecteds: readonly (string | null | undefined)[],
): boolean {
  const expectedValues = expecteds.map(normalizedScopeValue).filter((value): value is string => Boolean(value));
  if (expectedValues.length === 0) {
    return true;
  }
  const actualValues = new Set(actuals.map(normalizedScopeValue).filter((value): value is string => Boolean(value)));

  return expectedValues.some((expected) => actualValues.has(expected));
}

function normalizedScopeValue(value: string | null | undefined): string | null {
  const normalized = value?.trim().toLowerCase();
  return normalized || null;
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

class CatalogImportPreviewTimeoutError extends Error {
  readonly code = "catalog_provider_option_query_timeout";

  constructor(readonly timeoutMs: number) {
    super(
      `Provider source option query did not finish within ${Math.round(
        timeoutMs / 1_000,
      )} seconds, so the importer kept the page usable with degraded source options.`,
    );
    this.name = "CatalogImportPreviewTimeoutError";
  }
}

function withImportPreviewTimeout<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | null = null;
  return new Promise<T>((resolve, reject) => {
    timeout = setTimeout(() => {
      timeout = null;
      reject(new CatalogImportPreviewTimeoutError(timeoutMs));
    }, timeoutMs);

    operation.then(
      (value) => {
        if (timeout) {
          clearTimeout(timeout);
        }
        resolve(value);
      },
      (error) => {
        if (timeout) {
          clearTimeout(timeout);
        }
        reject(error);
      },
    );
  });
}
