import { afterEach, describe, expect, it, vi } from "vitest";
import { CHASE_SETS_INTERNAL_API_ORIGIN_ENV } from "@chase-sets/platform-runtime/http";
import {
  cancelProjectionOperation,
  loadWakeStatusSnapshot,
  readProjectionOperationsFilters,
  rebuildProjectionContext,
  rebuildProjectionGroup,
  refreshProjectionStatus,
  retryBlockedStream,
} from "./client";

describe("projection operations API client", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("reads route filters from query state", () => {
    const filters = readProjectionOperationsFilters(
      new Request(
        "https://admin.example.com/platform/projections?tab=blocked&state=failed&contextName=catalog&projectionName=catalog-item&search=charizard&selected=op_1",
      ),
    );

    expect(filters).toEqual({
      state: "failed",
      contextName: "catalog",
      projectionName: "catalog-item",
      search: "charizard",
      selected: "op_1",
    });
  });

  it("posts refresh, retry, rebuild, and cancel operations to the platform API", async () => {
    const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(async (input) => {
      const url = String(input);
      if (url.endsWith("/refresh")) {
        return new Response(
          JSON.stringify({
            summary: { totalGroups: 1 },
            projectionGroups: [],
            blockedProjections: [],
            projectionStatusSource: "live-refresh",
            workers: [],
            runners: [],
            operations: [],
            operationSummary: null,
          }),
          { status: 202 },
        );
      }
      if (url.endsWith("/cancel")) {
        return new Response(JSON.stringify({ result: { cancelled: true } }), { status: 200 });
      }
      return new Response(JSON.stringify({ operation: { operationId: "op_queued", state: "queued" } }), {
        status: 202,
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const request = new Request("https://admin.example.com/platform/projections", {
      headers: { cookie: "session=abc" },
    });

    const refreshed = await refreshProjectionStatus(request);
    const retried = await retryBlockedStream(request, {
      projectionKey: "catalog.catalog-item-projection",
      streamId: "catalog.item-1",
    });
    const rebuiltGroup = await rebuildProjectionGroup(request, {
      contextName: "catalog",
      projectionName: "catalog-item-projection",
    });
    const rebuiltContext = await rebuildProjectionContext(request, { contextName: "catalog" });
    const cancelled = await cancelProjectionOperation(request, { operationId: "op_1" });

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
    expect(refreshed.projectionStatusSource).toBe("live-refresh");
    expect(retried).toEqual({ operation: { operationId: "op_queued", state: "queued" } });
    expect(rebuiltGroup).toEqual({ operation: { operationId: "op_queued", state: "queued" } });
    expect(rebuiltContext).toEqual({ operation: { operationId: "op_queued", state: "queued" } });
    expect(cancelled).toEqual({ result: { cancelled: true } });
  });

  it("preserves dotted projection names when posting blocked-stream retries", async () => {
    const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(
      async () =>
        new Response(JSON.stringify({ operation: { operationId: "op_queued", state: "queued" } }), {
          status: 202,
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const request = new Request("https://admin.example.com/platform/projections", {
      headers: { cookie: "session=abc" },
    });

    await retryBlockedStream(request, {
      projectionKey: "checkout.checkout.session-projection",
      streamId: "checkout.session-1",
    });

    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      "https://admin.example.com/api/platform/projections/checkout.checkout.session-projection/blocked-streams/checkout.session-1/retry",
    );
  });

  it("uses the configured internal API origin for production-safe server calls", async () => {
    const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(
      async () =>
        new Response(
          JSON.stringify({
            summary: {},
            projectionGroups: [],
            blockedProjections: [],
            projectionStatusSource: "live-refresh",
            workers: [],
            runners: [],
            operations: [],
            operationSummary: null,
          }),
          { status: 202 },
        ),
    );
    vi.stubEnv(CHASE_SETS_INTERNAL_API_ORIGIN_ENV, "http://platform-api:8080");
    vi.stubGlobal("fetch", fetchMock);
    const request = new Request("https://admin.example.com/platform/projections", {
      headers: { cookie: "session=abc" },
    });

    await refreshProjectionStatus(request);

    expect(String(fetchMock.mock.calls[0]?.[0])).toBe("http://platform-api:8080/api/platform/projections/refresh");
  });

  it("loads and normalizes the wake status snapshot", async () => {
    const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(
      async () =>
        new Response(
          JSON.stringify({
            generatedAt: "2026-06-11T12:00:00.000Z",
            wakeStore: { available: true, intentSummary: { queuedCount: 2 } },
            relay: { available: true, lease: null, cursors: [] },
          }),
          { status: 200 },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const request = new Request("https://admin.example.com/platform/projections", {
      headers: { cookie: "session=abc" },
    });

    const snapshot = await loadWakeStatusSnapshot(request);

    expect(String(fetchMock.mock.calls[0]?.[0])).toBe("https://admin.example.com/api/platform/projections/wake-status");
    expect(snapshot).toMatchObject({
      wakeStore: { available: true, intentSummary: { queuedCount: 2 } },
      relay: { available: true, lease: null },
    });
  });

  it("degrades to null when the wake status endpoint is missing or failing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("not found", { status: 404 })),
    );
    const request = new Request("https://admin.example.com/platform/projections");

    await expect(loadWakeStatusSnapshot(request)).resolves.toBeNull();

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("connection refused");
      }),
    );

    await expect(loadWakeStatusSnapshot(request)).resolves.toBeNull();
  });
});
