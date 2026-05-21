import { describe, expect, it } from "vitest";
import { normalizeListingPhoto } from "./listing-photo-normalization";

describe("normalizeListingPhoto", () => {
  it("stores normalized WebP listing photo variants under the listing photo key", async () => {
    const stored: { key: string; contentType: string; body: Uint8Array }[] = [];
    const photo = await normalizeListingPhoto({
      sourceBody: new Uint8Array([1, 2, 3]),
      storageBaseKey: "marketplace/listings/acc_1/lst_1/lpho_1",
      photoId: "lpho_1",
      originalFilename: "front.png",
      altText: "Front",
      sortOrder: 0,
      generatedAt: "2026-05-21T00:00:00.000Z",
      photoStorage: {
        async putObject(input) {
          stored.push({
            key: input.key,
            contentType: input.contentType,
            body: input.body,
          });

          return {
            key: input.key,
            publicUrl: `https://assets.test/${input.key}`,
          };
        },
      },
      imageProcessor: {
        async metadata() {
          return { width: 600, height: 840 };
        },
        async normalizeDisplaySource() {
          return new Uint8Array([4, 5, 6]);
        },
        async resizeToWebp(input) {
          return {
            body: new Uint8Array([input.width % 255, input.quality]),
            width: input.width,
            height: Math.round(input.width * 1.4),
          };
        },
      },
    });

    expect(photo).toMatchObject({
      photoId: "lpho_1",
      originalFilename: "front.png",
      altText: "Front",
      assetSet: {
        kind: "listing-photo",
        source: {
          mediaType: "image/webp",
          storageKey: expect.stringMatching(/^marketplace\/listings\/acc_1\/lst_1\/lpho_1\/source-/),
        },
      },
    });
    expect(photo.assetSet.variants).toHaveLength(6);
    expect(stored.every((entry) => entry.contentType === "image/webp")).toBe(true);
    expect(stored.map((entry) => entry.key)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/thumbnail-96w-1x-[a-f0-9]{12}-trim-alpha-v1-[a-f0-9]{12}\.webp$/),
        expect.stringMatching(/catalog-detail-960w-2x-[a-f0-9]{12}-trim-alpha-v1-[a-f0-9]{12}\.webp$/),
      ]),
    );
  });
});
