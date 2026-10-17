import { afterEach, expect, it, vi } from "vitest";
import { createCatalogRequestApiClient } from "./api-client";
afterEach(() => vi.unstubAllGlobals());
it("AC1 production count client preserves browser origin/site for the paid boundary", async () => {
  const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json({ state: "complete" }));
  vi.stubGlobal("fetch", fetch);
  const request = new Request("http://127.0.0.1/catalog/scopes/sync-batches", {
    method: "POST",
    headers: { origin: "http://127.0.0.1", "sec-fetch-site": "same-origin" },
  });
  await createCatalogRequestApiClient(request).acquireScopeSyncCounts({
    quoteId: "synthetic",
    fingerprint: "synthetic",
  });
  const headers = new Headers(fetch.mock.calls[0]?.[1]?.headers);
  expect(headers.get("origin")).toBe("http://127.0.0.1");
  expect(headers.get("sec-fetch-site")).toBe("same-origin");
});
