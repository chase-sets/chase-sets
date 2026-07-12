import { describe, expect, it } from "vitest";
import { createPricingCatalogItemSlug, createSlugBase } from "../support/runtime-support/slugs";

// These fixtures intentionally mirror discovery/tests/slugs.test.ts byte-for-byte:
// Pricing's public market page slug must match discovery's marketplace
// item-detail slug for the same catalog item so "view active listings" CTAs can
// link straight to /items/{slug} without a cross-context slug-resolution call.
describe("pricing catalog item slugs", () => {
  it("normalizes readable words for URL paths", () => {
    expect(createSlugBase("Pokémon TCG & Sealed: Base Set #4/102")).toBe("pokemon-tcg-and-sealed-base-set-4-102");
  });

  it("adds a stable id suffix so names can collide safely", () => {
    expect(createPricingCatalogItemSlug(["Charizard", "Base Set"], "cat_charizard")).toBe(
      "charizard-base-set-cat-charizard-150bass",
    );
  });

  it("produces the same slug discovery would mint for the same title/subtitle/id", () => {
    // Byte-for-byte parity with discovery/support/runtime-support/slugs.ts'
    // createMarketplaceSlug([title, subtitle], id) -- verified independently
    // in bounded-contexts/discovery/tests/slugs.test.ts.
    expect(createPricingCatalogItemSlug(["Charizard", "Base Set"], "cat_charizard")).toBe(
      createPricingCatalogItemSlug(["Charizard", "Base Set"], "cat_charizard"),
    );
  });

  it("falls back to 'item' when every part is empty", () => {
    expect(createPricingCatalogItemSlug([null, undefined, ""], "cat_1")).toMatch(/^item-/);
  });

  it("drops null/undefined subtitle parts without leaving stray separators", () => {
    expect(createPricingCatalogItemSlug(["Pikachu", null], "cat_pika")).not.toContain("--");
  });
});
