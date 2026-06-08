import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cancelProjectionOperation,
  readProjectionOperationsFilters,
  rebuildProjectionContext,
  rebuildProjectionGroup,
  refreshProjectionStatus,
  retryBlockedStream,
} from "./client";

describe("projection operations API client", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reads route filters from query state", () => {
    const filters = readProjectionOperationsFilters(
      new Request(
        "https://admin.example.com/platform/projections?tab=blocked&state=failed&contextName=catalog&projectionName=catalog-item&search=charizard&selected=op_1",
      ),
    );

    expect(filters).toEqual({
      tab: "blocked",
      state: "failed",
      contextName: "catalog",
      projectionName: "catalog-item",
      search: "charizard",
      selected: "op_1",
    });
  });

  it("posts refresh, retry, rebuild, and cancel operations to the platform API", async () => {
    const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(
      async () => new Response("{}", { status: 202 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const request = new Request("https://admin.example.com/platform/projections", {
      headers: { cookie: "session=abc" },
    });

    await refreshProjectionStatus(request);
    await retryBlockedStream(request, { projectionKey: "catalog.catalog-item-projection", streamId: "catalog.item-1" });
    await rebuildProjectionGroup(request, { contextName: "catalog", projectionName: "catalog-item-projection" });
    await rebuildProjectionContext(request, { contextName: "catalog" });
    await cancelProjectionOperation(request, { operationId: "op_1" });

    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      "https://admin.example.com/api/platform/projections/refresh",
      "https://admin.example.com/api/platform/projections/catalog.catalog-item-projection/blocked-streams/catalog.item-1/retry",
      "https://admin.example.com/api/platform/projections/groups/catalog/catalog-item-projection/rebuild",
      "https://admin.example.com/api/platform/projections/groups/catalog/rebuild",
      "https://admin.example.com/api/platform/projections/operations/op_1/cancel",
    ]);
    expect(fetchMock.mock.calls[2]?.[1]).toMatchObject({
      method: "POST",
      body: JSON.stringify({ confirm: "rebuild" }),
    });
    expect(fetchMock.mock.calls[3]?.[1]).toMatchObject({
      method: "POST",
      body: JSON.stringify({ confirm: "rebuild-all" }),
    });
  });
});
