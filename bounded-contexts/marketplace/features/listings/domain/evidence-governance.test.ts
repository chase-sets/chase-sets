import { describe, expect, it } from "vitest";
import type { MarketplaceListingPhoto, MarketplaceListingPhotoAssetRole } from "./domain";
import {
  assertDecodedImageWithinBudget,
  assertEvidenceCountAndBytesWithinBudget,
  listingPhotoStoredBytes,
  MarketplaceEvidenceGovernanceError,
  totalActiveEvidenceStoredBytes,
} from "./evidence-governance";

function photo(
  overrides: Partial<MarketplaceListingPhoto> & { photoId: string; bytes?: number },
): MarketplaceListingPhoto {
  const bytes = overrides.bytes ?? 1000;
  const asset = (role: MarketplaceListingPhotoAssetRole) => ({
    role,
    width: 1200,
    height: 1600,
    density: null as 1 | 2 | null,
    mediaType: "image/webp" as const,
    storageKey: `key/${overrides.photoId}/${role}`,
    publicUrl: `https://assets.test/${overrides.photoId}/${role}.webp`,
    byteSize: bytes,
    generatedAt: "2026-07-10T00:00:00.000Z",
  });
  return {
    photoId: overrides.photoId,
    originalFilename: null,
    altText: null,
    slotId: null,
    viewKind: null,
    status: overrides.status ?? "active",
    sortOrder: 0,
    capturedAt: null,
    uploadedAt: "2026-07-10T00:00:00.000Z",
    assetRevision: `rev-${overrides.photoId}`,
    replacesPhotoId: null,
    assetSet: {
      kind: "listing-photo",
      sourceHash: `hash_${overrides.photoId}`,
      source: asset("source"),
      variants: [asset("catalog-detail")],
    },
  };
}

describe("listingPhotoStoredBytes", () => {
  it("sums the source and all variant bytes", () => {
    expect(listingPhotoStoredBytes(photo({ photoId: "a", bytes: 500 }))).toBe(1000);
  });
  it("counts only active entries in the total", () => {
    expect(
      totalActiveEvidenceStoredBytes([
        photo({ photoId: "a", bytes: 500 }),
        photo({ photoId: "b", bytes: 500, status: "removed" }),
      ]),
    ).toBe(1000);
  });
});

describe("assertEvidenceCountAndBytesWithinBudget", () => {
  it("rejects exceeding the count budget", () => {
    expect(() =>
      assertEvidenceCountAndBytesWithinBudget({
        existingEvidence: [photo({ photoId: "a" }), photo({ photoId: "b" })],
        additions: [photo({ photoId: "c" })],
        maxEvidenceCount: 2,
        maxTotalStoredBytes: 10_000_000,
      }),
    ).toThrowError(MarketplaceEvidenceGovernanceError);
  });

  it("rejects exceeding the total byte budget", () => {
    expect(() =>
      assertEvidenceCountAndBytesWithinBudget({
        existingEvidence: [photo({ photoId: "a", bytes: 5000 })],
        additions: [photo({ photoId: "b", bytes: 5000 })],
        maxEvidenceCount: 10,
        maxTotalStoredBytes: 15_000,
      }),
    ).toThrowError(/total storage budget/);
  });

  it("ignores non-active entries in the projected totals", () => {
    expect(() =>
      assertEvidenceCountAndBytesWithinBudget({
        existingEvidence: [photo({ photoId: "a", status: "replaced" })],
        additions: [photo({ photoId: "b" })],
        maxEvidenceCount: 1,
        maxTotalStoredBytes: 10_000_000,
      }),
    ).not.toThrow();
  });
});

describe("assertDecodedImageWithinBudget", () => {
  it("accepts a normal image", () => {
    expect(() => assertDecodedImageWithinBudget({ width: 1200, height: 1600 })).not.toThrow();
  });

  it("rejects an image exceeding the pixel budget (image bomb)", () => {
    let caught: unknown;
    try {
      assertDecodedImageWithinBudget({ width: 40000, height: 40000 }, { maxSourcePixels: 24_000_000 });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(MarketplaceEvidenceGovernanceError);
    expect((caught as MarketplaceEvidenceGovernanceError).code).toBe("pixel-budget-exceeded");
  });

  it("rejects unreadable dimensions", () => {
    expect(() => assertDecodedImageWithinBudget({ width: 0, height: 100 })).toThrowError(/could not be read/);
  });
});
