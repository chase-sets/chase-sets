import { describe, expect, it } from "vitest";
import type { ResolvedListingEvidenceRequirements } from "../../listing-evidence-policy/domain/policy";
import type {
  MarketplaceListingPhoto,
  MarketplaceListingPhotoAssetRole,
  MarketplaceListingPhotoStatus,
} from "./domain";
import { evaluateEvidenceCoverage } from "./evidence-coverage";

function photo(
  overrides: Partial<MarketplaceListingPhoto> & { photoId: string } & {
    sourceHash?: string;
    width?: number;
    height?: number;
  },
): MarketplaceListingPhoto {
  const sourceHash = overrides.sourceHash ?? `hash_${overrides.photoId}`;
  const width = overrides.width ?? 1200;
  const height = overrides.height ?? 1600;
  const asset = (role: MarketplaceListingPhotoAssetRole) => ({
    role,
    width,
    height,
    density: null as 1 | 2 | null,
    mediaType: "image/webp" as const,
    storageKey: `key/${overrides.photoId}/${role}`,
    publicUrl: `https://assets.test/${overrides.photoId}/${role}.webp`,
    byteSize: 1000,
    generatedAt: "2026-07-10T00:00:00.000Z",
  });
  return {
    photoId: overrides.photoId,
    originalFilename: null,
    altText: null,
    slotId: overrides.slotId ?? null,
    viewKind: overrides.viewKind ?? null,
    status: (overrides.status ?? "active") as MarketplaceListingPhotoStatus,
    sortOrder: overrides.sortOrder ?? 0,
    capturedAt: overrides.capturedAt ?? null,
    uploadedAt: overrides.uploadedAt ?? "2026-07-10T00:00:00.000Z",
    assetRevision: overrides.assetRevision ?? `rev-${sourceHash}`,
    replacesPhotoId: overrides.replacesPhotoId ?? null,
    assetSet: {
      kind: "listing-photo",
      sourceHash,
      source: asset("source"),
      variants: [asset("catalog-detail")],
    },
  };
}

function requirements(
  overrides: Partial<ResolvedListingEvidenceRequirements> = {},
): ResolvedListingEvidenceRequirements {
  return {
    minimumPhotoCount: 0,
    requiredSlots: [],
    sellerTrustRequirements: [],
    buyerAcknowledgment: "none",
    ...overrides,
  };
}

function slot(
  overrides: Partial<ResolvedListingEvidenceRequirements["requiredSlots"][number]> & {
    slotId: string;
    viewKind: string;
  },
) {
  return {
    minimumWidthPixels: null,
    minimumHeightPixels: null,
    maximumAgeHours: null,
    ...overrides,
  };
}

describe("evaluateEvidenceCoverage", () => {
  it("passes when no requirements are configured", () => {
    const result = evaluateEvidenceCoverage(requirements(), []);
    expect(result.complete).toBe(true);
    expect(result.unmetCodes).toEqual([]);
  });

  it("front+back cannot be satisfied by two front photos", () => {
    const result = evaluateEvidenceCoverage(
      requirements({
        requiredSlots: [slot({ slotId: "front", viewKind: "front" }), slot({ slotId: "back", viewKind: "back" })],
      }),
      [
        photo({ photoId: "a", slotId: "front", viewKind: "front" }),
        photo({ photoId: "b", slotId: "front", viewKind: "front" }),
      ],
    );
    expect(result.complete).toBe(false);
    expect(result.unmetCodes).toContain("slot-missing");
    expect(result.slots.find((entry) => entry.slotId === "back")?.satisfied).toBe(false);
    expect(result.slots.find((entry) => entry.slotId === "front")?.satisfied).toBe(true);
  });

  it("front+back is satisfied by one distinct photo per slot", () => {
    const result = evaluateEvidenceCoverage(
      requirements({
        requiredSlots: [slot({ slotId: "front", viewKind: "front" }), slot({ slotId: "back", viewKind: "back" })],
      }),
      [
        photo({ photoId: "a", slotId: "front", viewKind: "front" }),
        photo({ photoId: "b", slotId: "back", viewKind: "back" }),
      ],
    );
    expect(result.complete).toBe(true);
    expect(result.unmetCodes).toEqual([]);
  });

  it("enforces a configured slab slot generically", () => {
    const result = evaluateEvidenceCoverage(
      requirements({ requiredSlots: [slot({ slotId: "slab", viewKind: "slab" })] }),
      [photo({ photoId: "a", slotId: "front", viewKind: "front" })],
    );
    expect(result.complete).toBe(false);
    expect(result.slots[0]?.unmetCode).toBe("slot-missing");
  });

  it("flags an unmet minimum photo count", () => {
    const result = evaluateEvidenceCoverage(requirements({ minimumPhotoCount: 2 }), [photo({ photoId: "a" })]);
    expect(result.unmetCodes).toContain("min-photo-count-unmet");
    expect(result.activePhotoCount).toBe(1);
  });

  it("ignores replaced and removed evidence when counting", () => {
    const result = evaluateEvidenceCoverage(requirements({ minimumPhotoCount: 1 }), [
      photo({ photoId: "a", status: "removed" }),
      photo({ photoId: "b", status: "replaced" }),
    ]);
    expect(result.complete).toBe(false);
    expect(result.activePhotoCount).toBe(0);
  });

  it("flags a view-kind mismatch", () => {
    const result = evaluateEvidenceCoverage(
      requirements({ requiredSlots: [slot({ slotId: "front", viewKind: "front" })] }),
      [photo({ photoId: "a", slotId: "front", viewKind: "back" })],
    );
    expect(result.unmetCodes).toContain("slot-view-mismatch");
  });

  it("flags dimensions below the configured minimum", () => {
    const result = evaluateEvidenceCoverage(
      requirements({
        requiredSlots: [slot({ slotId: "front", viewKind: "front", minimumWidthPixels: 2000 })],
      }),
      [photo({ photoId: "a", slotId: "front", viewKind: "front", width: 1200 })],
    );
    expect(result.unmetCodes).toContain("slot-dimensions-too-small");
  });

  it("flags evidence older than the configured maximum age", () => {
    const result = evaluateEvidenceCoverage(
      requirements({
        requiredSlots: [slot({ slotId: "front", viewKind: "front", maximumAgeHours: 24 })],
      }),
      [photo({ photoId: "a", slotId: "front", viewKind: "front", capturedAt: "2026-07-01T00:00:00.000Z" })],
      { now: "2026-07-10T00:00:00.000Z" },
    );
    expect(result.unmetCodes).toContain("slot-expired");
  });

  it("accepts evidence within the configured maximum age", () => {
    const result = evaluateEvidenceCoverage(
      requirements({
        requiredSlots: [slot({ slotId: "front", viewKind: "front", maximumAgeHours: 72 })],
      }),
      [photo({ photoId: "a", slotId: "front", viewKind: "front", capturedAt: "2026-07-09T00:00:00.000Z" })],
      { now: "2026-07-10T00:00:00.000Z" },
    );
    expect(result.complete).toBe(true);
  });

  it("rejects the same source image proving two distinct slots (duplicate-source)", () => {
    const result = evaluateEvidenceCoverage(
      requirements({
        requiredSlots: [slot({ slotId: "front", viewKind: "front" }), slot({ slotId: "back", viewKind: "back" })],
      }),
      [
        photo({ photoId: "a", slotId: "front", viewKind: "front", sourceHash: "same" }),
        photo({ photoId: "b", slotId: "back", viewKind: "back", sourceHash: "same" }),
      ],
    );
    expect(result.complete).toBe(false);
    expect(result.unmetCodes).toContain("duplicate-source");
  });
});
