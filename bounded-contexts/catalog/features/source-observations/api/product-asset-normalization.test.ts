import sharp from "sharp";
import { describe, expect, it } from "vitest";
import type { CatalogAssetStoragePutInput } from "./asset-storage";
import { normalizeProductAssetSet } from "./product-asset-normalization";

describe("product asset normalization", () => {
  it("preserves the source asset and trims transparent display padding before generating variants", async () => {
    const sourceBody = await transparentPaddedCardImage();
    const storedAssets: CatalogAssetStoragePutInput[] = [];

    const assetSet = await normalizeProductAssetSet({
      sourceBody,
      sourceContentType: "image/webp",
      storageBaseKey: "catalog/items/cat_test/product-image",
      generatedAt: "2026-05-20T00:00:00.000Z",
      assetStorage: {
        async putObject(input) {
          storedAssets.push(input);
          return {
            key: input.key,
            publicUrl: `https://assets.chasesets.test/${input.key}`,
          };
        },
      },
    });

    expect(assetSet.source.width).toBe(120);
    expect(assetSet.source.height).toBe(200);
    expect(storedAssets[0]?.body).toEqual(sourceBody);

    const thumbnail = assetSet.variants.find((variant) => variant.role === "thumbnail" && variant.density === 1);
    const searchCard = assetSet.variants.find((variant) => variant.role === "search-card" && variant.density === 1);

    expect(thumbnail).toEqual(
      expect.objectContaining({
        width: 96,
        height: 128,
      }),
    );
    expect(searchCard).toEqual(
      expect.objectContaining({
        width: 120,
        height: 160,
      }),
    );
    const storedSearchCard = storedAssets.find((asset) => asset.key.includes("search-card-160w-1x"));
    const searchCardMetadata = await sharp(storedSearchCard?.body).metadata();
    expect(searchCardMetadata.hasAlpha).toBe(true);
    expect(assetSet.variants.map((variant) => variant.storageKey)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/thumbnail-96w-1x-[a-f0-9]{12}-trim-alpha-v1-[a-f0-9]{12}\.webp$/),
        expect.stringMatching(/search-card-160w-1x-[a-f0-9]{12}-trim-alpha-v1-[a-f0-9]{12}\.webp$/),
        expect.stringMatching(/catalog-detail-480w-1x-[a-f0-9]{12}-trim-alpha-v1-[a-f0-9]{12}\.webp$/),
      ]),
    );
  });
});

async function transparentPaddedCardImage(): Promise<Uint8Array> {
  const cardBody = await sharp(
    Buffer.from(`
    <svg width="120" height="160" viewBox="0 0 120 160" xmlns="http://www.w3.org/2000/svg">
      <rect x="0" y="0" width="120" height="160" rx="10" ry="10" fill="rgb(210,40,68)" />
    </svg>
  `),
  )
    .webp()
    .toBuffer();

  const source = await sharp({
    create: {
      width: 120,
      height: 200,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .composite([{ input: cardBody, top: 20, left: 0 }])
    .webp()
    .toBuffer();

  return new Uint8Array(source);
}
