import { describe, expect, it } from "vitest";
import type { PortableClientFetch } from "@chase-sets/platform-runtime/portable-client";
import { loadPortableSearchRoute } from "../ui/portable-route";

function urlOf(input: RequestInfo | URL) {
  return new URL(input instanceof Request ? input.url : input.toString());
}

describe("portable Search route", () => {
  it("cold-loads browse data from an injected absolute-origin fetch", async () => {
    const requested: string[] = [];
    const fetch: PortableClientFetch = (input) => {
      const url = urlOf(input);
      requested.push(url.toString());
      if (url.pathname === "/api/marketplace/categories") {
        return Promise.resolve(Response.json({ items: [], total: 0, count: 0 }));
      }
      return Promise.resolve(
        Response.json({
          items: [],
          facets: [],
          category_counts: [],
          total: 0,
          count: 0,
          nextCursor: null,
          retrievalMode: "lexical",
          lexicalCount: 0,
          queryHash: "query",
          resultSetKey: "result",
        }),
      );
    };

    await expect(
      loadPortableSearchRoute(
        { url: new URL("https://mobile.local/search?q=pikachu"), params: {} },
        { apiOrigin: "https://api.chasesets.test", fetch },
      ),
    ).resolves.toMatchObject({ kind: "data", data: { search: "pikachu" } });
    expect(requested).toEqual([
      "https://api.chasesets.test/api/marketplace/categories",
      expect.stringMatching(/^https:\/\/api\.chasesets\.test\/api\/marketplace\/items\?/),
    ]);
  });

  it("returns a portable navigation outcome for legacy page query parameters", async () => {
    const fetch: PortableClientFetch = () => Promise.reject(new Error("fetch must not run"));
    await expect(
      loadPortableSearchRoute(
        { url: new URL("https://mobile.local/search?q=pikachu&page=2"), params: {} },
        { apiOrigin: "https://api.chasesets.test", fetch },
      ),
    ).resolves.toEqual({ kind: "navigate", to: "/search?q=pikachu", replace: true });
  });
});
