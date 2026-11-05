import { resolveActorFromAuthApi } from "@chase-sets/platform-runtime/auth";
import type { LoaderFunctionArgs } from "react-router";
import { CatalogApiError, createCatalogRequestApiClient } from "../../request-support/api-client";
import type { CatalogScopeRecordListResponse } from "../../../features/scope-registry/ui/contracts";
import {
  buildCatalogScopeLandingReadModel,
  type CatalogScopeLandingReadModel,
} from "../../../features/source-observations/ui/admin-control-plane/scope-landing/scope-landing-read-model";
import type { CatalogAliasReviewReadModel } from "../../../features/alias-equivalence/api/alias-review-admin-contracts";
import type { CatalogDeferredAttentionQueueResult } from "../../../features/attention-queue/api/contracts";
import {
  CATALOG_ATTENTION_QUEUE_UNAVAILABLE,
  resolveCatalogAttentionQueueResult,
} from "../admin-integrations/attention-queue-result";
import { readCatalogListQuery, type CatalogListQuery } from "../../shell-support/list-query-state";

// Scope-first landing route loader (`/catalog/scopes`). Loads the canonical
// Scope Record list with server-side language filtering and global observed
// facets, then builds the landing read model.
//
// Fail-soft: a transient list failure resolves to an empty, correctly-shaped
// read model plus a `blocked` error string so the surface renders its blocked
// banner rather than throwing into an error page.
export type CatalogScopeLandingRouteData = Readonly<{
  readModel: CatalogScopeLandingReadModel;
  query: CatalogListQuery;
  productDomain: string;
  error: string | null;
  canManage: boolean;
  attentionQueue: CatalogDeferredAttentionQueueResult;
  generalAliasReview: CatalogAliasReviewReadModel | null;
  generalAliasReviewFailed: boolean;
}>;

export async function loader({ request }: LoaderFunctionArgs): Promise<CatalogScopeLandingRouteData> {
  const query = readCatalogListQuery(request);
  const productDomain = new URL(request.url).searchParams.get("productDomain")?.trim() ?? "";
  const api = createCatalogRequestApiClient(request);

  const [result, attentionQueue, generalAliasReview, actor] = await Promise.all([
    loadScopeRecords(api, query, productDomain),
    loadAttentionQueue(api),
    loadGeneralAliasReview(api),
    resolveActor(request).catch(() => null),
  ]);

  return {
    readModel: buildCatalogScopeLandingReadModel({
      scopes: result.scopes,
      filters: {
        search: query.search,
        productDomain,
        languageEdition: query.language,
        lifecycleStatus: query.status,
      },
      // The API's generation time, the clock its row freshness was measured against.
      generatedAt: result.scopes.generatedAt ?? new Date().toISOString(),
    }),
    query,
    productDomain,
    error: result.error,
    canManage: actor?.permissions.includes("catalog.manage") ?? false,
    attentionQueue,
    generalAliasReview: generalAliasReview.readModel,
    generalAliasReviewFailed: generalAliasReview.failed,
  };
}

async function loadAttentionQueue(
  api: ReturnType<typeof createCatalogRequestApiClient>,
): Promise<CatalogDeferredAttentionQueueResult> {
  if (typeof api.getCatalogAttentionQueueReadModel !== "function") return CATALOG_ATTENTION_QUEUE_UNAVAILABLE;
  try {
    return resolveCatalogAttentionQueueResult(await api.getCatalogAttentionQueueReadModel<unknown>());
  } catch {
    return CATALOG_ATTENTION_QUEUE_UNAVAILABLE;
  }
}

async function loadGeneralAliasReview(
  api: ReturnType<typeof createCatalogRequestApiClient>,
): Promise<Readonly<{ readModel: CatalogAliasReviewReadModel | null; failed: boolean }>> {
  if (typeof api.getCatalogAliasReviewReadModel !== "function") return { readModel: null, failed: false };
  try {
    const value = await api.getCatalogAliasReviewReadModel<unknown>("limit=200");
    return isAliasReviewReadModel(value) ? { readModel: value, failed: false } : { readModel: null, failed: true };
  } catch {
    return { readModel: null, failed: true };
  }
}

function isAliasReviewReadModel(value: unknown): value is CatalogAliasReviewReadModel {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Partial<CatalogAliasReviewReadModel>;
  return (
    candidate.schemaVersion === "catalog-alias-review-v1" &&
    typeof candidate.generatedAt === "string" &&
    Array.isArray(candidate.candidates) &&
    Array.isArray(candidate.groups) &&
    typeof candidate.counts === "object" &&
    candidate.counts !== null &&
    typeof candidate.coverage === "object" &&
    candidate.coverage !== null
  );
}

async function resolveActor(request: Request) {
  return resolveActorFromAuthApi({ request });
}

async function loadScopeRecords(
  api: ReturnType<typeof createCatalogRequestApiClient>,
  query: CatalogListQuery,
  productDomain: string,
): Promise<{ scopes: CatalogScopeRecordListResponse; error: string | null }> {
  try {
    const scopes = await api.listCatalogScopeRecords<CatalogScopeRecordListResponse>(
      scopeRecordsApiQuery(query, productDomain),
    );
    return {
      scopes: {
        ...scopes,
        facets: scopes.facets ?? { languageEditions: [] },
      },
      error: null,
    };
  } catch (error) {
    if (error instanceof CatalogApiError) {
      return { scopes: emptyScopeList(), error: error.message };
    }
    throw error;
  }
}

function scopeRecordsApiQuery(query: CatalogListQuery, productDomain: string): string {
  const params = new URLSearchParams();
  if (query.search) {
    params.set("search", query.search);
  }
  if (query.status) {
    params.set("status", query.status);
  }
  if (productDomain) {
    params.set("productDomain", productDomain);
  }
  if (query.language) {
    params.set("languageEdition", query.language);
  }
  params.set("limit", String(query.pageSize));
  params.set("offset", String(query.page * query.pageSize));
  return params.toString();
}

function emptyScopeList(): CatalogScopeRecordListResponse {
  return { items: [], total: 0, count: 0, facets: { languageEditions: [] } };
}
