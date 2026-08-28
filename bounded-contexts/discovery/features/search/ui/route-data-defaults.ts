import type { CategoryListResponse } from "../../categories/api/contracts";
import type { DiscoverySearchResponse } from "../../../support/client-support/contracts";

export const EMPTY_CATEGORY_LIST: CategoryListResponse = {
  items: [],
  total: 0,
  count: 0,
};

export const EMPTY_DISCOVERY_SEARCH_RESPONSE: DiscoverySearchResponse = {
  items: [],
  facets: [],
  category_counts: [],
  total: 0,
  count: 0,
  nextCursor: null,
  retrievalMode: "lexical",
  lexicalCount: 0,
  queryHash: "",
  resultSetKey: "",
};
