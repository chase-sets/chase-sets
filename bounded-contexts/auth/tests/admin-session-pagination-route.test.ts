import { afterEach, describe, expect, it, vi } from "vitest";
import { loader as sessionsLoader } from "../routes/access-admin/sessions";

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function requestUrl(input: RequestInfo | URL) {
  return input instanceof Request ? input.url : String(input);
}

describe("Auth admin session pagination route", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("forwards URL pagination to the session API list", async () => {
    const observedUrls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        observedUrls.push(requestUrl(input));
        return jsonResponse({ items: [], total: 72, count: 0 });
      }),
    );

    await sessionsLoader({
      request: new Request("https://admin.chasesets.test/access/sessions?limit=25&offset=50", {
        headers: { cookie: "session=auth" },
      }),
      params: {},
      context: undefined,
    } as never);

    expect(observedUrls).toHaveLength(1);
    const apiUrl = new URL(observedUrls[0]!);
    expect(`${apiUrl.pathname}${apiUrl.search}`).toBe("/api/auth/sessions?limit=25&offset=50");
  });
});
