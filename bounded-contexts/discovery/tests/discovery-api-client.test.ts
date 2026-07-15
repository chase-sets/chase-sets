import { describe, expect, it } from "vitest";

import { createDiscoveryApiClient, DiscoveryApiError } from "../client";

describe("DiscoveryApiError", () => {
  it("uses structured API error messages", () => {
    const error = new DiscoveryApiError(503, {
      error: {
        code: "projection_freshness_timeout",
        message: "Projection read model did not catch up before the freshness timeout.",
      },
    });

    expect(error.message).toBe("Projection read model did not catch up before the freshness timeout.");
  });
});

describe("Discovery API client", () => {
  it("requests marketplace item suggestions with an encoded query", async () => {
    const fetch = async (input: RequestInfo | URL) => {
      expect(String(input)).toBe("/api/marketplace/items/suggest?q=charizard+ex");
      return Response.json({ items: [], count: 0 });
    };
    const client = createDiscoveryApiClient({ fetch });

    await expect(client.suggestItems("charizard ex")).resolves.toEqual({ items: [], count: 0 });
  });
});
