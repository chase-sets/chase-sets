import { Hono } from "hono";
import type { AuthenticatedApiEnv } from "@chase-sets/auth-context";
import type { DiscoveryItemSearchServices } from "./runtime";
import type { DiscoveryMarketActivityFilter } from "../read-model/queries";
import { truncateDiscoverySearchQuery, truncateDiscoverySearchSuggestionQuery } from "../domain/normalization";

export function discoveryItemSearchRoutes(services: DiscoveryItemSearchServices) {
  const app = new Hono<AuthenticatedApiEnv>();

  app.get("/suggest", async (c) => {
    const query = truncateDiscoverySearchSuggestionQuery(c.req.query("q") ?? "");
    if (!query.trim()) {
      return c.json({ items: [], count: 0 });
    }

    const requestedLimit = Number.parseInt(c.req.query("limit") ?? "", 10);
    const items = await services.suggestItems(query, Number.isFinite(requestedLimit) ? requestedLimit : undefined);

    return c.json({ items, count: items.length });
  });

  app.get("/bulk-cart-preview", async (c) => {
    const params = searchParamsFromRequest(c.req.url, c.req.query.bind(c.req));
    const result = await services.previewBulkAdd(params);

    return c.json(result);
  });

  app.get("/", async (c) => {
    const params = searchParamsFromRequest(c.req.url, c.req.query.bind(c.req));

    const result = await services.searchItems(params);

    const actor = c.var.actor;
    const context = c.var.context;
    if (actor && !actor.agentGrant && context) {
      await services.publishSearchOutcome?.({
        accountId: actor.accountId,
        sessionId: actor.sessionId,
        context,
      });
    }

    return c.json({
      items: result.items,
      facets: result.facets,
      category_counts: result.category_counts,
      total: result.total,
      count: result.items.length,
      nextCursor: result.nextCursor,
      retrievalMode: result.retrievalMode,
      lexicalCount: result.lexicalCount,
      queryHash: result.queryHash,
      resultSetKey: result.resultSetKey,
    });
  });

  return app;
}

function searchParamsFromRequest(requestUrl: string, query: (name: string) => string | undefined) {
  const url = new URL(requestUrl);
  const search = query("search");
  const category = query("category");
  const tag = query("tag");
  const blueprintId = query("blueprintId");
  const language = query("language");
  const marketActivity = normalizeMarketActivity(query("marketActivity"));
  const priceMin = normalizePriceAmount(query("priceMin"));
  const priceMax = normalizePriceAmount(query("priceMax"));
  const inStock = query("inStock") === "true";
  const sort = query("sort");
  const limit = query("limit");
  const offset = query("offset");
  const cursor = query("cursor");
  const includeTotal = query("includeTotal");

  return {
    search: search ? truncateDiscoverySearchQuery(search) : undefined,
    category: category || undefined,
    tag: tag || undefined,
    blueprintId: blueprintId || undefined,
    language: language || undefined,
    marketActivity,
    priceMin,
    priceMax,
    inStock,
    sort: sort || undefined,
    status: "active",
    limit: limit ? Number.parseInt(limit, 10) : undefined,
    offset: offset ? Number.parseInt(offset, 10) : undefined,
    cursor: cursor || undefined,
    includeTotal: includeTotal === "true",
    fieldFilters: readFieldFilters(url.searchParams),
    referenceFilters: readReferenceFilters(url.searchParams),
    dimensionFilters: readDimensionFilters(url.searchParams),
  };
}

function normalizeMarketActivity(value: string | undefined): DiscoveryMarketActivityFilter | undefined {
  return value === "listings" || value === "offers" || value === "any" ? value : undefined;
}

function normalizePriceAmount(value: string | undefined): string | undefined {
  const amount = value?.trim();
  if (!amount || !/^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/.test(amount)) {
    return undefined;
  }

  return amount;
}

function readFieldFilters(searchParams: URLSearchParams) {
  return [...searchParams.entries()]
    .filter(([key]) => key.startsWith("field."))
    .map(([key, value]) => ({
      fieldId: key.slice("field.".length),
      value,
    }))
    .filter((filter) => filter.fieldId.length > 0 && filter.value.length > 0);
}

function readReferenceFilters(searchParams: URLSearchParams) {
  return [...searchParams.entries()]
    .filter(([key]) => key.startsWith("reference."))
    .map(([key, value]) => ({
      typeKey: key.slice("reference.".length),
      referenceId: value,
    }))
    .filter((filter) => filter.typeKey.length > 0 && filter.referenceId.length > 0);
}

function readDimensionFilters(searchParams: URLSearchParams) {
  return [...searchParams.entries()]
    .filter(([key]) => key.startsWith("dimension."))
    .map(([key, value]) => ({
      dimensionId: key.slice("dimension.".length),
      optionId: value,
    }))
    .filter((filter) => filter.dimensionId.length > 0 && filter.optionId.length > 0);
}
