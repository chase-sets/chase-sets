import { resolveActorFromAuthApi } from "@chase-sets/platform-runtime/auth";
import type { LoaderFunctionArgs } from "react-router";
import { createCatalogRequestApiClient, type ScopeCoverageMatrix } from "../../request-support/api-client";
import type {
  CatalogScopeJourneyOverviewReadModel,
  CatalogScopeJourneyResponse,
  CatalogScopeLanguageEditionReviewReadModel,
  CatalogScopeRecordDetail,
} from "../../../features/scope-registry/ui/contracts";
import type {
  CatalogMergeCandidateBulkJob,
  CatalogMergeCandidateBulkJobPage,
} from "../../../features/source-observations/api/runtime";
import {
  candidateReviewJobsCursorParam,
  type CatalogScopeCandidateReviewJobs,
} from "../../../features/source-observations/ui/admin-control-plane/scope-detail/candidate-review-jobs-panel";
import { loadDailySurfaceForRequest } from "../admin-integrations/integrations-loader-support";

// Scope Detail route loader (`/catalog/scopes/:id`). The Catalog API returns the
// canonical Scope Record with its language editions and journey in one read;
// a failed alias review there shows as the journey's partial-failure condition.
export type CatalogScopeDetailRouteData = Readonly<{
  scope: CatalogScopeRecordDetail;
  /** The editions to review; null when the scope has one edition or none. */
  languageEditions: CatalogScopeLanguageEditionReviewReadModel | null;
  journeyOverview: CatalogScopeJourneyOverviewReadModel;
  canManageAliases: boolean;
  coverageMatrix: ScopeCoverageMatrix | null;
  coverageMatrixFailed: boolean;
  journey: Awaited<ReturnType<typeof loadDailySurfaceForRequest>>;
  candidateReviewJobs: CatalogScopeCandidateReviewJobs;
  /** The completed-jobs page cursor this load rendered; null on the newest page. */
  candidateReviewJobsCursor: string | null;
}>;

export async function loader({ request, params }: LoaderFunctionArgs): Promise<CatalogScopeDetailRouteData> {
  const scopeRecordId = params.id ?? "";
  const api = createCatalogRequestApiClient(request);

  const candidateReviewJobsCursor =
    new URL(request.url).searchParams.get(candidateReviewJobsCursorParam)?.trim() || null;
  const [scopeJourney, actor, coverage, journey, candidateReviewJobs] = await Promise.all([
    api.getCatalogScopeJourney<CatalogScopeJourneyResponse>(scopeRecordId),
    resolveActor(request),
    loadScopeCoverageMatrix(api, scopeRecordId),
    // The Catalog API composes the journey from this page's own address and Scope Record.
    loadDailySurfaceForRequest(request),
    loadCandidateReviewJobs(api, scopeRecordId, candidateReviewJobsCursor),
  ]);

  return {
    scope: scopeJourney.scope,
    languageEditions: scopeJourney.languageEditions,
    journeyOverview: scopeJourney.overview,
    canManageAliases: actor?.permissions.includes("catalog.manage") ?? false,
    coverageMatrix: coverage.matrix,
    coverageMatrixFailed: coverage.failed,
    journey,
    candidateReviewJobs,
    candidateReviewJobsCursor,
  };
}

// Supplementary read: a failed job-list load renders a degraded panel instead of
// failing the scope page.
async function loadCandidateReviewJobs(
  api: ReturnType<typeof createCatalogRequestApiClient>,
  scopeRecordId: string,
  cursor: string | null,
): Promise<CatalogScopeCandidateReviewJobs> {
  try {
    const [active, completed, failedJobs] = await Promise.all([
      api.listCatalogMergeCandidateBulkJobs<Readonly<{ items: readonly CatalogMergeCandidateBulkJob[] }>>({
        scopeRecordId,
        status: "active",
      }),
      api.listCatalogMergeCandidateBulkJobs<CatalogMergeCandidateBulkJobPage>({
        scopeRecordId,
        status: "completed",
        cursor,
      }),
      api.listFailedCatalogMergeCandidateBulkJobs<Readonly<{ items: readonly CatalogMergeCandidateBulkJob[] }>>(
        scopeRecordId,
      ),
    ]);
    return {
      active: active.items,
      failedJobs: failedJobs.items,
      completed: completed.cursor ? { items: completed.items, cursor: completed.cursor } : { items: completed.items },
      failed: false,
    };
  } catch {
    return { active: [], failedJobs: [], completed: { items: [] }, failed: true };
  }
}

async function loadScopeCoverageMatrix(
  api: ReturnType<typeof createCatalogRequestApiClient>,
  scopeRecordId: string,
): Promise<Readonly<{ matrix: ScopeCoverageMatrix | null; failed: boolean }>> {
  try {
    return { matrix: await api.getScopeCoverageMatrix<ScopeCoverageMatrix>(scopeRecordId), failed: false };
  } catch {
    return { matrix: null, failed: true };
  }
}

async function resolveActor(request: Request): ReturnType<typeof resolveActorFromAuthApi> {
  try {
    return await resolveActorFromAuthApi({ request });
  } catch {
    return null;
  }
}
