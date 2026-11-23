import { afterEach, describe, expect, it, vi } from "vitest";
import { createOrderingApiClient, OrderingApiError } from "../../../client";
import { createPostagePolicyRequestClient } from "./request-client";

describe("postage policy request client", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("preserves the list query and forwards request credentials for postage policy reads", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json({ items: [], total: 0, count: 0 }));
    vi.stubGlobal("fetch", fetch);
    const request = new Request("http://localhost/commerce/postage-policies", {
      headers: { Cookie: "session=fixture" },
    });

    await expect(createPostagePolicyRequestClient(request).listPostagePolicies("limit=25&offset=50")).resolves.toEqual({
      items: [],
      total: 0,
      count: 0,
    });
    expect(fetch).toHaveBeenCalledOnce();
    const [url, init] = fetch.mock.calls[0]!;
    expect(new URL(String(url)).pathname).toBe("/api/marketplace/admin/postage-policies");
    expect(new URL(String(url)).search).toBe("?limit=25&offset=50");
    expect(init?.credentials).toBe("include");
    expect(new Headers(init?.headers).get("Cookie")).toBe("session=fixture");
  });

  it("preserves the composed client's encoded write, headers, credentials and error class", async () => {
    const body = { error: { code: "authorization_forbidden", message: "Forbidden." } };
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json(body, { status: 403 }));
    const headers = vi.fn(() => ({ "X-Fixture-Header": "fixture" }));
    const client = createOrderingApiClient({
      baseUrl: "https://service.test/api",
      fetch,
      headers,
      credentials: "omit",
    });
    const write = client.activatePostagePolicy("policy/1", "Reviewed");

    await expect(write).rejects.toBeInstanceOf(OrderingApiError);
    await expect(write).rejects.toMatchObject({ status: 403, body, message: "Forbidden." });
    expect(headers).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledExactlyOnceWith(
      "https://service.test/api/admin/postage-policies/policy%2F1/activate",
      {
        method: "POST",
        headers: { "X-Fixture-Header": "fixture", "Content-Type": "application/json" },
        body: JSON.stringify({ activationReason: "Reviewed" }),
        credentials: "omit",
      },
    );
  });
});
