import sharp from "sharp";
import { describe, expect, it } from "vitest";
import type { CatalogAssetStoragePutInput } from "./asset-storage";
import {
  extractApprovedLorcanaImageEvidence,
  extractApprovedOnePieceImageEvidence,
  normalizeLorcanaImageAsset,
  normalizeProductAssetSet,
  selectApprovedLorcanaImageEvidence,
} from "./product-asset-normalization";

describe("product asset normalization", () => {
  it("preserves the source asset and trims transparent display padding before generating variants", async () => {
    const sourceBody = await transparentPaddedCardImage();
    const storedAssets: CatalogAssetStoragePutInput[] = [];

    const assetSet = await normalizeProductAssetSet({
      sourceBody,
      sourceContentType: "image/webp",
      sourceProviderKey: "tcgdex",
      sourceUrl: "https://assets.tcgdex.net/en/base/base1/004/high.webp",
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
    expect(assetSet.sourcePolicy).toEqual({
      sourceProviderKey: "tcgdex",
      sourceUrlHost: "assets.tcgdex.net",
      sourceUrlHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      sourceContentType: "image/webp",
      approval: "catalog-owned-rehost-approved",
      rehostingBehavior: "store-source-and-webp-display-variants",
      retention: {
        policyKey: "catalog-product-image-retention-v1",
        retentionKind: "retain-while-referenced",
        previewRetentionDays: 90,
        takedownPath: "catalog-asset-takedown",
        removalSlaDays: 30,
      },
    });
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
    expect(searchCard?.width).not.toBe(224);
    expect(searchCard?.height).not.toBe(314);
    const storedSearchCard = storedAssets.find((asset) => asset.key.includes("search-card-224w-1x"));
    const searchCardMetadata = await sharp(storedSearchCard?.body).metadata();
    expect(searchCardMetadata.width).toBe(searchCard?.width);
    expect(searchCardMetadata.height).toBe(searchCard?.height);
    expect(searchCardMetadata.hasAlpha).toBe(true);
    expect(assetSet.variants.map((variant) => variant.storageKey)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/thumbnail-96w-1x-[a-f0-9]{12}-trim-alpha-v1-[a-f0-9]{12}\.webp$/),
        expect.stringMatching(/search-card-224w-1x-[a-f0-9]{12}-trim-alpha-v1-[a-f0-9]{12}\.webp$/),
        expect.stringMatching(/catalog-detail-480w-1x-[a-f0-9]{12}-trim-alpha-v1-[a-f0-9]{12}\.webp$/),
      ]),
    );
  });

  it("extracts approved current One Piece image URLs without duplicates", () => {
    const result = extractApprovedOnePieceImageEvidence({
      providerKey: "tcgplayer",
      imageUrls: [
        "https://tcgplayer-cdn.tcgplayer.com/product/987650_200w.jpg",
        "https://tcgplayer-cdn.tcgplayer.com/product/987650_200w.jpg",
        "http://tcgplayer-cdn.tcgplayer.com/product/987650_insecure.jpg",
      ],
      sourceUpdatedAt: "2026-06-01T00:00:00.000Z",
      observedAt: "2026-06-23T00:00:00.000Z",
    });

    expect(result).toEqual({
      status: "current",
      imageUrls: ["https://tcgplayer-cdn.tcgplayer.com/product/987650_200w.jpg"],
      diagnostics: [],
      retentionPolicy: expect.objectContaining({
        policyKey: "catalog-product-image-retention-v1",
        retentionKind: "retain-while-referenced",
      }),
    });
  });

  it("records missing One Piece images as review diagnostics instead of retained payloads", () => {
    const result = extractApprovedOnePieceImageEvidence({
      providerKey: "scrydex",
      imageUrls: [],
      observedAt: "2026-06-23T00:00:00.000Z",
    });

    expect(result.status).toBe("missing");
    expect(result.imageUrls).toEqual([]);
    expect(result.diagnostics).toEqual(["scrydex did not provide approved One Piece image URI evidence."]);
  });

  it("marks stale One Piece image evidence for review before rehosting", () => {
    const result = extractApprovedOnePieceImageEvidence({
      providerKey: "tcgplayer",
      imageUrls: ["https://tcgplayer-cdn.tcgplayer.com/product/987650_200w.jpg"],
      sourceUpdatedAt: "2024-01-01T00:00:00.000Z",
      observedAt: "2026-06-23T00:00:00.000Z",
    });

    expect(result.status).toBe("stale");
    expect(result.imageUrls).toEqual(["https://tcgplayer-cdn.tcgplayer.com/product/987650_200w.jpg"]);
    expect(result.diagnostics[0]).toContain("must be reviewed before rehosting");
  });

  it("excludes unapproved One Piece comparison image sources", () => {
    const result = extractApprovedOnePieceImageEvidence({
      providerKey: "bandai-official",
      imageUrls: ["https://www.bandai.example/one-piece/card-image.jpg"],
      observedAt: "2026-06-23T00:00:00.000Z",
    });

    expect(result.status).toBe("unapproved");
    expect(result.imageUrls).toEqual([]);
    expect(result.diagnostics).toEqual([
      "Provider 'bandai-official' is not approved for retained One Piece image evidence.",
    ]);
  });

  it("selects Lorcana image evidence by approved provider precedence", () => {
    const result = selectApprovedLorcanaImageEvidence([
      {
        providerKey: "tcgplayer",
        imageUrls: ["https://tcgplayer-cdn.tcgplayer.com/product/1005010_200w.jpg"],
        observedAt: "2026-06-23T00:00:00.000Z",
      },
      {
        providerKey: "scrydex",
        imageUrls: ["https://images.scrydex.example/lorcana/tfc-041.png"],
        observedAt: "2026-06-23T00:00:00.000Z",
      },
      {
        providerKey: "lorcanajson",
        imageUrls: ["https://images.lorcanajson.org/cards/en/1/041.webp"],
        observedAt: "2026-06-23T00:00:00.000Z",
      },
    ]);

    expect(result).toMatchObject({
      status: "current",
      providerKey: "lorcanajson",
      imageUrls: ["https://images.lorcanajson.org/cards/en/1/041.webp"],
    });
  });

  it("records missing Lorcana images as review diagnostics instead of retained payloads", () => {
    const result = extractApprovedLorcanaImageEvidence({
      providerKey: "lorcast",
      imageUrls: [],
      observedAt: "2026-06-23T00:00:00.000Z",
    });

    expect(result.status).toBe("missing");
    expect(result.imageUrls).toEqual([]);
    expect(result.diagnostics).toEqual(["lorcast did not provide approved Lorcana image URI evidence."]);
  });

  it("marks stale Lorcana image evidence for review before rehosting", () => {
    const result = extractApprovedLorcanaImageEvidence({
      providerKey: "scrydex",
      imageUrls: ["https://images.scrydex.example/lorcana/tfc-041.png"],
      sourceUpdatedAt: "2024-01-01T00:00:00.000Z",
      observedAt: "2026-06-23T00:00:00.000Z",
    });

    expect(result.status).toBe("stale");
    expect(result.imageUrls).toEqual(["https://images.scrydex.example/lorcana/tfc-041.png"]);
    expect(result.diagnostics[0]).toContain("must be reviewed before rehosting");
  });

  it("excludes official Lorcana validation images from retained image evidence", () => {
    const result = extractApprovedLorcanaImageEvidence({
      providerKey: "ravensburger-lorcana-official",
      imageUrls: ["https://www.ravensburger.example/lorcana/card-image.jpg"],
      observedAt: "2026-06-23T00:00:00.000Z",
    });

    expect(result.status).toBe("unapproved");
    expect(result.imageUrls).toEqual([]);
    expect(result.diagnostics).toEqual([
      "Provider 'ravensburger-lorcana-official' is not approved for retained Lorcana image evidence.",
    ]);
  });

  it("mirrors approved Lorcana provider images into Catalog-owned Product Asset Sets", async () => {
    const sourceBody = await transparentPaddedCardImage();
    const storedAssets: CatalogAssetStoragePutInput[] = [];

    const assetSet = await normalizeLorcanaImageAsset({
      providerKey: "lorcanajson",
      imageUrls: ["https://images.lorcanajson.org/cards/en/1/041.webp"],
      observedAt: "2026-06-23T00:00:00.000Z",
      storageBaseKey: "catalog/items/cat_lorcana/product-image",
      fetcher: async (input) =>
        new Response(copyToArrayBuffer(sourceBody), {
          status: 200,
          headers: { "content-type": "image/webp" },
        }),
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

    expect(assetSet?.sourcePolicy).toEqual(
      expect.objectContaining({
        sourceProviderKey: "lorcanajson",
        sourceUrlHost: "images.lorcanajson.org",
        sourceUrlHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        sourceContentType: "image/webp",
      }),
    );
    expect(assetSet?.variants.map((variant) => variant.publicUrl)).toEqual(
      expect.arrayContaining([
        expect.stringContaining("https://assets.chasesets.test/catalog/items/cat_lorcana/product-image/thumbnail"),
        expect.stringContaining("https://assets.chasesets.test/catalog/items/cat_lorcana/product-image/catalog-detail"),
      ]),
    );
    expect(storedAssets).toHaveLength(7);
    expect(JSON.stringify(assetSet)).not.toContain("https://images.lorcanajson.org/cards/en/1/041.webp");
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

function copyToArrayBuffer(source: Uint8Array): ArrayBuffer {
  const body = new ArrayBuffer(source.byteLength);
  new Uint8Array(body).set(source);
  return body;
}
