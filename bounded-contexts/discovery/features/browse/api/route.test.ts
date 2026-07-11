import { describe, expect, it, vi } from "vitest";
import { discoveryBrowseRoutes } from "./route";
import type { DiscoveryBrowseServices } from "./runtime";
import type { DiscoveryBrowseSetPageRow } from "../read-model/queries";

function services(result: DiscoveryBrowseSetPageRow | null) {
  return {
    getSetBySlug: vi.fn(async () => result),
  } satisfies DiscoveryBrowseServices;
}

const SET_PAGE: DiscoveryBrowseSetPageRow = {
  reference_record_id: "ref_1",
  type_key: "expansion",
  key: "surging-sparks",
  slug: "surging-sparks",
  name: "Surging Sparks",
  code: "sv08",
  game: "Pokémon TCG",
  release_date: "2024-11-08",
  status: "active",
  item_count: 1,
  items: [],
  updated_at: "2026-07-01T00:00:00.000Z",
};

describe("discovery browse set route", () => {
  it("returns the set page for a known slug", async () => {
    const runtime = services(SET_PAGE);
    const response = await discoveryBrowseRoutes(runtime).request("/surging-sparks");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(SET_PAGE);
    expect(runtime.getSetBySlug).toHaveBeenCalledWith("surging-sparks");
  });

  it("returns not found for an unresolved slug", async () => {
    const response = await discoveryBrowseRoutes(services(null)).request("/missing-set");

    expect(response.status).toBe(404);
  });
});
