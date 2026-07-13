import { describe, expect, it } from "vitest";
import type { MarketplaceListingPhoto, MarketplaceListingPhotoAssetRole } from "./domain";
import { buildListingEvidenceSnapshot } from "./evidence-snapshot";

function photo(overrides: Partial<MarketplaceListingPhoto> & { photoId: string }): MarketplaceListingPhoto {
  const sourceHash = overrides.assetSet?.sourceHash ?? `hash_${overrides.photoId}`;
  const asset = (role: MarketplaceListingPhotoAssetRole) => ({
    role,
    width: 1200,
    height: 1600,
    density: null as 1 | 2 | null,
    mediaType: "image/webp" as const,
    storageKey: `key/${overrides.photoId}/${role}`,
    publicUrl: `https://assets.test/${overrides.photoId}/${role}.webp`,
    byteSize: 1000,
    generatedAt: "2026-07-10T00:00:00.000Z",
  });
  return {
    photoId: overrides.photoId,
    originalFilename: "front.png",
    altText: "alt",
    slotId: overrides.slotId ?? null,
    viewKind: overrides.viewKind ?? null,
    status: overrides.status ?? "active",
    sortOrder: overrides.sortOrder ?? 0,
    capturedAt: overrides.capturedAt ?? null,
    uploadedAt: "2026-07-10T00:00:00.000Z",
    assetRevision: `rev-${sourceHash}`,
    replacesPhotoId: null,
    assetSet: {
      kind: "listing-photo",
      sourceHash,
      source: asset("source"),
      variants: [asset("catalog-detail")],
    },
  };
}

describe("buildListingEvidenceSnapshot", () => {
  it("includes only active evidence, ordered by sort order", () => {
    const snapshot = buildListingEvidenceSnapshot({
      createdAt: "2026-07-11T00:00:00.000Z",
      policyHash: "sha256:policy",
      evidence: [
        photo({ photoId: "b", sortOrder: 1, slotId: "back", viewKind: "back" }),
        photo({ photoId: "removed", status: "removed" }),
        photo({ photoId: "a", sortOrder: 0, slotId: "front", viewKind: "front" }),
      ],
    });
    expect(snapshot.evidence.map((entry) => entry.photoId)).toEqual(["a", "b"]);
    expect(snapshot.policyHash).toBe("sha256:policy");
    expect(snapshot.schemaVersion).toBe(1);
  });

  it("references retained asset revisions by key and url, no image bytes", () => {
    const snapshot = buildListingEvidenceSnapshot({
      createdAt: "2026-07-11T00:00:00.000Z",
      evidence: [photo({ photoId: "a" })],
    });
    const asset = snapshot.evidence[0]!.assets[0]!;
    expect(asset.storageKey).toContain("key/a");
    expect(asset.publicUrl).toContain("https://assets.test/a");
    expect(snapshot.evidence[0]!.sourceHash).toBe("hash_a");
    expect(snapshot.evidence[0]!.assetRevision).toBe("rev-hash_a");
  });

  it("produces a stable snapshot hash independent of createdAt", () => {
    const first = buildListingEvidenceSnapshot({
      createdAt: "2026-07-11T00:00:00.000Z",
      policyHash: "sha256:policy",
      evidence: [photo({ photoId: "a" })],
    });
    const second = buildListingEvidenceSnapshot({
      createdAt: "2026-07-12T09:09:09.000Z",
      policyHash: "sha256:policy",
      evidence: [photo({ photoId: "a" })],
    });
    expect(first.snapshotHash).toBe(second.snapshotHash);
  });

  it("changes the snapshot hash when the evidence set changes", () => {
    const base = buildListingEvidenceSnapshot({
      createdAt: "2026-07-11T00:00:00.000Z",
      evidence: [photo({ photoId: "a" })],
    });
    const changed = buildListingEvidenceSnapshot({
      createdAt: "2026-07-11T00:00:00.000Z",
      evidence: [photo({ photoId: "a" }), photo({ photoId: "b" })],
    });
    expect(base.snapshotHash).not.toBe(changed.snapshotHash);
  });
});
