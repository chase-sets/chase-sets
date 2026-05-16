import type { ListResponse } from "@chase-sets/http/responses";
import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigation, useSearchParams } from "react-router";

export const CATALOG_LIST_PAGE_SIZE = 50;
export const CATALOG_LIST_SEARCH_DEBOUNCE_MS = 300;

export type CatalogListQuery = Readonly<{
  search: string;
  status: string;
  language: string;
  source: string;
  setId: string;
  page: number;
  pageSize: number;
}>;

export type CatalogListRouteData<T> = Readonly<{
  data: ListResponse<T>;
  query: CatalogListQuery;
}>;

type CatalogListQueryUpdate = Partial<Pick<CatalogListQuery, "search" | "status" | "language" | "source" | "setId" | "page">>;

export function readCatalogListQuery(request: Request): CatalogListQuery {
  const url = new URL(request.url);
  const pageFromUrl = Number.parseInt(url.searchParams.get("page") ?? "1", 10);

  return {
    search: url.searchParams.get("search")?.trim() ?? "",
    status: url.searchParams.get("status")?.trim() ?? "",
    language: url.searchParams.get("language")?.trim() ?? "",
    source: url.searchParams.get("source")?.trim() ?? "",
    setId: url.searchParams.get("setId")?.trim() ?? "",
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

export function useCatalogListQueryControls(
  query: CatalogListQuery,
  debounceMs = CATALOG_LIST_SEARCH_DEBOUNCE_MS,
) {
  const navigation = useNavigation();
  const [, setSearchParams] = useSearchParams();
  const [draftSearch, setDraftSearch] = useState(query.search);
  const draftSearchRef = useRef(query.search);
  const pendingSearchRef = useRef<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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
      setSearchParams(
        (current) => applyCatalogListQueryToSearchParams(current, update),
        { preventScrollReset: true, replace },
      );
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
    page: query.page,
    pageSize: query.pageSize,
    loading: navigation.state !== "idle",
    setSearch,
    setStatus: (status: string) => commitWithCurrentSearch({ status }),
    setLanguage: (language: string) => commitWithCurrentSearch({ language }),
    setSource: (source: string) => commitWithCurrentSearch({ source }),
    setSetId: (setId: string) => commitWithCurrentSearch({ setId }),
    setFilters: (filters: Omit<CatalogListQueryUpdate, "page">) =>
      commitWithCurrentSearch(filters),
    setPage: (page: number) => commitWithCurrentSearch({ page }),
  };
}
