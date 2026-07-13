import type { ListResponse } from "@chase-sets/http/responses";
import { isTransientAuthResolutionError, resolveActorFromAuthApi } from "@chase-sets/platform-runtime/auth";
import type { LoaderFunctionArgs } from "react-router";
import type {
  CatalogProviderProfileVersionReview,
  SourceObservationIntegrationScope,
  SourceObservationListItem,
} from "../../../client";
import type {
  CatalogSyncProviderParticipationPreview,
  CatalogSyncProviderScopeHint,
  CatalogSyncScope,
} from "../../../features/source-observations/api/catalog-sync-scope-planner";
import type {
  CatalogPrimaryWorkbenchLifecycleOperation,
  CatalogPrimaryWorkbenchRouteContext,
} from "../../../features/source-observations/api/primary-workbench-admin-contracts";
import type { CatalogAdminRollbackRetirementImpactSummaryReadModel } from "../../../features/source-observations/api/admin-control-plane-read-model-contracts";
import type {
  CatalogProviderProfileAuthoringModel,
  CatalogIntegrationControlPlaneOverview,
  CatalogMergeCandidateListItem,
  CatalogScopeSyncUnitStateReadModel,
  CatalogSyncRun,
  SourceObservationIntegrationImportPreview,
  SourceObservationIntegrationJobScope,
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
import type {
  CatalogPrimaryWorkbenchInput,
  CatalogPrimaryWorkbenchReadModelFailure,
} from "../../../features/source-observations/ui/primary-workbench-read-model-input";
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
import type { CatalogAttentionQueueReadModel } from "../../../features/attention-queue/api/contracts";
import { CatalogApiError } from "../../../client";
import { createCatalogRequestApiClient } from "../../../support/request-support/api-client";
import { integrationScopeFromContext } from "./integrations-command-context";
import {
  loadCatalogListRouteData,
  readCatalogListQuery,
  type CatalogListRouteData,
} from "../../../support/shell-support/list-query-state";
import { commandFeedbackFromUrl } from "./integrations-command-feedback";

const SOURCE_OPTION_CACHE_PAGE_TIMEOUT_MS = 2_500;
const SOURCE_OPTION_LIVE_REFRESH_TIMEOUT_MS = 20_000;
const AUTH_RESOLUTION_RETRY_DELAYS_MS = [250, 1_000, 2_500] as const;

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
  readModelFailures: readonly CatalogPrimaryWorkbenchReadModelFailure[];
  canManageCatalog: boolean;
}>;

// The daily import surface consumes only `readiness`, `unitActivity`, and
// `providerReadiness` from the control-plane overview (the metric strip, the
// import-jobs activity strip, and the provider-scope selector); it never reads the
// audit-lifecycle entries, which feed only the governance/release evidence slices.
// So the daily loader requests the audit-trimmed `daily` overview — skipping
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
  const [routeDataResult, profileReviewsResult, controlPlaneOverviewResult, actor] = await Promise.all([
    catalogApiResult(
      () =>
        loadCatalogListRouteData<SourceObservationIntegrationScope>(request, (query) =>
          api.listSourceObservationIntegrationScopes(query),
        ),
      emptyListRouteData<SourceObservationIntegrationScope>(request),
    ),
    catalogApiResult(
      () => api.listSourceObservationProviderProfiles<ListResponse<CatalogProviderProfileVersionReview>>(),
      emptyListResponse<CatalogProviderProfileVersionReview>(),
    ),
    catalogApiResult(
      () => api.getCatalogIntegrationControlPlaneOverview<CatalogIntegrationControlPlaneOverview>(audience),
      null,
    ),
    resolveCatalogIntegrationsActor(request),
  ]);
  const readModelFailures: CatalogPrimaryWorkbenchReadModelFailure[] = [];
  if (routeDataResult.failed) {
    readModelFailures.push("integration-scopes");
  }
  if (controlPlaneOverviewResult.failed) {
    readModelFailures.push("control-plane-overview");
  }
  if (profileReviewsResult.failed) {
    readModelFailures.push("provider-profiles");
  }

  return {
    api,
    baseline: {
      routeData: routeDataResult.value,
      profileReviews: profileReviewsResult.value,
      controlPlaneOverview: controlPlaneOverviewResult.value,
      readModelFailures,
      canManageCatalog: actor?.permissions.includes("catalog.manage") ?? false,
    },
    routeContext: parseCatalogPrimaryWorkbenchRouteContext(request.url),
  };
}

async function resolveCatalogIntegrationsActor(request: Request): ReturnType<typeof resolveActorFromAuthApi> {
  for (let attempt = 0; attempt <= AUTH_RESOLUTION_RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      return await resolveActorFromAuthApi({ request });
    } catch (error) {
      if (!isTransientAuthResolutionError(error) || attempt === AUTH_RESOLUTION_RETRY_DELAYS_MS.length) {
        throw error;
      }

      await delay(AUTH_RESOLUTION_RETRY_DELAYS_MS[attempt] ?? 0);
    }
  }

  return null;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
  mergeCandidates?: ListResponse<CatalogMergeCandidateListItem> | null;
  reviewPagination?: Readonly<{ limit: number; offset: number }>;
  readModelFailures?: readonly CatalogPrimaryWorkbenchReadModelFailure[];
}) {
  // The source-option fan-out is not fetched here: every surface builds its
  // read model without the option pages, so `sourceOptions` is the structural
  // skeleton. The daily surface streams the populated slice separately;
  // the other surfaces do not render the status panel at all.
  const readModelInput: BuildSurfaceReadModelInput = {
    surface: input.surface,
    baseline: input.baseline,
    requestUrl: input.request.url,
    profileAuthoringModel: input.profileAuthoringModel ?? null,
    lifecycleImpacts: input.lifecycleImpacts ?? null,
    readModelFailures: input.readModelFailures ?? input.baseline.readModelFailures,
    reviewObservations: input.reviewObservations ?? null,
    mergeCandidates: input.mergeCandidates ?? null,
    reviewPagination: input.reviewPagination,
    sourceOptionPages: null,
    catalogSyncPreview: null,
    canManageCatalog: input.baseline.canManageCatalog,
  };
  let readModel = buildSurfaceReadModelFailSoft(readModelInput);
  const catalogSyncPreview =
    input.surface === "daily" ? await selectedCatalogSyncPreview(input.api, readModel.catalogSync) : null;
  if (catalogSyncPreview) {
    readModel = buildSurfaceReadModelFailSoft({
      ...readModelInput,
      catalogSyncPreview,
    });
  }
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
// loads behind streamed promises: the source-option fan-out (~150–250 KB,
// feeds only the secondary status panel) and the alias-review read model
// (supplementary pre-promotion context). The read model is built without the
// option pages, so `sourceOptions` is its structural skeleton (declared kinds +
// not-loaded pages) at first paint; the populated slice streams in behind a
// Suspense boundary. It never fetches the selected authoring model or lifecycle
// impacts, and the read model never computes the governance, lifecycle, release,
// or audit sub-models.
export async function loadDailySurface({ request }: LoaderFunctionArgs) {
  const { api, baseline, routeContext } = await loadIntegrationsBaseline(request, "daily");
  const normalized = normalizedDailyRouteContext(request, baseline, routeContext);
  const normalizedRouteContext = normalized.routeContext;
  const reviewRouteContext = routeContext.providerKey ? normalizedRouteContext : routeContext;
  const reviewPagination = dailyReviewPaginationFor(reviewRouteContext);
  const reviewQuery = buildCatalogPrimaryWorkbenchSourceObservationReviewQuery(reviewRouteContext, reviewPagination);
  const reviewObservationResult = reviewQuery
    ? await catalogApiResult(
        () => api.listSourceObservations<ListResponse<SourceObservationListItem>>(reviewQuery),
        null,
      )
    : ({ value: null, failed: false } as const);
  const mergeCandidateQuery = buildDailyMergeCandidateQuery(normalizedRouteContext);
  const mergeCandidateResult = await catalogApiResult(
    () => api.listCatalogMergeCandidates<ListResponse<CatalogMergeCandidateListItem>>(mergeCandidateQuery),
    null,
  );
  const readModelFailures: CatalogPrimaryWorkbenchReadModelFailure[] = [...normalized.readModelFailures];
  if (reviewObservationResult.failed) {
    readModelFailures.push("source-observation-review");
  }
  if (mergeCandidateResult.failed) {
    readModelFailures.push("merge-candidate-review");
  }

  const { readModel, requestUrl, commandFeedback } = await finalizeSurfaceLoad({
    api,
    request,
    surface: "daily",
    baseline,
    reviewObservations: reviewObservationResult.value,
    mergeCandidates: mergeCandidateResult.value,
    reviewPagination,
    readModelFailures,
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
    deferredImportPreview: selectedImportPreview(api, readModel.routeContext),
    deferredCatalogSyncRun: selectedCatalogSyncRun(api, readModel.routeContext),
    deferredScopeSyncState: selectedCatalogScopeSyncState(api, readModel.catalogSync),
    deferredAliasReview: selectedScopeAliasReview(api, readModel.routeContext),
    deferredAttentionQueue: selectedAttentionQueue(api),
  };
}

// Fetch the unified attention queue for the daily home surface. Like the
// alias review, it is supplementary "needs-you" context streamed behind an Await
// boundary: a missing endpoint (older API) or a transient failure resolves to
// null so the import-to-promotion workflow is never blocked by the queue.
async function selectedAttentionQueue(
  api: ReturnType<typeof createCatalogRequestApiClient>,
): Promise<CatalogAttentionQueueReadModel | null> {
  if (typeof api.getCatalogAttentionQueueReadModel !== "function") {
    return null;
  }
  try {
    return await api.getCatalogAttentionQueueReadModel<CatalogAttentionQueueReadModel>();
  } catch {
    return null;
  }
}

function normalizedDailyRouteContext(
  request: Request,
  baseline: CatalogIntegrationsBaseline,
  routeContext: CatalogPrimaryWorkbenchRouteContext,
): Readonly<{
  routeContext: CatalogPrimaryWorkbenchRouteContext;
  readModelFailures: readonly CatalogPrimaryWorkbenchReadModelFailure[];
}> {
  const readModel = buildSurfaceReadModelFailSoft({
    surface: "daily",
    baseline,
    requestUrl: request.url,
    profileAuthoringModel: null,
    lifecycleImpacts: null,
    readModelFailures: baseline.readModelFailures,
    reviewObservations: null,
    mergeCandidates: null,
    reviewPagination: dailyReviewPaginationFor(routeContext),
    sourceOptionPages: null,
    catalogSyncPreview: null,
    canManageCatalog: baseline.canManageCatalog,
  });
  return {
    routeContext: readModel.routeContext,
    readModelFailures:
      readModel.readiness.freshness === "unavailable"
        ? [...new Set([...baseline.readModelFailures, "control-plane-overview" as const])]
        : baseline.readModelFailures,
  };
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
    const preview =
      await api.previewSourceObservationIntegrationImport<SourceObservationIntegrationImportPreview>(expectedScope);

    return importPreviewMatchesSelectedScope(preview, expectedScope) ? preview : null;
  } catch {
    return null;
  }
}

async function selectedCatalogSyncPreview(
  api: ReturnType<typeof createCatalogRequestApiClient>,
  catalogSync: CatalogPrimaryWorkbenchReadModel["catalogSync"],
): Promise<CatalogSyncProviderParticipationPreview | null> {
  if (typeof api.previewCatalogSyncScope !== "function") {
    return null;
  }

  const scope = catalogSyncScopeFromReadModel(catalogSync);
  if (!scope) {
    return null;
  }

  try {
    return await api.previewCatalogSyncScope<CatalogSyncProviderParticipationPreview>(scope);
  } catch {
    return null;
  }
}

function catalogSyncScopeFromReadModel(
  catalogSync: CatalogPrimaryWorkbenchReadModel["catalogSync"],
): CatalogSyncScope | null {
  const selectedUnitKeys = catalogSync.preview.units
    .filter((unit) => unit.selected && unit.unitKey)
    .map((unit) => unit.unitKey as string);
  const excludedUnitKeys = catalogSync.preview.units
    .filter((unit) => unit.unitKey && !selectedUnitKeys.includes(unit.unitKey))
    .map((unit) => unit.unitKey as string);

  if (
    !catalogSync.scope.productDomain ||
    !catalogSync.scope.productForm ||
    !catalogSync.scope.languageCode ||
    !catalogSync.scope.reference.kind ||
    !catalogSync.scope.reference.id
  ) {
    return null;
  }

  return {
    scopeVersion: "catalog-sync-scope-v1",
    productDomain: catalogSync.scope.productDomain,
    productForm: catalogSync.scope.productForm,
    languageCode: catalogSync.scope.languageCode,
    reference: {
      kind: catalogSync.scope.reference.kind,
      id: catalogSync.scope.reference.id,
      name: catalogSync.scope.reference.name,
      seriesId: catalogSync.scope.reference.seriesId,
      seriesName: catalogSync.scope.reference.seriesName,
    },
    providerHints: catalogSyncProviderHintsFromReadModel(catalogSync, new Set(selectedUnitKeys)),
    providerParticipation: {
      requiredUnitKeys: [],
      selectedUnitKeys,
      excludedUnitKeys,
    },
  };
}

function catalogSyncProviderHintsFromReadModel(
  catalogSync: CatalogPrimaryWorkbenchReadModel["catalogSync"],
  selectedUnitKeys: ReadonlySet<string>,
): readonly CatalogSyncProviderScopeHint[] {
  return catalogSync.preview.units
    .filter((unit) => unit.unitKey && selectedUnitKeys.has(unit.unitKey) && unit.childExecutionScope)
    .map((unit) => ({
      providerKey: unit.childExecutionScope?.provider ?? unit.providerKey,
      unitKey: unit.unitKey as CatalogSyncProviderScopeHint["unitKey"],
      productLineId: unit.childExecutionScope?.productLineId,
      seriesId: unit.childExecutionScope?.seriesId,
      setId: unit.childExecutionScope?.setId,
      setName: unit.childExecutionScope?.setName,
      productId: unit.childExecutionScope?.productId,
    }));
}

function importPreviewMatchesSelectedScope(
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
    scopeFieldMatches(preview.scope.productId, expectedScope.productId)
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

// The durable per-scope sync state (survives across runs), keyed off the same
// scope the "Sync scope" action itself submits — so the scope page's state
// panel and the "Sync scope" fan-out always agree on which scope they mean.
async function selectedCatalogScopeSyncState(
  api: ReturnType<typeof createCatalogRequestApiClient>,
  catalogSync: CatalogPrimaryWorkbenchReadModel["catalogSync"],
): Promise<readonly CatalogScopeSyncUnitStateReadModel[] | null> {
  if (typeof api.getCatalogSyncScopeState !== "function") {
    return null;
  }
  const scope = catalogSyncScopeFromReadModel(catalogSync);
  if (!scope) {
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

async function catalogApiResult<T>(
  operation: () => Promise<T>,
  fallback: T,
): Promise<Readonly<{ value: T; failed: boolean }>> {
  try {
    return { value: await operation(), failed: false };
  } catch {
    return { value: fallback, failed: true };
  }
}

type BuildSurfaceReadModelInput = Readonly<{
  surface: CatalogControlPlaneRouteSurfaceKey;
  baseline: CatalogIntegrationsBaseline;
  requestUrl: string;
  profileAuthoringModel: CatalogProviderProfileAuthoringModel | null;
  lifecycleImpacts: Partial<
    Record<CatalogPrimaryWorkbenchLifecycleOperation, CatalogAdminRollbackRetirementImpactSummaryReadModel>
  > | null;
  readModelFailures: readonly CatalogPrimaryWorkbenchReadModelFailure[];
  reviewObservations: ListResponse<SourceObservationListItem> | null;
  mergeCandidates: ListResponse<CatalogMergeCandidateListItem> | null;
  reviewPagination: Readonly<{ limit: number; offset: number }> | undefined;
  sourceOptionPages: readonly CatalogPrimaryWorkbenchSourceOptionPageSnapshot[] | null;
  catalogSyncPreview: CatalogSyncProviderParticipationPreview | null;
  canManageCatalog: boolean;
}>;

function buildSurfaceReadModelFailSoft(input: BuildSurfaceReadModelInput): CatalogPrimaryWorkbenchReadModel {
  const initialFailures = uniqueReadModelFailures(input.readModelFailures);
  const fallbackKeys = optionalProjectionFallbackKeys(input, initialFailures);
  const fallbackMasks = projectionFallbackMasks(fallbackKeys.length);
  let lastError: unknown = null;

  for (const mask of fallbackMasks) {
    const readModelFailures = uniqueReadModelFailures([
      ...initialFailures,
      ...fallbackKeys.filter((_, index) => (mask & (1 << index)) !== 0),
    ]);

    try {
      return buildCatalogPrimaryWorkbenchReadModelForSurface(
        input.surface,
        surfaceReadModelInput(input, readModelFailures),
      );
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError;
}

function surfaceReadModelInput(
  input: BuildSurfaceReadModelInput,
  readModelFailures: readonly CatalogPrimaryWorkbenchReadModelFailure[],
): CatalogPrimaryWorkbenchInput {
  const failures = new Set(readModelFailures);

  return {
    requestUrl: input.requestUrl,
    scopes: failures.has("integration-scopes")
      ? emptyListResponse<SourceObservationIntegrationScope>()
      : input.baseline.routeData.data,
    profileReviews: input.baseline.profileReviews,
    profileAuthoringModel: input.profileAuthoringModel,
    lifecycleImpacts: input.lifecycleImpacts,
    controlPlaneOverview: failures.has("control-plane-overview") ? null : input.baseline.controlPlaneOverview,
    readModelFailures,
    reviewObservations: failures.has("source-observation-review") ? null : input.reviewObservations,
    mergeCandidates: failures.has("merge-candidate-review") ? null : input.mergeCandidates,
    reviewPagination: input.reviewPagination,
    sourceOptionPages: input.sourceOptionPages,
    catalogSyncPreview: input.catalogSyncPreview,
    canManageCatalog: input.canManageCatalog,
  };
}

function uniqueReadModelFailures(
  failures: readonly CatalogPrimaryWorkbenchReadModelFailure[],
): readonly CatalogPrimaryWorkbenchReadModelFailure[] {
  return [...new Set(failures)];
}

function optionalProjectionFallbackKeys(
  input: BuildSurfaceReadModelInput,
  initialFailures: readonly CatalogPrimaryWorkbenchReadModelFailure[],
): readonly CatalogPrimaryWorkbenchReadModelFailure[] {
  const failures = new Set(initialFailures);
  const keys: CatalogPrimaryWorkbenchReadModelFailure[] = [];
  if (input.reviewObservations && !failures.has("source-observation-review")) {
    keys.push("source-observation-review");
  }
  if (input.mergeCandidates && !failures.has("merge-candidate-review")) {
    keys.push("merge-candidate-review");
  }
  if (input.baseline.controlPlaneOverview && !failures.has("control-plane-overview")) {
    keys.push("control-plane-overview");
  }
  if (!failures.has("integration-scopes")) {
    keys.push("integration-scopes");
  }

  return keys;
}

function projectionFallbackMasks(count: number): readonly number[] {
  return Array.from({ length: 1 << count }, (_, mask) => mask).sort(
    (left, right) => selectedBitCount(left) - selectedBitCount(right),
  );
}

function selectedBitCount(value: number): number {
  let count = 0;
  for (let remaining = value; remaining > 0; remaining >>= 1) {
    count += remaining & 1;
  }

  return count;
}

function emptyListResponse<T>(): ListResponse<T> {
  return { items: [], total: 0, count: 0 };
}

function emptyListRouteData<T>(request: Request): CatalogListRouteData<T> {
  return {
    data: { items: [], total: 0, count: 0 },
    query: readCatalogListQuery(request),
  };
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

export function buildDailyMergeCandidateQuery(routeContext: CatalogPrimaryWorkbenchRouteContext): string {
  const params = new URLSearchParams();
  params.set("limit", String(dailyReviewPageSize));
  params.set("offset", "0");
  const scope = routeContext.scope;
  const hasSelectedScope = Boolean(
    scope?.providerKey || scope?.languageCode || scope?.productLineId || scope?.expansionId || scope?.expansionName,
  );
  if (scope?.providerKey) {
    params.set("provider", scope.providerKey);
  }
  if (scope?.languageCode) {
    params.set("language", scope.languageCode);
  }
  if (scope?.productLineId) {
    params.set("productLineId", scope.productLineId);
  }
  if (scope?.productLineName) {
    params.set("productLineName", scope.productLineName);
  }
  if (scope?.expansionId) {
    params.set("expansionId", scope.expansionId);
    params.set("setId", scope.expansionId);
  } else if (scope?.expansionName) {
    params.set("expansionId", scope.expansionName);
    params.set("setId", scope.expansionName);
  }
  if (routeContext.jobId && !hasSelectedScope) {
    params.set("syncRunId", routeContext.jobId);
  }
  const status = candidateStatusFromReviewStatus(routeContext.sourceObservationFilters.status);
  if (status) {
    params.set("status", status);
  }
  const search = routeContext.sourceObservationFilters.search?.trim();
  if (search) {
    params.set("search", search);
  }

  return params.toString();
}

function candidateStatusFromReviewStatus(status: string | undefined): string | null {
  switch (status) {
    case "ready":
    case "has-conflicts":
    case "stale":
    case "deferred":
    case "rejected":
    case "promoted":
      return status;
    default:
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
        const response = await withSourceOptionPageTimeout(
          api.listSourceObservationIntegrationOptions<SourceObservationIntegrationOptionResponse>(query),
          forceRefresh ? SOURCE_OPTION_LIVE_REFRESH_TIMEOUT_MS : SOURCE_OPTION_CACHE_PAGE_TIMEOUT_MS,
        );
        return { request: sourceOptionRequest, response };
      } catch (error) {
        return { request: sourceOptionRequest, error: sourceOptionPageError(error) };
      }
    }),
  );
}

class CatalogSourceOptionPageTimeoutError extends Error {
  readonly code = "catalog_provider_option_query_timeout";

  constructor(readonly timeoutMs: number) {
    super(
      `Provider source option query did not finish within ${Math.round(
        timeoutMs / 1_000,
      )} seconds, so the importer kept the page usable with degraded source options.`,
    );
    this.name = "CatalogSourceOptionPageTimeoutError";
  }
}

function withSourceOptionPageTimeout<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | null = null;
  return new Promise<T>((resolve, reject) => {
    timeout = setTimeout(() => {
      timeout = null;
      reject(new CatalogSourceOptionPageTimeoutError(timeoutMs));
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
  if (error instanceof CatalogSourceOptionPageTimeoutError) {
    return {
      status: null,
      code: error.code,
      message: error.message,
      rolloutBlocked: false,
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
