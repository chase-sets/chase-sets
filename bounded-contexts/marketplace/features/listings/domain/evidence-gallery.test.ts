import { describe, expect, it } from "vitest";
import type { MarketplaceListingPhoto, MarketplaceListingPhotoAssetRole } from "./domain";
import { copyPublicListingGallery, toPublicListingGallery } from "./evidence-gallery";

function photo(overrides: Partial<MarketplaceListingPhoto> & { photoId: string }): MarketplaceListingPhoto {
  const sourceHash = `hash_${overrides.photoId}`;
  const asset = (role: MarketplaceListingPhotoAssetRole) => ({
    role,
    width: 480,
    height: 640,
    density: 1 as 1 | 2 | null,
    mediaType: "image/webp" as const,
    storageKey: `private/key/${overrides.photoId}/${role}`,
    publicUrl: `https://assets.test/${overrides.photoId}/${role}.webp`,
    byteSize: 1234,
    generatedAt: "2026-07-10T00:00:00.000Z",
  });
  return {
    photoId: overrides.photoId,
    originalFilename: "secret-filename.png",
    altText: "Charizard front",
    slotId: overrides.slotId ?? "front",
    viewKind: overrides.viewKind ?? "front",
    status: overrides.status ?? "active",
    sortOrder: overrides.sortOrder ?? 0,
    capturedAt: "2026-07-01T00:00:00.000Z",
    uploadedAt: "2026-07-10T00:00:00.000Z",
    assetRevision: `rev-${sourceHash}`,
    replacesPhotoId: null,
    assetSet: {
      kind: "listing-photo",
      sourceHash,
      source: asset("source"),
      variants: [asset("catalog-detail"), asset("thumbnail")],
    },
  };
}

describe("toPublicListingGallery", () => {
  it("exposes only buyer-safe metadata", () => {
    const [image] = toPublicListingGallery([photo({ photoId: "a" })]);
    const serialized = JSON.stringify(image);
    expect(serialized).not.toContain("private/key");
    expect(serialized).not.toContain("hash_a");
    expect(serialized).not.toContain("secret-filename");
    expect(serialized).not.toContain("byteSize");
    expect(image?.altText).toBe("Charizard front");
    expect(image?.viewKind).toBe("front");
    expect(image?.assets.every((asset) => asset.publicUrl.startsWith("https://assets.test/"))).toBe(true);
  });

  it("excludes the full-resolution source variant", () => {
    const [image] = toPublicListingGallery([photo({ photoId: "a" })]);
    expect(image?.assets.some((asset) => asset.role === "source")).toBe(false);
  });

  it("omits non-active evidence", () => {
    const gallery = toPublicListingGallery([
      photo({ photoId: "a" }),
      photo({ photoId: "b", status: "removed" }),
      photo({ photoId: "c", status: "replaced" }),
    ]);
    expect(gallery.map((image) => image.photoId)).toEqual(["a"]);
  });

  it("orders by sort order", () => {
    const gallery = toPublicListingGallery([
      photo({ photoId: "b", sortOrder: 1 }),
      photo({ photoId: "a", sortOrder: 0 }),
    ]);
    expect(gallery.map((image) => image.photoId)).toEqual(["a", "b"]);
  });
});

describe("copyPublicListingGallery", () => {
  it("drops an image or asset whose required value has the wrong type and nulls a mistyped optional value", () => {
    const asset = { role: "catalog-detail", publicUrl: "https://assets.test/a.webp", width: 480, height: 640 };
    const gallery = copyPublicListingGallery([
      null,
      { photoId: { storageKey: "private/key" }, sortOrder: 0, assets: [asset] },
      {
        photoId: "a",
        sortOrder: 1,
        altText: { originalFilename: "secret-filename.png" },
        slotId: "front",
        viewKind: "front",
        assets: [{ ...asset, publicUrl: { storageKey: "private/key" } }, { ...asset, density: 3 }, "not an asset"],
      },
    ]);

    expect(gallery).toEqual([
      {
        photoId: "a",
        slotId: "front",
        viewKind: "front",
        altText: null,
        sortOrder: 1,
        assets: [{ ...asset, density: null }],
      },
    ]);
    expect(JSON.stringify(gallery)).not.toMatch(/private\/key|secret-filename/);
  });
});
