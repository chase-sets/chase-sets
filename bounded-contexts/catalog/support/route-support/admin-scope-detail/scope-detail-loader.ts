import { resolveActorFromAuthApi } from "@chase-sets/platform-runtime/auth";
import type { LoaderFunctionArgs } from "react-router";
import { createCatalogRequestApiClient, type CatalogScopeRecordDetail } from "../../request-support/api-client";
import { CatalogApiError } from "../../../client";
import { catalogScopeHasLanguageEditionsToReview } from "../../../features/source-observations/ui/admin-control-plane/scope-detail/language-editions/language-edition-review";
import type { CatalogAliasReviewReadModel } from "../../../features/alias-equivalence/api/alias-review-admin-contracts";

// Scope Detail route loader (`/catalog/scopes/:id`). Loads the canonical Scope
// Record and, only when the scope has sibling language editions to review,
// the alias review read model scoped to this scope's reference record — the
// same alias-equivalence read model the generic alias-review table reads,
// narrowed with the `targetKind`/`targetId` filter so the section never
// double-counts or leaks another scope's candidates.
export type CatalogScopeDetailRouteData = Readonly<{
  scope: CatalogScopeRecordDetail;
  languageEditionAliasReview: CatalogAliasReviewReadModel;
  // True when the supplementary alias-review load degraded to an empty model,
  // so the journey overview can surface a partial-failure state instead of
  // reading the empty model as "no candidates".
  languageEditionAliasReviewFailed: boolean;
  canManageAliases: boolean;
}>;

export async function loader({ request, params }: LoaderFunctionArgs): Promise<CatalogScopeDetailRouteData> {
  const scopeRecordId = params.id ?? "";
  const api = createCatalogRequestApiClient(request);

  const [scope, actor] = await Promise.all([
    api.getCatalogScopeRecord<CatalogScopeRecordDetail>(scopeRecordId),
    resolveActor(request),
  ]);

  const aliasReview = catalogScopeHasLanguageEditionsToReview(scope)
    ? await loadLanguageEditionAliasReview(api, scope.referenceRecordId)
    : { readModel: emptyAliasReviewReadModel(scope.referenceRecordId), failed: false };

  return {
    scope,
    languageEditionAliasReview: aliasReview.readModel,
    languageEditionAliasReviewFailed: aliasReview.failed,
    canManageAliases: actor?.permissions.includes("catalog.manage") ?? false,
  };
}

async function loadLanguageEditionAliasReview(
  api: ReturnType<typeof createCatalogRequestApiClient>,
  referenceRecordId: string,
): Promise<Readonly<{ readModel: CatalogAliasReviewReadModel; failed: boolean }>> {
  try {
    const query = new URLSearchParams({ targetKind: "reference-record", targetId: referenceRecordId }).toString();
    return { readModel: await api.getCatalogAliasReviewReadModel<CatalogAliasReviewReadModel>(query), failed: false };
  } catch (error) {
    // Supplementary read: a transient alias-review failure never blocks the
    // scope header from rendering. The section falls back to an empty (but
    // correctly-shaped) read model rather than throwing into an error page, and
    // the failure is reported so the journey overview reads it as degraded.
    if (error instanceof CatalogApiError) {
      return { readModel: emptyAliasReviewReadModel(referenceRecordId), failed: true };
    }
    throw error;
  }
}

function emptyAliasReviewReadModel(referenceRecordId: string): CatalogAliasReviewReadModel {
  return {
    schemaVersion: "catalog-alias-review-v1",
    generatedAt: new Date().toISOString(),
    filter: {
      providerKey: null,
      sourceProfileVersion: null,
      aliasType: null,
      reviewStatuses: [],
      observationId: null,
      targetKind: "reference-record",
      targetId: referenceRecordId,
    },
    counts: {
      total: 0,
      pending: 0,
      accepted: 0,
      autoAccepted: 0,
      rejected: 0,
      revoked: 0,
      needsReview: 0,
      autoAcceptEligible: 0,
      warned: 0,
    },
    candidates: [],
    groups: [],
    coverage: {
      cardsWithAcceptedEnglishAlias: 0,
      cardsWithOnlySpeciesAliases: 0,
      cardsNeedingReview: 0,
      expansionsAndSeriesNeedingReview: 0,
      cards: [],
      referenceScopes: [],
    },
  };
}

async function resolveActor(request: Request): ReturnType<typeof resolveActorFromAuthApi> {
  try {
    return await resolveActorFromAuthApi({ request });
  } catch {
    return null;
  }
}
