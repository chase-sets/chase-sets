import { afterEach, describe, expect, it, vi } from "vitest";
import { ucpSchemaValidator } from "@chase-sets/platform-runtime/ucp-schema-test-support";
import type { DiscoveryItemDetailRow } from "../../features/item-detail/read-model/queries";
import { catalogUcpProduct, selectPresentment } from "./catalog";

const productSchema = "https://ucp.dev/2026-08-25/schemas/shopping/types/product.json";

afterEach(() => vi.unstubAllEnvs());

describe("catalog public url policy", () => {
  it.each(["search", "lookup", "get_product"] as const)("filters %s Product media and URLs", (mode) => {
    vi.stubEnv("CHASE_SETS_TRUST_FORWARDED_HEADERS", "true");
    vi.stubEnv("CATALOG_ASSET_PUBLIC_BASE_URL", "https://assets.example/catalog");
    vi.stubEnv("MARKETPLACE_LISTING_PHOTO_PUBLIC_BASE_URL", "https://photos.example/listings");
    const source = {
      catalog_item_id: "cat_1",
      slug: "charizard",
      title: "Charizard",
      description: "A card.",
      image_urls: [
        "/seed/charizard.webp",
        "https://assets.example/charizard.webp",
        "javascript:void(0)",
        "data:image/png;base64,AA",
        "http://assets.example/unsafe.png",
        "//foreign.example/image.png",
        "https://foreign.example/image.png",
      ],
      image_fallback: { url: "https://photos.example/fallback.webp" },
      market_listings: [
        { listing_id: "lst_1", listing_slug: "charizard-1", price_amount: "20.00", price_currency_code: "USD" },
      ],
    } as unknown as DiscoveryItemDetailRow;
    const presentment = selectPresentment(source.market_listings, "USD")!;
    const inputs = mode === "lookup" ? [{ id: "cat_1", match: "featured" as const }] : undefined;
    const product = catalogUcpProduct({
      source,
      presentment,
      mode,
      inputs,
      request: new Request("http://localhost:3100/ucp/mcp", {
        headers: { "X-Forwarded-Proto": "https", "X-Forwarded-Host": "marketplace.example" },
      }),
    });
    expect(ucpSchemaValidator(productSchema)(product)).toBe(true);
    expect(product).toMatchObject({
      url: "https://marketplace.example/items/charizard",
      variants: [{ url: "https://marketplace.example/listings/charizard-1" }],
      media: [
        { type: "image", url: "https://marketplace.example/seed/charizard.webp" },
        { type: "image", url: "https://assets.example/charizard.webp" },
        { type: "image", url: "https://photos.example/fallback.webp" },
      ],
    });

    vi.stubEnv("CHASE_SETS_TRUST_FORWARDED_HEADERS", "false");
    const withoutPublicOrigin = catalogUcpProduct({
      source: {
        ...source,
        image_urls: ["/seed/charizard.webp", "https://foreign.example/image.png"],
        image_fallback: null,
      },
      presentment,
      mode,
      inputs,
      request: new Request("http://localhost:3100/ucp/mcp", {
        headers: { "X-Forwarded-Proto": "https", "X-Forwarded-Host": "foreign.example" },
      }),
    });
    expect(ucpSchemaValidator(productSchema)(withoutPublicOrigin)).toBe(true);
    expect(withoutPublicOrigin).not.toHaveProperty("url");
    expect(withoutPublicOrigin).not.toHaveProperty("media");
    expect(withoutPublicOrigin.variants[0]).not.toHaveProperty("url");
  });
});
