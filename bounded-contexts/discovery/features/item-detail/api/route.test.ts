import { describe, expect, it, vi } from "vitest";
import { discoveryItemDetailRoutes } from "./route";
import type { DiscoveryItemDetailServices } from "./runtime";

function services(result: Awaited<ReturnType<DiscoveryItemDetailServices["findSimilarItems"]>>) {
  return {
    getItemDetail: vi.fn(async () => null),
    getSellerOverlay: vi.fn(),
    findSimilarItems: vi.fn(async () => result),
    projectors: [],
  } satisfies DiscoveryItemDetailServices;
}

describe("discovery item detail similar-items route", () => {
  it("returns a capped, cache-friendly public response", async () => {
    const runtime = services({ items: [], count: 0, mode: "none" });
    const response = await discoveryItemDetailRoutes(runtime).request("/charizard/similar?limit=500");

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("public, max-age=60, stale-while-revalidate=300");
    expect(await response.json()).toEqual({ items: [], count: 0, mode: "none" });
    expect(runtime.findSimilarItems).toHaveBeenCalledWith("charizard", { limit: 500 });
  });

  it("returns not found when the active source item does not exist", async () => {
    const response = await discoveryItemDetailRoutes(services(null)).request("/missing/similar");

    expect(response.status).toBe(404);
  });
});
