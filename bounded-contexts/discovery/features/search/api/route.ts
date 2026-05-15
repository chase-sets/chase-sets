import { Hono } from "hono";
import type { DiscoveryItemSearchServices } from "./runtime";

export function discoveryItemSearchRoutes(services: DiscoveryItemSearchServices) {
  const app = new Hono();

  app.get("/", async (c) => {
    const url = new URL(c.req.url);
    const search = c.req.query("search");
    const category = c.req.query("category");
    const tag = c.req.query("tag");
    const blueprintId = c.req.query("blueprintId");
    const language = c.req.query("language");
    const sort = c.req.query("sort");
    const status = c.req.query("status");
    const limit = c.req.query("limit");
    const offset = c.req.query("offset");
    const cursor = c.req.query("cursor");
    const includeTotal = c.req.query("includeTotal");

    const result = await services.searchItems({
      search: search || undefined,
      category: category || undefined,
      tag: tag || undefined,
      blueprintId: blueprintId || undefined,
      language: language || undefined,
      sort: sort || undefined,
      status: status || undefined,
      limit: limit ? Number.parseInt(limit, 10) : undefined,
      offset: offset ? Number.parseInt(offset, 10) : undefined,
      cursor: cursor || undefined,
      includeTotal: includeTotal === "true",
      fieldFilters: readFieldFilters(url.searchParams),
      dimensionFilters: readDimensionFilters(url.searchParams),
    });

    return c.json({
      items: result.items,
      facets: result.facets,
      total: result.total,
      count: result.items.length,
      nextCursor: result.nextCursor,
    });
  });

  return app;
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

function readDimensionFilters(searchParams: URLSearchParams) {
  return [...searchParams.entries()]
    .filter(([key]) => key.startsWith("dimension."))
    .map(([key, value]) => ({
      dimensionId: key.slice("dimension.".length),
      optionId: value,
    }))
    .filter((filter) => filter.dimensionId.length > 0 && filter.optionId.length > 0);
}
