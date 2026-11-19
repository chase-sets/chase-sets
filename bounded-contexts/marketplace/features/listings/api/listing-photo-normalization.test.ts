import { describe, expect, it } from "vitest";
import { listingErrorResponse } from "./listing-errors";
import { normalizeListingPhoto, type ListingPhotoImageProcessor } from "./listing-photo-normalization";

function normalize(sourceBody: Uint8Array, imageProcessor?: ListingPhotoImageProcessor) {
  const stored: string[] = [];
  const photo = normalizeListingPhoto({
    sourceBody,
    storageBaseKey: "marketplace/listings/acc_1/lst_1/lpho_1",
    photoId: "lpho_1",
    originalFilename: "broken.jpg",
    altText: null,
    sortOrder: 0,
    generatedAt: "2026-05-21T00:00:00.000Z",
    photoStorage: {
      async putObject(input) {
        stored.push(input.key);
        return { key: input.key, publicUrl: `https://assets.test/${input.key}` };
      },
    },
    ...(imageProcessor ? { imageProcessor } : {}),
  });
  return { photo, stored };
}

// A 1x1 PNG: it decodes, but trimming leaves no pixels.
const onePixelPng = Uint8Array.from(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
  ),
);

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

  it.each([
    ["bytes that are not a picture", new TextEncoder().encode("this is not a picture")],
    ["a picture that trims to nothing", onePixelPng],
  ])("refuses %s as invalid evidence and stores nothing", async (_, body) => {
    const { photo, stored } = normalize(body);

    const error = await photo.then(
      () => null,
      (rejection: unknown) => rejection,
    );
    expect(error).toMatchObject({ name: "MarketplaceEvidenceGovernanceError", code: "unreadable-image" });
    const answer = listingErrorResponse(error, ["evidence-invalid"]);
    expect(answer.status).toBe(400);
    expect(await answer.json()).toMatchObject({ error: { code: "listing_evidence_invalid" } });
    expect(stored).toEqual([]);
  });

  it("keeps an oversized picture's own refusal", async () => {
    const { photo } = normalize(new Uint8Array([1]), {
      async metadata() {
        return { width: 100_000, height: 100_000 };
      },
      async normalizeDisplaySource() {
        throw new Error("not reached");
      },
      async resizeToWebp() {
        throw new Error("not reached");
      },
    });

    await expect(photo).rejects.toMatchObject({ code: "pixel-budget-exceeded" });
  });
});
