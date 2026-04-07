import { describe, expect, it } from "vitest";
import { buildOpenGraphMeta } from "./web";

describe("buildOpenGraphMeta", () => {
  it("builds the default metadata shape", () => {
    expect(
      buildOpenGraphMeta({
        title: "Marketplace Search",
      }),
    ).toEqual([
      { title: "Marketplace Search" },
      { name: "description", content: "Marketplace Search" },
      { property: "og:site_name", content: "Chase Sets" },
      { property: "og:title", content: "Marketplace Search" },
      { property: "og:description", content: "Marketplace Search" },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ]);
  });

  it("includes product image metadata when provided", () => {
    expect(
      buildOpenGraphMeta({
        title: "Charizard",
        description: "Shadowless holo",
        imageUrl: "https://example.test/charizard.png",
        type: "product",
      }),
    ).toEqual([
      { title: "Charizard" },
      { name: "description", content: "Shadowless holo" },
      { property: "og:site_name", content: "Chase Sets" },
      { property: "og:title", content: "Charizard" },
      { property: "og:description", content: "Shadowless holo" },
      { property: "og:type", content: "product" },
      { name: "twitter:card", content: "summary_large_image" },
      { property: "og:image", content: "https://example.test/charizard.png" },
    ]);
  });
});
