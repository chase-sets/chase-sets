import { createHash } from "node:crypto";
import { activeListingPhotos, type MarketplaceListingPhoto } from "./domain";

/**
 * Immutable, compact Listing Evidence Snapshot (issue #4985).
 *
 * Produced at the moment a Listing becomes a commercial commitment so the
 * exact evidence-bearing state is preserved verbatim. #4987 embeds this in
 * `marketplace.offer.accepted`; Ordering (#4989) projects it into buyer order
 * review. The snapshot references retained asset revisions by storage key and
 * public URL rather than depending on mutable current Listing rows, so later
 * policy or photo edits never mutate a historical commitment.
 *
 * It carries only active evidence, the policy fingerprint that governed the
 * commitment, and a stable `snapshotHash` for tamper-evident comparison. No
 * image bytes are copied — only keys, hashes, dimensions, and timestamps.
 */
export const LISTING_EVIDENCE_SNAPSHOT_SCHEMA_VERSION = 1;

export type ListingEvidenceSnapshotAsset = Readonly<{
  role: string;
  storageKey: string;
  publicUrl: string;
  width: number;
  height: number;
  density: 1 | 2 | null;
  mediaType: "image/webp";
  byteSize: number;
}>;

export type ListingEvidenceSnapshotItem = Readonly<{
  photoId: string;
  slotId: string | null;
  viewKind: string | null;
  sortOrder: number;
  sourceHash: string;
  assetRevision: string;
  capturedAt: string | null;
  uploadedAt: string;
  assets: readonly ListingEvidenceSnapshotAsset[];
}>;

export type ListingEvidenceSnapshot = Readonly<{
  schemaVersion: typeof LISTING_EVIDENCE_SNAPSHOT_SCHEMA_VERSION;
  /** Policy fingerprint that governed the commitment (from the resolved requirement snapshot); null if unknown. */
  policyHash: string | null;
  /** Stable content hash of the snapshot, excluding `createdAt`. */
  snapshotHash: string;
  createdAt: string;
  evidence: readonly ListingEvidenceSnapshotItem[];
}>;

export type BuildListingEvidenceSnapshotInput = Readonly<{
  evidence: readonly MarketplaceListingPhoto[];
  policyHash?: string | null;
  createdAt: string;
}>;

function snapshotAssets(photo: MarketplaceListingPhoto): ListingEvidenceSnapshotAsset[] {
  return [photo.assetSet.source, ...photo.assetSet.variants].map((variant) => ({
    role: variant.role,
    storageKey: variant.storageKey,
    publicUrl: variant.publicUrl,
    width: variant.width,
    height: variant.height,
    density: variant.density,
    mediaType: variant.mediaType,
    byteSize: variant.byteSize,
  }));
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => `${JSON.stringify(key)}:${stableStringify(nested)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function buildListingEvidenceSnapshot(input: BuildListingEvidenceSnapshotInput): ListingEvidenceSnapshot {
  const evidence: ListingEvidenceSnapshotItem[] = activeListingPhotos(input.evidence)
    .slice()
    .sort((left, right) =>
      left.sortOrder === right.sortOrder ? left.photoId.localeCompare(right.photoId) : left.sortOrder - right.sortOrder,
    )
    .map((photo) => ({
      photoId: photo.photoId,
      slotId: photo.slotId,
      viewKind: photo.viewKind,
      sortOrder: photo.sortOrder,
      sourceHash: photo.assetSet.sourceHash,
      assetRevision: photo.assetRevision,
      capturedAt: photo.capturedAt,
      uploadedAt: photo.uploadedAt,
      assets: snapshotAssets(photo),
    }));

  const policyHash = input.policyHash ?? null;
  const snapshotHash = `sha256:${createHash("sha256")
    .update(
      stableStringify({
        schemaVersion: LISTING_EVIDENCE_SNAPSHOT_SCHEMA_VERSION,
        policyHash,
        evidence,
      }),
    )
    .digest("hex")}`;

  return {
    schemaVersion: LISTING_EVIDENCE_SNAPSHOT_SCHEMA_VERSION,
    policyHash,
    snapshotHash,
    createdAt: input.createdAt,
    evidence,
  };
}
