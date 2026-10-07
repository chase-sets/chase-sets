import { afterEach, describe, expect, it, vi } from "vitest";
import type { LoaderFunctionArgs } from "react-router";
import { createId } from "@chase-sets/primitives/typed-ids";
import { loader } from "./requests";

describe("support requests admin loader", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("AC5 preserves unresolved, page count and rows on load, reload and returning to the URL", async () => {
    const queue = {
      items: [{ support_request_id: createId("sup"), status: "waiting-on-seller" }],
      total: 5,
      count: 1,
    };
    const fetchMock = vi.fn(async (_input: RequestInfo | URL) => Response.json(queue));
    vi.stubGlobal("fetch", fetchMock);
    const unresolvedUrl = "https://support.example.test/support/requests?status=unresolved&limit=2&offset=2";
    for (const url of [
      unresolvedUrl,
      unresolvedUrl,
      "https://support.example.test/support/requests?status=resolved",
      unresolvedUrl,
    ]) {
      const result = await loader({ request: new Request(url), params: {}, context: {} } as LoaderFunctionArgs);
      const outgoing = new URL(String(fetchMock.mock.calls.at(-1)?.[0]));
      expect(outgoing.pathname).toBe("/api/marketplace/support-requests/ops");
      if (url === unresolvedUrl) {
        expect(outgoing.searchParams.toString()).toBe("limit=2&offset=2&status=unresolved");
        expect(result.filters.status).toBe("unresolved");
        expect(result.pagination).toEqual({ limit: 2, offset: 2 });
        expect(result.queue).toEqual(queue);
        expect(result.unavailableMessage).toBeNull();
      } else {
        expect(result.filters.status).toBe("resolved");
      }
    }
  });

  it("AC5 unknown status uses the default view without sending an explicit status", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL) => Response.json({ items: [], total: 0, count: 0 }));
    vi.stubGlobal("fetch", fetchMock);
    const result = await loader({
      request: new Request("https://support.example.test/support/requests?status=unknown&limit=2&offset=2"),
      params: {},
      context: {},
    } as LoaderFunctionArgs);
    expect(new URL(String(fetchMock.mock.calls[0]?.[0])).searchParams.toString()).toBe("limit=2&offset=2");
    expect(result.filters.status).toBe("all");
  });

  it("preserves the existing visible loader failure signal", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("Queue unavailable");
      }),
    );
    const result = await loader({
      request: new Request("https://support.example.test/support/requests?status=unresolved"),
      params: {},
      context: {},
    } as LoaderFunctionArgs);
    expect(result.unavailableMessage).toBe("Queue unavailable");
    expect(result.filters.status).toBe("unresolved");
  });
});
