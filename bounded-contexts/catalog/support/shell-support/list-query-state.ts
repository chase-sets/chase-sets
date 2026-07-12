import type { ListResponse } from "@chase-sets/http/responses";
import { useCallback, useEffect, useRef, useState } from "react";
import { useLocation, useNavigation, useSearchParams } from "react-router";

export const CATALOG_LIST_PAGE_SIZE = 50;
export const CATALOG_LIST_SEARCH_DEBOUNCE_MS = 300;

export type CatalogListQuery = Readonly<{
  search: string;
  status: string;
  language: string;
  source: string;
  setId: string;
  typeKey: string;
  valueKind: string;
  valueType: string;
  filterable: string;
  searchable: string;
  sortable: string;
  hasFieldRules: string;
  hasDimensionRules: string;
  hasComponents: string;
  parentCategoryId: string;
  hierarchy: string;
  blueprintId: string;
  blueprintState: string;
  tag: string;
  hasImages: string;
  hasSourceReferences: string;
  missingRequiredFields: string;
  attributeKey: string;
  attributeValue: string;
  relationshipType: string;
  relatedReferenceId: string;
  targetKind: string;
  page: number;
  pageSize: number;
}>;

export type CatalogListRouteData<T> = Readonly<{
  data: ListResponse<T>;
  query: CatalogListQuery;
}>;

const EXTRA_FILTER_KEYS = [
  "valueKind",
  "valueType",
  "filterable",
  "searchable",
  "sortable",
  "hasFieldRules",
  "hasDimensionRules",
  "hasComponents",
  "parentCategoryId",
  "hierarchy",
  "blueprintId",
  "blueprintState",
  "tag",
  "hasImages",
  "hasSourceReferences",
  "missingRequiredFields",
  "attributeKey",
  "attributeValue",
  "relationshipType",
  "relatedReferenceId",
  "targetKind",
] as const;

type ExtraFilterKey = (typeof EXTRA_FILTER_KEYS)[number];
type CatalogListQueryUpdate = Partial<
  Pick<CatalogListQuery, "search" | "status" | "language" | "source" | "setId" | "typeKey" | "page" | ExtraFilterKey>
>;

export function readCatalogListQuery(request: Request): CatalogListQuery {
  const url = new URL(request.url);
  const pageFromUrl = Number.parseInt(url.searchParams.get("page") ?? "1", 10);

  return {
    search: url.searchParams.get("search")?.trim() ?? "",
    status: url.searchParams.get("status")?.trim() ?? "",
    language: url.searchParams.get("language")?.trim() ?? "",
    source: url.searchParams.get("source")?.trim() ?? "",
    setId: url.searchParams.get("setId")?.trim() ?? "",
    typeKey: url.searchParams.get("typeKey")?.trim() ?? "",
    valueKind: url.searchParams.get("valueKind")?.trim() ?? "",
    valueType: url.searchParams.get("valueType")?.trim() ?? "",
    filterable: url.searchParams.get("filterable")?.trim() ?? "",
    searchable: url.searchParams.get("searchable")?.trim() ?? "",
    sortable: url.searchParams.get("sortable")?.trim() ?? "",
    hasFieldRules: url.searchParams.get("hasFieldRules")?.trim() ?? "",
    hasDimensionRules: url.searchParams.get("hasDimensionRules")?.trim() ?? "",
    hasComponents: url.searchParams.get("hasComponents")?.trim() ?? "",
    parentCategoryId: url.searchParams.get("parentCategoryId")?.trim() ?? "",
    hierarchy: url.searchParams.get("hierarchy")?.trim() ?? "",
    blueprintId: url.searchParams.get("blueprintId")?.trim() ?? "",
    blueprintState: url.searchParams.get("blueprintState")?.trim() ?? "",
    tag: url.searchParams.get("tag")?.trim() ?? "",
    hasImages: url.searchParams.get("hasImages")?.trim() ?? "",
    hasSourceReferences: url.searchParams.get("hasSourceReferences")?.trim() ?? "",
    missingRequiredFields: url.searchParams.get("missingRequiredFields")?.trim() ?? "",
    attributeKey: url.searchParams.get("attributeKey")?.trim() ?? "",
    attributeValue: url.searchParams.get("attributeValue")?.trim() ?? "",
    relationshipType: url.searchParams.get("relationshipType")?.trim() ?? "",
    relatedReferenceId: url.searchParams.get("relatedReferenceId")?.trim() ?? "",
    targetKind: url.searchParams.get("targetKind")?.trim() ?? "",
    page: Number.isFinite(pageFromUrl) ? Math.max(0, pageFromUrl - 1) : 0,
    pageSize: CATALOG_LIST_PAGE_SIZE,
  };
}

export function buildCatalogListApiQuery(query: CatalogListQuery): string {
  const params = new URLSearchParams();
  if (query.search) {
    params.set("search", query.search);
  }
  if (query.status) {
    params.set("status", query.status);
  }
  if (query.language) {
    params.set("language", query.language);
  }
  if (query.source) {
    params.set("source", query.source);
  }
  if (query.setId) {
    params.set("setId", query.setId);
  }
  if (query.typeKey) {
    params.set("typeKey", query.typeKey);
  }
  for (const key of EXTRA_FILTER_KEYS) {
    if (query[key]) {
      params.set(key, query[key]);
    }
  }
  params.set("limit", String(query.pageSize));
  params.set("offset", String(query.page * query.pageSize));
  return params.toString();
}

export function applyCatalogListQueryToSearchParams(
  current: URLSearchParams,
  update: CatalogListQueryUpdate,
): URLSearchParams {
  const next = new URLSearchParams(current);

  if (update.search !== undefined) {
    const search = update.search.trim();
    if (search) {
      next.set("search", search);
    } else {
      next.delete("search");
    }
    next.delete("page");
  }

  if (update.status !== undefined) {
    const status = update.status.trim();
    if (status) {
      next.set("status", status);
    } else {
      next.delete("status");
    }
    next.delete("page");
  }

  if (update.language !== undefined) {
    const language = update.language.trim();
    if (language) {
      next.set("language", language);
    } else {
      next.delete("language");
    }
    next.delete("page");
  }

  if (update.source !== undefined) {
    const source = update.source.trim();
    if (source) {
      next.set("source", source);
    } else {
      next.delete("source");
    }
    next.delete("page");
  }

  if (update.setId !== undefined) {
    const setId = update.setId.trim();
    if (setId) {
      next.set("setId", setId);
    } else {
      next.delete("setId");
    }
    next.delete("page");
  }

  if (update.typeKey !== undefined) {
    const typeKey = update.typeKey.trim();
    if (typeKey) {
      next.set("typeKey", typeKey);
    } else {
      next.delete("typeKey");
    }
    next.delete("page");
  }

  for (const key of EXTRA_FILTER_KEYS) {
    if (update[key] !== undefined) {
      const value = update[key].trim();
      if (value) {
        next.set(key, value);
      } else {
        next.delete(key);
      }
      next.delete("page");
    }
  }

  if (update.page !== undefined) {
    if (update.page > 0) {
      next.set("page", String(update.page + 1));
    } else {
      next.delete("page");
    }
  }

  return next;
}

export async function loadCatalogListRouteData<T>(
  request: Request,
  list: (query: string) => Promise<ListResponse<T>>,
): Promise<CatalogListRouteData<T>> {
  const query = readCatalogListQuery(request);
  const data = await list(buildCatalogListApiQuery(query));

  return { data, query };
}

export function useCatalogListQueryControls(query: CatalogListQuery, debounceMs = CATALOG_LIST_SEARCH_DEBOUNCE_MS) {
  const navigation = useNavigation();
  const location = useLocation();
  const [, setSearchParams] = useSearchParams();
  const [draftSearch, setDraftSearch] = useState(query.search);
  const draftSearchRef = useRef(query.search);
  const pendingSearchRef = useRef<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Kept fresh every render so the debounce timer below can observe the router's
  // *current* state when it fires, not the state captured when the timer was armed.
  const navigationRef = useRef(navigation);
  navigationRef.current = navigation;
  const pathnameRef = useRef(location.pathname);
  pathnameRef.current = location.pathname;

  const clearTimer = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  useEffect(() => {
    if (pendingSearchRef.current === null || pendingSearchRef.current === query.search) {
      pendingSearchRef.current = null;
      draftSearchRef.current = query.search;
      setDraftSearch(query.search);
    }
  }, [query.search]);

  useEffect(() => clearTimer, [clearTimer]);

  const commit = useCallback(
    (update: CatalogListQueryUpdate, replace: boolean) => {
      setSearchParams((current) => applyCatalogListQueryToSearchParams(current, update), {
        preventScrollReset: true,
        replace,
      });
    },
    [setSearchParams],
  );

  const commitWithCurrentSearch = useCallback(
    (update: Omit<CatalogListQueryUpdate, "search">) => {
      clearTimer();
      const search = pendingSearchRef.current ?? draftSearchRef.current;
      pendingSearchRef.current = search;
      commit({ search, ...update }, false);
    },
    [clearTimer, commit],
  );

  const setSearch = useCallback(
    (value: string) => {
      draftSearchRef.current = value;
      pendingSearchRef.current = value;
      setDraftSearch(value);
      clearTimer();
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        // A row-level link (e.g. the View button) may have started a client-side
        // navigation away from this list while the debounce was pending. Committing
        // the stale search now would interrupt that in-flight navigation (React Router
        // cancels a pending navigation when a new one starts) and yank the user back
        // to the list, so drop the pending search instead. Same-pathname navigations
        // (an earlier filter commit still loading) are still superseded as before.
        const currentNavigation = navigationRef.current;
        const navigatingAwayFromList =
          currentNavigation.state !== "idle" &&
          currentNavigation.location !== undefined &&
          currentNavigation.location.pathname !== pathnameRef.current;
        if (navigatingAwayFromList) {
          pendingSearchRef.current = null;
          return;
        }
        commit({ search: pendingSearchRef.current ?? "" }, true);
      }, debounceMs);
    },
    [clearTimer, commit, debounceMs],
  );

  return {
    search: draftSearch,
    status: query.status,
    language: query.language,
    source: query.source,
    setId: query.setId,
    typeKey: query.typeKey,
    valueKind: query.valueKind,
    valueType: query.valueType,
    filterable: query.filterable,
    searchable: query.searchable,
    sortable: query.sortable,
    hasFieldRules: query.hasFieldRules,
    hasDimensionRules: query.hasDimensionRules,
    hasComponents: query.hasComponents,
    parentCategoryId: query.parentCategoryId,
    hierarchy: query.hierarchy,
    blueprintId: query.blueprintId,
    blueprintState: query.blueprintState,
    tag: query.tag,
    hasImages: query.hasImages,
    hasSourceReferences: query.hasSourceReferences,
    missingRequiredFields: query.missingRequiredFields,
    attributeKey: query.attributeKey,
    attributeValue: query.attributeValue,
    relationshipType: query.relationshipType,
    relatedReferenceId: query.relatedReferenceId,
    targetKind: query.targetKind,
    page: query.page,
    pageSize: query.pageSize,
    loading: navigation.state !== "idle",
    setSearch,
    setStatus: (status: string) => commitWithCurrentSearch({ status }),
    setLanguage: (language: string) => commitWithCurrentSearch({ language }),
    setSource: (source: string) => commitWithCurrentSearch({ source }),
    setSetId: (setId: string) => commitWithCurrentSearch({ setId }),
    setTypeKey: (typeKey: string) => commitWithCurrentSearch({ typeKey }),
    setValueKind: (valueKind: string) => commitWithCurrentSearch({ valueKind }),
    setValueType: (valueType: string) => commitWithCurrentSearch({ valueType }),
    setFilterable: (filterable: string) => commitWithCurrentSearch({ filterable }),
    setSearchable: (searchable: string) => commitWithCurrentSearch({ searchable }),
    setSortable: (sortable: string) => commitWithCurrentSearch({ sortable }),
    setHasFieldRules: (hasFieldRules: string) => commitWithCurrentSearch({ hasFieldRules }),
    setHasDimensionRules: (hasDimensionRules: string) => commitWithCurrentSearch({ hasDimensionRules }),
    setHasComponents: (hasComponents: string) => commitWithCurrentSearch({ hasComponents }),
    setParentCategoryId: (parentCategoryId: string) => commitWithCurrentSearch({ parentCategoryId }),
    setHierarchy: (hierarchy: string) => commitWithCurrentSearch({ hierarchy }),
    setBlueprintId: (blueprintId: string) => commitWithCurrentSearch({ blueprintId }),
    setBlueprintState: (blueprintState: string) => commitWithCurrentSearch({ blueprintState }),
    setTag: (tag: string) => commitWithCurrentSearch({ tag }),
    setHasImages: (hasImages: string) => commitWithCurrentSearch({ hasImages }),
    setHasSourceReferences: (hasSourceReferences: string) => commitWithCurrentSearch({ hasSourceReferences }),
    setMissingRequiredFields: (missingRequiredFields: string) => commitWithCurrentSearch({ missingRequiredFields }),
    setAttributeKey: (attributeKey: string) => commitWithCurrentSearch({ attributeKey }),
    setAttributeValue: (attributeValue: string) => commitWithCurrentSearch({ attributeValue }),
    setRelationshipType: (relationshipType: string) => commitWithCurrentSearch({ relationshipType }),
    setRelatedReferenceId: (relatedReferenceId: string) => commitWithCurrentSearch({ relatedReferenceId }),
    setTargetKind: (targetKind: string) => commitWithCurrentSearch({ targetKind }),
    setFilters: (filters: Omit<CatalogListQueryUpdate, "page">) => commitWithCurrentSearch(filters),
    setPage: (page: number) => commitWithCurrentSearch({ page }),
  };
}
