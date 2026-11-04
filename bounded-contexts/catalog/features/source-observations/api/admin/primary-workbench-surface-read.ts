import type { ListResponse } from "@chase-sets/http/responses";
import type {
  CatalogSyncProviderParticipationPreview,
  CatalogSyncScope,
} from "../providers/catalog-sync-scope-planner";
import type { SourceObservationPromotionOutcomeRecord } from "../runtime";
import type { CatalogAdminRollbackRetirementImpactSummaryReadModel } from "../admin-control-plane-read-model-contracts";
import type {
  CatalogPrimaryWorkbenchLifecycleOperation,
  CatalogPrimaryWorkbenchReadModel,
  CatalogPrimaryWorkbenchRouteContext,
} from "./primary-workbench-admin-contracts";
import type {
  CatalogIntegrationControlPlaneOverview,
  CatalogMergeCandidateListItem,
  CatalogProviderProfileAuthoringModel,
  CatalogProviderProfileVersionReview,
  SourceObservationIntegrationOptionResponse,
  SourceObservationIntegrationScope,
  SourceObservationListItem,
  SourceObservationPromotionPreview,
  SourceObservationPromotionValidation,
} from "../../ui/contracts";
import type { CatalogControlPlaneRouteSurfaceKey } from "../../ui/admin-control-plane/information-architecture";
import {
  buildCatalogPrimaryWorkbenchDeferredSourceOptions,
  buildCatalogPrimaryWorkbenchReadModelForSurface,
  buildCatalogPrimaryWorkbenchSourceObservationReviewQuery,
  buildCatalogPrimaryWorkbenchSourceOptionRequests,
  type CatalogPrimaryWorkbenchSourceOptionPageSnapshot,
} from "../../ui/primary-workbench-read-model";
import type {
  CatalogPrimaryWorkbenchInput,
  CatalogPrimaryWorkbenchReadModelFailure,
} from "../../ui/primary-workbench-read-model-input";
import {
  catalogPrimaryWorkbenchHref,
  parseCatalogPrimaryWorkbenchRouteContext,
} from "../../ui/primary-workbench-route-context";
import {
  catalogPrimaryWorkbenchSourceOptionForcesRefresh,
  parseCatalogPrimaryWorkbenchSourceOptionIntent,
} from "../../ui/primary-workbench-source-option-refresh";
import {
  scopeContextFromRouteContext,
  scopeContextToObservationFilterScope,
} from "../../ui/primary-workbench-scope-context";

// ---------------------------------------------------------------------------
// Catalog primary workbench surface read
//
// The Catalog API composes the integrations workbench for one audience surface
// (daily, governance, health) from its own services, so every client renders the
// same read model without re-implementing the joins, the source-option cursor
// exhaustion or the fail-soft fallback order. The admin loaders only pass the
// route location and stream their supplementary panels.
//
// Fail-soft stays visible: a projection that cannot be read (or that makes the
// composition throw) is dropped and named in `readModelFailures`; it degrades
// only its own panel and never reads as empty.
// ---------------------------------------------------------------------------

const SOURCE_OPTION_CACHE_PAGE_TIMEOUT_MS = 2_500;
const SOURCE_OPTION_LIVE_REFRESH_TIMEOUT_MS = 20_000;
const SOURCE_OPTION_CONTINUATION_PAGE_LIMIT = 200;
export const MAX_SOURCE_OPTION_CONTINUATION_PAGES = 100;

export type CatalogPrimaryWorkbenchSurfaceKey = CatalogControlPlaneRouteSurfaceKey;

export const catalogPrimaryWorkbenchSurfaceKeys = [
  "daily",
  "governance",
  "health",
] as const satisfies readonly CatalogPrimaryWorkbenchSurfaceKey[];

export type CatalogIntegrationsOverviewAudience = "full" | "daily";

export type CatalogPrimaryWorkbenchLifecycleImpacts = Partial<
  Record<CatalogPrimaryWorkbenchLifecycleOperation, CatalogAdminRollbackRetirementImpactSummaryReadModel>
>;

// A documented refusal from an option query, carrying the HTTP status and error
// body the option route answers with, so the status panel reports it exactly as
// the route would.
export class CatalogSourceOptionQueryRefusedError extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown,
  ) {
    super("Provider source option query was refused.");
    this.name = "CatalogSourceOptionQueryRefusedError";
  }
}

// The Catalog reads the workbench composes. Each source answers with the wire
// shape its HTTP route returns (the `ui/contracts` records). Query-string inputs
// are parsed by the same functions the HTTP routes use.
export type CatalogPrimaryWorkbenchSurfaceSources = Readonly<{
  canManageCatalog: boolean;
  listIntegrationScopes: (
    filter: Readonly<{ source?: string; language?: string; setId?: string }>,
  ) => Promise<ListResponse<SourceObservationIntegrationScope>>;
  listProviderProfiles: () => Promise<ListResponse<CatalogProviderProfileVersionReview>>;
  getControlPlaneOverview: (
    audience: CatalogIntegrationsOverviewAudience,
  ) => Promise<CatalogIntegrationControlPlaneOverview>;
  listSourceObservations: (query: string) => Promise<ListResponse<SourceObservationListItem>>;
  listMergeCandidates: (query: string) => Promise<ListResponse<CatalogMergeCandidateListItem>>;
  /** Null when the job is unknown, not a promotion, or has no outcome yet. */
  getPromotionOutcome: (jobId: string) => Promise<SourceObservationPromotionOutcomeRecord | null>;
  previewPromotion: (
    input: Readonly<{
      observationIds: readonly string[];
      scope: ReturnType<typeof scopeContextToObservationFilterScope>;
      promoteAsDraft: boolean;
    }>,
  ) => Promise<SourceObservationPromotionPreview>;
  /** Null when the provider profile version does not exist. */
  getProviderProfileAuthoringModel: (
    providerKey: string,
    profileVersion: string,
  ) => Promise<CatalogProviderProfileAuthoringModel | null>;
  getProviderProfileLifecycleImpact: (
    providerKey: string,
    profileVersion: string,
    operation: CatalogPrimaryWorkbenchLifecycleOperation,
  ) => Promise<CatalogAdminRollbackRetirementImpactSummaryReadModel>;
  /** Throws {@link CatalogSourceOptionQueryRefusedError} for a documented refusal. */
  queryIntegrationOptions: (query: string) => Promise<SourceObservationIntegrationOptionResponse>;
  previewCatalogSyncScope: (scope: CatalogSyncScope) => Promise<CatalogSyncProviderParticipationPreview>;
}>;

export type CatalogPrimaryWorkbenchSurfaceRead = Readonly<{
  readModel: CatalogPrimaryWorkbenchReadModel;
  /** Every projection the read model was built without. */
  readModelFailures: readonly CatalogPrimaryWorkbenchReadModelFailure[];
  /** The Catalog sync scope the surface's "Sync scope" action submits, when the selection names one. */
  catalogSyncScope: CatalogSyncScope | null;
}>;

// Provider profiles + the control plane overview are the shared baseline every
// integrations surface needs: the cross-surface metric strip, navigation, and
// readiness summary derive from them. Each surface adds only the reads its own
// slices consume (daily: the review wave; governance and health: the selected
// authoring model and lifecycle impacts).
type CatalogIntegrationsBaseline = Readonly<{
  scopes: ListResponse<SourceObservationIntegrationScope>;
  profileReviews: ListResponse<CatalogProviderProfileVersionReview>;
  controlPlaneOverview: CatalogIntegrationControlPlaneOverview | null;
  readModelFailures: readonly CatalogPrimaryWorkbenchReadModelFailure[];
  canManageCatalog: boolean;
}>;

export async function readCatalogPrimaryWorkbenchSurface(
  surface: CatalogPrimaryWorkbenchSurfaceKey,
  location: URL,
  sources: CatalogPrimaryWorkbenchSurfaceSources,
): Promise<CatalogPrimaryWorkbenchSurfaceRead> {
  if (surface === "daily") {
    return readDailySurface(location, sources);
  }

  // Governance and health load the selected profile's authoring model and
  // lifecycle impacts: lifecycle recovery folds in validation readiness (derived
  // from the authoring model) and the audit timeline cites both. The review
  // wave is not fetched.
  const baseline = await loadIntegrationsBaseline(location, sources, "full");
  const routeContext = parseCatalogPrimaryWorkbenchRouteContext(location);
  const [profileAuthoringModel, lifecycleImpacts] = await Promise.all([
    selectedProviderProfileAuthoringModel(sources, routeContext),
    selectedProviderProfileLifecycleImpacts(sources, routeContext),
  ]);

  return finalizeSurfaceRead(sources, {
    surface,
    baseline,
    requestUrl: location.toString(),
    profileAuthoringModel,
    lifecycleImpacts,
    readModelFailures: baseline.readModelFailures,
    reviewObservations: null,
    mergeCandidates: null,
    reviewPagination: undefined,
    sourceOptionPages: null,
    catalogSyncPreview: null,
    canManageCatalog: baseline.canManageCatalog,
  });
}

// Daily import-to-promotion surface. Reads the baseline plus the paginated
// Source Observation review wave: the data the shell, metric strip, and 3-stage
// flow paint from. The source-option fan-out is a separate read
// (`readCatalogPrimaryWorkbenchDeferredSourceOptions`) so the shell paints
// before the option pages resolve.
async function readDailySurface(
  location: URL,
  sources: CatalogPrimaryWorkbenchSurfaceSources,
): Promise<CatalogPrimaryWorkbenchSurfaceRead> {
  const baseline = await loadIntegrationsBaseline(location, sources, "daily");
  const routeContext = parseCatalogPrimaryWorkbenchRouteContext(location);
  const normalized = normalizedDailyRouteContext(location, baseline, routeContext);
  const normalizedRouteContext = normalized.routeContext;
  const reviewRouteContext = routeContext.providerKey ? normalizedRouteContext : routeContext;
  const reviewPagination = dailyReviewPaginationFor(reviewRouteContext);
  const reviewQuery = buildCatalogPrimaryWorkbenchSourceObservationReviewQuery(
    reviewRouteContext,
    reviewPagination,
    normalized.selectedScope,
  );
  const [reviewObservationResult, mergeCandidateResult, promotionOutcome, promotionValidation] = await Promise.all([
    reviewQuery
      ? sourceResult(() => sources.listSourceObservations(reviewQuery), null)
      : Promise.resolve({ value: null, failed: false } as const),
    sourceResult(() => sources.listMergeCandidates(buildDailyMergeCandidateQuery(normalizedRouteContext)), null),
    selectedPromotionOutcome(sources, normalizedRouteContext),
    selectedPromotionValidation(sources, normalizedRouteContext),
  ]);
  const readModelFailures: CatalogPrimaryWorkbenchReadModelFailure[] = [...normalized.readModelFailures];
  if (reviewObservationResult.failed) {
    readModelFailures.push("source-observation-review");
  }
  if (mergeCandidateResult.failed) {
    readModelFailures.push("merge-candidate-review");
  }

  return finalizeSurfaceRead(sources, {
    surface: "daily",
    baseline,
    requestUrl: location.toString(),
    profileAuthoringModel: null,
    lifecycleImpacts: null,
    readModelFailures,
    reviewObservations: reviewObservationResult.value,
    mergeCandidates: mergeCandidateResult.value,
    promotionOutcome,
    promotionValidation,
    reviewPagination,
    sourceOptionPages: null,
    catalogSyncPreview: null,
    canManageCatalog: baseline.canManageCatalog,
  });
}

// The populated source-options slice for the daily status panel: the option
// fan-out resolved cache-only (or force-refreshed for a refresh intent), every
// continuation page exhausted from one cache snapshot, and the slice built from
// the same baseline and normalized route context the daily read uses. Returning
// the built slice keeps the raw option pages out of the browser payload.
export async function readCatalogPrimaryWorkbenchDeferredSourceOptions(
  location: URL,
  sources: CatalogPrimaryWorkbenchSurfaceSources,
): Promise<CatalogPrimaryWorkbenchReadModel["sourceOptions"]> {
  const baseline = await loadIntegrationsBaseline(location, sources, "daily");
  const { routeContext } = normalizedDailyRouteContext(
    location,
    baseline,
    parseCatalogPrimaryWorkbenchRouteContext(location),
  );
  const sourceOptionPages = await selectedProviderSourceOptionPages(sources, location, baseline, routeContext);

  return buildCatalogPrimaryWorkbenchDeferredSourceOptions({
    requestUrl: new URL(catalogPrimaryWorkbenchHref(routeContext), location).toString(),
    scopes: baseline.scopes,
    profileReviews: baseline.profileReviews,
    controlPlaneOverview: baseline.controlPlaneOverview,
    sourceOptionPages,
    canManageCatalog: baseline.canManageCatalog,
  });
}

async function loadIntegrationsBaseline(
  location: URL,
  sources: CatalogPrimaryWorkbenchSurfaceSources,
  audience: CatalogIntegrationsOverviewAudience,
): Promise<CatalogIntegrationsBaseline> {
  const [scopesResult, profileReviewsResult, controlPlaneOverviewResult] = await Promise.all([
    sourceResult(
      () => sources.listIntegrationScopes(integrationScopeFilterFromLocation(location)),
      emptyListResponse<SourceObservationIntegrationScope>(),
    ),
    sourceResult(() => sources.listProviderProfiles(), emptyListResponse<CatalogProviderProfileVersionReview>()),
    sourceResult<CatalogIntegrationControlPlaneOverview | null>(() => sources.getControlPlaneOverview(audience), null),
  ]);
  const readModelFailures: CatalogPrimaryWorkbenchReadModelFailure[] = [];
  if (scopesResult.failed) {
    readModelFailures.push("integration-scopes");
  }
  if (controlPlaneOverviewResult.failed) {
    readModelFailures.push("control-plane-overview");
  }
  if (profileReviewsResult.failed) {
    readModelFailures.push("provider-profiles");
  }

  return {
    scopes: scopesResult.value,
    profileReviews: profileReviewsResult.value,
    controlPlaneOverview: controlPlaneOverviewResult.value,
    readModelFailures,
    canManageCatalog: sources.canManageCatalog,
  };
}

// The Catalog list filters the integration-scope read honours: the provider
// (`source`), language and set, trimmed, as the admin list query states them.
function integrationScopeFilterFromLocation(location: URL): Readonly<{
  source?: string;
  language?: string;
  setId?: string;
}> {
  const value = (key: string) => location.searchParams.get(key)?.trim() || undefined;
  const source = value("source");
  const language = value("language");
  const setId = value("setId");

  return {
    ...(source ? { source } : {}),
    ...(language ? { language } : {}),
    ...(setId ? { setId } : {}),
  };
}

async function finalizeSurfaceRead(
  sources: CatalogPrimaryWorkbenchSurfaceSources,
  input: BuildSurfaceReadModelInput,
): Promise<CatalogPrimaryWorkbenchSurfaceRead> {
  // The source-option fan-out is not read here: every surface builds its read
  // model without the option pages, so `sourceOptions` is the structural
  // skeleton. The daily surface streams the populated slice separately; the
  // other surfaces do not render the status panel.
  let built = buildSurfaceReadModelFailSoft(input);
  const catalogSyncPreview =
    input.surface === "daily" ? await selectedCatalogSyncPreview(sources, built.readModel.catalogSync) : null;
  if (catalogSyncPreview) {
    built = buildSurfaceReadModelFailSoft({ ...input, catalogSyncPreview });
  }

  return {
    readModel: built.readModel,
    readModelFailures: built.readModelFailures,
    catalogSyncScope: catalogSyncScopeFromReadModel(built.readModel.catalogSync),
  };
}

function normalizedDailyRouteContext(
  location: URL,
  baseline: CatalogIntegrationsBaseline,
  routeContext: CatalogPrimaryWorkbenchRouteContext,
): Readonly<{
  routeContext: CatalogPrimaryWorkbenchRouteContext;
  readModelFailures: readonly CatalogPrimaryWorkbenchReadModelFailure[];
  selectedScope: CatalogPrimaryWorkbenchReadModel["sourceScopeWorkset"]["selectedScope"]["scope"];
}> {
  const { readModel } = buildSurfaceReadModelFailSoft({
    surface: "daily",
    baseline,
    requestUrl: location.toString(),
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
    selectedScope: readModel.sourceScopeWorkset.selectedScope.scope,
    readModelFailures:
      readModel.readiness.freshness === "unavailable"
        ? [...new Set([...baseline.readModelFailures, "control-plane-overview" as const])]
        : baseline.readModelFailures,
  };
}

async function selectedCatalogSyncPreview(
  sources: CatalogPrimaryWorkbenchSurfaceSources,
  catalogSync: CatalogPrimaryWorkbenchReadModel["catalogSync"],
): Promise<CatalogSyncProviderParticipationPreview | null> {
  const scope = catalogSyncScopeFromReadModel(catalogSync);
  if (!scope) {
    return null;
  }

  try {
    return await sources.previewCatalogSyncScope(scope);
  } catch {
    return null;
  }
}

export function catalogSyncScopeFromReadModel(
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
    !catalogSync.scope.reference.scopeRecordId
  ) {
    return null;
  }

  return {
    scopeVersion: "catalog-sync-scope-v2",
    productDomain: catalogSync.scope.productDomain,
    productForm: catalogSync.scope.productForm,
    languageCode: catalogSync.scope.languageCode,
    reference: {
      kind: catalogSync.scope.reference.kind,
      scopeRecordId: catalogSync.scope.reference.scopeRecordId,
    },
    providerParticipation: {
      requiredUnitKeys: [],
      selectedUnitKeys,
      excludedUnitKeys,
    },
  };
}

async function selectedPromotionOutcome(
  sources: CatalogPrimaryWorkbenchSurfaceSources,
  context: CatalogPrimaryWorkbenchRouteContext,
): Promise<SourceObservationPromotionOutcomeRecord | null> {
  if (!context.jobId) {
    return null;
  }

  try {
    return await sources.getPromotionOutcome(context.jobId);
  } catch {
    return null;
  }
}

// The read-only pre-write validation for the route's promotion preview token, so
// the create/update stage paints the current per-observation verdicts rather
// than a count-only eligibility. Previewing needs catalog.manage; absence renders
// as not-previewed.
async function selectedPromotionValidation(
  sources: CatalogPrimaryWorkbenchSurfaceSources,
  context: CatalogPrimaryWorkbenchRouteContext,
): Promise<SourceObservationPromotionValidation | null> {
  if (!context.promotionPreviewId || !sources.canManageCatalog) {
    return null;
  }

  try {
    const preview = await sources.previewPromotion({
      observationIds: context.selectedObservationIds,
      scope: scopeContextToObservationFilterScope(
        scopeContextFromRouteContext(context),
        context.sourceObservationFilters,
      ),
      promoteAsDraft: context.promoteAsDraft === true,
    });
    return preview.validation;
  } catch {
    return null;
  }
}

async function sourceResult<T>(
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
  surface: CatalogPrimaryWorkbenchSurfaceKey;
  baseline: CatalogIntegrationsBaseline;
  requestUrl: string;
  profileAuthoringModel: CatalogProviderProfileAuthoringModel | null;
  lifecycleImpacts: CatalogPrimaryWorkbenchLifecycleImpacts | null;
  readModelFailures: readonly CatalogPrimaryWorkbenchReadModelFailure[];
  reviewObservations: ListResponse<SourceObservationListItem> | null;
  mergeCandidates: ListResponse<CatalogMergeCandidateListItem> | null;
  promotionOutcome?: SourceObservationPromotionOutcomeRecord | null;
  promotionValidation?: SourceObservationPromotionValidation | null;
  reviewPagination: Readonly<{ limit: number; offset: number }> | undefined;
  sourceOptionPages: readonly CatalogPrimaryWorkbenchSourceOptionPageSnapshot[] | null;
  catalogSyncPreview: CatalogSyncProviderParticipationPreview | null;
  canManageCatalog: boolean;
}>;

// Build the surface read model, dropping optional projections only when the
// composition cannot build with them. Combinations are tried fewest-dropped
// first, so the result keeps every projection it can.
function buildSurfaceReadModelFailSoft(
  input: BuildSurfaceReadModelInput,
): Readonly<{
  readModel: CatalogPrimaryWorkbenchReadModel;
  readModelFailures: readonly CatalogPrimaryWorkbenchReadModelFailure[];
}> {
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
      return {
        readModel: buildCatalogPrimaryWorkbenchReadModelForSurface(
          input.surface,
          surfaceReadModelInput(input, readModelFailures),
        ),
        readModelFailures,
      };
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
      : input.baseline.scopes,
    profileReviews: input.baseline.profileReviews,
    profileAuthoringModel: input.profileAuthoringModel,
    lifecycleImpacts: input.lifecycleImpacts,
    controlPlaneOverview: failures.has("control-plane-overview") ? null : input.baseline.controlPlaneOverview,
    readModelFailures,
    reviewObservations: failures.has("source-observation-review") ? null : input.reviewObservations,
    mergeCandidates: failures.has("merge-candidate-review") ? null : input.mergeCandidates,
    promotionOutcome: input.promotionOutcome,
    promotionValidation: input.promotionValidation ?? null,
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

// Resolve the Source Observation review page window from the durable, URL-backed
// pager cursor (reviewOffset/reviewLimit) the route context carries: clamp the
// page size to a sane band and snap the offset onto a page boundary so the read
// and the pager hrefs agree on every reachable page.
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
  if (routeContext.scopeRecordId) {
    params.set("scopeRecordId", routeContext.scopeRecordId);
  } else if (scope?.expansionId) {
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

async function selectedProviderProfileAuthoringModel(
  sources: CatalogPrimaryWorkbenchSurfaceSources,
  context: CatalogPrimaryWorkbenchRouteContext,
): Promise<CatalogProviderProfileAuthoringModel | null> {
  if (!context.providerKey || !context.profileVersion) {
    return null;
  }

  // A deep link from a missing/invalid-profile blocker can carry a provider and a
  // stale or unknown profileVersion; the source answers that with null, the
  // "no authoring model" state, so the surfaces render the author-a-profile
  // path. Any other failure propagates.
  return sources.getProviderProfileAuthoringModel(context.providerKey, context.profileVersion);
}

async function selectedProviderProfileLifecycleImpacts(
  sources: CatalogPrimaryWorkbenchSurfaceSources,
  context: CatalogPrimaryWorkbenchRouteContext,
): Promise<CatalogPrimaryWorkbenchLifecycleImpacts | null> {
  if (!context.providerKey || !context.profileVersion) {
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
      impact: await sources.getProviderProfileLifecycleImpact(providerKey, profileVersion, operation),
    })),
  );
  const impacts: CatalogPrimaryWorkbenchLifecycleImpacts = {};
  for (const result of results) {
    if (result.status === "fulfilled") {
      impacts[result.value.operation] = result.value.impact;
    }
  }

  return impacts;
}

async function selectedProviderSourceOptionPages(
  sources: CatalogPrimaryWorkbenchSurfaceSources,
  location: URL,
  baseline: CatalogIntegrationsBaseline,
  routeContext: CatalogPrimaryWorkbenchRouteContext,
): Promise<readonly CatalogPrimaryWorkbenchSourceOptionPageSnapshot[]> {
  const requests = buildCatalogPrimaryWorkbenchSourceOptionRequests({
    requestUrl: location.toString(),
    scopes: baseline.scopes.items,
    profiles: baseline.profileReviews.items,
    routeContext,
    cacheOnly: true,
  });
  // A workbench reload stays cache-only; a per-group or refresh-all intent
  // escalates the matching request(s) to the force-refresh (live) query.
  const refreshIntent = parseCatalogPrimaryWorkbenchSourceOptionIntent(location);
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

      const forceRefresh =
        catalogPrimaryWorkbenchSourceOptionForcesRefresh(refreshIntent, sourceOptionRequest.queryKind) &&
        !(refreshIntent?.action === "force-refresh-all" && sourceOptionRequest.scope === "product/card");
      const href =
        forceRefresh && sourceOptionRequest.refreshHref
          ? sourceOptionRequest.refreshHref
          : sourceOptionRequest.queryHref;

      try {
        const query = new URL(href, location).searchParams.toString();
        const firstResponse = await withSourceOptionPageTimeout(
          sources.queryIntegrationOptions(query),
          forceRefresh ? SOURCE_OPTION_LIVE_REFRESH_TIMEOUT_MS : SOURCE_OPTION_CACHE_PAGE_TIMEOUT_MS,
        );
        const response = await completeSourceOptionResponse(
          sources,
          location,
          sourceOptionRequest,
          href,
          firstResponse,
        );
        return { request: sourceOptionRequest, response };
      } catch (error) {
        return { request: sourceOptionRequest, error: sourceOptionPageError(error) };
      }
    }),
  );
}

// Guided selectors need the complete provider-neutral option list, while the
// option query exposes bounded cursor pages. Resolve the first page with the
// requested cache/live semantics, then exhaust continuation cursors from that
// same cache snapshot: a force refresh happens once, and continuation pages
// never repeat provider I/O or move refresh timestamps. A list that exceeds the
// page cap, stalls its cursor, or changes count or cache between pages is an
// error for its group, never a complete list.
async function completeSourceOptionResponse(
  sources: CatalogPrimaryWorkbenchSurfaceSources,
  location: URL,
  sourceOptionRequest: CatalogPrimaryWorkbenchSourceOptionPageSnapshot["request"],
  firstHref: string,
  firstResponse: SourceObservationIntegrationOptionResponse,
): Promise<SourceObservationIntegrationOptionResponse> {
  if (!firstResponse.page?.hasMore) {
    return firstResponse;
  }

  const items = [...firstResponse.items];
  const seenCursors = new Set<string>();
  let continuationPageCount = 0;
  let response = firstResponse;

  while (response.page?.hasMore) {
    if (continuationPageCount >= MAX_SOURCE_OPTION_CONTINUATION_PAGES) {
      throw new CatalogSourceOptionPaginationError(
        sourceOptionRequest.queryKind,
        `the response exceeded ${MAX_SOURCE_OPTION_CONTINUATION_PAGES} continuation pages`,
      );
    }
    const cursor = response.page.nextCursor?.trim();
    if (!cursor || seenCursors.has(cursor)) {
      throw new CatalogSourceOptionPaginationError(sourceOptionRequest.queryKind, "the cursor did not advance");
    }
    seenCursors.add(cursor);

    const continuationResponse = await withSourceOptionPageTimeout(
      sources.queryIntegrationOptions(sourceOptionContinuationQuery(firstHref, location, cursor)),
      SOURCE_OPTION_CACHE_PAGE_TIMEOUT_MS,
    );
    continuationPageCount += 1;
    assertSourceOptionContinuation(firstResponse, continuationResponse, cursor, sourceOptionRequest.queryKind);
    response = continuationResponse;
    items.push(...response.items);
  }

  return {
    ...firstResponse,
    items,
    total: Math.max(firstResponse.total, response.total, items.length),
    count: items.length,
    page: {
      cursor: firstResponse.page.cursor,
      nextCursor: null,
      limit: Math.max(firstResponse.page.limit, items.length),
      hasMore: false,
    },
  };
}

function sourceOptionContinuationQuery(href: string, location: URL, cursor: string): string {
  const continuation = new URL(href, location);
  continuation.searchParams.set("cursor", cursor);
  continuation.searchParams.set("limit", String(SOURCE_OPTION_CONTINUATION_PAGE_LIMIT));
  continuation.searchParams.set("cacheOnly", "true");
  continuation.searchParams.delete("forceRefresh");
  return continuation.searchParams.toString();
}

function assertSourceOptionContinuation(
  firstResponse: SourceObservationIntegrationOptionResponse,
  response: SourceObservationIntegrationOptionResponse,
  expectedCursor: string,
  queryKind: string,
): void {
  if (!response.page || response.page.cursor !== expectedCursor) {
    throw new CatalogSourceOptionPaginationError(queryKind, "the continuation page did not match its cursor");
  }
  if (response.total !== firstResponse.total) {
    throw new CatalogSourceOptionPaginationError(queryKind, "the cached option count changed between pages");
  }
  if (firstResponse.cache?.cacheKey && response.cache?.cacheKey !== firstResponse.cache.cacheKey) {
    throw new CatalogSourceOptionPaginationError(queryKind, "the option cache changed between pages");
  }
}

class CatalogSourceOptionPaginationError extends Error {
  readonly code = "catalog_provider_option_pagination_invalid";

  constructor(queryKind: string, reason: string) {
    super(`Provider source option query '${queryKind}' could not load every option because ${reason}.`);
    this.name = "CatalogSourceOptionPaginationError";
  }
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
  if (error instanceof CatalogSourceOptionQueryRefusedError) {
    const parsed = sourceOptionRefusalBody(error.body);
    return {
      status: error.status,
      code: parsed.code,
      message: parsed.message,
      rolloutBlocked: error.status === 403 && parsed.code === "catalog_integration_rollout_control_denied",
    };
  }
  if (error instanceof CatalogSourceOptionPageTimeoutError || error instanceof CatalogSourceOptionPaginationError) {
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
    message: "Provider source options are unavailable.",
    rolloutBlocked: false,
  };
}

function sourceOptionRefusalBody(body: unknown): Readonly<{ code: string; message: string }> {
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
