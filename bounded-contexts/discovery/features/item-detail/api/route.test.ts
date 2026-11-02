import { describe, expect, it, vi } from "vitest";
import { discoveryItemDetailRoutes } from "./route";
import type { DiscoveryItemDetailRow } from "../read-model/queries";
import type { DiscoveryItemDetailServices } from "./runtime";

function services(
  result: Awaited<ReturnType<DiscoveryItemDetailServices["findSimilarItems"]>>,
  item: DiscoveryItemDetailRow | null = null,
) {
  return {
    getItemDetail: vi.fn(async () => item),
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

  it("returns the same item-detail body for guest and authenticated requests", async () => {
    const item = {
      catalog_item_id: "cat_one",
      slug: "charizard",
      language_code: "en",
      title_i18n: {},
      title: "Charizard",
      subtitle_i18n: {},
      subtitle: null,
      display_badges: [],
      description_i18n: {},
      description: "",
      blueprint_id: null,
      blueprint: null,
      status: "published",
      field_values: [],
      categories: [],
      tags: [],
      image_urls: [],
      product_asset_sets: [],
      image_fallback: null,
      product_schema: null,
      market_summary: null,
      market_listings: [],
      offer_demand_matches: [],
      market_products: [],
      market_product_listings: [],
      contents: [],
      included_in: [],
      updated_at: "2026-01-01T00:00:00.000Z",
    } satisfies DiscoveryItemDetailRow;
    const runtime = services({ items: [], count: 0, mode: "none" }, item);
    const routes = discoveryItemDetailRoutes(runtime);

    const guest = await routes.request("/charizard");
    const authenticated = await routes.request("/charizard", {
      headers: { authorization: "Bearer test-token" },
    });

    expect(guest.status).toBe(200);
    expect(authenticated.status).toBe(200);
    expect(await authenticated.json()).toEqual(await guest.json());
  });
});
