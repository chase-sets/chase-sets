import { parseCatalogAttentionQueueWindow, type CatalogAttentionQueueNavigation } from "../api/contracts";
import {
  CATALOG_ATTENTION_SUMMARY_WINDOW,
  type CatalogAttentionItemKind,
  type CatalogAttentionQueueWindow,
} from "../read-model/attention-item";

// Route parameters for a mounted panel's window, kept apart from the host page's
// own parameters (for example Scope Record filters and `page`) so paging the queue
// never moves the host list and paging the host list never moves the queue.
export const CATALOG_ATTENTION_KIND_PARAM = "attentionKind";
export const CATALOG_ATTENTION_OFFSET_PARAM = "attentionOffset";

// The queue window a page URL asks for. An unknown kind falls back to the summary
// instead of failing the host page.
export function readCatalogAttentionQueuePageWindow(url: URL): CatalogAttentionQueueWindow {
  return (
    parseCatalogAttentionQueueWindow({
      kind: url.searchParams.get(CATALOG_ATTENTION_KIND_PARAM),
      offset: url.searchParams.get(CATALOG_ATTENTION_OFFSET_PARAM),
    }) ?? CATALOG_ATTENTION_SUMMARY_WINDOW
  );
}

// Everything the page URL carries except the attention window.
export function catalogAttentionQueueNavigation(url: URL): CatalogAttentionQueueNavigation {
  const search = new URLSearchParams(url.searchParams);
  search.delete(CATALOG_ATTENTION_KIND_PARAM);
  search.delete(CATALOG_ATTENTION_OFFSET_PARAM);
  return { pathname: url.pathname, search: search.toString() };
}

// A page link that keeps the host page's parameters and sets only the window;
// `kind: null` at offset 0 returns to the summary.
export function catalogAttentionQueuePageHref(
  navigation: CatalogAttentionQueueNavigation,
  target: Readonly<{ kind: CatalogAttentionItemKind | null; offset: number }>,
): string {
  const search = new URLSearchParams(navigation.search);
  if (target.kind) {
    search.set(CATALOG_ATTENTION_KIND_PARAM, target.kind);
  }
  if (target.offset > 0) {
    search.set(CATALOG_ATTENTION_OFFSET_PARAM, String(target.offset));
  }
  const query = search.toString();
  return query ? `${navigation.pathname}?${query}` : navigation.pathname;
}
